use std::ffi::{OsStr, OsString};
use std::fs::{File, Metadata, OpenOptions};
use std::os::windows::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsHandle;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use plurum_windows_syscall::{
    attest_local_ntfs, attest_security, create_private_directory, create_private_file,
    file_identity, file_standard, flush_file, try_lock_exclusive, unlock, DirectoryCreateAttempt,
    FileCreateAttempt, LockAttempt, ProcessIdentity, SecurityKind, WinError,
};
use sha2::{Digest, Sha256};

mod mutation;

pub(crate) use mutation::{
    CanonicalEntryRole, ConditionalMutationResult, ExclusiveCreateResult, ExpectedEntrySnapshot,
    ManagedEntry, ManagedEntryObservation, MissingEntrySnapshot, PresentEntrySnapshot,
    TemporaryEntry, TemporaryEntryRole, WindowsExclusiveWriteHandle, WindowsLeaseReadHandle,
};

const CREDENTIAL_ENTRY: &str = "credentials.json";
const SETUP_LOCK_ENTRY: &str = "setup.lock";
pub(crate) const MAX_ATTESTED_BYTES: usize = 40_961;
const MAX_BASE_PATH_UTF16: usize = 180;
const MAX_COMPONENT_UTF16: usize = 255;

const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
const FILE_SHARE_DELETE: u32 = 0x0000_0004;
const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const DELETE: u32 = 0x0001_0000;
const READ_CONTROL: u32 = 0x0002_0000;
const WRITE_DAC: u32 = 0x0004_0000;
const WRITE_OWNER: u32 = 0x0008_0000;
const ERROR_FILE_NOT_FOUND: i32 = 2;
const ERROR_PATH_NOT_FOUND: i32 = 3;
const ERROR_SHARING_VIOLATION: i32 = 32;

const LOCK_RECORD_LENGTH: usize = 64;
const LOCK_STATE_UNINITIALIZED: u8 = 0;
const LOCK_STATE_CLEAN: u8 = 1;
const LOCK_STATE_HELD: u8 = 2;
const LOCK_HEADER: &[u8] = b"plurum-lock-v1";
const LOCK_HEADER_START: usize = 1;
const LOCK_HEADER_END: usize = LOCK_HEADER_START + LOCK_HEADER.len();
const LOCK_NONCE_START: usize = 16;
const LOCK_NONCE_LENGTH: usize = 36;
const LOCK_NONCE_END: usize = LOCK_NONCE_START + LOCK_NONCE_LENGTH;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WindowsStoreError {
    InvalidInput,
    Missing,
    Unsafe,
    Lost,
    Closed,
    Limit,
    Unsupported,
    Io,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ObjectIdentity {
    pub(crate) volume: u64,
    pub(crate) file_id: [u8; 16],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ObjectKind {
    Directory,
    RegularFile,
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MetadataFacts {
    identity: ObjectIdentity,
    kind: ObjectKind,
    attributes: u32,
    links: u64,
    delete_pending: bool,
    size: u64,
    created: u64,
    modified: u64,
}

impl MetadataFacts {
    fn from_file(file: &File, metadata: &Metadata) -> Result<Self, WindowsStoreError> {
        let attributes = metadata.file_attributes();
        let identity = file_identity(file.as_handle()).map_err(map_win)?;
        let standard = file_standard(file.as_handle()).map_err(map_win)?;
        let kind = if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            ObjectKind::Other
        } else if attributes & FILE_ATTRIBUTE_DIRECTORY != 0
            && metadata.is_dir()
            && standard.directory
        {
            ObjectKind::Directory
        } else if metadata.is_file() && !standard.directory {
            ObjectKind::RegularFile
        } else {
            ObjectKind::Other
        };
        Ok(Self {
            identity: ObjectIdentity {
                volume: identity.volume_serial,
                file_id: identity.file_id,
            },
            kind,
            attributes,
            links: u64::from(standard.links),
            delete_pending: standard.delete_pending,
            size: metadata.file_size(),
            created: metadata.creation_time(),
            modified: metadata.last_write_time(),
        })
    }

    fn exact_file(self) -> bool {
        self.kind == ObjectKind::RegularFile
            && self.links == 1
            && !self.delete_pending
            && self.attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
    }
}

fn metadata(file: &File) -> Result<MetadataFacts, WindowsStoreError> {
    let value = file.metadata().map_err(|_| WindowsStoreError::Io)?;
    MetadataFacts::from_file(file, &value)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct NormalizedAbsolutePath {
    drive: u8,
    components: Vec<OsString>,
    path: PathBuf,
}

impl NormalizedAbsolutePath {
    fn parse(path: &Path) -> Result<Self, WindowsStoreError> {
        let raw = path.to_str().ok_or(WindowsStoreError::InvalidInput)?;
        if raw.contains('/') || raw.encode_utf16().count() > MAX_BASE_PATH_UTF16 {
            return Err(WindowsStoreError::InvalidInput);
        }
        let mut parts = path.components();
        let drive = match parts.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(drive) if drive.is_ascii_alphabetic() => drive.to_ascii_uppercase(),
                _ => return Err(WindowsStoreError::InvalidInput),
            },
            _ => return Err(WindowsStoreError::InvalidInput),
        };
        if parts.next() != Some(Component::RootDir) {
            return Err(WindowsStoreError::InvalidInput);
        }

        let mut components = Vec::new();
        for part in parts {
            match part {
                Component::Normal(component) if valid_component(component) => {
                    components.push(component.to_os_string());
                }
                _ => return Err(WindowsStoreError::InvalidInput),
            }
        }
        if components.is_empty() {
            return Err(WindowsStoreError::InvalidInput);
        }

        let mut normalized = PathBuf::from(format!("{}:\\", char::from(drive)));
        for component in &components {
            normalized.push(component);
        }
        let normalized_string = normalized.to_str().ok_or(WindowsStoreError::InvalidInput)?;
        if !normalized_string.eq_ignore_ascii_case(raw) {
            return Err(WindowsStoreError::InvalidInput);
        }
        Ok(Self {
            drive,
            components,
            path: normalized,
        })
    }

    fn open_parent(&self) -> Result<OpenedDirectoryChain, WindowsStoreError> {
        open_directory_components(self.drive, &self.components[..self.components.len() - 1])
    }

    fn open_complete(&self) -> Result<OpenedDirectoryChain, WindowsStoreError> {
        open_directory_components(self.drive, &self.components)
    }
}

fn valid_component(component: &OsStr) -> bool {
    let Some(value) = component.to_str() else {
        return false;
    };
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.encode_utf16().count() > MAX_COMPONENT_UTF16
        || value.ends_with(['.', ' '])
        || value.chars().any(|character| {
            character <= '\u{1f}'
                || matches!(
                    character,
                    '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
        })
    {
        return false;
    }
    let base = value.split('.').next().unwrap_or(value);
    let upper = base.to_ascii_uppercase();
    !matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
    )
}

fn is_single_entry_name(name: &OsStr) -> bool {
    valid_component(name)
        && name
            .to_str()
            .is_some_and(|value| !value.contains('\\') && !value.contains('/'))
}

struct OpenedDirectoryChain {
    ancestors: Vec<File>,
    leaf: File,
}

fn open_directory_components(
    drive: u8,
    components: &[OsString],
) -> Result<OpenedDirectoryChain, WindowsStoreError> {
    let root_path = PathBuf::from(format!("{}:\\", char::from(drive)));
    let root = open_directory_nofollow(&root_path, true).map_err(classify_path_error)?;
    let volume =
        attest_local_ntfs(root.as_handle(), &[u16::from(drive), 58, 92, 0]).map_err(map_win)?;
    if !volume.fixed_drive
        || !volume.ntfs
        || !volume.persistent_acls
        || !volume.direct_volume_mapping
    {
        return Err(WindowsStoreError::Unsupported);
    }
    let root_facts = metadata(&root)?;
    if root_facts.kind != ObjectKind::Directory
        || root_facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(WindowsStoreError::Unsafe);
    }

    let mut ancestors = Vec::with_capacity(components.len());
    let mut current_path = root_path;
    let mut current = root;
    for component in components {
        current_path.push(component);
        let next = open_directory_nofollow(&current_path, false).map_err(classify_path_error)?;
        let facts = metadata(&next)?;
        if facts.kind != ObjectKind::Directory
            || facts.identity.volume != root_facts.identity.volume
            || facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(WindowsStoreError::Unsafe);
        }
        ancestors.push(current);
        current = next;
    }
    Ok(OpenedDirectoryChain {
        ancestors,
        leaf: current,
    })
}

