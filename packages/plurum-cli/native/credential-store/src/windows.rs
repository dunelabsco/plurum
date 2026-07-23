use std::ffi::{OsStr, OsString};
use std::fs::{File, Metadata, OpenOptions};
use std::os::windows::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsHandle;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use plurum_native_secret_memory::zeroize_bytes;
use plurum_windows_syscall::{
    attest_local_ntfs, attest_no_untrusted_namespace_control, attest_security,
    create_private_directory, create_private_file, file_identity, file_standard, flush_file,
    remove_by_handle, try_lock_exclusive, unlock, DirectoryCreateAttempt, FileCreateAttempt,
    LockAttempt, MutationAttempt, ProcessIdentity, SecurityKind, WinError,
};
use sha2::{Digest, Sha256};

mod mutation;

pub(crate) use mutation::{
    CanonicalEntryRole, ConditionalMutationResult, ExclusiveCreateResult, ExpectedEntrySnapshot,
    ManagedEntry, ManagedEntryObservation, MissingEntrySnapshot, PresentEntrySnapshot,
    PrivateManagedEntryObservation, TemporaryEntry, TemporaryEntryRole,
    WindowsExclusiveWriteHandle, WindowsLeaseReadHandle,
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

#[cfg(test)]
const TEST_OBSERVED_ACQUIRE_BUSY_AFTER_PREPARE: u8 = 1;

#[cfg(test)]
thread_local! {
    static TEST_OBSERVED_ACQUIRE_FAULT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn inject_observed_acquire_fault(fault: u8) {
    TEST_OBSERVED_ACQUIRE_FAULT.with(|slot| {
        assert_eq!(
            slot.replace(fault),
            0,
            "observed-acquire fault already armed"
        );
    });
}

#[cfg(test)]
fn take_observed_acquire_fault(fault: u8) -> bool {
    TEST_OBSERVED_ACQUIRE_FAULT.with(|slot| {
        if slot.get() == fault {
            slot.set(0);
            true
        } else {
            false
        }
    })
}

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

fn open_directory_delete_nofollow(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        .access_mode(GENERIC_READ | READ_CONTROL | DELETE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

fn open_object_nofollow(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        .access_mode(GENERIC_READ | READ_CONTROL)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
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

fn open_legacy_file_nofollow(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        .access_mode(GENERIC_READ | READ_CONTROL)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
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

pub(crate) struct MissingDirectoryBinding {
    process: ProcessIdentity,
    path: NormalizedAbsolutePath,
    parent_chain: OpenedDirectoryChain,
    parent_identities: Vec<ObjectIdentity>,
}

impl MissingDirectoryBinding {
    fn parent_is_current(
        &self,
        expected_path: &NormalizedAbsolutePath,
    ) -> Result<bool, WindowsStoreError> {
        self.process.verify().map_err(|_| WindowsStoreError::Lost)?;
        if self.path != *expected_path {
            return Ok(false);
        }
        let retained = self
            .parent_chain
            .ancestors
            .iter()
            .chain(std::iter::once(&self.parent_chain.leaf))
            .map(metadata)
            .collect::<Result<Vec<_>, _>>()?;
        if retained.len() != self.parent_identities.len()
            || retained.iter().any(|facts| {
                facts.kind != ObjectKind::Directory
                    || facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            })
            || !retained
                .iter()
                .map(|facts| facts.identity)
                .eq(self.parent_identities.iter().copied())
        {
            return Ok(false);
        }
        let reopened = match expected_path.open_parent() {
            Ok(chain) => chain,
            Err(
                WindowsStoreError::Missing | WindowsStoreError::Unsafe | WindowsStoreError::Lost,
            ) => return Ok(false),
            Err(error) => return Err(error),
        };
        let reopened = reopened
            .ancestors
            .iter()
            .chain(std::iter::once(&reopened.leaf))
            .map(metadata)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(reopened.len() == self.parent_identities.len()
            && reopened.iter().all(|facts| {
                facts.kind == ObjectKind::Directory
                    && facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
            })
            && reopened
                .iter()
                .map(|facts| facts.identity)
                .eq(self.parent_identities.iter().copied()))
    }

    fn target_is_missing(
        &self,
        expected_path: &NormalizedAbsolutePath,
    ) -> Result<bool, WindowsStoreError> {
        if !self.parent_is_current(expected_path)? {
            return Ok(false);
        }
        match open_object_nofollow(&expected_path.path) {
            Ok(_) => Ok(false),
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
                ) =>
            {
                Ok(true)
            }
            Err(_) => Err(WindowsStoreError::Unsafe),
        }
    }
}

pub(crate) fn observe_missing_private_directory(
    path: &Path,
) -> Result<Option<MissingDirectoryBinding>, WindowsStoreError> {
    let process = ProcessIdentity::capture().map_err(map_win)?;
    let path = NormalizedAbsolutePath::parse(path)?;
    let parent_chain = path.open_parent()?;
    let parent_identities = parent_chain
        .ancestors
        .iter()
        .chain(std::iter::once(&parent_chain.leaf))
        .map(metadata)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|facts| facts.identity)
        .collect::<Vec<_>>();
    let binding = MissingDirectoryBinding {
        process,
        path,
        parent_chain,
        parent_identities,
    };
    if binding.target_is_missing(&binding.path)? {
        Ok(Some(binding))
    } else {
        Ok(None)
    }
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

fn remove_exact_created_directory(
    binding: &MissingDirectoryBinding,
    path: &NormalizedAbsolutePath,
    expected: ObjectIdentity,
    pinned: Option<File>,
) -> Result<(), WindowsStoreError> {
    if let Some(pinned) = pinned {
        let facts = metadata(&pinned)?;
        let security = attest_security(
            pinned.as_handle(),
            &binding.process,
            SecurityKind::Directory,
        )
        .map_err(map_win)?;
        if facts.identity != expected
            || facts.kind != ObjectKind::Directory
            || facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || !security.owner_current
            || !security.exact_protected_dacl
            || !security.semantic_medium_label
        {
            return Err(WindowsStoreError::Lost);
        }
        drop(pinned);
    }
    let opened = open_directory_delete_nofollow(&path.path).map_err(|_| WindowsStoreError::Lost)?;
    let facts = metadata(&opened)?;
    let security = attest_security(
        opened.as_handle(),
        &binding.process,
        SecurityKind::Directory,
    )
    .map_err(map_win)?;
    if facts.identity != expected
        || facts.kind != ObjectKind::Directory
        || facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || !security.owner_current
        || !security.exact_protected_dacl
        || !security.semantic_medium_label
    {
        return Err(WindowsStoreError::Lost);
    }
    match remove_by_handle(opened.as_handle()).map_err(map_win)? {
        MutationAttempt::Applied => {}
        MutationAttempt::Conflict => return Err(WindowsStoreError::Lost),
        MutationAttempt::Unsupported => return Err(WindowsStoreError::Unsupported),
    }
    drop(opened);
    if binding.parent_is_current(path)? {
        match open_object_nofollow(&path.path) {
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
                ) =>
            {
                Ok(())
            }
            Ok(current) if metadata(&current)?.identity != expected => Ok(()),
            _ => Err(WindowsStoreError::Lost),
        }
    } else {
        Ok(())
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
                    zeroize_bytes(bytes.as_mut_slice());
                    return Err(error);
                }
            };
        if before != after
            || before_security != after_security
            || before_descriptor != after_descriptor
        {
            zeroize_bytes(bytes.as_mut_slice());
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
        zeroize_bytes(bytes.as_mut_slice());
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
                    zeroize_bytes(bytes.as_mut_slice());
                    return Err(error);
                }
            };
        if before != after
            || before_security != after_security
            || before_descriptor != after_descriptor
        {
            zeroize_bytes(bytes.as_mut_slice());
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
                zeroize_bytes(bytes.as_mut_slice());
                return Err(WindowsStoreError::Limit);
            }
        };
        let read = match file.seek_read(&mut bytes[offset..], position) {
            Ok(read) => read,
            Err(_) => {
                zeroize_bytes(bytes.as_mut_slice());
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
        zeroize_bytes(bytes.as_mut_slice());
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

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum LegacyCredentialReadResult {
    Missing,
    Unsafe,
    Malformed,
    Loaded(Vec<u8>),
    Oversized,
}

fn legacy_parent_chain_is_stable(
    path: &NormalizedAbsolutePath,
    retained: &OpenedDirectoryChain,
    identities: &[ObjectIdentity],
    process: &ProcessIdentity,
) -> Result<bool, WindowsStoreError> {
    process.verify().map_err(|_| WindowsStoreError::Lost)?;
    let retained_facts = retained
        .ancestors
        .iter()
        .chain(std::iter::once(&retained.leaf))
        .map(metadata)
        .collect::<Result<Vec<_>, _>>()?;
    if retained_facts.len() != identities.len()
        || retained_facts.iter().any(|facts| {
            facts.kind != ObjectKind::Directory
                || facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        })
        || !retained_facts
            .iter()
            .map(|facts| facts.identity)
            .eq(identities.iter().copied())
    {
        return Ok(false);
    }
    // Walk outward from the direct parent. An exact protected current-user directory is a complete
    // authority anchor, so broader host-managed ancestors above it need only remain pinned by their
    // retained no-delete handles. Without such an anchor, every named component must pass the
    // explicit owner/DACL namespace-control predicate. The fixed local NTFS drive root is the
    // volume anchor and cannot itself be renamed.
    let named_directories = retained
        .ancestors
        .iter()
        .chain(std::iter::once(&retained.leaf))
        .skip(1)
        .collect::<Vec<_>>();
    for directory in named_directories.into_iter().rev() {
        let security = attest_security(directory.as_handle(), process, SecurityKind::Directory)
            .map_err(map_win)?;
        if security.owner_current && security.exact_protected_dacl && security.semantic_medium_label
        {
            break;
        }
        if !attest_no_untrusted_namespace_control(directory.as_handle(), process)
            .map_err(map_win)?
        {
            return Ok(false);
        }
    }

    let reopened = match path.open_parent() {
        Ok(reopened) => reopened,
        Err(WindowsStoreError::Missing | WindowsStoreError::Unsafe | WindowsStoreError::Lost) => {
            return Ok(false)
        }
        Err(error) => return Err(error),
    };
    let reopened_facts = reopened
        .ancestors
        .iter()
        .chain(std::iter::once(&reopened.leaf))
        .map(metadata)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(reopened_facts.len() == identities.len()
        && reopened_facts.iter().all(|facts| {
            facts.kind == ObjectKind::Directory
                && facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
        })
        && reopened_facts
            .iter()
            .map(|facts| facts.identity)
            .eq(identities.iter().copied()))
}

pub(crate) fn read_allowlisted_legacy_credential(
    path: &Path,
    expected_leaf: &OsStr,
    max_bytes: usize,
) -> Result<LegacyCredentialReadResult, WindowsStoreError> {
    if max_bytes >= MAX_ATTESTED_BYTES {
        return Err(WindowsStoreError::Limit);
    }
    if !is_single_entry_name(expected_leaf) {
        return Err(WindowsStoreError::InvalidInput);
    }
    let path = NormalizedAbsolutePath::parse(path)?;
    if path.path.file_name() != Some(expected_leaf) {
        return Ok(LegacyCredentialReadResult::Unsafe);
    }
    let process = ProcessIdentity::capture().map_err(map_win)?;
    let parent = match path.open_parent() {
        Ok(parent) => parent,
        Err(WindowsStoreError::Missing) => return Ok(LegacyCredentialReadResult::Missing),
        Err(error) => return Err(error),
    };
    let parent_facts = parent
        .ancestors
        .iter()
        .chain(std::iter::once(&parent.leaf))
        .map(metadata)
        .collect::<Result<Vec<_>, _>>()?;
    let parent_identities = parent_facts
        .iter()
        .map(|facts| facts.identity)
        .collect::<Vec<_>>();
    if !legacy_parent_chain_is_stable(&path, &parent, &parent_identities, &process)? {
        return Ok(LegacyCredentialReadResult::Unsafe);
    }
    let direct_parent = parent_facts
        .last()
        .ok_or(WindowsStoreError::InvalidInput)?
        .identity;

    let file = match open_legacy_file_nofollow(&path.path) {
        Ok(file) => file,
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
            ) =>
        {
            return Ok(LegacyCredentialReadResult::Missing);
        }
        Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION) => {
            return Ok(LegacyCredentialReadResult::Unsafe);
        }
        Err(_) => return Err(WindowsStoreError::Io),
    };
    let before = metadata(&file)?;
    let before_security =
        attest_security(file.as_handle(), &process, SecurityKind::File).map_err(map_win)?;
    if !before.exact_file()
        || before.identity.volume != direct_parent.volume
        || !before_security.owner_current
        || !before_security.exact_protected_dacl
        || !before_security.semantic_medium_label
    {
        return Ok(LegacyCredentialReadResult::Unsafe);
    }
    let rebound = match open_legacy_file_nofollow(&path.path) {
        Ok(rebound) => rebound,
        Err(_) => return Ok(LegacyCredentialReadResult::Unsafe),
    };
    if metadata(&rebound)?.identity != before.identity {
        return Ok(LegacyCredentialReadResult::Unsafe);
    }

    let read_limit = max_bytes.checked_add(1).ok_or(WindowsStoreError::Limit)?;
    let mut bytes = read_up_to_at(&file, read_limit)?;
    let post_read = (|| {
        let after = metadata(&file)?;
        let after_security =
            attest_security(file.as_handle(), &process, SecurityKind::File).map_err(map_win)?;
        let stable = before == after
            && before_security == after_security
            && metadata(&rebound)?.identity == before.identity
            && legacy_parent_chain_is_stable(&path, &parent, &parent_identities, &process)?;
        Ok((after, stable))
    })();
    let (after, stable) = match post_read {
        Ok(value) => value,
        Err(error) => {
            zeroize_bytes(bytes.as_mut_slice());
            return Err(error);
        }
    };
    if !stable {
        zeroize_bytes(bytes.as_mut_slice());
        return Ok(LegacyCredentialReadResult::Unsafe);
    }
    let end_of_file = u64::try_from(bytes.len()).ok() == Some(after.size);
    if bytes.len() > max_bytes || !end_of_file {
        zeroize_bytes(bytes.as_mut_slice());
        return Ok(LegacyCredentialReadResult::Oversized);
    }
    if bytes.is_empty() {
        return Ok(LegacyCredentialReadResult::Malformed);
    }
    Ok(LegacyCredentialReadResult::Loaded(bytes))
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

pub(crate) enum ObservedDirectoryExpectation<'a> {
    Missing(&'a MissingDirectoryBinding),
    Present,
}

pub(crate) enum ObservedSetupLeaseAcquireResult {
    Busy,
    PreconditionFailed,
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
    let facts = metadata(file)?;
    if !secure_setup_lock_object(directory, file, facts)? {
        return Ok(false);
    }
    let current_path = directory.core.path.path.join(SETUP_LOCK_ENTRY);
    Ok(open_file_nofollow(&current_path, true, false, true)
        .ok()
        .and_then(|current| metadata(&current).ok())
        .is_some_and(|current| current.identity == facts.identity && current.exact_file()))
}

fn secure_setup_lock_object(
    directory: &WindowsPrivateDirectory,
    file: &File,
    facts: MetadataFacts,
) -> Result<bool, WindowsStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
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
    Ok(true)
}

fn open_or_create_setup_lock(
    directory: &WindowsPrivateDirectory,
) -> Result<(File, Option<ObjectIdentity>), WindowsStoreError> {
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
    let created_identity = if created {
        Some(metadata(&file)?.identity)
    } else {
        None
    };
    Ok((file, created_identity))
}

struct CreatedDirectoryRollback<'a> {
    binding: &'a MissingDirectoryBinding,
    path: NormalizedAbsolutePath,
    identity: ObjectIdentity,
}

struct PreparedPrivateDirectory<'a> {
    ensured: EnsuredPrivateDirectory,
    rollback: Option<CreatedDirectoryRollback<'a>>,
}

