use std::ffi::{OsStr, OsString};
use std::fs::{File, Metadata};
use std::os::fd::AsFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use rustix::fs::{self as rustix_fs, Mode, OFlags};
use rustix::io::Errno;
use sha2::{Digest, Sha256};

use super::image::{attest_native_image, NativeImageAttestation};
use super::{ExecutableAuthorityError, ExecutableOwner, RetainedHandleFootprint};

const MAX_PATH_BYTES: usize = 32_767;
const MAX_COMPONENTS: usize = 256;
const BROAD_WRITE_BITS: u32 = 0o022;
const SET_ID_BITS: u32 = 0o6000;
const DIRECTORY_TYPE: u32 = 0o040000;
const REGULAR_FILE_TYPE: u32 = 0o100000;
const FILE_TYPE_MASK: u32 = 0o170000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ObjectFacts {
    device: u64,
    inode: u64,
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

impl ObjectFacts {
    fn capture(file: &File) -> Result<Self, ExecutableAuthorityError> {
        file.metadata()
            .map(|metadata| Self::from_metadata(&metadata))
            .map_err(|_| ExecutableAuthorityError::Unavailable)
    }

    fn from_metadata(metadata: &Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
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

    fn same_object(self, other: Self) -> bool {
        self.device == other.device && self.inode == other.inode
    }

    fn same_directory_authority(self, other: Self) -> bool {
        self.same_object(other)
            && self.mode == other.mode
            && self.uid == other.uid
            && self.gid == other.gid
    }

    fn update_directory_digest(self, digest: &mut Sha256) {
        digest.update(self.device.to_le_bytes());
        digest.update(self.inode.to_le_bytes());
        digest.update(self.mode.to_le_bytes());
        digest.update(self.uid.to_le_bytes());
        digest.update(self.gid.to_le_bytes());
    }

    fn update_digest(self, digest: &mut Sha256) {
        digest.update(self.device.to_le_bytes());
        digest.update(self.inode.to_le_bytes());
        digest.update(self.mode.to_le_bytes());
        digest.update(self.uid.to_le_bytes());
        digest.update(self.gid.to_le_bytes());
        digest.update(self.links.to_le_bytes());
        digest.update(self.size.to_le_bytes());
        digest.update(self.modified_seconds.to_le_bytes());
        digest.update(self.modified_nanoseconds.to_le_bytes());
        digest.update(self.changed_seconds.to_le_bytes());
        digest.update(self.changed_nanoseconds.to_le_bytes());
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct NormalizedAbsolutePath {
    path: PathBuf,
    components: Vec<OsString>,
}

impl NormalizedAbsolutePath {
    fn parse(path: &Path) -> Result<Self, ExecutableAuthorityError> {
        if !path.is_absolute()
            || path.as_os_str().as_bytes().is_empty()
            || path.as_os_str().as_bytes().len() > MAX_PATH_BYTES
        {
            return Err(ExecutableAuthorityError::InvalidInput);
        }
        let mut components = Vec::new();
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name)
                    if !name.as_bytes().is_empty()
                        && !name.as_bytes().contains(&0)
                        && components.len() < MAX_COMPONENTS =>
                {
                    components.push(name.to_os_string());
                }
                _ => return Err(ExecutableAuthorityError::InvalidInput),
            }
        }
        if components.is_empty() {
            return Err(ExecutableAuthorityError::InvalidInput);
        }
        let mut normalized = PathBuf::from("/");
        for component in &components {
            normalized.push(component);
        }
        if normalized.as_os_str() != path.as_os_str() {
            return Err(ExecutableAuthorityError::InvalidInput);
        }
        Ok(Self {
            path: normalized,
            components,
        })
    }
}

struct RetainedDirectory {
    file: File,
    facts: ObjectFacts,
}

pub(super) struct PlatformExecutableLease {
    source_path: PathBuf,
    excluded_project_directory: PathBuf,
    excluded: RetainedDirectory,
    directories: Vec<RetainedDirectory>,
    executable: File,
    executable_facts: ObjectFacts,
    image_attestation: NativeImageAttestation,
    owner: ExecutableOwner,
    entry_revision: [u8; 32],
}

pub(super) struct PlatformDirectoryLease {
    path: PathBuf,
    excluded_project_directory: PathBuf,
    excluded: RetainedDirectory,
    directories: Vec<RetainedDirectory>,
}

impl PlatformDirectoryLease {
    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn same_evidence(&self, other: &Self) -> bool {
        self.path == other.path
            && self.excluded_project_directory == other.excluded_project_directory
            && self
                .excluded
                .facts
                .same_directory_authority(other.excluded.facts)
            && self.directories.len() == other.directories.len()
            && self
                .directories
                .iter()
                .map(|entry| entry.facts)
                .zip(other.directories.iter().map(|entry| entry.facts))
                .all(|(left, right)| left.same_directory_authority(right))
    }

    pub(super) fn directory(&self) -> &File {
        &self
            .directories
            .last()
            .expect("trusted directory chains are nonempty")
            .file
    }
}

impl PlatformExecutableLease {
    pub(super) fn source_path(&self) -> &Path {
        &self.source_path
    }

    pub(super) fn excluded_project_directory(&self) -> &Path {
        &self.excluded_project_directory
    }

    pub(super) fn owner(&self) -> ExecutableOwner {
        self.owner
    }

    pub(super) fn entry_revision(&self) -> [u8; 32] {
        self.entry_revision
    }

    pub(super) fn same_evidence(&self, other: &Self) -> bool {
        self.source_path == other.source_path
            && self.excluded_project_directory == other.excluded_project_directory
            && self
                .excluded
                .facts
                .same_directory_authority(other.excluded.facts)
            && self.directories.len() == other.directories.len()
            && self
                .directories
                .iter()
                .map(|entry| entry.facts)
                .zip(other.directories.iter().map(|entry| entry.facts))
                .all(|(left, right)| left.same_directory_authority(right))
            && self.executable_facts == other.executable_facts
            && self.image_attestation == other.image_attestation
            && self.owner == other.owner
            && self.entry_revision == other.entry_revision
    }

    pub(super) fn executable(&self) -> &File {
        &self.executable
    }

    #[cfg(target_os = "macos")]
    pub(super) fn mapped_file_offset(&self) -> u64 {
        self.image_attestation.mapped_file_offset()
    }
}

pub(super) fn resolve_direct_executable(
    candidate_path: &Path,
    excluded_project_directory: &Path,
) -> Result<PlatformExecutableLease, ExecutableAuthorityError> {
    let candidate = NormalizedAbsolutePath::parse(candidate_path)?;
    let excluded = NormalizedAbsolutePath::parse(excluded_project_directory)?;
    let first = capture_once(&candidate, &excluded)?;
    let second = capture_once(&candidate, &excluded)?;
    if !first.same_evidence(&second) {
        return Err(ExecutableAuthorityError::Conflict);
    }
    Ok(second)
}

pub(super) fn direct_executable_footprint(
    candidate_path: &Path,
    excluded_project_directory: &Path,
) -> Result<RetainedHandleFootprint, ExecutableAuthorityError> {
    let candidate = NormalizedAbsolutePath::parse(candidate_path)?;
    let excluded = NormalizedAbsolutePath::parse(excluded_project_directory)?;
    RetainedHandleFootprint::executable(candidate.components.len(), excluded.components.len())
}

pub(super) fn trusted_directory_footprint(
    path: &Path,
    executable: &PlatformExecutableLease,
) -> Result<RetainedHandleFootprint, ExecutableAuthorityError> {
    let path = NormalizedAbsolutePath::parse(path)?;
    let excluded = NormalizedAbsolutePath::parse(&executable.excluded_project_directory)?;
    RetainedHandleFootprint::directory(path.components.len(), excluded.components.len())
}

pub(super) fn reattest_directory_footprint(
    expected: &PlatformDirectoryLease,
) -> Result<RetainedHandleFootprint, ExecutableAuthorityError> {
    let path = NormalizedAbsolutePath::parse(&expected.path)?;
    let excluded = NormalizedAbsolutePath::parse(&expected.excluded_project_directory)?;
    RetainedHandleFootprint::directory(path.components.len(), excluded.components.len())
}

pub(super) fn resolve_trusted_directory(
    path: &Path,
    executable: &PlatformExecutableLease,
) -> Result<PlatformDirectoryLease, ExecutableAuthorityError> {
    let path = NormalizedAbsolutePath::parse(path)?;
    let excluded = NormalizedAbsolutePath::parse(&executable.excluded_project_directory)?;
    let first = capture_directory_once(&path, &excluded, &executable.excluded)?;
    let second = capture_directory_once(&path, &excluded, &executable.excluded)?;
    if !first.same_evidence(&second) {
        return Err(ExecutableAuthorityError::Conflict);
    }
    Ok(second)
}

pub(super) fn reattest_trusted_directory(
    expected: &PlatformDirectoryLease,
) -> Result<PlatformDirectoryLease, ExecutableAuthorityError> {
    let path = NormalizedAbsolutePath::parse(&expected.path)?;
    let excluded = NormalizedAbsolutePath::parse(&expected.excluded_project_directory)?;
    let first = capture_directory_once(&path, &excluded, &expected.excluded)?;
    let second = capture_directory_once(&path, &excluded, &expected.excluded)?;
    if !first.same_evidence(&second) {
        return Err(ExecutableAuthorityError::Conflict);
    }
    Ok(second)
}

fn capture_directory_once(
    path: &NormalizedAbsolutePath,
    excluded: &NormalizedAbsolutePath,
    bound_excluded: &RetainedDirectory,
) -> Result<PlatformDirectoryLease, ExecutableAuthorityError> {
    let current_uid = rustix::process::getuid().as_raw();
    if current_uid == 0 {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let excluded_leaf = reopen_bound_excluded(excluded, bound_excluded, current_uid)?;
    let excluded_facts = excluded_leaf.facts;
    drop(excluded_leaf);
    let directories = open_directory_chain(path, current_uid)?;
    if directories
        .iter()
        .any(|directory| directory.facts.same_object(bound_excluded.facts))
    {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let confirmed_excluded = reopen_bound_excluded(excluded, bound_excluded, current_uid)?;
    if !excluded_facts.same_directory_authority(confirmed_excluded.facts) {
        return Err(ExecutableAuthorityError::Conflict);
    }
    Ok(PlatformDirectoryLease {
        path: path.path.clone(),
        excluded_project_directory: excluded.path.clone(),
        excluded: confirmed_excluded,
        directories,
    })
}

fn reopen_bound_excluded(
    excluded: &NormalizedAbsolutePath,
    bound: &RetainedDirectory,
    current_uid: u32,
) -> Result<RetainedDirectory, ExecutableAuthorityError> {
    let retained_facts = ObjectFacts::capture(&bound.file)?;
    require_secure_directory(&bound.file, retained_facts, current_uid)?;
    if !retained_facts.same_directory_authority(bound.facts) {
        return Err(ExecutableAuthorityError::Conflict);
    }

    let excluded_chain =
        open_directory_chain(excluded, current_uid).map_err(|error| match error {
            ExecutableAuthorityError::Missing => ExecutableAuthorityError::Conflict,
            other => other,
        })?;
    let reopened = excluded_chain
        .into_iter()
        .last()
        .ok_or(ExecutableAuthorityError::Unavailable)?;
    if !retained_facts.same_directory_authority(reopened.facts) {
        return Err(ExecutableAuthorityError::Conflict);
    }
    Ok(reopened)
}

fn capture_once(
    candidate: &NormalizedAbsolutePath,
    excluded: &NormalizedAbsolutePath,
) -> Result<PlatformExecutableLease, ExecutableAuthorityError> {
    let current_uid = rustix::process::getuid().as_raw();
    if current_uid == 0 {
        return Err(ExecutableAuthorityError::Unsafe);
    }

    let excluded_chain = open_directory_chain(excluded, current_uid)?;
    let excluded_identity = excluded_chain
        .last()
        .ok_or(ExecutableAuthorityError::Unavailable)?
        .facts;
    let excluded_leaf = excluded_chain
        .into_iter()
        .last()
        .ok_or(ExecutableAuthorityError::Unavailable)?;

    let root = open_root_directory()?;
    let root_facts = ObjectFacts::capture(&root)?;
    require_secure_directory(&root, root_facts, current_uid)?;
    if root_facts.same_object(excluded_identity) {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let mut directories = vec![RetainedDirectory {
        file: root,
        facts: root_facts,
    }];

    for component in &candidate.components[..candidate.components.len() - 1] {
        let parent = &directories
            .last()
            .ok_or(ExecutableAuthorityError::Unavailable)?
            .file;
        let file = open_directory_at(parent, component)?;
        let facts = ObjectFacts::capture(&file)?;
        require_secure_directory(&file, facts, current_uid)?;
        if facts.same_object(excluded_identity) {
            return Err(ExecutableAuthorityError::Unsafe);
        }
        directories.push(RetainedDirectory { file, facts });
    }

    let parent = &directories
        .last()
        .ok_or(ExecutableAuthorityError::Unavailable)?
        .file;
    let executable = open_file_at(
        parent,
        candidate
            .components
            .last()
            .ok_or(ExecutableAuthorityError::InvalidInput)?,
    )?;
    let executable_facts = ObjectFacts::capture(&executable)?;
    let owner = require_secure_executable(&executable, executable_facts, current_uid)?;
    let image_attestation = attest_native_image(&executable, executable_facts.size)?;
    if ObjectFacts::capture(&executable)? != executable_facts {
        return Err(ExecutableAuthorityError::Conflict);
    }

    let mut digest = Sha256::new();
    digest.update(b"plurum-posix-direct-executable-entry-v1\0");
    digest.update(candidate.path.as_os_str().as_bytes());
    digest.update([0]);
    excluded_leaf.facts.update_directory_digest(&mut digest);
    for directory in &directories {
        directory.facts.update_directory_digest(&mut digest);
    }
    executable_facts.update_digest(&mut digest);
    image_attestation.update_digest(&mut digest);
    digest.update([match owner {
        ExecutableOwner::CurrentUser => 1,
        ExecutableOwner::TrustedSystem => 2,
    }]);
    let bytes = digest.finalize();
    let mut entry_revision = [0_u8; 32];
    entry_revision.copy_from_slice(&bytes);

    Ok(PlatformExecutableLease {
        source_path: candidate.path.clone(),
        excluded_project_directory: excluded.path.clone(),
        excluded: excluded_leaf,
        directories,
        executable,
        executable_facts,
        image_attestation,
        owner,
        entry_revision,
    })
}

fn open_directory_chain(
    path: &NormalizedAbsolutePath,
    current_uid: u32,
) -> Result<Vec<RetainedDirectory>, ExecutableAuthorityError> {
    let root = open_root_directory()?;
    let root_facts = ObjectFacts::capture(&root)?;
    require_secure_directory(&root, root_facts, current_uid)?;
    let mut result = vec![RetainedDirectory {
        file: root,
        facts: root_facts,
    }];
    for component in &path.components {
        let parent = &result
            .last()
            .ok_or(ExecutableAuthorityError::Unavailable)?
            .file;
        let file = open_directory_at(parent, component)?;
        let facts = ObjectFacts::capture(&file)?;
        require_secure_directory(&file, facts, current_uid)?;
        result.push(RetainedDirectory { file, facts });
    }
    Ok(result)
}

fn open_root_directory() -> Result<File, ExecutableAuthorityError> {
    rustix_fs::open(
        Path::new("/"),
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(classify_open_error)
}

fn open_directory_at(parent: &File, name: &OsStr) -> Result<File, ExecutableAuthorityError> {
    rustix_fs::openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(classify_open_error)
}

fn open_file_at(parent: &File, name: &OsStr) -> Result<File, ExecutableAuthorityError> {
    rustix_fs::openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(classify_open_error)
}

fn classify_open_error(error: Errno) -> ExecutableAuthorityError {
    match error {
        Errno::NOENT => ExecutableAuthorityError::Missing,
        Errno::LOOP | Errno::NOTDIR | Errno::ACCESS | Errno::PERM => {
            ExecutableAuthorityError::Unsafe
        }
        _ => ExecutableAuthorityError::Unavailable,
    }
}

fn require_secure_directory(
    file: &File,
    facts: ObjectFacts,
    current_uid: u32,
) -> Result<(), ExecutableAuthorityError> {
    if facts.mode & FILE_TYPE_MASK != DIRECTORY_TYPE
        || (facts.uid != current_uid && facts.uid != 0)
        || facts.mode & BROAD_WRITE_BITS != 0
        || facts.mode & SET_ID_BITS != 0
    {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    require_safe_access_metadata(file, false)
}

fn require_secure_executable(
    file: &File,
    facts: ObjectFacts,
    current_uid: u32,
) -> Result<ExecutableOwner, ExecutableAuthorityError> {
    let owner = if facts.uid == current_uid {
        ExecutableOwner::CurrentUser
    } else if facts.uid == 0 {
        ExecutableOwner::TrustedSystem
    } else {
        return Err(ExecutableAuthorityError::Unsafe);
    };
    let executable_for_user = match owner {
        ExecutableOwner::CurrentUser => facts.mode & 0o100 != 0,
        ExecutableOwner::TrustedSystem => facts.mode & 0o001 != 0,
    };
    if facts.mode & FILE_TYPE_MASK != REGULAR_FILE_TYPE
        || facts.links != 1
        || facts.mode & BROAD_WRITE_BITS != 0
        || facts.mode & SET_ID_BITS != 0
        || !executable_for_user
    {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    require_safe_access_metadata(file, true)?;
    Ok(owner)
}

fn require_safe_access_metadata(
    file: &File,
    executable: bool,
) -> Result<(), ExecutableAuthorityError> {
    match plurum_native_posix_syscall::local_filesystem_is_supported(file.as_fd()) {
        Ok(true) => {}
        Ok(false) => return Err(ExecutableAuthorityError::Unsupported),
        Err(_) => return Err(ExecutableAuthorityError::Unavailable),
    }
    #[cfg(target_os = "macos")]
    {
        let _ = executable;
        if !plurum_native_macos_acl::extended_acl_is_empty(file.as_fd())
            .map_err(|_| ExecutableAuthorityError::Unsupported)?
        {
            return Err(ExecutableAuthorityError::Unsafe);
        }
    }
    #[cfg(target_os = "linux")]
    {
        for name in [
            OsStr::new("system.posix_acl_access"),
            OsStr::new("system.posix_acl_default"),
        ] {
            require_missing_xattr(file, name)?;
        }
        if executable {
            require_missing_xattr(file, OsStr::new("security.capability"))?;
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn require_missing_xattr(file: &File, name: &OsStr) -> Result<(), ExecutableAuthorityError> {
    let mut empty = [0_u8; 0];
    match rustix_fs::fgetxattr(file, name, &mut empty) {
        Err(Errno::NODATA) => Ok(()),
        Ok(_) | Err(Errno::RANGE) => Err(ExecutableAuthorityError::Unsafe),
        Err(Errno::NOTSUP) | Err(Errno::NOSYS) => Err(ExecutableAuthorityError::Unsupported),
        Err(_) => Err(ExecutableAuthorityError::Unavailable),
    }
}

#[cfg(test)]
mod tests {
    use super::NormalizedAbsolutePath;
    use crate::runtime::executable::ExecutableAuthorityError;
    use std::path::Path;

    #[test]
    fn normalized_absolute_paths_reject_aliases_and_unbounded_input() {
        assert!(NormalizedAbsolutePath::parse(Path::new("/safe/value")).is_ok());
        for path in [
            "",
            ".",
            "relative",
            "/",
            "//safe/value",
            "/safe/../value",
            "/safe/./value",
            "/safe/value/",
        ] {
            assert_eq!(
                NormalizedAbsolutePath::parse(Path::new(path)),
                Err(ExecutableAuthorityError::InvalidInput),
                "{path}"
            );
        }
    }
}