fn open_directory_nofollow(path: &Path, relaxed_root_sharing: bool) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        .access_mode(GENERIC_READ | READ_CONTROL)
        .share_mode(if relaxed_root_sharing {
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
        } else {
            FILE_SHARE_READ | FILE_SHARE_WRITE
        })
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

fn open_file_nofollow(
    path: &Path,
    writable: bool,
    delete_access: bool,
    pin_name: bool,
) -> std::io::Result<File> {
    let mut access = GENERIC_READ | READ_CONTROL;
    if writable {
        access |= GENERIC_WRITE;
    }
    if delete_access {
        access |= DELETE;
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(writable)
        .access_mode(access)
        .share_mode(
            FILE_SHARE_READ | FILE_SHARE_WRITE | if pin_name { 0 } else { FILE_SHARE_DELETE },
        )
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    options.open(path)
}

fn classify_path_error(error: std::io::Error) -> WindowsStoreError {
    match error.raw_os_error() {
        Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) => WindowsStoreError::Missing,
        Some(ERROR_SHARING_VIOLATION) => WindowsStoreError::Unsafe,
        _ => WindowsStoreError::Io,
    }
}

fn map_win(error: WinError) -> WindowsStoreError {
    use plurum_windows_syscall::ErrorKind;
    match error.kind {
        ErrorKind::Unsupported => WindowsStoreError::Unsupported,
        ErrorKind::Busy | ErrorKind::Conflict => WindowsStoreError::Lost,
        ErrorKind::Unsafe => WindowsStoreError::Unsafe,
        ErrorKind::Other => WindowsStoreError::Io,
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, WindowsStoreError> {
    mutex.lock().map_err(|_| WindowsStoreError::Lost)
}

fn digest_metadata(
    domain: &[u8],
    facts: MetadataFacts,
    canonical_current: bool,
    parent: Option<ObjectIdentity>,
    security_descriptor: &[u8],
    content: &[u8],
) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(domain);
    digest.update(facts.identity.volume.to_le_bytes());
    digest.update(facts.identity.file_id);
    digest.update(facts.attributes.to_le_bytes());
    digest.update(facts.links.to_le_bytes());
    digest.update([u8::from(facts.delete_pending)]);
    digest.update(facts.size.to_le_bytes());
    digest.update(facts.created.to_le_bytes());
    digest.update(facts.modified.to_le_bytes());
    digest.update([u8::from(canonical_current)]);
    if let Some(parent) = parent {
        digest.update(parent.volume.to_le_bytes());
        digest.update(parent.file_id);
    }
    digest.update(security_descriptor);
    digest.update(content);
    let value = digest.finalize();
    let mut result = [0_u8; 32];
    result.copy_from_slice(&value);
    result
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct DirectoryAttestation {
    pub(crate) identity: ObjectIdentity,
    pub(crate) revision: [u8; 32],
    pub(crate) canonical_current: bool,
    pub(crate) current_user: bool,
    pub(crate) private_mode: bool,
}

impl DirectoryAttestation {
    fn is_secure(self) -> bool {
        self.canonical_current && self.current_user && self.private_mode
    }
}

struct DirectoryState {
    ancestors: Vec<File>,
    parent: Option<File>,
    directory: Option<File>,
    children: Vec<Weak<Mutex<Option<File>>>>,
}

struct DirectoryCore {
    process: ProcessIdentity,
    path: NormalizedAbsolutePath,
    state: Mutex<DirectoryState>,
}

impl DirectoryCore {
    fn attest_locked(
        &self,
        state: &DirectoryState,
    ) -> Result<DirectoryAttestation, WindowsStoreError> {
        self.process.verify().map_err(|_| WindowsStoreError::Lost)?;
        let directory = state.directory.as_ref().ok_or(WindowsStoreError::Closed)?;
        let parent = state.parent.as_ref().ok_or(WindowsStoreError::Closed)?;
        let facts = metadata(directory)?;
        let security = attest_security(
            directory.as_handle(),
            &self.process,
            SecurityKind::Directory,
        )
        .map_err(map_win)?;

        let retained_parent_identities = state
            .ancestors
            .iter()
            .chain(std::iter::once(parent))
            .map(metadata)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(|value| value.identity)
            .collect::<Vec<_>>();
        let parent_binding = self
            .path
            .open_parent()
            .ok()
            .and_then(|chain| {
                chain
                    .ancestors
                    .iter()
                    .chain(std::iter::once(&chain.leaf))
                    .map(metadata)
                    .collect::<Result<Vec<_>, _>>()
                    .ok()
            })
            .is_some_and(|reopened| {
                reopened
                    .iter()
                    .map(|value| value.identity)
                    .eq(retained_parent_identities.iter().copied())
            });
        let complete_binding = self
            .path
            .open_complete()
            .ok()
            .and_then(|chain| metadata(&chain.leaf).ok())
            .is_some_and(|current| current.identity == facts.identity);
        let canonical_current =
            parent_binding && complete_binding && facts.kind == ObjectKind::Directory;
        Ok(DirectoryAttestation {
            identity: facts.identity,
            revision: digest_metadata(
                b"plurum-windows-directory-revision-v1\0",
                facts,
                canonical_current,
                None,
                &security.descriptor,
                &[],
            ),
            canonical_current,
            current_user: security.owner_current,
            private_mode: facts.kind == ObjectKind::Directory
                && security.exact_protected_dacl
                && security.semantic_medium_label
                && facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        })
    }

    fn require_secure_locked(
        &self,
        state: &DirectoryState,
    ) -> Result<DirectoryAttestation, WindowsStoreError> {
        let attestation = self.attest_locked(state)?;
        if !attestation.canonical_current {
            return Err(WindowsStoreError::Lost);
        }
        if !attestation.is_secure() {
            return Err(WindowsStoreError::Unsafe);
        }
        Ok(attestation)
    }

    fn close_all(&self) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.parent.take();
        state.directory.take();
        state.ancestors.clear();
        for child in state.children.drain(..) {
            if let Some(child) = child.upgrade() {
                let mut slot = match child.lock() {
                    Ok(slot) => slot,
                    Err(poisoned) => poisoned.into_inner(),
                };
                slot.take();
            }
        }
    }
}

pub(crate) struct WindowsPrivateDirectory {
    core: Arc<DirectoryCore>,
}

impl WindowsPrivateDirectory {
    pub(crate) fn attest(&self) -> Result<DirectoryAttestation, WindowsStoreError> {
        let state = lock_unpoisoned(&self.core.state)?;
        self.core.attest_locked(&state)
    }

    pub(crate) fn open_credential_read_only(
        &self,
    ) -> Result<CredentialReadOpenResult, WindowsStoreError> {
        self.open_managed_read_only(OsStr::new(CREDENTIAL_ENTRY))
    }

    fn open_managed_read_only(
        &self,
        entry_name: &OsStr,
    ) -> Result<CredentialReadOpenResult, WindowsStoreError> {
        if !is_single_entry_name(entry_name) {
            return Err(WindowsStoreError::InvalidInput);
        }
        let mut state = lock_unpoisoned(&self.core.state)?;
        let parent = self.core.require_secure_locked(&state)?;
        let entry_path = self.core.path.path.join(entry_name);
        let file = match open_file_nofollow(&entry_path, false, true, false) {
            Ok(file) => file,
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
                ) =>
            {
                return Ok(CredentialReadOpenResult::Missing);
            }
            Err(_) => return Err(WindowsStoreError::Unsafe),
        };
        let facts = metadata(&file)?;
        if facts.kind != ObjectKind::RegularFile {
            return Err(WindowsStoreError::Unsafe);
        }
        let rebound = open_file_nofollow(&entry_path, false, true, false)
            .map_err(|_| WindowsStoreError::Lost)?;
        if metadata(&rebound)?.identity != facts.identity {
            return Err(WindowsStoreError::Lost);
        }

        let slot = Arc::new(Mutex::new(Some(file)));
        state.children.retain(|child| child.upgrade().is_some());
        state.children.push(Arc::downgrade(&slot));
        Ok(CredentialReadOpenResult::Opened(
            WindowsCredentialReadHandle {
                directory: Arc::clone(&self.core),
                parent_identity: parent.identity,
                entry_name: entry_name.to_os_string(),
                slot,
            },
        ))
    }

    pub(crate) fn close(&mut self) {
        self.core.close_all();
    }
}