enum DirectoryPreparation<'a> {
    PreconditionFailed,
    Ready(PreparedPrivateDirectory<'a>),
}

fn prepare_missing_directory<'a>(
    path: &Path,
    binding: &'a MissingDirectoryBinding,
) -> Result<DirectoryPreparation<'a>, WindowsStoreError> {
    let path = NormalizedAbsolutePath::parse(path)?;
    if !binding.target_is_missing(&path)? {
        return Ok(DirectoryPreparation::PreconditionFailed);
    }
    match create_private_directory(&path.path, &binding.process).map_err(map_win)? {
        DirectoryCreateAttempt::Conflict => return Ok(DirectoryPreparation::PreconditionFailed),
        DirectoryCreateAttempt::Created => {}
    }

    let created =
        open_directory_nofollow(&path.path, false).map_err(|_| WindowsStoreError::Lost)?;
    let facts = metadata(&created)?;
    let security = attest_security(
        created.as_handle(),
        &binding.process,
        SecurityKind::Directory,
    )
    .map_err(map_win)?;
    if facts.kind != ObjectKind::Directory
        || facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || !security.owner_current
        || !security.exact_protected_dacl
        || !security.semantic_medium_label
    {
        remove_exact_created_directory(binding, &path, facts.identity, Some(created))?;
        return Err(WindowsStoreError::Unsafe);
    }
    if !binding.parent_is_current(&path)? {
        remove_exact_created_directory(binding, &path, facts.identity, Some(created))?;
        return Ok(DirectoryPreparation::PreconditionFailed);
    }

    let parent = match path.open_parent() {
        Ok(parent) => parent,
        Err(error) => {
            remove_exact_created_directory(binding, &path, facts.identity, Some(created))?;
            return Err(error);
        }
    };
    let directory = directory_from_parts(binding.process.clone(), path.clone(), parent, created);
    let secure = lock_unpoisoned(&directory.core.state)
        .and_then(|state| directory.core.require_secure_locked(&state));
    if let Err(error) = secure {
        drop(directory);
        remove_exact_created_directory(binding, &path, facts.identity, None)?;
        return Err(error);
    }
    if !binding.parent_is_current(&path)? {
        drop(directory);
        remove_exact_created_directory(binding, &path, facts.identity, None)?;
        return Ok(DirectoryPreparation::PreconditionFailed);
    }
    Ok(DirectoryPreparation::Ready(PreparedPrivateDirectory {
        ensured: EnsuredPrivateDirectory {
            disposition: DirectoryDisposition::Created,
            directory,
        },
        rollback: Some(CreatedDirectoryRollback {
            binding,
            path,
            identity: facts.identity,
        }),
    }))
}

fn prepare_observed_directory<'a>(
    path: &Path,
    expectation: ObservedDirectoryExpectation<'a>,
) -> Result<DirectoryPreparation<'a>, WindowsStoreError> {
    match expectation {
        ObservedDirectoryExpectation::Missing(binding) => prepare_missing_directory(path, binding),
        ObservedDirectoryExpectation::Present => match open_private_directory(path)? {
            PrivateDirectoryOpenResult::Missing => Ok(DirectoryPreparation::PreconditionFailed),
            PrivateDirectoryOpenResult::Opened(directory) => {
                Ok(DirectoryPreparation::Ready(PreparedPrivateDirectory {
                    ensured: EnsuredPrivateDirectory {
                        disposition: DirectoryDisposition::Existing,
                        directory,
                    },
                    rollback: None,
                }))
            }
        },
    }
}

fn release_uncommitted_setup_lock(lock: File) -> Result<(), WindowsStoreError> {
    let unlocked = unlock(lock.as_handle()).map_err(map_win);
    drop(lock);
    unlocked
}

fn cleanup_exact_created_setup_lock(
    directory: &WindowsPrivateDirectory,
    lock: File,
    expected: ObjectIdentity,
    locked: bool,
) -> Result<(), WindowsStoreError> {
    if metadata(&lock)?.identity != expected || !exact_setup_lock(directory, &lock)? {
        drop(lock);
        return Err(WindowsStoreError::Lost);
    }
    if locked {
        release_uncommitted_setup_lock(lock)?;
    } else {
        drop(lock);
    }

    let path = directory.core.path.path.join(SETUP_LOCK_ENTRY);
    let reopened = match open_file_nofollow(&path, true, true, true) {
        Ok(file) => file,
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
            ) =>
        {
            return Ok(());
        }
        Err(_) => return Err(WindowsStoreError::Lost),
    };
    let reopened_facts = metadata(&reopened)?;
    if reopened_facts.identity != expected
        || !secure_setup_lock_object(directory, &reopened, reopened_facts)?
    {
        return Err(WindowsStoreError::Lost);
    }
    match remove_by_handle(reopened.as_handle()).map_err(map_win)? {
        MutationAttempt::Applied => {}
        MutationAttempt::Conflict => return Err(WindowsStoreError::Lost),
        MutationAttempt::Unsupported => return Err(WindowsStoreError::Unsupported),
    }
    drop(reopened);
    // Windows exposes no documented general directory-handle flush. The synchronous by-handle
    // disposition plus retained-directory and exact path re-attestation is the supported
    // completed-operation/process-crash barrier; this makes no physical power-loss claim.
    {
        let state = lock_unpoisoned(&directory.core.state)?;
        directory.core.require_secure_locked(&state)?;
    }
    match open_object_nofollow(&path) {
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
            ) =>
        {
            Ok(())
        }
        _ => Err(WindowsStoreError::Lost),
    }
}

