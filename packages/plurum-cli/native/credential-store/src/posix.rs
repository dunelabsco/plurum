use std::ffi::{OsStr, OsString};
use std::fs::{File, Metadata};
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use rustix::fs::{self as rustix_fs, AtFlags, FlockOperation, Mode, OFlags};
use rustix::io::Errno;
use rustix::process;
use sha2::{Digest, Sha256};

mod mutation;

const CREDENTIAL_ENTRY: &str = "credentials.json";
const SETUP_LOCK_ENTRY: &str = "setup.lock";
const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
const PRIVATE_FILE_MODE: u32 = 0o600;
const PERMISSION_AND_SPECIAL_BITS: u32 = 0o7777;
const MAX_ATTESTED_BYTES: usize = 40_961;

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
pub(crate) enum PosixStoreError {
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
    pub(crate) device: u64,
    pub(crate) inode: u64,
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
    mode: u32,
    uid: u32,
    gid: u32,
    links: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

impl MetadataFacts {
    fn from_metadata(metadata: &Metadata) -> Self {
        let kind = if metadata.is_dir() {
            ObjectKind::Directory
        } else if metadata.is_file() {
            ObjectKind::RegularFile
        } else {
            ObjectKind::Other
        };
        Self {
            identity: ObjectIdentity {
                device: metadata.dev(),
                inode: metadata.ino(),
            },
            kind,
            mode: metadata.mode(),
            uid: metadata.uid(),
            gid: metadata.gid(),
            links: metadata.nlink(),
            size: metadata.size(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        }
    }

    fn owned_by(self, uid: u32) -> bool {
        self.uid == uid
    }

    fn exact_private_file(self, uid: u32) -> bool {
        self.kind == ObjectKind::RegularFile
            && self.owned_by(uid)
            && self.links == 1
            && self.mode & PERMISSION_AND_SPECIAL_BITS == PRIVATE_FILE_MODE
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProcessIdentity {
    uid: u32,
    gid: u32,
}

impl ProcessIdentity {
    fn validate(
        uid: u32,
        effective_uid: u32,
        gid: u32,
        effective_gid: u32,
        root_group_detected: bool,
        sudo_detected: bool,
    ) -> Result<Self, PosixStoreError> {
        if uid == 0
            || effective_uid == 0
            || gid == 0
            || effective_gid == 0
            || uid != effective_uid
            || gid != effective_gid
            || root_group_detected
            || sudo_detected
        {
            return Err(PosixStoreError::Unsafe);
        }
        Ok(Self { uid, gid })
    }

    fn capture() -> Result<Self, PosixStoreError> {
        let real = process::getuid();
        let effective = process::geteuid();
        let real_group = process::getgid();
        let effective_group = process::getegid();
        let root_group_detected = process::getgroups()
            .map_err(|_| PosixStoreError::Unsafe)?
            .into_iter()
            .any(|group| group.is_root());
        Self::validate(
            real.as_raw(),
            effective.as_raw(),
            real_group.as_raw(),
            effective_group.as_raw(),
            root_group_detected,
            std::env::var_os("SUDO_UID").is_some() || std::env::var_os("SUDO_USER").is_some(),
        )
    }

    fn verify(self) -> Result<(), PosixStoreError> {
        let current = Self::capture()?;
        if current == self {
            Ok(())
        } else {
            Err(PosixStoreError::Lost)
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct NormalizedAbsolutePath {
    components: Vec<OsString>,
    path: PathBuf,
}

impl NormalizedAbsolutePath {
    fn parse(path: &Path) -> Result<Self, PosixStoreError> {
        if !path.is_absolute() {
            return Err(PosixStoreError::InvalidInput);
        }

        let mut components = Vec::new();
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name)
                    if !name.as_bytes().is_empty() && !name.as_bytes().contains(&0) =>
                {
                    components.push(name.to_os_string());
                }
                _ => return Err(PosixStoreError::InvalidInput),
            }
        }
        if components.is_empty() {
            return Err(PosixStoreError::InvalidInput);
        }

        let mut normalized = PathBuf::from("/");
        for component in &components {
            normalized.push(component);
        }
        if normalized.as_os_str() != path.as_os_str() {
            return Err(PosixStoreError::InvalidInput);
        }
        Ok(Self {
            components,
            path: normalized,
        })
    }

    fn final_name(&self) -> &OsStr {
        self.components
            .last()
            .expect("normalized POSIX paths always have a final component")
    }

    fn open_parent(&self) -> Result<File, PosixStoreError> {
        open_directory_components(&self.components[..self.components.len() - 1])
    }

    fn open_complete(&self) -> Result<File, PosixStoreError> {
        open_directory_components(&self.components)
    }
}

fn is_single_entry_name(name: &OsStr) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes != b"."
        && bytes != b".."
        && !bytes.contains(&0)
        && !bytes.contains(&b'/')
}

fn directory_open_flags() -> OFlags {
    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC
}

fn read_open_flags() -> OFlags {
    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK
}

fn lock_open_flags() -> OFlags {
    OFlags::RDWR | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK
}

fn private_directory_mode() -> Mode {
    Mode::RWXU
}

fn private_file_mode() -> Mode {
    Mode::RUSR | Mode::WUSR
}

fn secure_openat(
    directory: &File,
    path: &OsStr,
    flags: OFlags,
    mode: Mode,
) -> Result<OwnedFd, Errno> {
    #[cfg(target_os = "linux")]
    {
        use rustix::fs::ResolveFlags;

        match rustix_fs::openat2(
            directory,
            path,
            flags,
            mode,
            ResolveFlags::BENEATH | ResolveFlags::NO_MAGICLINKS | ResolveFlags::NO_SYMLINKS,
        ) {
            Ok(file) => return Ok(file),
            Err(error) if error != Errno::NOSYS => return Err(error),
            Err(_) => {}
        }
    }
    rustix_fs::openat(directory, path, flags, mode)
}

fn open_directory_components(components: &[OsString]) -> Result<File, PosixStoreError> {
    let root = rustix_fs::open(Path::new("/"), directory_open_flags(), Mode::empty())
        .map_err(|_| PosixStoreError::Io)?;
    let mut current = File::from(root);
    for component in components {
        let next = secure_openat(
            &current,
            component.as_os_str(),
            directory_open_flags(),
            Mode::empty(),
        )
        .map_err(classify_path_open_error)?;
        current = File::from(next);
    }
    Ok(current)
}

fn classify_path_open_error(error: Errno) -> PosixStoreError {
    if error == Errno::NOENT {
        PosixStoreError::Missing
    } else if error == Errno::LOOP || error == Errno::NOTDIR {
        PosixStoreError::Unsafe
    } else {
        PosixStoreError::Io
    }
}

fn metadata(file: &File) -> Result<MetadataFacts, PosixStoreError> {
    file.metadata()
        .map(|value| MetadataFacts::from_metadata(&value))
        .map_err(|_| PosixStoreError::Io)
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, PosixStoreError> {
    mutex.lock().map_err(|_| PosixStoreError::Lost)
}

fn digest_metadata(
    domain: &[u8],
    facts: MetadataFacts,
    canonical_current: bool,
    parent: Option<ObjectIdentity>,
    content: &[u8],
) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(domain);
    digest.update(facts.identity.device.to_le_bytes());
    digest.update(facts.identity.inode.to_le_bytes());
    digest.update(facts.mode.to_le_bytes());
    digest.update(facts.uid.to_le_bytes());
    digest.update(facts.gid.to_le_bytes());
    digest.update(facts.links.to_le_bytes());
    digest.update(facts.size.to_le_bytes());
    digest.update(facts.modified_seconds.to_le_bytes());
    digest.update(facts.modified_nanoseconds.to_le_bytes());
    digest.update(facts.changed_seconds.to_le_bytes());
    digest.update(facts.changed_nanoseconds.to_le_bytes());
    digest.update([u8::from(canonical_current)]);
    if let Some(parent) = parent {
        digest.update(parent.device.to_le_bytes());
        digest.update(parent.inode.to_le_bytes());
    }
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
    ) -> Result<DirectoryAttestation, PosixStoreError> {
        self.process.verify()?;
        let directory = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
        let parent = state.parent.as_ref().ok_or(PosixStoreError::Closed)?;
        let facts = metadata(directory)?;

        let parent_binding = secure_openat(
            parent,
            self.path.final_name(),
            directory_open_flags(),
            Mode::empty(),
        )
        .ok()
        .and_then(|file| metadata(&File::from(file)).ok())
        .is_some_and(|current| current.identity == facts.identity);
        let complete_binding = self
            .path
            .open_complete()
            .ok()
            .and_then(|file| metadata(&file).ok())
            .is_some_and(|current| current.identity == facts.identity);
        let canonical_current = parent_binding && complete_binding;

        Ok(DirectoryAttestation {
            identity: facts.identity,
            revision: digest_metadata(
                b"plurum-posix-directory-revision-v1\0",
                facts,
                canonical_current,
                None,
                &[],
            ),
            canonical_current,
            current_user: facts.owned_by(self.process.uid),
            private_mode: facts.kind == ObjectKind::Directory
                && facts.mode & PERMISSION_AND_SPECIAL_BITS == PRIVATE_DIRECTORY_MODE,
        })
    }

    fn require_secure_locked(
        &self,
        state: &DirectoryState,
    ) -> Result<DirectoryAttestation, PosixStoreError> {
        let attestation = self.attest_locked(state)?;
        if !attestation.canonical_current {
            return Err(PosixStoreError::Lost);
        }
        if !attestation.is_secure() {
            return Err(PosixStoreError::Unsafe);
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

pub(crate) struct PosixPrivateDirectory {
    core: Arc<DirectoryCore>,
}

impl PosixPrivateDirectory {
    pub(crate) fn attest(&self) -> Result<DirectoryAttestation, PosixStoreError> {
        let state = lock_unpoisoned(&self.core.state)?;
        self.core.attest_locked(&state)
    }

    pub(crate) fn open_credential_read_only(
        &self,
    ) -> Result<CredentialReadOpenResult, PosixStoreError> {
        self.open_managed_read_only(OsStr::new(CREDENTIAL_ENTRY))
    }

    fn open_managed_read_only(
        &self,
        entry_name: &OsStr,
    ) -> Result<CredentialReadOpenResult, PosixStoreError> {
        if !is_single_entry_name(entry_name) {
            return Err(PosixStoreError::InvalidInput);
        }
        let mut state = lock_unpoisoned(&self.core.state)?;
        let parent = self.core.require_secure_locked(&state)?;
        let directory = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;

        match rustix_fs::statat(directory, entry_name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(_) => {}
            Err(error) if error == Errno::NOENT => {
                return Ok(CredentialReadOpenResult::Missing);
            }
            Err(_) => return Err(PosixStoreError::Unsafe),
        }

        let opened = secure_openat(directory, entry_name, read_open_flags(), Mode::empty())
            .map_err(|error| {
                if error == Errno::NOENT {
                    PosixStoreError::Lost
                } else {
                    PosixStoreError::Unsafe
                }
            })?;
        let file = File::from(opened);
        let facts = metadata(&file)?;
        if facts.kind != ObjectKind::RegularFile {
            return Err(PosixStoreError::Unsafe);
        }

        let rebound = secure_openat(directory, entry_name, read_open_flags(), Mode::empty())
            .map(File::from)
            .map_err(|_| PosixStoreError::Lost)?;
        if metadata(&rebound)?.identity != facts.identity {
            return Err(PosixStoreError::Lost);
        }

        let slot = Arc::new(Mutex::new(Some(file)));
        state.children.retain(|child| child.upgrade().is_some());
        state.children.push(Arc::downgrade(&slot));
        Ok(CredentialReadOpenResult::Opened(
            PosixCredentialReadHandle {
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

impl Drop for PosixPrivateDirectory {
    fn drop(&mut self) {
        self.core.close_all();
    }
}

pub(crate) enum PrivateDirectoryOpenResult {
    Missing,
    Opened(PosixPrivateDirectory),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DirectoryDisposition {
    Created,
    Existing,
}

pub(crate) struct EnsuredPrivateDirectory {
    pub(crate) disposition: DirectoryDisposition,
    pub(crate) directory: PosixPrivateDirectory,
}

pub(crate) fn open_private_directory(
    path: &Path,
) -> Result<PrivateDirectoryOpenResult, PosixStoreError> {
    let process = ProcessIdentity::capture()?;
    let path = NormalizedAbsolutePath::parse(path)?;
    let parent = match path.open_parent() {
        Ok(parent) => parent,
        Err(PosixStoreError::Missing) => return Ok(PrivateDirectoryOpenResult::Missing),
        Err(error) => return Err(error),
    };
    let directory = match secure_openat(
        &parent,
        path.final_name(),
        directory_open_flags(),
        Mode::empty(),
    ) {
        Ok(directory) => File::from(directory),
        Err(error) if error == Errno::NOENT => {
            return Ok(PrivateDirectoryOpenResult::Missing);
        }
        Err(error) => return Err(classify_path_open_error(error)),
    };
    Ok(PrivateDirectoryOpenResult::Opened(PosixPrivateDirectory {
        core: Arc::new(DirectoryCore {
            process,
            path,
            state: Mutex::new(DirectoryState {
                parent: Some(parent),
                directory: Some(directory),
                children: Vec::new(),
            }),
        }),
    }))
}

pub(crate) fn ensure_private_directory(
    path: &Path,
) -> Result<EnsuredPrivateDirectory, PosixStoreError> {
    let process = ProcessIdentity::capture()?;
    let path = NormalizedAbsolutePath::parse(path)?;
    let parent = path.open_parent()?;
    let mut disposition = DirectoryDisposition::Existing;

    let directory = match secure_openat(
        &parent,
        path.final_name(),
        directory_open_flags(),
        Mode::empty(),
    ) {
        Ok(directory) => File::from(directory),
        Err(error) if error == Errno::NOENT => {
            match rustix_fs::mkdirat(&parent, path.final_name(), private_directory_mode()) {
                Ok(()) => {
                    disposition = DirectoryDisposition::Created;
                }
                Err(create_error) if create_error == Errno::EXIST => {}
                Err(_) => return Err(PosixStoreError::Io),
            }
            let opened = secure_openat(
                &parent,
                path.final_name(),
                directory_open_flags(),
                Mode::empty(),
            )
            .map_err(classify_path_open_error)?;
            let opened = File::from(opened);
            if disposition == DirectoryDisposition::Created {
                rustix_fs::fchmod(&opened, private_directory_mode())
                    .map_err(|_| PosixStoreError::Io)?;
                rustix_fs::fsync(&parent).map_err(|_| PosixStoreError::Io)?;
            }
            opened
        }
        Err(error) => return Err(classify_path_open_error(error)),
    };

    let directory = PosixPrivateDirectory {
        core: Arc::new(DirectoryCore {
            process,
            path,
            state: Mutex::new(DirectoryState {
                parent: Some(parent),
                directory: Some(directory),
                children: Vec::new(),
            }),
        }),
    };
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
    Opened(PosixCredentialReadHandle),
}

pub(crate) struct PosixCredentialReadHandle {
    directory: Arc<DirectoryCore>,
    parent_identity: ObjectIdentity,
    entry_name: OsString,
    slot: Arc<Mutex<Option<File>>>,
}

impl PosixCredentialReadHandle {
    fn security_locked(
        &self,
        directory_state: &DirectoryState,
        file: &File,
    ) -> Result<(FileSecurityAttestation, MetadataFacts), PosixStoreError> {
        self.directory.process.verify()?;
        let parent = self.directory.attest_locked(directory_state)?;
        let facts = metadata(file)?;
        if facts.kind != ObjectKind::RegularFile {
            return Err(PosixStoreError::Unsafe);
        }
        let directory = directory_state
            .directory
            .as_ref()
            .ok_or(PosixStoreError::Closed)?;
        let canonical_current = parent.is_secure()
            && secure_openat(
                directory,
                self.entry_name.as_os_str(),
                read_open_flags(),
                Mode::empty(),
            )
            .ok()
            .map(File::from)
            .and_then(|current| metadata(&current).ok())
            .is_some_and(|current| current.identity == facts.identity);
        Ok((
            FileSecurityAttestation {
                identity: facts.identity,
                parent_identity: self.parent_identity,
                canonical_current,
                current_user: facts.owned_by(self.directory.process.uid),
                private_mode: facts.mode & PERMISSION_AND_SPECIAL_BITS == PRIVATE_FILE_MODE,
                links: facts.links,
                size: facts.size,
            },
            facts,
        ))
    }

    pub(crate) fn security_attestation(&self) -> Result<FileSecurityAttestation, PosixStoreError> {
        let directory_state = lock_unpoisoned(&self.directory.state)?;
        let slot = lock_unpoisoned(&self.slot)?;
        let file = slot.as_ref().ok_or(PosixStoreError::Closed)?;
        self.security_locked(&directory_state, file)
            .map(|(security, _)| security)
    }

    pub(crate) fn attest(&self) -> Result<CredentialFileAttestation, PosixStoreError> {
        let directory_state = lock_unpoisoned(&self.directory.state)?;
        let slot = lock_unpoisoned(&self.slot)?;
        let file = slot.as_ref().ok_or(PosixStoreError::Closed)?;
        let (before_security, before) = self.security_locked(&directory_state, file)?;
        if !before_security.is_secure() {
            return Err(PosixStoreError::Unsafe);
        }
        let expected_size = usize::try_from(before.size).map_err(|_| PosixStoreError::Limit)?;
        if expected_size > MAX_ATTESTED_BYTES {
            return Err(PosixStoreError::Limit);
        }
        let mut bytes = read_exact_at(file, expected_size)?;
        let (after_security, after) = self.security_locked(&directory_state, file)?;
        if before != after || before_security != after_security {
            bytes.fill(0);
            return Err(PosixStoreError::Lost);
        }
        let revision = digest_metadata(
            b"plurum-posix-credential-revision-v1\0",
            after,
            after_security.canonical_current,
            Some(after_security.parent_identity),
            &bytes,
        );
        bytes.fill(0);
        Ok(CredentialFileAttestation {
            security: after_security,
            revision,
        })
    }

    pub(crate) fn read_bounded(&self, max_bytes: usize) -> Result<BoundedRead, PosixStoreError> {
        if max_bytes > MAX_ATTESTED_BYTES {
            return Err(PosixStoreError::Limit);
        }
        let directory_state = lock_unpoisoned(&self.directory.state)?;
        let slot = lock_unpoisoned(&self.slot)?;
        let file = slot.as_ref().ok_or(PosixStoreError::Closed)?;
        let (before_security, before) = self.security_locked(&directory_state, file)?;
        if !before_security.is_secure() {
            return Err(PosixStoreError::Unsafe);
        }
        let mut bytes = read_up_to_at(file, max_bytes)?;
        let (after_security, after) = match self.security_locked(&directory_state, file) {
            Ok(value) => value,
            Err(error) => {
                bytes.fill(0);
                return Err(error);
            }
        };
        if before != after || before_security != after_security {
            bytes.fill(0);
            return Err(PosixStoreError::Lost);
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

impl Drop for PosixCredentialReadHandle {
    fn drop(&mut self) {
        self.close();
    }
}

fn read_up_to_at(file: &File, max_bytes: usize) -> Result<Vec<u8>, PosixStoreError> {
    let mut bytes = vec![0_u8; max_bytes];
    let mut offset = 0;
    while offset < max_bytes {
        let position = match u64::try_from(offset) {
            Ok(position) => position,
            Err(_) => {
                bytes.fill(0);
                return Err(PosixStoreError::Limit);
            }
        };
        let read = match file.read_at(&mut bytes[offset..], position) {
            Ok(read) => read,
            Err(_) => {
                bytes.fill(0);
                return Err(PosixStoreError::Io);
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

fn read_exact_at(file: &File, expected: usize) -> Result<Vec<u8>, PosixStoreError> {
    let mut bytes = read_up_to_at(file, expected)?;
    if bytes.len() == expected {
        Ok(bytes)
    } else {
        bytes.fill(0);
        Err(PosixStoreError::Lost)
    }
}

fn write_all_at(file: &File, bytes: &[u8], start: u64) -> Result<(), PosixStoreError> {
    let mut written = 0;
    while written < bytes.len() {
        let offset = start
            .checked_add(u64::try_from(written).map_err(|_| PosixStoreError::Limit)?)
            .ok_or(PosixStoreError::Limit)?;
        let count = file
            .write_at(&bytes[written..], offset)
            .map_err(|_| PosixStoreError::Io)?;
        if count == 0 {
            return Err(PosixStoreError::Io);
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
        lease: PosixSetupLease,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ValidatedUuidV4([u8; LOCK_NONCE_LENGTH]);

impl ValidatedUuidV4 {
    fn parse(value: &str) -> Result<Self, PosixStoreError> {
        let bytes = value.as_bytes();
        if bytes.len() != LOCK_NONCE_LENGTH {
            return Err(PosixStoreError::InvalidInput);
        }
        for (index, byte) in bytes.iter().copied().enumerate() {
            let expected_hyphen = matches!(index, 8 | 13 | 18 | 23);
            if expected_hyphen {
                if byte != b'-' {
                    return Err(PosixStoreError::InvalidInput);
                }
            } else if !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte) {
                return Err(PosixStoreError::InvalidInput);
            }
        }
        if bytes[14] != b'4' || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b') {
            return Err(PosixStoreError::InvalidInput);
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

fn read_lock_record(file: &File) -> Result<LockRecordState, PosixStoreError> {
    let facts = metadata(file)?;
    if facts.size == 0 {
        return Ok(LockRecordState::Uninitialized);
    }
    if facts.size != LOCK_RECORD_LENGTH as u64 {
        return Err(PosixStoreError::Unsafe);
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
        return Err(PosixStoreError::Unsafe);
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
                Err(PosixStoreError::Unsafe)
            }
        }
        LOCK_STATE_HELD => {
            let nonce = std::str::from_utf8(&bytes[LOCK_NONCE_START..LOCK_NONCE_END])
                .map_err(|_| PosixStoreError::Unsafe)
                .and_then(ValidatedUuidV4::parse)?;
            Ok(LockRecordState::Held(nonce))
        }
        _ => Err(PosixStoreError::Unsafe),
    }
}

fn write_lock_state(file: &File, state: u8) -> Result<(), PosixStoreError> {
    write_all_at(file, &[state], 0)?;
    file.sync_all().map_err(|_| PosixStoreError::Io)
}

fn initialize_clean_lock_record(file: &File) -> Result<(), PosixStoreError> {
    if metadata(file)?.size != 0 {
        write_lock_state(file, LOCK_STATE_UNINITIALIZED)?;
    }
    file.set_len(LOCK_RECORD_LENGTH as u64)
        .map_err(|_| PosixStoreError::Io)?;
    let mut tail = [0_u8; LOCK_RECORD_LENGTH - 1];
    tail[LOCK_HEADER_START - 1..LOCK_HEADER_END - 1].copy_from_slice(LOCK_HEADER);
    write_all_at(file, &tail, 1)?;
    file.sync_all().map_err(|_| PosixStoreError::Io)?;
    write_lock_state(file, LOCK_STATE_CLEAN)?;
    if read_lock_record(file)? == LockRecordState::Clean {
        Ok(())
    } else {
        Err(PosixStoreError::Lost)
    }
}

fn write_held_lock_record(file: &File, nonce: ValidatedUuidV4) -> Result<(), PosixStoreError> {
    if read_lock_record(file)? != LockRecordState::Clean {
        return Err(PosixStoreError::Lost);
    }
    write_all_at(file, &nonce.0, LOCK_NONCE_START as u64)?;
    file.sync_all().map_err(|_| PosixStoreError::Io)?;
    write_lock_state(file, LOCK_STATE_HELD)?;
    if read_lock_record(file)? == LockRecordState::Held(nonce) {
        Ok(())
    } else {
        Err(PosixStoreError::Lost)
    }
}

fn exact_setup_lock(
    directory: &PosixPrivateDirectory,
    file: &File,
) -> Result<bool, PosixStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
    let facts = metadata(file)?;
    if !facts.exact_private_file(directory.core.process.uid) {
        return Ok(false);
    }
    Ok(secure_openat(
        directory_file,
        OsStr::new(SETUP_LOCK_ENTRY),
        lock_open_flags(),
        Mode::empty(),
    )
    .ok()
    .map(File::from)
    .and_then(|current| metadata(&current).ok())
    .is_some_and(|current| {
        current.identity == facts.identity && current.exact_private_file(directory.core.process.uid)
    }))
}

fn open_or_create_setup_lock(
    directory: &PosixPrivateDirectory,
) -> Result<(File, bool), PosixStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;

    let mut created = false;
    let file = match secure_openat(
        directory_file,
        OsStr::new(SETUP_LOCK_ENTRY),
        lock_open_flags(),
        Mode::empty(),
    ) {
        Ok(file) => File::from(file),
        Err(error) if error == Errno::NOENT => {
            let flags = lock_open_flags() | OFlags::CREATE | OFlags::EXCL;
            match secure_openat(
                directory_file,
                OsStr::new(SETUP_LOCK_ENTRY),
                flags,
                private_file_mode(),
            ) {
                Ok(file) => {
                    created = true;
                    File::from(file)
                }
                Err(create_error) if create_error == Errno::EXIST => {
                    let existing = secure_openat(
                        directory_file,
                        OsStr::new(SETUP_LOCK_ENTRY),
                        lock_open_flags(),
                        Mode::empty(),
                    )
                    .map_err(|_| PosixStoreError::Unsafe)?;
                    File::from(existing)
                }
                Err(_) => return Err(PosixStoreError::Io),
            }
        }
        Err(_) => return Err(PosixStoreError::Unsafe),
    };
    if created {
        rustix_fs::fchmod(&file, private_file_mode()).map_err(|_| PosixStoreError::Io)?;
    }
    drop(state);

    if !exact_setup_lock(directory, &file)? {
        return Err(PosixStoreError::Unsafe);
    }
    Ok((file, created))
}

pub(crate) fn acquire_setup_lease(
    path: &Path,
    nonce: &str,
) -> Result<SetupLeaseAcquireResult, PosixStoreError> {
    let nonce = ValidatedUuidV4::parse(nonce)?;
    let ensured = ensure_private_directory(path)?;
    let directory_disposition = ensured.disposition;
    let directory = ensured.directory;
    let (lock, created) = match open_or_create_setup_lock(&directory) {
        Ok(value) => value,
        Err(PosixStoreError::Unsafe | PosixStoreError::Lost) => {
            return Ok(SetupLeaseAcquireResult::Busy);
        }
        Err(error) => return Err(error),
    };

    match rustix_fs::flock(&lock, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => {}
        Err(error) if error == Errno::WOULDBLOCK || error == Errno::AGAIN => {
            return Ok(SetupLeaseAcquireResult::Busy);
        }
        Err(_) => return Err(PosixStoreError::Io),
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
        Err(PosixStoreError::Unsafe) => return Ok(SetupLeaseAcquireResult::Busy),
        Err(error) => return Err(error),
    };
    write_held_lock_record(&lock, nonce)?;
    if created {
        let state = lock_unpoisoned(&directory.core.state)?;
        let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
        rustix_fs::fsync(directory_file).map_err(|_| PosixStoreError::Io)?;
    }

    let lease = PosixSetupLease {
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
        return Err(PosixStoreError::Lost);
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
    directory: Option<PosixPrivateDirectory>,
    lock: Option<File>,
}

struct LeaseCore {
    nonce: ValidatedUuidV4,
    runtime: Mutex<LeaseRuntime>,
}

impl LeaseCore {
    fn verify_held_locked(&self, runtime: &LeaseRuntime) -> Result<(), PosixStoreError> {
        match runtime.status {
            LeaseStatus::Held => {}
            LeaseStatus::Lost => return Err(PosixStoreError::Lost),
            LeaseStatus::Terminal => return Err(PosixStoreError::Closed),
        }
        let directory = runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?;
        let lock = runtime.lock.as_ref().ok_or(PosixStoreError::Closed)?;
        if !exact_setup_lock(directory, lock)?
            || read_lock_record(lock)? != LockRecordState::Held(self.nonce)
        {
            return Err(PosixStoreError::Lost);
        }
        Ok(())
    }

    fn verify_or_latch_locked(&self, runtime: &mut LeaseRuntime) -> Result<(), PosixStoreError> {
        if let Err(error) = self.verify_held_locked(runtime) {
            if runtime.status != LeaseStatus::Terminal {
                runtime.status = LeaseStatus::Lost;
            }
            return Err(error);
        }
        Ok(())
    }

    fn finish_locked(runtime: &mut LeaseRuntime) {
        runtime.status = LeaseStatus::Terminal;
        if let Some(mut directory) = runtime.directory.take() {
            directory.close();
        }
        runtime.lock.take();
    }
}

pub(crate) struct PosixSetupLease {
    core: Arc<LeaseCore>,
}

impl PosixSetupLease {
    fn verify_held(&self) -> Result<(), PosixStoreError> {
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

    pub(crate) fn release(&mut self) -> Result<(), PosixStoreError> {
        let (mut runtime, poisoned) = match self.core.runtime.lock() {
            Ok(runtime) => (runtime, false),
            Err(poisoned) => (poisoned.into_inner(), true),
        };
        if runtime.status == LeaseStatus::Terminal {
            return Err(PosixStoreError::Closed);
        }
        if poisoned {
            runtime.status = LeaseStatus::Lost;
            LeaseCore::finish_locked(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        let result = (|| {
            self.core.verify_or_latch_locked(&mut runtime)?;
            let lock = runtime.lock.as_ref().ok_or(PosixStoreError::Closed)?;
            write_lock_state(lock, LOCK_STATE_CLEAN)?;
            if read_lock_record(lock)? != LockRecordState::Clean {
                return Err(PosixStoreError::Lost);
            }
            Ok(())
        })();
        if result.is_err() {
            runtime.status = LeaseStatus::Lost;
        }
        LeaseCore::finish_locked(&mut runtime);
        result
    }

    pub(crate) fn abandon(&mut self) -> Result<(), PosixStoreError> {
        let (mut runtime, poisoned) = match self.core.runtime.lock() {
            Ok(runtime) => (runtime, false),
            Err(poisoned) => (poisoned.into_inner(), true),
        };
        if runtime.status == LeaseStatus::Terminal {
            return Err(PosixStoreError::Closed);
        }
        LeaseCore::finish_locked(&mut runtime);
        if poisoned {
            Err(PosixStoreError::Lost)
        } else {
            Ok(())
        }
    }
}

impl Drop for PosixSetupLease {
    fn drop(&mut self) {
        let mut runtime = match self.core.runtime.lock() {
            Ok(runtime) => runtime,
            Err(poisoned) => poisoned.into_inner(),
        };
        if runtime.status != LeaseStatus::Terminal {
            LeaseCore::finish_locked(&mut runtime);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::fs::{self, DirBuilder, OpenOptions};
    use std::io::{Read, Write};
    use std::os::unix::fs::{symlink, DirBuilderExt, OpenOptionsExt, PermissionsExt};
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::Duration;

    use super::*;

    const NONCE_1: &str = "b56c52f5-a090-41eb-a164-1c92e36db94f";
    const NONCE_2: &str = "4657f2a0-739f-4923-86e8-f25f1dc328f9";
    const NONCE_3: &str = "c5a8d21a-9679-43bd-93c7-2c476388d8aa";
    pub(super) const ISOLATION_MARKER: &str = "plurum-native-isolation-v1\n";
    pub(super) const TEST_MARKER: &str = "plurum-posix-native-test-v1\n";
    const CHILD_DIRECTORY_ENV: &str = "PLURUM_POSIX_LEASE_CHILD_DIRECTORY";
    const CHILD_READY_ENV: &str = "PLURUM_POSIX_LEASE_CHILD_READY";
    static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(1);

    pub(super) struct TestRoot {
        pub(super) root: PathBuf,
        pub(super) temporary: PathBuf,
        pub(super) store: PathBuf,
        pub(super) outside: PathBuf,
        pub(super) marker: PathBuf,
    }

    pub(super) fn verified_test_isolation() -> (ProcessIdentity, PathBuf, PathBuf) {
        let process = ProcessIdentity::capture().expect("test process identity must be safe");
        let configured = PathBuf::from(
            env::var("PLURUM_NATIVE_ISOLATION_ROOT")
                .expect("native tests require the isolated runner root"),
        );
        NormalizedAbsolutePath::parse(&configured)
            .expect("isolation root must be a normalized absolute path");
        let configured_metadata =
            fs::symlink_metadata(&configured).expect("isolation root must exist");
        assert!(!configured_metadata.file_type().is_symlink());
        assert!(configured_metadata.is_dir());
        assert_eq!(configured_metadata.uid(), process.uid);
        assert_eq!(
            configured_metadata.mode() & PERMISSION_AND_SPECIAL_BITS,
            PRIVATE_DIRECTORY_MODE
        );
        assert_eq!(
            fs::read_to_string(configured.join(".plurum-native-isolation"))
                .expect("isolation marker must be readable"),
            ISOLATION_MARKER
        );

        let isolation = configured
            .canonicalize()
            .expect("isolation root must canonicalize");
        assert_eq!(isolation, configured);
        let temporary = isolation
            .join("tmp")
            .canonicalize()
            .expect("isolated temporary directory must exist");
        assert_eq!(temporary.parent(), Some(isolation.as_path()));
        let temporary_metadata =
            fs::symlink_metadata(&temporary).expect("temporary root must exist");
        assert!(!temporary_metadata.file_type().is_symlink());
        assert!(temporary_metadata.is_dir());
        assert_eq!(temporary_metadata.uid(), process.uid);
        assert_eq!(
            temporary_metadata.mode() & PERMISSION_AND_SPECIAL_BITS,
            PRIVATE_DIRECTORY_MODE
        );
        (process, isolation, temporary)
    }

    fn verified_child_fixture_paths() -> Option<(PathBuf, PathBuf)> {
        let directory = PathBuf::from(env::var_os(CHILD_DIRECTORY_ENV)?);
        let ready = PathBuf::from(
            env::var_os(CHILD_READY_ENV).expect("lease child ready path must be configured"),
        );
        NormalizedAbsolutePath::parse(&directory)
            .expect("lease child directory must be a normalized absolute path");
        NormalizedAbsolutePath::parse(&ready)
            .expect("lease child ready path must be a normalized absolute path");

        let (process, _, temporary) = verified_test_isolation();
        let test_root = directory
            .parent()
            .expect("lease child directory must have a parent");
        assert_eq!(test_root.parent(), Some(temporary.as_path()));
        assert_eq!(directory, test_root.join("plurum"));
        assert_eq!(ready, test_root.join("lease-child-ready"));

        let root_metadata =
            fs::symlink_metadata(test_root).expect("lease child test root must exist");
        assert!(!root_metadata.file_type().is_symlink());
        assert!(root_metadata.is_dir());
        assert_eq!(root_metadata.uid(), process.uid);
        assert_eq!(
            root_metadata.mode() & PERMISSION_AND_SPECIAL_BITS,
            PRIVATE_DIRECTORY_MODE
        );
        assert_eq!(
            test_root
                .canonicalize()
                .expect("lease child test root must canonicalize"),
            test_root
        );
        let marker = test_root.join(".plurum-posix-native-test");
        let marker_metadata =
            fs::symlink_metadata(&marker).expect("lease child test marker must exist");
        assert!(!marker_metadata.file_type().is_symlink());
        assert!(marker_metadata.is_file());
        assert_eq!(marker_metadata.uid(), process.uid);
        assert_eq!(marker_metadata.nlink(), 1);
        assert_eq!(
            marker_metadata.mode() & PERMISSION_AND_SPECIAL_BITS,
            PRIVATE_FILE_MODE
        );
        assert_eq!(
            fs::read_to_string(marker).expect("lease child test marker must be readable"),
            TEST_MARKER
        );
        assert!(!ready.exists(), "lease child ready path must not preexist");
        Some((directory, ready))
    }

    impl TestRoot {
        pub(super) fn new() -> Self {
            let (_, _, temporary) = verified_test_isolation();

            let sequence = NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed);
            let root = temporary.join(format!("plurum-posix-{}-{sequence}", std::process::id()));
            let mut builder = DirBuilder::new();
            builder.mode(PRIVATE_DIRECTORY_MODE);
            builder
                .create(&root)
                .expect("isolated POSIX test root must be created");
            fs::set_permissions(&root, fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE))
                .expect("test root mode must be private");

            let marker = root.join(".plurum-posix-native-test");
            create_private_file(&marker, TEST_MARKER.as_bytes());
            let outside = root.join("outside-canary");
            create_private_file(&outside, b"outside-canary\n");
            let store = root.join("plurum");
            Self {
                root,
                temporary,
                store,
                outside,
                marker,
            }
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let safe = self.root.starts_with(&self.temporary)
                && fs::symlink_metadata(&self.root)
                    .is_ok_and(|metadata| metadata.is_dir() && !metadata.is_symlink())
                && fs::read_to_string(&self.marker).is_ok_and(|value| value == TEST_MARKER);
            if safe {
                let _ = fs::remove_dir_all(&self.root);
            }
        }
    }

    struct ChildGuard {
        child: Option<Child>,
    }

    impl ChildGuard {
        fn spawn(directory: &Path, ready: &Path) -> Self {
            let child = Command::new(
                env::current_exe().expect("native test binary path must be available"),
            )
            .args([
                "--exact",
                "posix::tests::process_lease_child",
                "--nocapture",
            ])
            .env(CHILD_DIRECTORY_ENV, directory)
            .env(CHILD_READY_ENV, ready)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("lease child must start");
            Self { child: Some(child) }
        }

        fn wait_until_ready(&mut self, ready: &Path) {
            for _ in 0..200 {
                if ready.exists() {
                    return;
                }
                if let Some(status) = self
                    .child
                    .as_mut()
                    .expect("child must exist")
                    .try_wait()
                    .expect("child status must be readable")
                {
                    panic!("lease child exited before readiness: {status}");
                }
                thread::sleep(Duration::from_millis(25));
            }
            panic!("lease child did not become ready");
        }

        fn kill_and_wait(&mut self) {
            if let Some(mut child) = self.child.take() {
                child.kill().expect("lease child must be killable");
                child.wait().expect("lease child must be reapable");
            }
        }
    }

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            if let Some(mut child) = self.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    pub(super) fn create_private_directory(path: &Path) {
        let mut builder = DirBuilder::new();
        builder.mode(PRIVATE_DIRECTORY_MODE);
        builder
            .create(path)
            .expect("private test directory must be created");
        fs::set_permissions(path, fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE))
            .expect("private test directory mode must be set");
    }

    pub(super) fn create_private_file(path: &Path, bytes: &[u8]) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(PRIVATE_FILE_MODE)
            .open(path)
            .expect("private test file must be created");
        fs::set_permissions(path, fs::Permissions::from_mode(PRIVATE_FILE_MODE))
            .expect("private test file mode must be set");
        file.write_all(bytes)
            .expect("private test file must be written");
        file.sync_all().expect("private test file must sync");
    }

    pub(super) fn overwrite_private_file(path: &Path, bytes: &[u8]) {
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)
            .expect("private test file must open for replacement");
        file.write_all(bytes)
            .expect("private test file replacement must be written");
        file.sync_all()
            .expect("private test file replacement must sync");
    }

    fn opened_directory(path: &Path) -> PosixPrivateDirectory {
        match open_private_directory(path).expect("directory open must complete") {
            PrivateDirectoryOpenResult::Missing => panic!("test directory unexpectedly missing"),
            PrivateDirectoryOpenResult::Opened(directory) => directory,
        }
    }

    fn opened_credential(directory: &PosixPrivateDirectory) -> PosixCredentialReadHandle {
        match directory
            .open_credential_read_only()
            .expect("credential open must complete")
        {
            CredentialReadOpenResult::Missing => panic!("test credential unexpectedly missing"),
            CredentialReadOpenResult::Opened(file) => file,
        }
    }

    pub(super) fn acquired_lease(
        path: &Path,
        nonce: &str,
    ) -> (PriorLease, DirectoryDisposition, PosixSetupLease) {
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
    fn secure_directory_reads_are_bounded_content_sensitive_and_terminal() {
        let test = TestRoot::new();
        let ensured = ensure_private_directory(&test.store).expect("directory must be ensured");
        assert_eq!(ensured.disposition, DirectoryDisposition::Created);
        let mut directory = ensured.directory;
        let directory_attestation = directory.attest().expect("directory must attest");
        assert!(directory_attestation.canonical_current);
        assert!(directory_attestation.current_user);
        assert!(directory_attestation.private_mode);

        let credential = test.store.join(CREDENTIAL_ENTRY);
        create_private_file(&credential, b"alpha");
        let mut file = opened_credential(&directory);
        let first = file.attest().expect("credential must attest");
        assert!(first.security.is_secure());
        assert_eq!(
            file.read_bounded(0).expect("zero read must succeed"),
            BoundedRead {
                bytes: Vec::new(),
                end_of_file: false,
            }
        );
        assert_eq!(
            file.read_bounded(5).expect("exact read must succeed"),
            BoundedRead {
                bytes: b"alpha".to_vec(),
                end_of_file: true,
            }
        );

        overwrite_private_file(&credential, b"bravo");
        let second = file.attest().expect("changed credential must reattest");
        assert_ne!(first.revision, second.revision);
        assert_eq!(
            file.read_bounded(5)
                .expect("repeated positional read must succeed"),
            BoundedRead {
                bytes: b"bravo".to_vec(),
                end_of_file: true,
            }
        );

        directory.close();
        assert_eq!(file.security_attestation(), Err(PosixStoreError::Closed));
        assert_eq!(file.read_bounded(5), Err(PosixStoreError::Closed));
        file.close();
    }

    #[test]
    fn revision_digest_changes_for_bytes_with_identical_metadata() {
        let test = TestRoot::new();
        create_private_file(&test.root.join("metadata-source"), b"alpha");
        let source =
            File::open(test.root.join("metadata-source")).expect("metadata source must open");
        let facts = metadata(&source).expect("metadata facts must load");

        let first = digest_metadata(
            b"plurum-posix-credential-revision-v1\0",
            facts,
            true,
            Some(facts.identity),
            b"alpha",
        );
        let second = digest_metadata(
            b"plurum-posix-credential-revision-v1\0",
            facts,
            true,
            Some(facts.identity),
            b"bravo",
        );

        assert_ne!(first, second);
    }

    #[test]
    fn metadata_owner_policy_rejects_other_users() {
        let test = TestRoot::new();
        let credential = test.root.join("owner-policy");
        create_private_file(&credential, b"private");
        let facts = metadata(&File::open(&credential).expect("owner fixture must open"))
            .expect("owner metadata must load");
        let process = ProcessIdentity::capture().expect("test process must be supported");
        let other_uid = if process.uid == u32::MAX {
            process.uid - 1
        } else {
            process.uid + 1
        };
        let other_owner = MetadataFacts {
            uid: other_uid,
            ..facts
        };

        assert!(facts.owned_by(process.uid));
        assert!(facts.exact_private_file(process.uid));
        assert!(!other_owner.owned_by(process.uid));
        assert!(!other_owner.exact_private_file(process.uid));
    }

    #[test]
    fn process_identity_policy_rejects_every_elevated_shape() {
        assert_eq!(
            ProcessIdentity::validate(501, 501, 20, 20, false, false),
            Ok(ProcessIdentity { uid: 501, gid: 20 })
        );
        for context in [
            (0, 0, 20, 20, false, false),
            (501, 0, 20, 20, false, false),
            (501, 502, 20, 20, false, false),
            (501, 501, 0, 0, false, false),
            (501, 501, 20, 0, false, false),
            (501, 501, 20, 21, false, false),
            (501, 501, 20, 20, true, false),
            (501, 501, 20, 20, false, true),
        ] {
            assert_eq!(
                ProcessIdentity::validate(
                    context.0, context.1, context.2, context.3, context.4, context.5,
                ),
                Err(PosixStoreError::Unsafe)
            );
        }
    }

    #[test]
    fn bounded_reads_enforce_the_native_ceiling() {
        let test = TestRoot::new();
        let directory = ensure_private_directory(&test.store)
            .expect("directory must be ensured")
            .directory;
        let credential = test.store.join(CREDENTIAL_ENTRY);
        let bytes = vec![b'x'; MAX_ATTESTED_BYTES];
        create_private_file(&credential, &bytes);
        let file = opened_credential(&directory);

        assert!(file.attest().is_ok());
        let exact = file
            .read_bounded(MAX_ATTESTED_BYTES)
            .expect("maximum bounded read must succeed");
        assert_eq!(exact.bytes.len(), MAX_ATTESTED_BYTES);
        assert!(exact.end_of_file);
        assert_eq!(
            file.read_bounded(MAX_ATTESTED_BYTES + 1),
            Err(PosixStoreError::Limit)
        );
    }

    #[test]
    fn expired_credential_handles_do_not_accumulate() {
        let test = TestRoot::new();
        let directory = ensure_private_directory(&test.store)
            .expect("directory must be ensured")
            .directory;
        create_private_file(&test.store.join(CREDENTIAL_ENTRY), b"private");

        for _ in 0..64 {
            drop(opened_credential(&directory));
        }
        let retained = opened_credential(&directory);
        let state = lock_unpoisoned(&directory.core.state).expect("directory state must lock");
        assert_eq!(state.children.len(), 1);
        drop(state);
        drop(retained);
    }

    #[test]
    fn unsafe_modes_special_bits_and_hard_links_are_never_read() {
        let test = TestRoot::new();
        create_private_directory(&test.store);
        fs::set_permissions(&test.store, fs::Permissions::from_mode(0o755))
            .expect("broader directory mode must be set");
        let broader_directory = opened_directory(&test.store);
        assert!(
            !broader_directory
                .attest()
                .expect("broader directory must attest")
                .private_mode
        );
        assert!(matches!(
            broader_directory.open_credential_read_only(),
            Err(PosixStoreError::Unsafe)
        ));
        drop(broader_directory);
        fs::set_permissions(
            &test.store,
            fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE),
        )
        .expect("private directory mode must be restored");

        let credential = test.store.join(CREDENTIAL_ENTRY);
        create_private_file(&credential, b"do-not-read");
        let directory = opened_directory(&test.store);
        for mode in [0o644, 0o1600] {
            fs::set_permissions(&credential, fs::Permissions::from_mode(mode))
                .expect("unsafe credential mode must be set");
            let mut file = opened_credential(&directory);
            let security = file
                .security_attestation()
                .expect("unsafe file metadata must remain inspectable");
            assert!(!security.private_mode);
            assert_eq!(file.attest(), Err(PosixStoreError::Unsafe));
            assert_eq!(file.read_bounded(32), Err(PosixStoreError::Unsafe));
            file.close();
        }

        fs::remove_file(&credential).expect("unsafe credential must be removable");
        let source = test.store.join("hard-link-source");
        create_private_file(&source, b"do-not-read");
        fs::hard_link(&source, &credential).expect("hard link fixture must be created");
        let file = opened_credential(&directory);
        let security = file
            .security_attestation()
            .expect("hard-linked file metadata must remain inspectable");
        assert_eq!(security.links, 2);
        assert_eq!(file.attest(), Err(PosixStoreError::Unsafe));
        assert_eq!(file.read_bounded(32), Err(PosixStoreError::Unsafe));
    }

    #[test]
    fn symlinks_and_nonregular_entries_fail_without_touching_targets() {
        let test = TestRoot::new();
        let real = test.root.join("real");
        create_private_directory(&real);
        create_private_directory(&real.join("plurum"));
        let intermediate = test.root.join("intermediate");
        symlink(&real, &intermediate).expect("intermediate symlink must be created");
        assert!(matches!(
            open_private_directory(&intermediate.join("plurum")),
            Err(PosixStoreError::Unsafe)
        ));
        fs::remove_file(&intermediate).expect("intermediate symlink must be removed");

        symlink(&real, &test.store).expect("final directory symlink must be created");
        assert!(matches!(
            open_private_directory(&test.store),
            Err(PosixStoreError::Unsafe)
        ));
        fs::remove_file(&test.store).expect("final directory symlink must be removed");

        let directory = ensure_private_directory(&test.store)
            .expect("private directory must be ensured")
            .directory;
        let credential = test.store.join(CREDENTIAL_ENTRY);
        symlink(&test.outside, &credential).expect("credential symlink must be created");
        assert!(matches!(
            directory.open_credential_read_only(),
            Err(PosixStoreError::Unsafe)
        ));
        assert_eq!(
            fs::read_to_string(&test.outside).expect("outside canary must remain readable"),
            "outside-canary\n"
        );
        fs::remove_file(&credential).expect("credential symlink must be removed");

        #[cfg(target_os = "linux")]
        {
            let directory_fd = rustix_fs::open(&test.store, directory_open_flags(), Mode::empty())
                .expect("test directory descriptor must open");
            rustix_fs::mkfifoat(&directory_fd, CREDENTIAL_ENTRY, private_file_mode())
                .expect("FIFO fixture must be created");
            assert!(matches!(
                directory.open_credential_read_only(),
                Err(PosixStoreError::Unsafe)
            ));
        }
    }

    #[test]
    fn replacement_detaches_retained_directory_and_file_handles() {
        let test = TestRoot::new();
        let mut directory = ensure_private_directory(&test.store)
            .expect("private directory must be ensured")
            .directory;
        let credential = test.store.join(CREDENTIAL_ENTRY);
        create_private_file(&credential, b"original");
        let file = opened_credential(&directory);
        let original = file
            .security_attestation()
            .expect("original credential must attest");

        let detached_file = test.store.join("detached-credential");
        fs::rename(&credential, &detached_file).expect("credential must be detached");
        create_private_file(&credential, b"replaced");
        let detached = file
            .security_attestation()
            .expect("detached file handle must remain inspectable");
        assert_eq!(detached.identity, original.identity);
        assert!(!detached.canonical_current);
        assert_eq!(file.attest(), Err(PosixStoreError::Unsafe));
        assert_eq!(file.read_bounded(32), Err(PosixStoreError::Unsafe));

        let original_directory = directory.attest().expect("directory must attest");
        let detached_directory = test.root.join("detached-directory");
        fs::rename(&test.store, &detached_directory).expect("directory must be detached");
        create_private_directory(&test.store);
        let after = directory
            .attest()
            .expect("retained directory must remain inspectable");
        assert_eq!(after.identity, original_directory.identity);
        assert!(!after.canonical_current);
        assert!(matches!(
            directory.open_credential_read_only(),
            Err(PosixStoreError::Lost)
        ));
        directory.close();
    }

    #[test]
    fn persistent_lock_serializes_and_clean_release_preserves_its_inode() {
        let test = TestRoot::new();
        let (prior, disposition, mut first) = acquired_lease(&test.store, NONCE_1);
        assert_eq!(prior, PriorLease::Absent);
        assert_eq!(disposition, DirectoryDisposition::Created);
        assert_eq!(first.renew(), LeaseRenewal::Held);
        let lock = test.store.join(SETUP_LOCK_ENTRY);
        let first_identity = MetadataFacts::from_metadata(
            &fs::metadata(&lock).expect("persistent lock metadata must load"),
        )
        .identity;

        assert!(matches!(
            acquire_setup_lease(&test.store, NONCE_2),
            Ok(SetupLeaseAcquireResult::Busy)
        ));
        first.release().expect("first lease must release cleanly");
        assert_eq!(first.renew(), LeaseRenewal::Lost);

        let (prior, disposition, mut second) = acquired_lease(&test.store, NONCE_2);
        assert_eq!(prior, PriorLease::Absent);
        assert_eq!(disposition, DirectoryDisposition::Existing);
        let second_identity = MetadataFacts::from_metadata(
            &fs::metadata(&lock).expect("persistent lock metadata must reload"),
        )
        .identity;
        assert_eq!(first_identity, second_identity);
        second.release().expect("second lease must release cleanly");
        assert_eq!(second.release(), Err(PosixStoreError::Closed));

        let (_, _, mut abandoned) = acquired_lease(&test.store, NONCE_3);
        abandoned.abandon().expect("lease must abandon terminally");
        let (prior, _, mut recovered) = acquired_lease(&test.store, NONCE_1);
        assert_eq!(prior, PriorLease::ProvenAbandoned);
        recovered
            .release()
            .expect("lease after explicit abandonment must release");
    }

    #[test]
    fn malformed_and_unsafe_lock_records_remain_fail_closed() {
        let test = TestRoot::new();
        create_private_directory(&test.store);
        let lock = test.store.join(SETUP_LOCK_ENTRY);
        create_private_file(&lock, b"malformed");
        assert!(matches!(
            acquire_setup_lease(&test.store, NONCE_1),
            Ok(SetupLeaseAcquireResult::Busy)
        ));
        assert_eq!(
            fs::read(&lock).expect("malformed lock must remain"),
            b"malformed"
        );

        fs::remove_file(&lock).expect("malformed lock must be removable");
        create_private_file(&lock, b"");
        {
            let record = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&lock)
                .expect("reserved-byte fixture must open");
            initialize_clean_lock_record(&record).expect("clean record must initialize");
            write_all_at(&record, &[1], LOCK_HEADER_END as u64)
                .expect("reserved byte must be written");
            record.sync_all().expect("reserved byte must sync");
            assert_eq!(read_lock_record(&record), Err(PosixStoreError::Unsafe));
        }
        assert!(matches!(
            acquire_setup_lease(&test.store, NONCE_1),
            Ok(SetupLeaseAcquireResult::Busy)
        ));
        assert_eq!(
            fs::read(&lock).expect("reserved-byte record must remain")[LOCK_HEADER_END],
            1
        );

        fs::remove_file(&lock).expect("reserved-byte record must be removable");
        symlink(&test.outside, &lock).expect("lock symlink must be created");
        assert!(matches!(
            acquire_setup_lease(&test.store, NONCE_1),
            Ok(SetupLeaseAcquireResult::Busy)
        ));
        assert_eq!(
            fs::read_to_string(&test.outside).expect("outside canary must remain readable"),
            "outside-canary\n"
        );

        fs::remove_file(&lock).expect("lock symlink must be removable");
        let source = test.store.join("lock-source");
        create_private_file(&source, b"");
        fs::hard_link(&source, &lock).expect("hard-linked lock must be created");
        assert!(matches!(
            acquire_setup_lease(&test.store, NONCE_1),
            Ok(SetupLeaseAcquireResult::Busy)
        ));
        assert_eq!(
            fs::metadata(&source)
                .expect("hard-linked source metadata must load")
                .nlink(),
            2
        );
    }

    #[test]
    fn replacing_a_held_lock_path_loses_the_lease_and_wedges_safely() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        let lock = test.store.join(SETUP_LOCK_ENTRY);
        let detached = test.store.join("detached-setup-lock");
        fs::rename(&lock, &detached).expect("held lock must be detached");
        create_private_file(&lock, b"unknown replacement");

        assert_eq!(lease.renew(), LeaseRenewal::Lost);
        assert_eq!(lease.release(), Err(PosixStoreError::Lost));
        assert!(matches!(
            acquire_setup_lease(&test.store, NONCE_2),
            Ok(SetupLeaseAcquireResult::Busy)
        ));
        assert_eq!(
            fs::read(&lock).expect("replacement lock must remain readable"),
            b"unknown replacement"
        );
    }

    #[test]
    fn uninitialized_lock_is_recovered_without_claiming_abandonment() {
        let test = TestRoot::new();
        create_private_directory(&test.store);
        create_private_file(&test.store.join(SETUP_LOCK_ENTRY), b"");
        let (prior, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        assert_eq!(prior, PriorLease::Absent);
        assert_eq!(lease.renew(), LeaseRenewal::Held);
        lease.release().expect("initialized lease must release");
    }

    #[test]
    fn invalid_nonce_is_rejected_before_any_filesystem_mutation() {
        let test = TestRoot::new();
        assert!(matches!(
            acquire_setup_lease(&test.store, "not-a-valid-nonce"),
            Err(PosixStoreError::InvalidInput)
        ));
        assert!(!test.store.exists());
    }

    #[test]
    fn process_death_releases_kernel_exclusion_and_proves_abandonment() {
        if env::var_os(CHILD_DIRECTORY_ENV).is_some() {
            return;
        }
        let test = TestRoot::new();
        let ready = test.root.join("lease-child-ready");
        let mut child = ChildGuard::spawn(&test.store, &ready);
        child.wait_until_ready(&ready);

        assert!(matches!(
            acquire_setup_lease(&test.store, NONCE_2),
            Ok(SetupLeaseAcquireResult::Busy)
        ));
        child.kill_and_wait();

        let (prior, disposition, mut recovered) = acquired_lease(&test.store, NONCE_3);
        assert_eq!(prior, PriorLease::ProvenAbandoned);
        assert_eq!(disposition, DirectoryDisposition::Existing);
        assert_eq!(recovered.renew(), LeaseRenewal::Held);
        recovered.release().expect("recovered lease must release");
    }

    #[test]
    fn process_lease_child() {
        let Some((directory, ready)) = verified_child_fixture_paths() else {
            return;
        };
        let (_, _, lease) = acquired_lease(&directory, NONCE_1);
        assert_eq!(lease.renew(), LeaseRenewal::Held);
        create_private_file(&ready, b"ready\n");
        thread::sleep(Duration::from_secs(60));
        drop(lease);
    }

    #[test]
    fn lock_record_state_transition_is_crash_safe_by_construction() {
        let test = TestRoot::new();
        create_private_directory(&test.store);
        let lock_path = test.store.join(SETUP_LOCK_ENTRY);
        create_private_file(&lock_path, b"");
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .expect("lock fixture must open");

        initialize_clean_lock_record(&lock).expect("clean record must initialize");
        assert_eq!(read_lock_record(&lock), Ok(LockRecordState::Clean));
        let nonce = ValidatedUuidV4::parse(NONCE_1).expect("nonce must validate");
        write_all_at(&lock, &nonce.0, LOCK_NONCE_START as u64).expect("nonce payload must write");
        lock.sync_all().expect("nonce payload must sync");
        assert_eq!(
            read_lock_record(&lock),
            Ok(LockRecordState::Clean),
            "a crash before the held marker remains clean"
        );
        write_lock_state(&lock, LOCK_STATE_HELD).expect("held state must commit");
        assert_eq!(read_lock_record(&lock), Ok(LockRecordState::Held(nonce)));
        write_lock_state(&lock, LOCK_STATE_CLEAN).expect("clean state must commit");
        assert_eq!(
            read_lock_record(&lock),
            Ok(LockRecordState::Clean),
            "a clean marker safely ignores the stale nonce payload"
        );
    }

    #[test]
    fn test_root_cleanup_marker_is_not_a_symlink() {
        let test = TestRoot::new();
        let mut contents = String::new();
        File::open(&test.marker)
            .expect("test marker must open")
            .read_to_string(&mut contents)
            .expect("test marker must be readable");
        assert_eq!(contents, TEST_MARKER);
        assert!(!fs::symlink_metadata(&test.marker)
            .expect("test marker metadata must load")
            .file_type()
            .is_symlink());
    }
}