impl Drop for WindowsPrivateDirectory {
    fn drop(&mut self) {
        self.core.close_all();
    }
}

pub(crate) enum PrivateDirectoryOpenResult {
    Missing,
    Opened(WindowsPrivateDirectory),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DirectoryDisposition {
    Created,
    Existing,
}

pub(crate) struct EnsuredPrivateDirectory {
    pub(crate) disposition: DirectoryDisposition,
    pub(crate) directory: WindowsPrivateDirectory,
}

fn directory_from_parts(
    process: ProcessIdentity,
    path: NormalizedAbsolutePath,
    mut parent_chain: OpenedDirectoryChain,
    directory: File,
) -> WindowsPrivateDirectory {
    WindowsPrivateDirectory {
        core: Arc::new(DirectoryCore {
            process,
            path,
            state: Mutex::new(DirectoryState {
                ancestors: std::mem::take(&mut parent_chain.ancestors),
                parent: Some(parent_chain.leaf),
                directory: Some(directory),
                children: Vec::new(),
            }),
        }),
    }
}

pub(crate) fn open_private_directory(
    path: &Path,
) -> Result<PrivateDirectoryOpenResult, WindowsStoreError> {
    let process = ProcessIdentity::capture().map_err(map_win)?;
    let path = NormalizedAbsolutePath::parse(path)?;
    let parent = match path.open_parent() {
        Ok(parent) => parent,
        Err(WindowsStoreError::Missing) => return Ok(PrivateDirectoryOpenResult::Missing),
        Err(error) => return Err(error),
    };
    let directory = match open_directory_nofollow(&path.path, false) {
        Ok(directory) => directory,
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
            ) =>
        {
            return Ok(PrivateDirectoryOpenResult::Missing);
        }
        Err(error) => return Err(classify_path_error(error)),
    };
    let facts = metadata(&directory)?;
    if facts.kind != ObjectKind::Directory || facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(WindowsStoreError::Unsafe);
    }
    let directory = directory_from_parts(process, path, parent, directory);
    {
        let state = lock_unpoisoned(&directory.core.state)?;
        directory.core.require_secure_locked(&state)?;
    }
    Ok(PrivateDirectoryOpenResult::Opened(directory))
}