fn acquire_prepared_setup_lease<F>(
    prepared: EnsuredPrivateDirectory,
    nonce: ValidatedUuidV4,
    validate: F,
) -> Result<ObservedSetupLeaseAcquireResult, WindowsStoreError>
where
    F: FnOnce(&WindowsPrivateDirectory) -> Result<bool, WindowsStoreError>,
{
    let directory_disposition = prepared.disposition;
    let directory = prepared.directory;
    let (lock, created_identity) = match open_or_create_setup_lock(&directory) {
        Ok(value) => value,
        Err(WindowsStoreError::Unsafe | WindowsStoreError::Lost) => {
            return Ok(ObservedSetupLeaseAcquireResult::Busy);
        }
        Err(error) => return Err(error),
    };
    match try_lock_exclusive(lock.as_handle()).map_err(map_win)? {
        LockAttempt::Acquired => {}
        LockAttempt::Busy => return Ok(ObservedSetupLeaseAcquireResult::Busy),
    }
    if !exact_setup_lock(&directory, &lock)? {
        if let Some(identity) = created_identity {
            cleanup_exact_created_setup_lock(&directory, lock, identity, true)?;
            return Err(WindowsStoreError::Lost);
        }
        release_uncommitted_setup_lock(lock)?;
        return Ok(ObservedSetupLeaseAcquireResult::Busy);
    }

    let validation = validate(&directory);
    if !matches!(validation, Ok(true)) {
        let cleanup = match created_identity {
            Some(identity) => cleanup_exact_created_setup_lock(&directory, lock, identity, true),
            None => release_uncommitted_setup_lock(lock),
        };
        cleanup?;
        return match validation {
            Ok(false) => Ok(ObservedSetupLeaseAcquireResult::PreconditionFailed),
            Ok(true) => unreachable!("true validation returned through mismatch branch"),
            Err(error) => Err(error),
        };
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
        Err(WindowsStoreError::Unsafe) => {
            if let Some(identity) = created_identity {
                cleanup_exact_created_setup_lock(&directory, lock, identity, true)?;
                return Err(WindowsStoreError::Lost);
            }
            release_uncommitted_setup_lock(lock)?;
            return Ok(ObservedSetupLeaseAcquireResult::Busy);
        }
        Err(error) => {
            let _ = release_uncommitted_setup_lock(lock);
            return Err(error);
        }
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
    Ok(ObservedSetupLeaseAcquireResult::Acquired {
        prior,
        directory: directory_disposition,
        lease,
    })
}

fn cleanup_observed_attempt(
    directory: &mut WindowsPrivateDirectory,
    lock: Option<(File, Option<ObjectIdentity>, bool)>,
    rollback: Option<&CreatedDirectoryRollback<'_>>,
) -> Result<(), WindowsStoreError> {
    if let Some((lock, created_identity, locked)) = lock {
        if let Some(identity) = created_identity {
            cleanup_exact_created_setup_lock(directory, lock, identity, locked)?;
        } else if locked {
            release_uncommitted_setup_lock(lock)?;
        } else {
            drop(lock);
        }
    }
    if let Some(rollback) = rollback {
        let attestation = directory.attest()?;
        if attestation.identity != rollback.identity || !attestation.is_secure() {
            return Err(WindowsStoreError::Lost);
        }
        directory.close();
        remove_exact_created_directory(rollback.binding, &rollback.path, rollback.identity, None)?;
    }
    Ok(())
}

pub(crate) fn acquire_observed_setup_lease<F>(
    path: &Path,
    nonce: &str,
    expectation: ObservedDirectoryExpectation<'_>,
    validate: F,
) -> Result<ObservedSetupLeaseAcquireResult, WindowsStoreError>
where
    F: FnOnce(&WindowsPrivateDirectory) -> Result<bool, WindowsStoreError>,
{
    let nonce = ValidatedUuidV4::parse(nonce)?;
    let prepared = match prepare_observed_directory(path, expectation)? {
        DirectoryPreparation::PreconditionFailed => {
            return Ok(ObservedSetupLeaseAcquireResult::PreconditionFailed);
        }
        DirectoryPreparation::Ready(prepared) => prepared,
    };
    let PreparedPrivateDirectory { ensured, rollback } = prepared;
    let directory_disposition = ensured.disposition;
    let mut directory = ensured.directory;

    #[cfg(test)]
    if take_observed_acquire_fault(TEST_OBSERVED_ACQUIRE_BUSY_AFTER_PREPARE) {
        cleanup_observed_attempt(&mut directory, None, rollback.as_ref())?;
        return Ok(ObservedSetupLeaseAcquireResult::Busy);
    }

    let (lock, created_identity) = match open_or_create_setup_lock(&directory) {
        Ok(value) => value,
        Err(WindowsStoreError::Unsafe | WindowsStoreError::Lost) => {
            cleanup_observed_attempt(&mut directory, None, rollback.as_ref())?;
            return Ok(ObservedSetupLeaseAcquireResult::Busy);
        }
        Err(error) => {
            cleanup_observed_attempt(&mut directory, None, rollback.as_ref())?;
            return Err(error);
        }
    };

    match try_lock_exclusive(lock.as_handle()).map_err(map_win) {
        Ok(LockAttempt::Acquired) => {}
        Ok(LockAttempt::Busy) => {
            cleanup_observed_attempt(
                &mut directory,
                Some((lock, created_identity, false)),
                rollback.as_ref(),
            )?;
            return Ok(ObservedSetupLeaseAcquireResult::Busy);
        }
        Err(error) => {
            cleanup_observed_attempt(
                &mut directory,
                Some((lock, created_identity, false)),
                rollback.as_ref(),
            )?;
            return Err(error);
        }
    }
    match exact_setup_lock(&directory, &lock) {
        Ok(true) => {}
        Ok(false) | Err(WindowsStoreError::Unsafe | WindowsStoreError::Lost) => {
            cleanup_observed_attempt(
                &mut directory,
                Some((lock, created_identity, true)),
                rollback.as_ref(),
            )?;
            return Ok(ObservedSetupLeaseAcquireResult::Busy);
        }
        Err(error) => {
            cleanup_observed_attempt(
                &mut directory,
                Some((lock, created_identity, true)),
                rollback.as_ref(),
            )?;
            return Err(error);
        }
    }

    match validate(&directory) {
        Ok(true) => {}
        Ok(false) => {
            cleanup_observed_attempt(
                &mut directory,
                Some((lock, created_identity, true)),
                rollback.as_ref(),
            )?;
            return Ok(ObservedSetupLeaseAcquireResult::PreconditionFailed);
        }
        Err(error) => {
            cleanup_observed_attempt(
                &mut directory,
                Some((lock, created_identity, true)),
                rollback.as_ref(),
            )?;
            return Err(error);
        }
    }

    let prior = match read_lock_record(&lock) {
        Ok(LockRecordState::Uninitialized) => {
            if let Err(error) = initialize_clean_lock_record(&lock) {
                cleanup_observed_attempt(
                    &mut directory,
                    Some((lock, created_identity, true)),
                    rollback.as_ref(),
                )?;
                return Err(error);
            }
            PriorLease::Absent
        }
        Ok(LockRecordState::Clean) => PriorLease::Absent,
        Ok(LockRecordState::Held(_)) => {
            if let Err(error) = write_lock_state(&lock, LOCK_STATE_CLEAN) {
                cleanup_observed_attempt(
                    &mut directory,
                    Some((lock, created_identity, true)),
                    rollback.as_ref(),
                )?;
                return Err(error);
            }
            PriorLease::ProvenAbandoned
        }
        Err(WindowsStoreError::Unsafe) => {
            cleanup_observed_attempt(
                &mut directory,
                Some((lock, created_identity, true)),
                rollback.as_ref(),
            )?;
            return Ok(ObservedSetupLeaseAcquireResult::Busy);
        }
        Err(error) => {
            cleanup_observed_attempt(
                &mut directory,
                Some((lock, created_identity, true)),
                rollback.as_ref(),
            )?;
            return Err(error);
        }
    };
    if let Err(error) = write_held_lock_record(&lock, nonce) {
        cleanup_observed_attempt(
            &mut directory,
            Some((lock, created_identity, true)),
            rollback.as_ref(),
        )?;
        return Err(error);
    }
    match exact_setup_lock(&directory, &lock) {
        Ok(true) => {}
        Ok(false) => {
            cleanup_observed_attempt(
                &mut directory,
                Some((lock, created_identity, true)),
                rollback.as_ref(),
            )?;
            return Err(WindowsStoreError::Lost);
        }
        Err(error) => {
            cleanup_observed_attempt(
                &mut directory,
                Some((lock, created_identity, true)),
                rollback.as_ref(),
            )?;
            return Err(error);
        }
    }
    match read_lock_record(&lock) {
        Ok(LockRecordState::Held(value)) if value == nonce => {}
        Ok(_) => {
            cleanup_observed_attempt(
                &mut directory,
                Some((lock, created_identity, true)),
                rollback.as_ref(),
            )?;
            return Err(WindowsStoreError::Lost);
        }
        Err(error) => {
            cleanup_observed_attempt(
                &mut directory,
                Some((lock, created_identity, true)),
                rollback.as_ref(),
            )?;
            return Err(error);
        }
    }

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
    Ok(ObservedSetupLeaseAcquireResult::Acquired {
        prior,
        directory: directory_disposition,
        lease,
    })
}

pub(crate) fn acquire_setup_lease(
    path: &Path,
    nonce: &str,
) -> Result<SetupLeaseAcquireResult, WindowsStoreError> {
    let nonce = ValidatedUuidV4::parse(nonce)?;
    match acquire_prepared_setup_lease(ensure_private_directory(path)?, nonce, |_| Ok(true))? {
        ObservedSetupLeaseAcquireResult::Busy => Ok(SetupLeaseAcquireResult::Busy),
        ObservedSetupLeaseAcquireResult::PreconditionFailed => Err(WindowsStoreError::Lost),
        ObservedSetupLeaseAcquireResult::Acquired {
            prior,
            directory,
            lease,
        } => Ok(SetupLeaseAcquireResult::Acquired {
            prior,
            directory,
            lease,
        }),
    }
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
    use std::collections::HashSet;
    use std::env;
    use std::fs;
    use std::io::Write;
    use std::os::windows::ffi::OsStrExt;
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
    const MAX_TEST_CLEANUP_ENTRIES: usize = 8_192;
    const MAX_TEST_CLEANUP_DEPTH: usize = 16;
    const MAX_TEST_CLEANUP_BYTES: u64 = 64 * 1_024 * 1_024;
    static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(1);
    static NEXT_QUARANTINE: AtomicU64 = AtomicU64::new(1);
    static TEST_PROCESS_MEDIUM: OnceLock<()> = OnceLock::new();

    #[derive(Clone, Debug, Eq, PartialEq)]
    struct CleanupObjectEvidence {
        identity: ObjectIdentity,
        kind: ObjectKind,
        attributes: u32,
        links: u64,
        size: Option<u64>,
        security: plurum_windows_syscall::SecurityAttestation,
    }

    impl CleanupObjectEvidence {
        fn capture(
            file: &File,
            process: &ProcessIdentity,
            kind: ObjectKind,
        ) -> Result<Self, CleanupRefusal> {
            let facts = metadata(file).map_err(|_| CleanupRefusal::Unsafe)?;
            let security = attest_security(
                file.as_handle(),
                process,
                match kind {
                    ObjectKind::Directory => SecurityKind::Directory,
                    ObjectKind::RegularFile => SecurityKind::File,
                    ObjectKind::Other => return Err(CleanupRefusal::Unsafe),
                },
            )
            .map_err(|_| CleanupRefusal::Unsafe)?;
            if facts.kind != kind
                || facts.links == 0
                || (kind == ObjectKind::RegularFile && facts.links != 1)
                || facts.delete_pending
                || facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || !security.owner_current
                || !security.exact_protected_dacl
                || !security.semantic_medium_label
            {
                return Err(CleanupRefusal::Unsafe);
            }
            Ok(Self {
                identity: facts.identity,
                kind: facts.kind,
                attributes: facts.attributes,
                links: facts.links,
                size: (kind == ObjectKind::RegularFile).then_some(facts.size),
                security,
            })
        }

        fn matches(&self, file: &File, process: &ProcessIdentity) -> Result<bool, CleanupRefusal> {
            let current = Self::capture(file, process, self.kind)?;
            Ok(current == *self)
        }
    }

    struct CleanupEvidence {
        process: ProcessIdentity,
        drive_root: [u16; 4],
        temporary: CleanupObjectEvidence,
        temporary_volume: plurum_windows_syscall::VolumeAttestation,
        root: CleanupObjectEvidence,
        marker: CleanupObjectEvidence,
    }

    #[derive(Clone, Copy)]
    struct CleanupLimits {
        entries: usize,
        depth: usize,
        bytes: u64,
    }

    impl CleanupLimits {
        const STANDARD: Self = Self {
            entries: MAX_TEST_CLEANUP_ENTRIES,
            depth: MAX_TEST_CLEANUP_DEPTH,
            bytes: MAX_TEST_CLEANUP_BYTES,
        };
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum CleanupRefusal {
        Unsafe,
        Limit,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    struct CleanupNode {
        name: OsString,
        object: CleanupObjectEvidence,
        children: Vec<CleanupNode>,
    }

    struct CleanupTraversal {
        limits: CleanupLimits,
        entries: usize,
        bytes: u64,
        root_volume: u64,
        identities: HashSet<(u64, [u8; 16])>,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    struct CleanupPlan {
        root: CleanupNode,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum CleanupFault {
        None,
        AfterQuarantine,
        AfterFirstChildRemoval,
        AfterRootRemoval,
    }

    struct CleanupFaultState {
        fault: CleanupFault,
        removed_children: usize,
    }

    pub(super) struct TestRoot {
        pub(super) root: PathBuf,
        pub(super) temporary: PathBuf,
        pub(super) store: PathBuf,
        pub(super) marker: PathBuf,
        cleanup: CleanupEvidence,
        cleaned: bool,
    }

    fn open_test_security_directory(path: &Path) -> std::io::Result<File> {
        OpenOptions::new()
            .read(true)
            .access_mode(GENERIC_READ | READ_CONTROL | WRITE_DAC | WRITE_OWNER)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
    }

    pub(super) fn verified_test_isolation() -> PathBuf {
        let configured = PathBuf::from(
            env::var("PLURUM_NATIVE_ISOLATION_ROOT")
                .expect("native tests require the isolated runner root"),
        );
        let configured_path = NormalizedAbsolutePath::parse(&configured)
            .expect("isolation root must be a canonical local drive path");
        assert_eq!(
            configured.file_name(),
            Some(OsStr::new("plurum-native-isolation")),
            "isolation root must use the exact sentinel directory name"
        );
        let configured_chain = configured_path
            .open_complete()
            .expect("isolation root must open through one retained no-follow chain");
        let configured_facts =
            metadata(&configured_chain.leaf).expect("isolation root metadata must attest");
        assert_eq!(configured_facts.kind, ObjectKind::Directory);
        assert_eq!(
            configured_facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT,
            0,
            "isolation root must not be a reparse point"
        );

        let marker = configured.join(".plurum-native-isolation");
        let marker_handle = open_file_nofollow(&marker, false, false, true)
            .expect("isolation marker must open without following reparses");
        let marker_facts = metadata(&marker_handle).expect("isolation marker metadata must attest");
        assert_eq!(marker_facts.kind, ObjectKind::RegularFile);
        assert_eq!(marker_facts.links, 1);
        assert_eq!(marker_facts.size, ISOLATION_MARKER.len() as u64);
        assert_eq!(marker_facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT, 0);
        assert_eq!(
            read_exact_at(&marker_handle, ISOLATION_MARKER.len())
                .expect("isolation marker must be readable"),
            ISOLATION_MARKER.as_bytes()
        );

        let temporary = configured.join("tmp");
        let temporary_path = NormalizedAbsolutePath::parse(&temporary)
            .expect("isolated temporary root must be canonical");
        let temporary_chain = temporary_path
            .open_complete()
            .expect("isolated temporary root must open through one retained no-follow chain");
        let temporary_facts =
            metadata(&temporary_chain.leaf).expect("temporary root metadata must attest");
        assert_eq!(temporary_facts.kind, ObjectKind::Directory);
        assert_eq!(temporary_facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT, 0);
        assert_eq!(
            temporary_facts.identity.volume, configured_facts.identity.volume,
            "isolation and temporary roots must share one native volume"
        );

        let configured_security = open_test_security_directory(&configured)
            .expect("isolation root security handle must open");
        let temporary_security = open_test_security_directory(&temporary)
            .expect("temporary root security handle must open");
        assert_eq!(
            metadata(&configured_security)
                .expect("isolation security handle must attest")
                .identity,
            configured_facts.identity
        );
        assert_eq!(
            metadata(&temporary_security)
                .expect("temporary security handle must attest")
                .identity,
            temporary_facts.identity
        );

        TEST_PROCESS_MEDIUM.get_or_init(|| {
            plurum_windows_syscall::lower_process_integrity_to_medium_for_tests()
                .expect("isolated Windows tests must run at exact medium integrity");
            let process =
                ProcessIdentity::capture().expect("test process identity must be unimpersonated");
            assert!(
                attest_security(
                    configured_security.as_handle(),
                    &process,
                    SecurityKind::Directory,
                )
                .expect("isolation root owner must attest")
                .owner_current,
                "isolation root must be owned by the current test user"
            );
            assert!(
                attest_security(
                    temporary_security.as_handle(),
                    &process,
                    SecurityKind::Directory,
                )
                .expect("temporary root owner must attest")
                .owner_current,
                "temporary root must be owned by the current test user"
            );
            assert!(
                attest_security(marker_handle.as_handle(), &process, SecurityKind::File)
                    .expect("isolation marker owner must attest")
                    .owner_current,
                "isolation marker must be owned by the current test user"
            );
            plurum_windows_syscall::prepare_medium_integrity_test_directory_handle(
                configured_security.as_handle(),
            )
            .expect("isolated Windows test root must have medium integrity");
            plurum_windows_syscall::prepare_medium_integrity_test_directory_handle(
                temporary_security.as_handle(),
            )
            .expect("isolated Windows temporary root must have medium integrity");
            plurum_windows_syscall::set_private_current_user_dacl_for_tests_handle(
                temporary_security.as_handle(),
                SecurityKind::Directory,
            )
            .expect("isolated Windows temporary root must have an exact private DACL");
        });
        let process =
            ProcessIdentity::capture().expect("test process identity must remain unimpersonated");
        let configured_security_state = attest_security(
            configured_security.as_handle(),
            &process,
            SecurityKind::Directory,
        )
        .expect("isolation root security must re-attest");
        assert!(
            configured_security_state.owner_current
                && configured_security_state.semantic_medium_label,
            "isolation root must remain current-user owned at medium integrity"
        );
        let temporary_security_state = attest_security(
            temporary_security.as_handle(),
            &process,
            SecurityKind::Directory,
        )
        .expect("temporary root security must re-attest");
        assert!(
            temporary_security_state.owner_current
                && temporary_security_state.exact_protected_dacl
                && temporary_security_state.semantic_medium_label,
            "temporary root must retain its exact protected user-only security"
        );
        assert!(
            attest_security(marker_handle.as_handle(), &process, SecurityKind::File)
                .expect("isolation marker security must re-attest")
                .owner_current,
            "isolation marker must remain owned by the current test user"
        );
        assert_eq!(
            metadata(&configured_chain.leaf)
                .expect("isolation root must remain bound")
                .identity,
            configured_facts.identity
        );
        assert_eq!(
            metadata(&temporary_chain.leaf)
                .expect("temporary root must remain bound")
                .identity,
            temporary_facts.identity
        );
        assert_eq!(
            read_exact_at(&marker_handle, ISOLATION_MARKER.len())
                .expect("isolation marker must remain readable"),
            ISOLATION_MARKER.as_bytes()
        );
        assert_eq!(
            metadata(&marker_handle).expect("isolation marker must remain stable"),
            marker_facts
        );
        temporary
    }

    impl TestRoot {
        pub(super) fn new() -> Self {
            let temporary = verified_test_isolation();
            let process = ProcessIdentity::capture().expect("test process identity must be safe");
            let normalized_temporary = NormalizedAbsolutePath::parse(&temporary)
                .expect("isolated temporary root must be canonical");
            let temporary_chain = normalized_temporary
                .open_complete()
                .expect("isolated temporary root chain must open without following reparses");
            let temporary_handle = &temporary_chain.leaf;
            let temporary_evidence =
                CleanupObjectEvidence::capture(temporary_handle, &process, ObjectKind::Directory)
                    .expect("isolated temporary root must have exact cleanup security");
            let drive_root = [
                u16::from(normalized_temporary.drive),
                b':' as u16,
                b'\\' as u16,
                0,
            ];
            let temporary_volume = attest_local_ntfs(temporary_handle.as_handle(), &drive_root)
                .expect("isolated temporary root volume must attest");
            assert!(
                temporary_volume.fixed_drive
                    && temporary_volume.ntfs
                    && temporary_volume.persistent_acls
                    && temporary_volume.direct_volume_mapping,
                "isolated temporary root must be on a local fixed NTFS volume"
            );

            let sequence = NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed);
            let root = temporary.join(format!("plurum-windows-{}-{sequence}", std::process::id()));
            let ensured = ensure_private_directory(&root).expect("test root must be secured");
            assert_eq!(ensured.disposition, DirectoryDisposition::Created);
            let ensured_attestation = ensured
                .directory
                .attest()
                .expect("new test root must remain bound and secure");
            assert_eq!(
                ensured_attestation.identity.volume, temporary_evidence.identity.volume,
                "test root and isolated temporary root must share one native volume"
            );

            let marker = root.join(".plurum-windows-native-test");
            let mut marker_origin = match create_private_file(
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
            marker_origin
                .write_all(TEST_MARKER.as_bytes())
                .expect("test marker must be written");
            flush_file(marker_origin.as_handle()).expect("test marker must be flushed");
            let marker_evidence =
                CleanupObjectEvidence::capture(&marker_origin, &process, ObjectKind::RegularFile)
                    .expect("original test marker cleanup evidence must be safe");
            assert_eq!(marker_evidence.size, Some(TEST_MARKER.len() as u64));
            assert_eq!(
                read_exact_at(&marker_origin, TEST_MARKER.len())
                    .expect("original test marker must be readable"),
                TEST_MARKER.as_bytes()
            );

            let root_handle = open_directory_nofollow(&root, false)
                .expect("test root must open without following reparses");
            let root_evidence =
                CleanupObjectEvidence::capture(&root_handle, &process, ObjectKind::Directory)
                    .expect("test root cleanup evidence must be safe");
            assert_eq!(
                root_evidence.identity, ensured_attestation.identity,
                "reopened test root must match the retained created root"
            );
            let marker_handle = open_file_nofollow(&marker, false, false, true)
                .expect("test marker must open without following reparses");
            assert!(
                marker_evidence
                    .matches(&marker_handle, &process)
                    .expect("reopened marker evidence must be comparable"),
                "reopened marker must match the retained created marker"
            );
            assert_eq!(
                read_exact_at(&marker_handle, TEST_MARKER.len())
                    .expect("test marker evidence must be readable"),
                TEST_MARKER.as_bytes()
            );
            assert_eq!(
                metadata(&marker_handle)
                    .expect("test marker evidence must remain stable")
                    .size,
                TEST_MARKER.len() as u64
            );
            let store = root.join("Plurum");
            Self {
                root,
                temporary,
                store,
                marker,
                cleanup: CleanupEvidence {
                    process,
                    drive_root,
                    temporary: temporary_evidence,
                    temporary_volume,
                    root: root_evidence,
                    marker: marker_evidence,
                },
                cleaned: false,
            }
        }

        fn cleanup_plan(&self, limits: CleanupLimits) -> Result<CleanupPlan, CleanupRefusal> {
            if self.root.parent() != Some(self.temporary.as_path())
                || self.marker != self.root.join(".plurum-windows-native-test")
                || self.store != self.root.join("Plurum")
            {
                return Err(CleanupRefusal::Unsafe);
            }
            let temporary_chain = NormalizedAbsolutePath::parse(&self.temporary)
                .and_then(|path| path.open_complete())
                .map_err(|_| CleanupRefusal::Unsafe)?;
            let root_parent_chain = NormalizedAbsolutePath::parse(&self.root)
                .and_then(|path| path.open_parent())
                .map_err(|_| CleanupRefusal::Unsafe)?;

            let temporary_handle = &temporary_chain.leaf;
            if !self
                .cleanup
                .temporary
                .matches(temporary_handle, &self.cleanup.process)?
                || !self
                    .cleanup
                    .temporary
                    .matches(&root_parent_chain.leaf, &self.cleanup.process)?
                || attest_local_ntfs(temporary_handle.as_handle(), &self.cleanup.drive_root)
                    .map_err(|_| CleanupRefusal::Unsafe)?
                    != self.cleanup.temporary_volume
            {
                return Err(CleanupRefusal::Unsafe);
            }

            let root_handle =
                open_cleanup_directory(&self.root).map_err(|_| CleanupRefusal::Unsafe)?;
            if !self
                .cleanup
                .root
                .matches(&root_handle, &self.cleanup.process)?
            {
                return Err(CleanupRefusal::Unsafe);
            }
            let marker_handle = open_file_nofollow(&self.marker, false, false, true)
                .map_err(|_| CleanupRefusal::Unsafe)?;
            if !self
                .cleanup
                .marker
                .matches(&marker_handle, &self.cleanup.process)?
                || metadata(&marker_handle)
                    .map_err(|_| CleanupRefusal::Unsafe)?
                    .size
                    != TEST_MARKER.len() as u64
                || read_exact_at(&marker_handle, TEST_MARKER.len())
                    .map_err(|_| CleanupRefusal::Unsafe)?
                    != TEST_MARKER.as_bytes()
            {
                return Err(CleanupRefusal::Unsafe);
            }
            drop(marker_handle);

            let root_facts = metadata(&root_handle).map_err(|_| CleanupRefusal::Unsafe)?;
            if root_facts.identity.volume != self.cleanup.temporary.identity.volume {
                return Err(CleanupRefusal::Unsafe);
            }
            let mut first_traversal = CleanupTraversal {
                limits,
                entries: 1,
                bytes: 0,
                root_volume: root_facts.identity.volume,
                identities: HashSet::from([(
                    root_facts.identity.volume,
                    root_facts.identity.file_id,
                )]),
            };
            if first_traversal.entries > limits.entries {
                return Err(CleanupRefusal::Limit);
            }
            let first = capture_cleanup_node(
                &self.root,
                &root_handle,
                0,
                &self.cleanup.process,
                &mut first_traversal,
            )?;
            require_original_marker(&first, &self.cleanup.marker)?;

            let mut second_traversal = CleanupTraversal {
                limits,
                entries: 1,
                bytes: 0,
                root_volume: root_facts.identity.volume,
                identities: HashSet::from([(
                    root_facts.identity.volume,
                    root_facts.identity.file_id,
                )]),
            };
            let second = capture_cleanup_node(
                &self.root,
                &root_handle,
                0,
                &self.cleanup.process,
                &mut second_traversal,
            )?;
            let marker_handle = open_file_nofollow(&self.marker, false, false, true)
                .map_err(|_| CleanupRefusal::Unsafe)?;
            if first != second
                || !self
                    .cleanup
                    .root
                    .matches(&root_handle, &self.cleanup.process)?
                || !self
                    .cleanup
                    .marker
                    .matches(&marker_handle, &self.cleanup.process)?
                || read_exact_at(&marker_handle, TEST_MARKER.len())
                    .map_err(|_| CleanupRefusal::Unsafe)?
                    != TEST_MARKER.as_bytes()
            {
                return Err(CleanupRefusal::Unsafe);
            }
            Ok(CleanupPlan { root: second })
        }

        fn cleanup_check(&self, limits: CleanupLimits) -> Result<(), CleanupRefusal> {
            self.cleanup_plan(limits).map(|_| ())
        }

        fn cleanup_now(&mut self) -> Result<(), CleanupRefusal> {
            let plan = self.cleanup_plan(CleanupLimits::STANDARD)?;
            execute_cleanup_plan(self, &plan)?;
            self.cleaned = true;
            Ok(())
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            if self.cleaned {
                return;
            }
            if self.cleanup_now().is_err() {
                if std::thread::panicking() {
                    eprintln!("plurum native test cleanup refused");
                } else {
                    panic!("plurum native test cleanup refused");
                }
            }
        }
    }

    fn open_cleanup_directory(path: &Path) -> std::io::Result<File> {
        OpenOptions::new()
            .read(true)
            .access_mode(GENERIC_READ | READ_CONTROL | DELETE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
    }

    fn open_cleanup_file(path: &Path) -> std::io::Result<File> {
        OpenOptions::new()
            .read(true)
            .access_mode(GENERIC_READ | READ_CONTROL | DELETE)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    }

    fn capture_cleanup_node(
        directory_path: &Path,
        opened: &File,
        depth: usize,
        process: &ProcessIdentity,
        traversal: &mut CleanupTraversal,
    ) -> Result<CleanupNode, CleanupRefusal> {
        let object = CleanupObjectEvidence::capture(opened, process, ObjectKind::Directory)?;
        if object.identity.volume != traversal.root_volume {
            return Err(CleanupRefusal::Unsafe);
        }
        if depth >= traversal.limits.depth {
            return Err(CleanupRefusal::Limit);
        }
        let remaining = traversal.limits.entries.saturating_sub(traversal.entries);
        let mut entries = bounded_cleanup_entries(directory_path, remaining)?;
        entries.sort_by_key(|entry| entry.file_name());
        let mut children = Vec::with_capacity(entries.len());
        for entry in entries {
            if !valid_component(&entry.file_name()) {
                return Err(CleanupRefusal::Unsafe);
            }
            traversal.entries = traversal
                .entries
                .checked_add(1)
                .ok_or(CleanupRefusal::Limit)?;
            if traversal.entries > traversal.limits.entries {
                return Err(CleanupRefusal::Limit);
            }

            let path = entry.path();
            if path.parent() != Some(directory_path) {
                return Err(CleanupRefusal::Unsafe);
            }
            let path_metadata = fs::symlink_metadata(&path).map_err(|_| CleanupRefusal::Unsafe)?;
            if path_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(CleanupRefusal::Unsafe);
            }
            let (file, kind) = if path_metadata.is_dir() {
                (
                    open_cleanup_directory(&path).map_err(|_| CleanupRefusal::Unsafe)?,
                    ObjectKind::Directory,
                )
            } else if path_metadata.is_file() {
                (
                    open_cleanup_file(&path).map_err(|_| CleanupRefusal::Unsafe)?,
                    ObjectKind::RegularFile,
                )
            } else {
                return Err(CleanupRefusal::Unsafe);
            };
            let object = CleanupObjectEvidence::capture(&file, process, kind)?;
            if object.identity.volume != traversal.root_volume
                || !traversal
                    .identities
                    .insert((object.identity.volume, object.identity.file_id))
            {
                return Err(CleanupRefusal::Unsafe);
            }

            let child = if kind == ObjectKind::RegularFile {
                let size = object.size.ok_or(CleanupRefusal::Unsafe)?;
                traversal.bytes = traversal
                    .bytes
                    .checked_add(size)
                    .ok_or(CleanupRefusal::Limit)?;
                if traversal.bytes > traversal.limits.bytes {
                    return Err(CleanupRefusal::Limit);
                }
                CleanupNode {
                    name: entry.file_name(),
                    object,
                    children: Vec::new(),
                }
            } else {
                capture_cleanup_node(&path, &file, depth + 1, process, traversal)?
            };
            children.push(child);
        }
        Ok(CleanupNode {
            name: directory_path
                .file_name()
                .ok_or(CleanupRefusal::Unsafe)?
                .to_os_string(),
            object,
            children,
        })
    }

    fn bounded_cleanup_entries(
        directory: &Path,
        maximum: usize,
    ) -> Result<Vec<fs::DirEntry>, CleanupRefusal> {
        let mut entries = Vec::with_capacity(maximum.min(256));
        let stream = fs::read_dir(directory).map_err(|_| CleanupRefusal::Unsafe)?;
        for entry in stream {
            if entries.len() == maximum {
                return Err(CleanupRefusal::Limit);
            }
            entries.push(entry.map_err(|_| CleanupRefusal::Unsafe)?);
        }
        Ok(entries)
    }

    fn require_original_marker(
        root: &CleanupNode,
        expected: &CleanupObjectEvidence,
    ) -> Result<(), CleanupRefusal> {
        let marker = root
            .children
            .iter()
            .find(|child| child.name == OsStr::new(".plurum-windows-native-test"))
            .ok_or(CleanupRefusal::Unsafe)?;
        if marker.object != *expected || !marker.children.is_empty() {
            return Err(CleanupRefusal::Unsafe);
        }
        Ok(())
    }

    fn quarantine_name(root: &CleanupObjectEvidence) -> OsString {
        let sequence = NEXT_QUARANTINE.fetch_add(1, Ordering::Relaxed);
        let file_id = root
            .identity
            .file_id
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        OsString::from(format!(
            ".plurum-cleanup-{}-{sequence}-{file_id}",
            std::process::id()
        ))
    }

    fn execute_cleanup_plan(test: &TestRoot, plan: &CleanupPlan) -> Result<(), CleanupRefusal> {
        let quarantine_name = quarantine_name(&test.cleanup.root);
        execute_cleanup_plan_named(test, plan, &quarantine_name, CleanupFault::None)
    }

    fn execute_cleanup_plan_named(
        test: &TestRoot,
        plan: &CleanupPlan,
        quarantine_name: &OsStr,
        fault: CleanupFault,
    ) -> Result<(), CleanupRefusal> {
        let temporary_chain = NormalizedAbsolutePath::parse(&test.temporary)
            .and_then(|path| path.open_complete())
            .map_err(|_| CleanupRefusal::Unsafe)?;
        let root_parent_chain = NormalizedAbsolutePath::parse(&test.root)
            .and_then(|path| path.open_parent())
            .map_err(|_| CleanupRefusal::Unsafe)?;
        let temporary = &temporary_chain.leaf;
        if !test
            .cleanup
            .temporary
            .matches(temporary, &test.cleanup.process)?
            || !test
                .cleanup
                .temporary
                .matches(&root_parent_chain.leaf, &test.cleanup.process)?
            || attest_local_ntfs(temporary.as_handle(), &test.cleanup.drive_root)
                .map_err(|_| CleanupRefusal::Unsafe)?
                != test.cleanup.temporary_volume
        {
            return Err(CleanupRefusal::Unsafe);
        }

        let root = open_cleanup_directory(&test.root).map_err(|_| CleanupRefusal::Unsafe)?;
        if !test.cleanup.root.matches(&root, &test.cleanup.process)?
            || plan.root.object != test.cleanup.root
        {
            return Err(CleanupRefusal::Unsafe);
        }
        let root_facts = metadata(&root).map_err(|_| CleanupRefusal::Unsafe)?;
        if root_facts.identity.volume != test.cleanup.temporary.identity.volume {
            return Err(CleanupRefusal::Unsafe);
        }
        let mut traversal = CleanupTraversal {
            limits: CleanupLimits::STANDARD,
            entries: 1,
            bytes: 0,
            root_volume: root_facts.identity.volume,
            identities: HashSet::from([(root_facts.identity.volume, root_facts.identity.file_id)]),
        };
        if capture_cleanup_node(&test.root, &root, 0, &test.cleanup.process, &mut traversal)?
            != plan.root
        {
            return Err(CleanupRefusal::Unsafe);
        }

        if !valid_component(quarantine_name) {
            return Err(CleanupRefusal::Unsafe);
        }
        let quarantine = test.temporary.join(quarantine_name);
        match fs::symlink_metadata(&quarantine) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(CleanupRefusal::Unsafe),
        }
        let quarantine_wide = quarantine_name.encode_wide().collect::<Vec<_>>();
        match plurum_windows_syscall::rename_by_handle(
            root.as_handle(),
            temporary.as_handle(),
            &quarantine_wide,
            false,
        )
        .map_err(|_| CleanupRefusal::Unsafe)?
        {
            plurum_windows_syscall::MutationAttempt::Applied => {}
            plurum_windows_syscall::MutationAttempt::Conflict
            | plurum_windows_syscall::MutationAttempt::Unsupported => {
                return Err(CleanupRefusal::Unsafe);
            }
        }
        if !path_is_missing(&test.root) {
            return Err(CleanupRefusal::Unsafe);
        }
        // `root` retains DELETE access while pinning the renamed object. The
        // verification handle must therefore share deletion without requesting
        // it itself, or Windows correctly rejects the second open.
        let rebound =
            open_directory_nofollow(&quarantine, true).map_err(|_| CleanupRefusal::Unsafe)?;
        if !plan.root.object.matches(&rebound, &test.cleanup.process)? {
            return Err(CleanupRefusal::Unsafe);
        }
        drop(rebound);
        if fault == CleanupFault::AfterQuarantine {
            return Err(CleanupRefusal::Unsafe);
        }

        let mut fault_state = CleanupFaultState {
            fault,
            removed_children: 0,
        };
        remove_expected_children(
            &quarantine,
            &plan.root,
            &test.cleanup.process,
            test.cleanup.marker.identity,
            &mut fault_state,
        )?;
        if !plan.root.object.matches(&root, &test.cleanup.process)? {
            return Err(CleanupRefusal::Unsafe);
        }
        require_empty_directory(&quarantine)?;
        match plurum_windows_syscall::remove_by_handle(root.as_handle())
            .map_err(|_| CleanupRefusal::Unsafe)?
        {
            plurum_windows_syscall::MutationAttempt::Applied => {}
            plurum_windows_syscall::MutationAttempt::Conflict
            | plurum_windows_syscall::MutationAttempt::Unsupported => {
                return Err(CleanupRefusal::Unsafe);
            }
        }
        drop(root);
        if fault == CleanupFault::AfterRootRemoval {
            return Err(CleanupRefusal::Unsafe);
        }
        if !path_is_missing(&test.root) || !path_is_missing(&quarantine) {
            return Err(CleanupRefusal::Unsafe);
        }
        Ok(())
    }

    fn remove_expected_children(
        directory: &Path,
        expected: &CleanupNode,
        process: &ProcessIdentity,
        marker_identity: ObjectIdentity,
        fault: &mut CleanupFaultState,
    ) -> Result<(), CleanupRefusal> {
        let actual_names = cleanup_names(directory, expected.children.len())?;
        let mut expected_names = expected
            .children
            .iter()
            .map(|child| child.name.clone())
            .collect::<Vec<_>>();
        expected_names.sort();
        if actual_names != expected_names {
            return Err(CleanupRefusal::Unsafe);
        }

        let mut children = expected.children.iter().collect::<Vec<_>>();
        children.sort_by_key(|child| child.object.identity == marker_identity);
        for child in children {
            let path = directory.join(&child.name);
            if child.object.kind == ObjectKind::Directory {
                let opened = open_cleanup_directory(&path).map_err(|_| CleanupRefusal::Unsafe)?;
                if !child.object.matches(&opened, process)? {
                    return Err(CleanupRefusal::Unsafe);
                }
                remove_expected_children(&path, child, process, marker_identity, fault)?;
                if !child.object.matches(&opened, process)? {
                    return Err(CleanupRefusal::Unsafe);
                }
                require_empty_directory(&path)?;
                match plurum_windows_syscall::remove_by_handle(opened.as_handle())
                    .map_err(|_| CleanupRefusal::Unsafe)?
                {
                    plurum_windows_syscall::MutationAttempt::Applied => {}
                    plurum_windows_syscall::MutationAttempt::Conflict
                    | plurum_windows_syscall::MutationAttempt::Unsupported => {
                        return Err(CleanupRefusal::Unsafe);
                    }
                }
                drop(opened);
            } else {
                let opened = open_cleanup_file(&path).map_err(|_| CleanupRefusal::Unsafe)?;
                if !child.object.matches(&opened, process)? {
                    return Err(CleanupRefusal::Unsafe);
                }
                if child.object.identity == marker_identity
                    && (child.name != OsStr::new(".plurum-windows-native-test")
                        || child.object.size != Some(TEST_MARKER.len() as u64)
                        || read_exact_at(&opened, TEST_MARKER.len())
                            .map_err(|_| CleanupRefusal::Unsafe)?
                            != TEST_MARKER.as_bytes())
                {
                    return Err(CleanupRefusal::Unsafe);
                }
                match plurum_windows_syscall::remove_by_handle(opened.as_handle())
                    .map_err(|_| CleanupRefusal::Unsafe)?
                {
                    plurum_windows_syscall::MutationAttempt::Applied => {}
                    plurum_windows_syscall::MutationAttempt::Conflict
                    | plurum_windows_syscall::MutationAttempt::Unsupported => {
                        return Err(CleanupRefusal::Unsafe);
                    }
                }
                drop(opened);
            }
            if !path_is_missing(&path) {
                return Err(CleanupRefusal::Unsafe);
            }
            fault.removed_children = fault
                .removed_children
                .checked_add(1)
                .ok_or(CleanupRefusal::Limit)?;
            if fault.fault == CleanupFault::AfterFirstChildRemoval && fault.removed_children == 1 {
                return Err(CleanupRefusal::Unsafe);
            }
        }
        require_empty_directory(directory)
    }

    fn restore_quarantined_root(
        test: &TestRoot,
        quarantine_name: &OsStr,
    ) -> Result<(), CleanupRefusal> {
        if !valid_component(quarantine_name) || !path_is_missing(&test.root) {
            return Err(CleanupRefusal::Unsafe);
        }
        let temporary_chain = NormalizedAbsolutePath::parse(&test.temporary)
            .and_then(|path| path.open_complete())
            .map_err(|_| CleanupRefusal::Unsafe)?;
        let root_parent_chain = NormalizedAbsolutePath::parse(&test.root)
            .and_then(|path| path.open_parent())
            .map_err(|_| CleanupRefusal::Unsafe)?;
        let temporary = &temporary_chain.leaf;
        if !test
            .cleanup
            .temporary
            .matches(temporary, &test.cleanup.process)?
            || !test
                .cleanup
                .temporary
                .matches(&root_parent_chain.leaf, &test.cleanup.process)?
            || attest_local_ntfs(temporary.as_handle(), &test.cleanup.drive_root)
                .map_err(|_| CleanupRefusal::Unsafe)?
                != test.cleanup.temporary_volume
        {
            return Err(CleanupRefusal::Unsafe);
        }
        let quarantine = test.temporary.join(quarantine_name);
        let root = open_cleanup_directory(&quarantine).map_err(|_| CleanupRefusal::Unsafe)?;
        if !test.cleanup.root.matches(&root, &test.cleanup.process)? {
            return Err(CleanupRefusal::Unsafe);
        }
        let original_name = test
            .root
            .file_name()
            .ok_or(CleanupRefusal::Unsafe)?
            .encode_wide()
            .collect::<Vec<_>>();
        match plurum_windows_syscall::rename_by_handle(
            root.as_handle(),
            temporary.as_handle(),
            &original_name,
            false,
        )
        .map_err(|_| CleanupRefusal::Unsafe)?
        {
            plurum_windows_syscall::MutationAttempt::Applied => {}
            plurum_windows_syscall::MutationAttempt::Conflict
            | plurum_windows_syscall::MutationAttempt::Unsupported => {
                return Err(CleanupRefusal::Unsafe);
            }
        }
        if !path_is_missing(&quarantine) {
            return Err(CleanupRefusal::Unsafe);
        }
        // `root` still carries DELETE access across the handle-relative rename.
        let rebound =
            open_directory_nofollow(&test.root, true).map_err(|_| CleanupRefusal::Unsafe)?;
        if test.cleanup.root.matches(&rebound, &test.cleanup.process)? {
            Ok(())
        } else {
            Err(CleanupRefusal::Unsafe)
        }
    }

    fn cleanup_names(directory: &Path, maximum: usize) -> Result<Vec<OsString>, CleanupRefusal> {
        let mut names = Vec::with_capacity(maximum.min(256));
        let stream = fs::read_dir(directory).map_err(|_| CleanupRefusal::Unsafe)?;
        for entry in stream {
            if names.len() == maximum {
                return Err(CleanupRefusal::Unsafe);
            }
            let name = entry.map_err(|_| CleanupRefusal::Unsafe)?.file_name();
            if !valid_component(&name) {
                return Err(CleanupRefusal::Unsafe);
            }
            names.push(name);
        }
        names.sort();
        Ok(names)
    }

    fn require_empty_directory(directory: &Path) -> Result<(), CleanupRefusal> {
        let mut entries = fs::read_dir(directory).map_err(|_| CleanupRefusal::Unsafe)?;
        match entries.next() {
            None => Ok(()),
            Some(Ok(_)) => Err(CleanupRefusal::Unsafe),
            Some(Err(_)) => Err(CleanupRefusal::Unsafe),
        }
    }

    fn path_is_missing(path: &Path) -> bool {
        matches!(
            fs::symlink_metadata(path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        )
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
    fn cleanup_guard_requires_original_root_and_marker_identities() {
        let test = TestRoot::new();
        assert_eq!(
            test.cleanup_check(CleanupLimits::STANDARD),
            Ok(()),
            "fresh disposable tree must pass cleanup validation"
        );

        let parked_marker = test.root.join(".parked-native-test-marker");
        fs::rename(&test.marker, &parked_marker).expect("original marker must be parkable");
        let process = ProcessIdentity::capture().expect("test process identity must be safe");
        let mut replacement = match create_private_file(
            &test.marker,
            &process,
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER,
            FILE_SHARE_READ,
        )
        .expect("replacement marker create must complete")
        {
            FileCreateAttempt::Created(file) => file,
            FileCreateAttempt::Conflict => panic!("replacement marker unexpectedly exists"),
        };
        replacement
            .write_all(TEST_MARKER.as_bytes())
            .expect("replacement marker bytes must be written");
        flush_file(replacement.as_handle()).expect("replacement marker must be flushed");
        drop(replacement);
        assert_eq!(
            test.cleanup_check(CleanupLimits::STANDARD),
            Err(CleanupRefusal::Unsafe),
            "identical marker bytes must not substitute for the original file identity"
        );
        assert!(
            test.root.is_dir(),
            "refused cleanup must not mutate the tree"
        );
        fs::remove_file(&test.marker).expect("replacement marker must be removable");
        fs::rename(&parked_marker, &test.marker).expect("original marker must be restorable");

        let parked_root = test.temporary.join(format!(
            ".parked-{}",
            test.root.file_name().unwrap().to_string_lossy()
        ));
        fs::rename(&test.root, &parked_root).expect("original root must be parkable");
        let replacement_root =
            ensure_private_directory(&test.root).expect("replacement root must be securable");
        assert_eq!(replacement_root.disposition, DirectoryDisposition::Created);
        drop(replacement_root);
        let mut replacement_marker = match create_private_file(
            &test.marker,
            &process,
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER,
            FILE_SHARE_READ,
        )
        .expect("replacement root marker create must complete")
        {
            FileCreateAttempt::Created(file) => file,
            FileCreateAttempt::Conflict => panic!("replacement root marker unexpectedly exists"),
        };
        replacement_marker
            .write_all(TEST_MARKER.as_bytes())
            .expect("replacement root marker bytes must be written");
        flush_file(replacement_marker.as_handle())
            .expect("replacement root marker must be flushed");
        drop(replacement_marker);
        assert_eq!(
            test.cleanup_check(CleanupLimits::STANDARD),
            Err(CleanupRefusal::Unsafe),
            "a new private root at the same path must not replace the captured root identity"
        );
        assert!(
            test.root.is_dir(),
            "refused cleanup must retain replacement root"
        );
        fs::remove_file(&test.marker).expect("known replacement marker must be removable");
        fs::remove_dir(&test.root).expect("known empty replacement root must be removable");
        fs::rename(&parked_root, &test.root).expect("original root must be restorable");
        assert_eq!(test.cleanup_check(CleanupLimits::STANDARD), Ok(()));
    }

    #[test]
    fn cleanup_guard_refuses_reparse_points_hard_links_and_exhausted_bounds() {
        let test = TestRoot::new();

        let alias = test.root.join("marker-hard-link");
        fs::hard_link(&test.marker, &alias).expect("marker hard-link fixture must be created");
        assert_eq!(
            test.cleanup_check(CleanupLimits::STANDARD),
            Err(CleanupRefusal::Unsafe)
        );
        assert!(
            alias.is_file(),
            "refused cleanup must retain hard-link fixture"
        );
        fs::remove_file(&alias).expect("hard-link fixture must be removable");

        let target = test.root.join("junction-target");
        drop(
            ensure_private_directory(&target)
                .expect("junction target must be created with exact private security"),
        );
        let junction = test.root.join("cleanup-junction");
        fs::create_dir(&junction).expect("junction placeholder must be created");
        let junction_created =
            plurum_windows_syscall::try_create_junction_for_tests(&junction, &target)
                .expect("junction creation attempt must complete");
        if env::var("CI").as_deref() == Ok("true") {
            assert!(
                junction_created,
                "Windows CI must execute cleanup junction refusal"
            );
        }
        if junction_created {
            assert_eq!(
                test.cleanup_check(CleanupLimits::STANDARD),
                Err(CleanupRefusal::Unsafe)
            );
            assert!(target.is_dir(), "refused cleanup must not follow junction");
        }
        fs::remove_dir(&junction).expect("junction fixture must be removable");

        assert_eq!(
            test.cleanup_check(CleanupLimits {
                entries: 1,
                ..CleanupLimits::STANDARD
            }),
            Err(CleanupRefusal::Limit)
        );
        assert_eq!(
            test.cleanup_check(CleanupLimits {
                depth: 0,
                ..CleanupLimits::STANDARD
            }),
            Err(CleanupRefusal::Limit)
        );
        assert_eq!(
            test.cleanup_check(CleanupLimits {
                bytes: 0,
                ..CleanupLimits::STANDARD
            }),
            Err(CleanupRefusal::Limit)
        );
        assert_eq!(test.cleanup_check(CleanupLimits::STANDARD), Ok(()));
    }

    #[test]
    fn cleanup_guard_removes_only_a_fully_revalidated_disposable_tree() {
        let test = TestRoot::new();
        let root = test.root.clone();
        assert_eq!(test.cleanup_check(CleanupLimits::STANDARD), Ok(()));
        drop(test);
        assert!(
            fs::symlink_metadata(root).is_err(),
            "validated disposable tree must be removed"
        );
    }

    #[test]
    fn cleanup_guard_requires_exact_descendant_security_and_stable_contents() {
        let mut test = TestRoot::new();
        let broad = test.root.join("broad-descendant");
        drop(
            ensure_private_directory(&broad)
                .expect("broad descendant must begin with private security"),
        );
        plurum_windows_syscall::set_broad_dacl_for_tests(&broad, SecurityKind::Directory)
            .expect("broad descendant DACL must be installed");
        assert_eq!(
            test.cleanup_check(CleanupLimits::STANDARD),
            Err(CleanupRefusal::Unsafe)
        );
        plurum_windows_syscall::set_private_current_user_dacl_for_tests(
            &broad,
            SecurityKind::Directory,
        )
        .expect("broad descendant must be restored to exact private security");

        let inherited = test.root.join("inherited-descendant");
        write_private_test_file(&inherited, b"private");
        plurum_windows_syscall::set_inherited_current_user_dacl_for_tests(
            &inherited,
            SecurityKind::File,
        )
        .expect("inherited descendant DACL must be installed");
        assert_eq!(
            test.cleanup_check(CleanupLimits::STANDARD),
            Err(CleanupRefusal::Unsafe)
        );
        plurum_windows_syscall::set_private_current_user_dacl_for_tests(
            &inherited,
            SecurityKind::File,
        )
        .expect("inherited descendant must be restored to exact private security");

        let plan = test
            .cleanup_plan(CleanupLimits::STANDARD)
            .expect("stable private tree must produce a cleanup plan");
        let unexpected = test.root.join("unexpected-after-plan");
        write_private_test_file(&unexpected, b"unexpected");
        assert_eq!(
            execute_cleanup_plan(&test, &plan),
            Err(CleanupRefusal::Unsafe),
            "an unexpected nonempty entry must prevent quarantine and deletion"
        );
        assert!(test.root.is_dir());
        fs::remove_file(unexpected).expect("known unexpected fixture must be removable");

        let sharing_conflict = test.root.join("sharing-conflict");
        let holder = write_private_test_file_retained(&sharing_conflict, b"held");
        assert_eq!(
            test.cleanup_now(),
            Err(CleanupRefusal::Unsafe),
            "a handle denying delete sharing must prevent cleanup"
        );
        assert!(test.root.is_dir());
        drop(holder);
        assert_eq!(test.cleanup_check(CleanupLimits::STANDARD), Ok(()));
    }

    #[test]
    fn cleanup_guard_handles_a_bounded_nested_tree_by_exact_native_identity() {
        let test = TestRoot::new();
        let first = test.root.join("first");
        let second = first.join("second");
        drop(ensure_private_directory(&first).expect("first private directory must be created"));
        drop(ensure_private_directory(&second).expect("second private directory must be created"));
        for index in 0..32 {
            write_private_test_file(
                &second.join(format!("entry-{index:02}")),
                format!("payload-{index:02}").as_bytes(),
            );
        }
        assert_eq!(test.cleanup_check(CleanupLimits::STANDARD), Ok(()));
    }

    #[test]
    fn cleanup_fault_boundaries_never_fall_back_to_path_recursive_deletion() {
        let mut test = TestRoot::new();
        write_private_test_file(&test.root.join("fault-child"), b"fault");

        let plan = test
            .cleanup_plan(CleanupLimits::STANDARD)
            .expect("fault test tree must produce a cleanup plan");
        let after_quarantine = quarantine_name(&test.cleanup.root);
        assert_eq!(
            execute_cleanup_plan_named(
                &test,
                &plan,
                &after_quarantine,
                CleanupFault::AfterQuarantine,
            ),
            Err(CleanupRefusal::Unsafe)
        );
        assert!(path_is_missing(&test.root));
        assert!(test.temporary.join(&after_quarantine).is_dir());
        restore_quarantined_root(&test, &after_quarantine)
            .expect("untouched quarantine must restore by exact handle");

        let plan = test
            .cleanup_plan(CleanupLimits::STANDARD)
            .expect("restored fault tree must produce a cleanup plan");
        let after_child = quarantine_name(&test.cleanup.root);
        assert_eq!(
            execute_cleanup_plan_named(
                &test,
                &plan,
                &after_child,
                CleanupFault::AfterFirstChildRemoval,
            ),
            Err(CleanupRefusal::Unsafe)
        );
        assert!(path_is_missing(&test.root));
        assert!(test.temporary.join(&after_child).is_dir());
        restore_quarantined_root(&test, &after_child)
            .expect("partially reduced quarantine must restore by exact handle");
        assert!(
            test.marker.is_file(),
            "the original marker must be retained until the final child removal"
        );

        let plan = test
            .cleanup_plan(CleanupLimits::STANDARD)
            .expect("reduced fault tree must produce a cleanup plan");
        let after_root = quarantine_name(&test.cleanup.root);
        assert_eq!(
            execute_cleanup_plan_named(&test, &plan, &after_root, CleanupFault::AfterRootRemoval,),
            Err(CleanupRefusal::Unsafe)
        );
        assert!(path_is_missing(&test.root));
        assert!(path_is_missing(&test.temporary.join(after_root)));
        test.cleaned = true;
    }

    fn write_private_test_file(path: &Path, bytes: &[u8]) {
        drop(write_private_test_file_retained(path, bytes));
    }

    fn write_private_test_file_retained(path: &Path, bytes: &[u8]) -> File {
        let process = ProcessIdentity::capture().expect("test process identity must be safe");
        let mut file = match create_private_file(
            path,
            &process,
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER,
            FILE_SHARE_READ,
        )
        .expect("private test file create must complete")
        {
            FileCreateAttempt::Created(file) => file,
            FileCreateAttempt::Conflict => panic!("private test file unexpectedly exists"),
        };
        file.write_all(bytes)
            .expect("private test file bytes must be written");
        flush_file(file.as_handle()).expect("private test file must be flushed");
        file
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
        drop(
            ensure_private_directory(&outside)
                .expect("outside directory must exist with exact private security"),
        );
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
        fs::remove_dir(&broad).expect("broad-DACL fixture must be removed after assertion");

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
        fs::remove_dir(&inherited).expect("inherited-DACL fixture must be removed after assertion");

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
        fs::remove_dir(&wrong_owner).expect("wrong-owner fixture must be removed after assertion");
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
        fs::remove_file(&credential)
            .expect("credential reparse fixture must be removed after assertion");
        fs::remove_file(&target).expect("reparse target fixture must be removed after assertion");
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
        let unrelated = test.root.join("unrelated-write");
        fs::write(&unrelated, b"ok")
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
        fs::remove_file(unrelated).expect("known unrelated-write fixture must be removable");
    }

    #[test]
    fn observed_lease_validates_under_exclusion_and_cleans_a_new_lock_on_mismatch() {
        let test = TestRoot::new();
        let binding = observe_missing_private_directory(&test.store)
            .expect("missing observation must complete")
            .expect("store must initially be absent");
        let validation_ran = std::cell::Cell::new(false);
        let acquired = acquire_observed_setup_lease(
            &test.store,
            NONCE_1,
            ObservedDirectoryExpectation::Missing(&binding),
            |directory| {
                validation_ran.set(true);
                let lock = directory.core.path.path.join(SETUP_LOCK_ENTRY);
                assert_eq!(
                    fs::metadata(lock)
                        .expect("native exclusion file must exist during validation")
                        .len(),
                    0,
                    "validation must run before any lock-record initialization"
                );
                assert!(matches!(
                    directory
                        .observe_managed_entry(ManagedEntry::credential())
                        .expect("credential observation must complete"),
                    PrivateManagedEntryObservation::Missing
                ));
                assert!(directory
                    .list_managed_temporary_entries()
                    .expect("temporary enumeration must complete")
                    .is_empty());
                Ok(false)
            },
        )
        .expect("observed acquisition must complete");
        assert!(validation_ran.get());
        assert!(matches!(
            acquired,
            ObservedSetupLeaseAcquireResult::PreconditionFailed
        ));
        assert!(
            path_is_missing(&test.store.join(SETUP_LOCK_ENTRY)),
            "a newly-created uninitialized lock must be removed after mismatch"
        );
        assert!(matches!(
            open_private_directory(&test.store),
            Ok(PrivateDirectoryOpenResult::Missing)
        ));
    }

    #[test]
    fn observed_lease_distinguishes_stale_missing_and_busy_without_validation() {
        let test = TestRoot::new();
        let binding = observe_missing_private_directory(&test.store)
            .expect("missing observation must complete")
            .expect("store must initially be absent");
        drop(ensure_private_directory(&test.store).expect("store creation must complete"));
        let stale_validation = std::cell::Cell::new(false);
        assert!(matches!(
            acquire_observed_setup_lease(
                &test.store,
                NONCE_1,
                ObservedDirectoryExpectation::Missing(&binding),
                |_| {
                    stale_validation.set(true);
                    Ok(true)
                },
            ),
            Ok(ObservedSetupLeaseAcquireResult::PreconditionFailed)
        ));
        assert!(!stale_validation.get());
        assert!(
            test.store.is_dir(),
            "a stale missing observation must not remove the independently-created directory"
        );
        assert!(path_is_missing(&test.store.join(SETUP_LOCK_ENTRY)));

        let (_, _, mut held) = acquired_lease(&test.store, NONCE_1);
        let busy_validation = std::cell::Cell::new(false);
        assert!(matches!(
            acquire_observed_setup_lease(
                &test.store,
                NONCE_2,
                ObservedDirectoryExpectation::Present,
                |_| {
                    busy_validation.set(true);
                    Ok(true)
                },
            ),
            Ok(ObservedSetupLeaseAcquireResult::Busy)
        ));
        assert!(!busy_validation.get());
        held.release().expect("held lease must release");
    }

    #[test]
    fn observed_missing_busy_and_validation_error_leave_no_created_directory() {
        let test = TestRoot::new();
        let busy_binding = observe_missing_private_directory(&test.store)
            .expect("busy-path missing observation must complete")
            .expect("store must initially be absent");
        inject_observed_acquire_fault(TEST_OBSERVED_ACQUIRE_BUSY_AFTER_PREPARE);
        assert!(matches!(
            acquire_observed_setup_lease(
                &test.store,
                NONCE_1,
                ObservedDirectoryExpectation::Missing(&busy_binding),
                |_| panic!("forced busy path must not validate"),
            ),
            Ok(ObservedSetupLeaseAcquireResult::Busy)
        ));
        assert!(
            path_is_missing(&test.store),
            "forced busy after final-directory creation must roll back the exact directory"
        );

        let error_binding = observe_missing_private_directory(&test.store)
            .expect("error-path missing observation must complete")
            .expect("store must remain absent after busy rollback");
        assert_eq!(
            acquire_observed_setup_lease(
                &test.store,
                NONCE_2,
                ObservedDirectoryExpectation::Missing(&error_binding),
                |_| Err(WindowsStoreError::Io),
            )
            .err(),
            Some(WindowsStoreError::Io)
        );
        assert!(
            path_is_missing(&test.store),
            "validation error must remove both the new lock and exact new directory"
        );
    }

    #[test]
    fn legacy_reader_is_read_only_bounded_and_rejects_broad_parent_authority() {
        let test = TestRoot::new();
        let parent = test.root.join("legacy");
        drop(ensure_private_directory(&parent).expect("legacy parent must be secured"));
        let legacy = parent.join("plurum.json");
        let empty = parent.join("empty.json");
        write_private_test_file(&legacy, b"secret");
        write_private_test_file(&empty, b"");

        assert_eq!(
            read_allowlisted_legacy_credential(&legacy, OsStr::new("plurum.json"), 6)
                .expect("legacy read must complete"),
            LegacyCredentialReadResult::Loaded(b"secret".to_vec())
        );
        assert_eq!(
            read_allowlisted_legacy_credential(&empty, OsStr::new("empty.json"), 6)
                .expect("empty legacy classification must complete"),
            LegacyCredentialReadResult::Malformed
        );
        assert_eq!(
            read_allowlisted_legacy_credential(&legacy, OsStr::new("plurum.json"), 5)
                .expect("oversize classification must complete"),
            LegacyCredentialReadResult::Oversized
        );
        assert_eq!(
            read_allowlisted_legacy_credential(&legacy, OsStr::new("other.json"), 6)
                .expect("leaf mismatch must fail closed"),
            LegacyCredentialReadResult::Unsafe
        );
        assert_eq!(
            read_allowlisted_legacy_credential(
                &parent.join("missing.json"),
                OsStr::new("missing.json"),
                6,
            )
            .expect("missing classification must complete"),
            LegacyCredentialReadResult::Missing
        );

        plurum_windows_syscall::set_broad_dacl_for_tests(&parent, SecurityKind::Directory)
            .expect("broad parent DACL must be installed");
        assert_eq!(
            read_allowlisted_legacy_credential(&legacy, OsStr::new("plurum.json"), 6)
                .expect("broad parent classification must complete"),
            LegacyCredentialReadResult::Unsafe
        );
        plurum_windows_syscall::set_private_current_user_dacl_for_tests(
            &parent,
            SecurityKind::Directory,
        )
        .expect("legacy parent security must be restored");
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
        fs::remove_file(&ready).expect("child readiness fixture must be removable");
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