pub(crate) fn ensure_private_directory(
    path: &Path,
) -> Result<EnsuredPrivateDirectory, WindowsStoreError> {
    let process = ProcessIdentity::capture().map_err(map_win)?;
    let path = NormalizedAbsolutePath::parse(path)?;
    let parent = path.open_parent()?;
    let mut disposition = DirectoryDisposition::Existing;

    let directory = match open_directory_nofollow(&path.path, false) {
        Ok(directory) => directory,
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
            ) =>
        {
            match create_private_directory(&path.path, &process).map_err(map_win)? {
                DirectoryCreateAttempt::Created => {
                    disposition = DirectoryDisposition::Created;
                    open_directory_nofollow(&path.path, false)
                        .map_err(|_| WindowsStoreError::Lost)?
                }
                DirectoryCreateAttempt::Conflict => open_directory_nofollow(&path.path, false)
                    .map_err(|_| WindowsStoreError::Lost)?,
            }
        }
        Err(error) => return Err(classify_path_error(error)),
    };
    let facts = metadata(&directory)?;
    if facts.kind != ObjectKind::Directory || facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(WindowsStoreError::Unsafe);
    }

    let directory = directory_from_parts(process, path, parent, directory);
    {
        let state = lock_unpoisoned(&directory.core.state)?;
        directory.core.require_secure_locked(&state)?;
    }
    Ok(EnsuredPrivateDirectory {
        disposition,
        directory,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct FileSecurityAttestation {
    pub(crate) identity: ObjectIdentity,
    pub(crate) parent_identity: ObjectIdentity,
    pub(crate) canonical_current: bool,
    pub(crate) current_user: bool,
    pub(crate) private_mode: bool,
    pub(crate) links: u64,
    pub(crate) size: u64,
}

impl FileSecurityAttestation {
    fn is_secure(self) -> bool {
        self.canonical_current && self.current_user && self.private_mode && self.links == 1
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CredentialFileAttestation {
    pub(crate) security: FileSecurityAttestation,
    pub(crate) revision: [u8; 32],
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct BoundedRead {
    pub(crate) bytes: Vec<u8>,
    pub(crate) end_of_file: bool,
}

pub(crate) enum CredentialReadOpenResult {
    Missing,
    Opened(WindowsCredentialReadHandle),
}

pub(crate) struct WindowsCredentialReadHandle {
    directory: Arc<DirectoryCore>,
    parent_identity: ObjectIdentity,
    entry_name: OsString,
    slot: Arc<Mutex<Option<File>>>,
}

impl WindowsCredentialReadHandle {
    fn security_locked(
        &self,
        directory_state: &DirectoryState,
        file: &File,
    ) -> Result<(FileSecurityAttestation, MetadataFacts, Vec<u8>), WindowsStoreError> {
        self.directory
            .process
            .verify()
            .map_err(|_| WindowsStoreError::Lost)?;
        let parent = self.directory.attest_locked(directory_state)?;
        let facts = metadata(file)?;
        if facts.kind != ObjectKind::RegularFile {
            return Err(WindowsStoreError::Unsafe);
        }
        let security = attest_security(
            file.as_handle(),
            &self.directory.process,
            SecurityKind::File,
        )
        .map_err(map_win)?;
        let current_path = self.directory.path.path.join(&self.entry_name);
        let canonical_current = parent.is_secure()
            && open_file_nofollow(&current_path, false, true, false)
                .ok()
                .and_then(|current| metadata(&current).ok())
                .is_some_and(|current| current.identity == facts.identity);
        Ok((
            FileSecurityAttestation {
                identity: facts.identity,
                parent_identity: self.parent_identity,
                canonical_current,
                current_user: security.owner_current,
                private_mode: facts.exact_file()
                    && security.exact_protected_dacl
                    && security.semantic_medium_label,
                links: facts.links,
                size: facts.size,
            },
            facts,
            security.descriptor,
        ))
    }

    pub(crate) fn attest(&self) -> Result<CredentialFileAttestation, WindowsStoreError> {
        let directory_state = lock_unpoisoned(&self.directory.state)?;
        let slot = lock_unpoisoned(&self.slot)?;
        let file = slot.as_ref().ok_or(WindowsStoreError::Closed)?;
        let (before_security, before, before_descriptor) =
            self.security_locked(&directory_state, file)?;
        if !before_security.is_secure() {
            return Err(WindowsStoreError::Unsafe);
        }
        let expected_size = usize::try_from(before.size).map_err(|_| WindowsStoreError::Limit)?;
        if expected_size > MAX_ATTESTED_BYTES {
            return Err(WindowsStoreError::Limit);
        }
        let mut bytes = read_exact_at(file, expected_size)?;
        let (after_security, after, after_descriptor) =
            match self.security_locked(&directory_state, file) {
                Ok(value) => value,
                Err(error) => {
                    bytes.fill(0);
                    return Err(error);
                }
            };
        if before != after
            || before_security != after_security
            || before_descriptor != after_descriptor
        {
            bytes.fill(0);
            return Err(WindowsStoreError::Lost);
        }
        let revision = digest_metadata(
            b"plurum-windows-credential-revision-v1\0",
            after,
            after_security.canonical_current,
            Some(after_security.parent_identity),
            &after_descriptor,
            &bytes,
        );
        bytes.fill(0);
        Ok(CredentialFileAttestation {
            security: after_security,
            revision,
        })
    }

    pub(crate) fn read_bounded(&self, max_bytes: usize) -> Result<BoundedRead, WindowsStoreError> {
        if max_bytes > MAX_ATTESTED_BYTES {
            return Err(WindowsStoreError::Limit);
        }
        let directory_state = lock_unpoisoned(&self.directory.state)?;
        let slot = lock_unpoisoned(&self.slot)?;
        let file = slot.as_ref().ok_or(WindowsStoreError::Closed)?;
        let (before_security, before, before_descriptor) =
            self.security_locked(&directory_state, file)?;
        if !before_security.is_secure() {
            return Err(WindowsStoreError::Unsafe);
        }
        let mut bytes = read_up_to_at(file, max_bytes)?;
        let (after_security, after, after_descriptor) =
            match self.security_locked(&directory_state, file) {
                Ok(value) => value,
                Err(error) => {
                    bytes.fill(0);
                    return Err(error);
                }
            };
        if before != after
            || before_security != after_security
            || before_descriptor != after_descriptor
        {
            bytes.fill(0);
            return Err(WindowsStoreError::Lost);
        }
        Ok(BoundedRead {
            end_of_file: u64::try_from(bytes.len()).ok() == Some(after.size),
            bytes,
        })
    }

    pub(crate) fn close(&mut self) {
        let mut slot = match self.slot.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        slot.take();
    }
}

impl Drop for WindowsCredentialReadHandle {
    fn drop(&mut self) {
        self.close();
    }
}

fn read_up_to_at(file: &File, max_bytes: usize) -> Result<Vec<u8>, WindowsStoreError> {
    let mut bytes = vec![0_u8; max_bytes];
    let mut offset = 0;
    while offset < max_bytes {
        let position = match u64::try_from(offset) {
            Ok(position) => position,
            Err(_) => {
                bytes.fill(0);
                return Err(WindowsStoreError::Limit);
            }
        };
        let read = match file.seek_read(&mut bytes[offset..], position) {
            Ok(read) => read,
            Err(_) => {
                bytes.fill(0);
                return Err(WindowsStoreError::Io);
            }
        };
        if read == 0 {
            break;
        }
        offset += read;
    }
    bytes.truncate(offset);
    Ok(bytes)
}

fn read_exact_at(file: &File, expected: usize) -> Result<Vec<u8>, WindowsStoreError> {
    let mut bytes = read_up_to_at(file, expected)?;
    if bytes.len() == expected {
        Ok(bytes)
    } else {
        bytes.fill(0);
        Err(WindowsStoreError::Lost)
    }
}

fn write_all_at(file: &File, bytes: &[u8], start: u64) -> Result<(), WindowsStoreError> {
    let mut written = 0;
    while written < bytes.len() {
        let offset = start
            .checked_add(u64::try_from(written).map_err(|_| WindowsStoreError::Limit)?)
            .ok_or(WindowsStoreError::Limit)?;
        let count = file
            .seek_write(&bytes[written..], offset)
            .map_err(|_| WindowsStoreError::Io)?;
        if count == 0 {
            return Err(WindowsStoreError::Io);
        }
        written += count;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PriorLease {
    Absent,
    ProvenAbandoned,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LeaseRenewal {
    Held,
    Lost,
}

pub(crate) enum SetupLeaseAcquireResult {
    Busy,
    Acquired {
        prior: PriorLease,
        directory: DirectoryDisposition,
        lease: WindowsSetupLease,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ValidatedUuidV4([u8; LOCK_NONCE_LENGTH]);

impl ValidatedUuidV4 {
    fn parse(value: &str) -> Result<Self, WindowsStoreError> {
        let bytes = value.as_bytes();
        if bytes.len() != LOCK_NONCE_LENGTH {
            return Err(WindowsStoreError::InvalidInput);
        }
        for (index, byte) in bytes.iter().copied().enumerate() {
            let expected_hyphen = matches!(index, 8 | 13 | 18 | 23);
            if expected_hyphen {
                if byte != b'-' {
                    return Err(WindowsStoreError::InvalidInput);
                }
            } else if !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte) {
                return Err(WindowsStoreError::InvalidInput);
            }
        }
        if bytes[14] != b'4' || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b') {
            return Err(WindowsStoreError::InvalidInput);
        }
        let mut nonce = [0_u8; LOCK_NONCE_LENGTH];
        nonce.copy_from_slice(bytes);
        Ok(Self(nonce))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LockRecordState {
    Uninitialized,
    Clean,
    Held(ValidatedUuidV4),
}

fn read_lock_record(file: &File) -> Result<LockRecordState, WindowsStoreError> {
    let facts = metadata(file)?;
    if facts.size == 0 {
        return Ok(LockRecordState::Uninitialized);
    }
    if facts.size != LOCK_RECORD_LENGTH as u64 {
        return Err(WindowsStoreError::Unsafe);
    }
    let bytes = read_exact_at(file, LOCK_RECORD_LENGTH)?;
    if bytes[0] == LOCK_STATE_UNINITIALIZED {
        return Ok(LockRecordState::Uninitialized);
    }
    if &bytes[LOCK_HEADER_START..LOCK_HEADER_END] != LOCK_HEADER
        || bytes[LOCK_HEADER_END..LOCK_NONCE_START]
            .iter()
            .any(|byte| *byte != 0)
        || bytes[LOCK_NONCE_END..].iter().any(|byte| *byte != 0)
    {
        return Err(WindowsStoreError::Unsafe);
    }
    match bytes[0] {
        LOCK_STATE_CLEAN => {
            let nonce = &bytes[LOCK_NONCE_START..LOCK_NONCE_END];
            if nonce.iter().all(|byte| *byte == 0)
                || std::str::from_utf8(nonce)
                    .ok()
                    .and_then(|value| ValidatedUuidV4::parse(value).ok())
                    .is_some()
            {
                Ok(LockRecordState::Clean)
            } else {
                Err(WindowsStoreError::Unsafe)
            }
        }
        LOCK_STATE_HELD => {
            let nonce = std::str::from_utf8(&bytes[LOCK_NONCE_START..LOCK_NONCE_END])
                .map_err(|_| WindowsStoreError::Unsafe)
                .and_then(ValidatedUuidV4::parse)?;
            Ok(LockRecordState::Held(nonce))
        }
        _ => Err(WindowsStoreError::Unsafe),
    }
}

fn write_lock_state(file: &File, state: u8) -> Result<(), WindowsStoreError> {
    write_all_at(file, &[state], 0)?;
    flush_file(file.as_handle()).map_err(map_win)
}

fn initialize_clean_lock_record(file: &File) -> Result<(), WindowsStoreError> {
    if metadata(file)?.size != 0 {
        write_lock_state(file, LOCK_STATE_UNINITIALIZED)?;
    }
    file.set_len(LOCK_RECORD_LENGTH as u64)
        .map_err(|_| WindowsStoreError::Io)?;
    let mut tail = [0_u8; LOCK_RECORD_LENGTH - 1];
    tail[LOCK_HEADER_START - 1..LOCK_HEADER_END - 1].copy_from_slice(LOCK_HEADER);
    write_all_at(file, &tail, 1)?;
    flush_file(file.as_handle()).map_err(map_win)?;
    write_lock_state(file, LOCK_STATE_CLEAN)?;
    if read_lock_record(file)? == LockRecordState::Clean {
        Ok(())
    } else {
        Err(WindowsStoreError::Lost)
    }
}

fn write_held_lock_record(file: &File, nonce: ValidatedUuidV4) -> Result<(), WindowsStoreError> {
    if read_lock_record(file)? != LockRecordState::Clean {
        return Err(WindowsStoreError::Lost);
    }
    write_all_at(file, &nonce.0, LOCK_NONCE_START as u64)?;
    flush_file(file.as_handle()).map_err(map_win)?;
    write_lock_state(file, LOCK_STATE_HELD)?;
    if read_lock_record(file)? == LockRecordState::Held(nonce) {
        Ok(())
    } else {
        Err(WindowsStoreError::Lost)
    }
}

fn exact_setup_lock(
    directory: &WindowsPrivateDirectory,
    file: &File,
) -> Result<bool, WindowsStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let facts = metadata(file)?;
    let security = attest_security(
        file.as_handle(),
        &directory.core.process,
        SecurityKind::File,
    )
    .map_err(map_win)?;
    if !facts.exact_file()
        || !security.owner_current
        || !security.exact_protected_dacl
        || !security.semantic_medium_label
    {
        return Ok(false);
    }
    let current_path = directory.core.path.path.join(SETUP_LOCK_ENTRY);
    Ok(open_file_nofollow(&current_path, true, false, true)
        .ok()
        .and_then(|current| metadata(&current).ok())
        .is_some_and(|current| current.identity == facts.identity && current.exact_file()))
}

fn open_or_create_setup_lock(
    directory: &WindowsPrivateDirectory,
) -> Result<(File, bool), WindowsStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let path = directory.core.path.path.join(SETUP_LOCK_ENTRY);
    let mut created = false;
    let file = match open_file_nofollow(&path, true, false, true) {
        Ok(file) => file,
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
            ) =>
        {
            match create_private_file(
                &path,
                &directory.core.process,
                GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
            )
            .map_err(map_win)?
            {
                FileCreateAttempt::Created(file) => {
                    created = true;
                    file
                }
                FileCreateAttempt::Conflict => open_file_nofollow(&path, true, false, true)
                    .map_err(|_| WindowsStoreError::Unsafe)?,
            }
        }
        Err(_) => return Err(WindowsStoreError::Unsafe),
    };
    drop(state);
    if !exact_setup_lock(directory, &file)? {
        return Err(WindowsStoreError::Unsafe);
    }
    Ok((file, created))
}

pub(crate) fn acquire_setup_lease(
    path: &Path,
    nonce: &str,
) -> Result<SetupLeaseAcquireResult, WindowsStoreError> {
    let nonce = ValidatedUuidV4::parse(nonce)?;
    let ensured = ensure_private_directory(path)?;
    let directory_disposition = ensured.disposition;
    let directory = ensured.directory;
    let (lock, _created) = match open_or_create_setup_lock(&directory) {
        Ok(value) => value,
        Err(WindowsStoreError::Unsafe | WindowsStoreError::Lost) => {
            return Ok(SetupLeaseAcquireResult::Busy);
        }
        Err(error) => return Err(error),
    };
    match try_lock_exclusive(lock.as_handle()).map_err(map_win)? {
        LockAttempt::Acquired => {}
        LockAttempt::Busy => return Ok(SetupLeaseAcquireResult::Busy),
    }
    if !exact_setup_lock(&directory, &lock)? {
        return Ok(SetupLeaseAcquireResult::Busy);
    }

    let prior = match read_lock_record(&lock) {
        Ok(LockRecordState::Uninitialized) => {
            initialize_clean_lock_record(&lock)?;
            PriorLease::Absent
        }
        Ok(LockRecordState::Clean) => PriorLease::Absent,
        Ok(LockRecordState::Held(_)) => {
            write_lock_state(&lock, LOCK_STATE_CLEAN)?;
            PriorLease::ProvenAbandoned
        }
        Err(WindowsStoreError::Unsafe) => return Ok(SetupLeaseAcquireResult::Busy),
        Err(error) => return Err(error),
    };
    write_held_lock_record(&lock, nonce)?;

    let lease = WindowsSetupLease {
        core: Arc::new(LeaseCore {
            nonce,
            runtime: Mutex::new(LeaseRuntime {
                status: LeaseStatus::Held,
                generation: 0,
                directory: Some(directory),
                lock: Some(lock),
            }),
        }),
    };
    if lease.verify_held().is_err() {
        return Err(WindowsStoreError::Lost);
    }
    Ok(SetupLeaseAcquireResult::Acquired {
        prior,
        directory: directory_disposition,
        lease,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LeaseStatus {
    Held,
    Lost,
    Terminal,
}

struct LeaseRuntime {
    status: LeaseStatus,
    generation: u64,
    directory: Option<WindowsPrivateDirectory>,
    lock: Option<File>,
}

struct LeaseCore {
    nonce: ValidatedUuidV4,
    runtime: Mutex<LeaseRuntime>,
}

impl LeaseCore {
    fn verify_held_locked(&self, runtime: &LeaseRuntime) -> Result<(), WindowsStoreError> {
        match runtime.status {
            LeaseStatus::Held => {}
            LeaseStatus::Lost => return Err(WindowsStoreError::Lost),
            LeaseStatus::Terminal => return Err(WindowsStoreError::Closed),
        }
        let directory = runtime
            .directory
            .as_ref()
            .ok_or(WindowsStoreError::Closed)?;
        let lock = runtime.lock.as_ref().ok_or(WindowsStoreError::Closed)?;
        if !exact_setup_lock(directory, lock)?
            || read_lock_record(lock)? != LockRecordState::Held(self.nonce)
        {
            return Err(WindowsStoreError::Lost);
        }
        Ok(())
    }

    fn verify_or_latch_locked(&self, runtime: &mut LeaseRuntime) -> Result<(), WindowsStoreError> {
        if let Err(error) = self.verify_held_locked(runtime) {
            if runtime.status != LeaseStatus::Terminal {
                runtime.status = LeaseStatus::Lost;
            }
            return Err(error);
        }
        Ok(())
    }

    fn finish_locked(
        runtime: &mut LeaseRuntime,
        explicit_unlock: bool,
    ) -> Result<(), WindowsStoreError> {
        runtime.status = LeaseStatus::Terminal;
        let unlock_result = if explicit_unlock {
            runtime
                .lock
                .as_ref()
                .map(|lock| unlock(lock.as_handle()).map_err(map_win))
                .transpose()
                .map(|_| ())
        } else {
            Ok(())
        };
        if let Some(mut directory) = runtime.directory.take() {
            directory.close();
        }
        runtime.lock.take();
        unlock_result
    }
}

pub(crate) struct WindowsSetupLease {
    core: Arc<LeaseCore>,
}

impl WindowsSetupLease {
    fn verify_held(&self) -> Result<(), WindowsStoreError> {
        let mut runtime = lock_unpoisoned(&self.core.runtime)?;
        self.core.verify_or_latch_locked(&mut runtime)
    }

    pub(crate) fn renew(&self) -> LeaseRenewal {
        if self.verify_held().is_ok() {
            LeaseRenewal::Held
        } else {
            LeaseRenewal::Lost
        }
    }

    pub(crate) fn release(&mut self) -> Result<(), WindowsStoreError> {
        let (mut runtime, poisoned) = match self.core.runtime.lock() {
            Ok(runtime) => (runtime, false),
            Err(poisoned) => (poisoned.into_inner(), true),
        };
        if runtime.status == LeaseStatus::Terminal {
            return Err(WindowsStoreError::Closed);
        }
        if poisoned {
            runtime.status = LeaseStatus::Lost;
            let _ = LeaseCore::finish_locked(&mut runtime, false);
            return Err(WindowsStoreError::Lost);
        }
        let result = (|| {
            self.core.verify_or_latch_locked(&mut runtime)?;
            let lock = runtime.lock.as_ref().ok_or(WindowsStoreError::Closed)?;
            write_lock_state(lock, LOCK_STATE_CLEAN)?;
            if read_lock_record(lock)? != LockRecordState::Clean {
                return Err(WindowsStoreError::Lost);
            }
            Ok(())
        })();
        if result.is_err() {
            runtime.status = LeaseStatus::Lost;
        }
        let unlock_result = LeaseCore::finish_locked(&mut runtime, result.is_ok());
        result.and(unlock_result)
    }

    pub(crate) fn abandon(&mut self) -> Result<(), WindowsStoreError> {
        let (mut runtime, poisoned) = match self.core.runtime.lock() {
            Ok(runtime) => (runtime, false),
            Err(poisoned) => (poisoned.into_inner(), true),
        };
        if runtime.status == LeaseStatus::Terminal {
            return Err(WindowsStoreError::Closed);
        }
        let result = LeaseCore::finish_locked(&mut runtime, !poisoned);
        if poisoned {
            Err(WindowsStoreError::Lost)
        } else {
            result
        }
    }
}

impl Drop for WindowsSetupLease {
    fn drop(&mut self) {
        let mut runtime = match self.core.runtime.lock() {
            Ok(runtime) => runtime,
            Err(poisoned) => poisoned.into_inner(),
        };
        if runtime.status != LeaseStatus::Terminal {
            let _ = LeaseCore::finish_locked(&mut runtime, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::fs;
    use std::io::Write;
    use std::os::windows::fs::{symlink_dir, symlink_file};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::OnceLock;
    use std::thread;
    use std::time::Duration;

    use super::*;

    const NONCE_1: &str = "b56c52f5-a090-41eb-a164-1c92e36db94f";
    const NONCE_2: &str = "4657f2a0-739f-4923-86e8-f25f1dc328f9";
    const ISOLATION_MARKER: &str = "plurum-native-isolation-v1\n";
    const TEST_MARKER: &str = "plurum-windows-native-test-v1\n";
    const CHILD_DIRECTORY_ENV: &str = "PLURUM_WINDOWS_LEASE_CHILD_DIRECTORY";
    const CHILD_READY_ENV: &str = "PLURUM_WINDOWS_LEASE_CHILD_READY";
    static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(1);
    static TEST_PROCESS_MEDIUM: OnceLock<()> = OnceLock::new();

    pub(super) struct TestRoot {
        pub(super) root: PathBuf,
        pub(super) temporary: PathBuf,
        pub(super) store: PathBuf,
        pub(super) marker: PathBuf,
    }

    pub(super) fn verified_test_isolation() -> PathBuf {
        let configured = PathBuf::from(
            env::var("PLURUM_NATIVE_ISOLATION_ROOT")
                .expect("native tests require the isolated runner root"),
        );
        NormalizedAbsolutePath::parse(&configured)
            .expect("isolation root must be a canonical local drive path");
        assert_eq!(
            configured.file_name(),
            Some(OsStr::new("plurum-native-isolation")),
            "isolation root must use the exact sentinel directory name"
        );
        let configured_metadata =
            fs::symlink_metadata(&configured).expect("isolation root must exist");
        assert!(configured_metadata.is_dir());
        assert_eq!(
            configured_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT,
            0,
            "isolation root must not be a reparse point"
        );
        let marker = configured.join(".plurum-native-isolation");
        let marker_metadata = fs::symlink_metadata(&marker).expect("isolation marker must exist");
        assert!(marker_metadata.is_file());
        assert_eq!(
            marker_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT,
            0
        );
        assert_eq!(
            fs::read_to_string(marker).expect("isolation marker must be readable"),
            ISOLATION_MARKER
        );
        let temporary = configured.join("tmp");
        let temporary_metadata =
            fs::symlink_metadata(&temporary).expect("isolated temporary root must exist");
        assert!(temporary_metadata.is_dir());
        assert_eq!(
            temporary_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT,
            0
        );
        TEST_PROCESS_MEDIUM.get_or_init(|| {
            plurum_windows_syscall::prepare_medium_integrity_test_directory(&configured)
                .expect("isolated Windows test root must have medium integrity");
            plurum_windows_syscall::prepare_medium_integrity_test_directory(&temporary)
                .expect("isolated Windows temporary root must have medium integrity");
            plurum_windows_syscall::lower_process_integrity_to_medium_for_tests()
                .expect("isolated Windows tests must run at exact medium integrity");
        });
        temporary
    }

    impl TestRoot {
        pub(super) fn new() -> Self {
            let temporary = verified_test_isolation();
            let sequence = NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed);
            let root = temporary.join(format!("plurum-windows-{}-{sequence}", std::process::id()));
            let ensured = ensure_private_directory(&root).expect("test root must be secured");
            assert_eq!(ensured.disposition, DirectoryDisposition::Created);
            drop(ensured);
            let marker = root.join(".plurum-windows-native-test");
            let process = ProcessIdentity::capture().expect("test process identity must be safe");
            let mut file = match create_private_file(
                &marker,
                &process,
                GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER,
                FILE_SHARE_READ,
            )
            .expect("test marker create must complete")
            {
                FileCreateAttempt::Created(file) => file,
                FileCreateAttempt::Conflict => panic!("test marker unexpectedly exists"),
            };
            file.write_all(TEST_MARKER.as_bytes())
                .expect("test marker must be written");
            flush_file(file.as_handle()).expect("test marker must be flushed");
            drop(file);
            let store = root.join("Plurum");
            Self {
                root,
                temporary,
                store,
                marker,
            }
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let safe = self.root.starts_with(&self.temporary)
                && fs::symlink_metadata(&self.root).is_ok_and(|metadata| {
                    metadata.is_dir()
                        && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
                })
                && fs::read_to_string(&self.marker).is_ok_and(|value| value == TEST_MARKER);
            if safe {
                let _ = fs::remove_dir_all(&self.root);
            }
        }
    }

    pub(super) fn acquired_lease(
        path: &Path,
        nonce: &str,
    ) -> (PriorLease, DirectoryDisposition, WindowsSetupLease) {
        match acquire_setup_lease(path, nonce).expect("lease acquisition must complete") {
            SetupLeaseAcquireResult::Busy => panic!("test lease unexpectedly busy"),
            SetupLeaseAcquireResult::Acquired {
                prior,
                directory,
                lease,
            } => (prior, directory, lease),
        }
    }

    #[test]
    fn canonical_path_parser_rejects_ambiguous_windows_namespaces() {
        assert!(NormalizedAbsolutePath::parse(Path::new(r"C:\Users\agent\AppData\Plurum")).is_ok());
        for invalid in [
            r"relative\Plurum",
            r"C:Plurum",
            r"\\server\share\Plurum",
            r"\\?\C:\Plurum",
            r"\\.\C:\Plurum",
            r"C:\Plurum\..\other",
            r"C:\Plurum.",
            r"C:\Plurum ",
            r"C:\NUL",
            "C:\\COM¹.txt",
            "C:\\LPT³",
            r"C:\Plurum:stream",
            r"C:/Plurum",
        ] {
            assert_eq!(
                NormalizedAbsolutePath::parse(Path::new(invalid)),
                Err(WindowsStoreError::InvalidInput),
                "{invalid}"
            );
        }
    }

    #[test]
    fn exact_user_acl_bounded_reads_and_terminal_handles() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        assert_eq!(lease.renew(), LeaseRenewal::Held);
        let attestation = lease
            .attest_directory()
            .expect("secured directory must attest");
        assert!(attestation.current_user);
        assert!(attestation.private_mode);
        assert!(lease
            .observe_entry(mutation::ManagedEntry::credential())
            .expect("credential observation must complete")
            .is_missing());
        lease.release().expect("lease must release cleanly");
        assert_eq!(lease.renew(), LeaseRenewal::Lost);
    }

    #[test]
    fn persistent_kernel_lock_serializes_and_abandonment_is_record_based() {
        let test = TestRoot::new();
        let (prior, _, mut first) = acquired_lease(&test.store, NONCE_1);
        assert_eq!(prior, PriorLease::Absent);
        assert!(matches!(
            acquire_setup_lease(&test.store, NONCE_2),
            Ok(SetupLeaseAcquireResult::Busy)
        ));
        first.abandon().expect("explicit abandonment must close");
        let (prior, _, mut recovered) = acquired_lease(&test.store, NONCE_2);
        assert_eq!(prior, PriorLease::ProvenAbandoned);
        recovered.release().expect("recovered lease must release");
    }

    #[test]
    fn final_and_intermediate_directory_reparse_points_are_never_followed() {
        let test = TestRoot::new();
        let outside = test.root.join("outside");
        fs::create_dir(&outside).expect("outside directory must exist");
        symlink_dir(&outside, &test.store).expect("directory symlink must be created");
        assert!(matches!(
            ensure_private_directory(&test.store),
            Err(WindowsStoreError::Unsafe)
        ));
        fs::remove_dir(&test.store).expect("directory symlink itself must be removable");

        let intermediate = test.root.join("redirect");
        symlink_dir(&outside, &intermediate).expect("intermediate symlink must be created");
        assert!(matches!(
            ensure_private_directory(&intermediate.join("Plurum")),
            Err(WindowsStoreError::Unsafe)
        ));
        assert!(outside.is_dir(), "reparse target must remain untouched");
        fs::remove_dir(&intermediate).expect("intermediate symlink itself must be removable");

        let junction = test.root.join("junction");
        fs::create_dir(&junction).expect("junction placeholder must be created");
        let junction_created =
            plurum_windows_syscall::try_create_junction_for_tests(&junction, &outside)
                .expect("junction creation attempt must complete");
        if env::var("CI").as_deref() == Ok("true") {
            assert!(
                junction_created,
                "Windows CI must execute the real junction rejection path"
            );
        }
        if junction_created {
            assert_ne!(
                fs::symlink_metadata(&junction)
                    .expect("junction metadata must exist")
                    .file_attributes()
                    & FILE_ATTRIBUTE_REPARSE_POINT,
                0
            );
            assert!(matches!(
                ensure_private_directory(&junction.join("Plurum")),
                Err(WindowsStoreError::Unsafe)
            ));
        }
        fs::remove_dir(&junction).expect("junction placeholder must be removable");
    }

    #[test]
    fn broad_inherited_and_wrong_owner_security_are_rejected() {
        let test = TestRoot::new();

        let broad = test.root.join("Broad");
        drop(ensure_private_directory(&broad).expect("broad test directory must be created"));
        plurum_windows_syscall::set_broad_dacl_for_tests(&broad, SecurityKind::Directory)
            .expect("broad test DACL must be installed");
        assert!(matches!(
            open_private_directory(&broad),
            Err(WindowsStoreError::Unsafe)
        ));

        let inherited = test.root.join("Inherited");
        drop(
            ensure_private_directory(&inherited).expect("inherited test directory must be created"),
        );
        plurum_windows_syscall::set_inherited_current_user_dacl_for_tests(
            &inherited,
            SecurityKind::Directory,
        )
        .expect("inherited test DACL must be installed");
        assert!(matches!(
            open_private_directory(&inherited),
            Err(WindowsStoreError::Unsafe)
        ));

        let wrong_owner = test.root.join("WrongOwner");
        drop(
            ensure_private_directory(&wrong_owner)
                .expect("wrong-owner test directory must be created"),
        );
        let wrong_owner_changed = plurum_windows_syscall::try_set_wrong_owner_for_tests(
            &wrong_owner,
            SecurityKind::Directory,
        )
        .expect("wrong-owner attempt must complete");
        if env::var("CI").as_deref() == Ok("true") {
            assert!(
                wrong_owner_changed,
                "Windows CI must execute the wrong-owner rejection path"
            );
        }
        if wrong_owner_changed {
            assert!(matches!(
                open_private_directory(&wrong_owner),
                Err(WindowsStoreError::Unsafe)
            ));
        }
    }

    #[test]
    fn final_file_reparse_and_non_file_entries_are_rejected() {
        let test = TestRoot::new();
        let ensured =
            ensure_private_directory(&test.store).expect("store directory must be secured");
        let directory = ensured.directory;
        let credential = test.store.join(CREDENTIAL_ENTRY);

        fs::create_dir(&credential).expect("non-file credential entry must be created");
        assert!(matches!(
            directory.open_credential_read_only(),
            Err(WindowsStoreError::Unsafe)
        ));
        fs::remove_dir(&credential).expect("non-file credential entry must be removed");

        let target = test.root.join("outside-credential");
        fs::write(&target, b"outside").expect("reparse target must be written");
        symlink_file(&target, &credential).expect("file symlink must be created");
        assert!(matches!(
            directory.open_credential_read_only(),
            Err(WindowsStoreError::Unsafe)
        ));
        assert_eq!(
            fs::read(&target).expect("reparse target must remain readable"),
            b"outside"
        );
    }

    #[test]
    fn malformed_lock_is_busy_and_retained_names_cannot_be_replaced() {
        let test = TestRoot::new();
        let ensured =
            ensure_private_directory(&test.store).expect("store directory must be secured");
        let process = ProcessIdentity::capture().expect("test process identity must be safe");
        let lock_path = test.store.join(SETUP_LOCK_ENTRY);
        let mut malformed = match create_private_file(
            &lock_path,
            &process,
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
        )
        .expect("malformed lock create must complete")
        {
            FileCreateAttempt::Created(file) => file,
            FileCreateAttempt::Conflict => panic!("malformed lock unexpectedly exists"),
        };
        malformed
            .write_all(&[0xff; LOCK_RECORD_LENGTH])
            .expect("malformed lock bytes must be written");
        flush_file(malformed.as_handle()).expect("malformed lock must be flushed");
        drop(malformed);
        drop(ensured);
        assert!(matches!(
            acquire_setup_lease(&test.store, NONCE_1),
            Ok(SetupLeaseAcquireResult::Busy)
        ));
        fs::remove_file(&lock_path).expect("malformed lock must be removable");

        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        fs::write(test.root.join("unrelated-write"), b"ok")
            .expect("retained ancestor handles must allow unrelated writes");
        assert!(
            fs::rename(&lock_path, test.store.join("replacement.lock")).is_err(),
            "the retained lock name must deny replacement"
        );
        assert!(
            fs::rename(&test.store, test.root.join("replacement-store")).is_err(),
            "the retained directory name must deny replacement"
        );
        assert_eq!(lease.renew(), LeaseRenewal::Held);
        lease.release().expect("lease must release cleanly");
    }

    #[test]
    fn process_death_releases_kernel_lock_and_proves_abandonment() {
        let test = TestRoot::new();
        let ready = test.root.join("lease-child-ready");
        let mut child = Command::new(env::current_exe().expect("test executable must exist"))
            .args([
                "--exact",
                "windows::tests::process_lease_child",
                "--nocapture",
            ])
            .env(CHILD_DIRECTORY_ENV, &test.store)
            .env(CHILD_READY_ENV, &ready)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("lease child must start");
        for _ in 0..200 {
            if ready.exists() {
                break;
            }
            assert!(
                child
                    .try_wait()
                    .expect("child status must be readable")
                    .is_none(),
                "lease child exited before readiness"
            );
            thread::sleep(Duration::from_millis(25));
        }
        assert!(ready.exists(), "lease child must become ready");
        assert!(matches!(
            acquire_setup_lease(&test.store, NONCE_2),
            Ok(SetupLeaseAcquireResult::Busy)
        ));
        child.kill().expect("lease child must be killable");
        child.wait().expect("lease child must be reapable");
        let (prior, _, mut recovered) = acquired_lease(&test.store, NONCE_2);
        assert_eq!(prior, PriorLease::ProvenAbandoned);
        recovered.release().expect("recovered lease must release");
    }

    #[test]
    fn process_lease_child() {
        let Some(directory) = env::var_os(CHILD_DIRECTORY_ENV).map(PathBuf::from) else {
            return;
        };
        let ready = PathBuf::from(
            env::var_os(CHILD_READY_ENV).expect("child ready path must be configured"),
        );
        let temporary = verified_test_isolation();
        let test_root = directory.parent().expect("store must have test parent");
        assert_eq!(test_root.parent(), Some(temporary.as_path()));
        assert_eq!(directory, test_root.join("Plurum"));
        assert_eq!(
            fs::read_to_string(test_root.join(".plurum-windows-native-test"))
                .expect("test marker must be readable"),
            TEST_MARKER
        );
        let (_, _, _lease) = acquired_lease(&directory, NONCE_1);
        fs::write(&ready, b"ready\n").expect("child readiness marker must be written");
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }
}
