use std::ffi::OsString;
use std::fs::{File, Metadata, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsHandle;
use std::path::{Component, Path, PathBuf, Prefix};

use plurum_windows_syscall::process::attest_no_untrusted_file_control;
use plurum_windows_syscall::{
    attest_local_ntfs, attest_no_untrusted_namespace_control, attest_security, file_identity,
    file_standard, ProcessIdentity, SecurityKind, VolumeAttestation,
};
use sha2::{Digest, Sha256};

use super::image::{attest_native_image, NativeImageAttestation};
use super::{ExecutableAuthorityError, ExecutableOwner, RetainedHandleFootprint};

const MAX_PATH_UTF16: usize = 32_767;
const MAX_COMPONENTS: usize = 256;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
const GENERIC_READ: u32 = 0x8000_0000;
const READ_CONTROL: u32 = 0x0002_0000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ObjectFacts {
    volume: u64,
    file_id: [u8; 16],
    attributes: u32,
    links: u32,
    delete_pending: bool,
    directory: bool,
    size: u64,
    created: u64,
    modified: u64,
}

impl ObjectFacts {
    fn capture(file: &File) -> Result<Self, ExecutableAuthorityError> {
        let metadata = file
            .metadata()
            .map_err(|_| ExecutableAuthorityError::Unavailable)?;
        Self::from_metadata(file, &metadata)
    }

    fn from_metadata(file: &File, metadata: &Metadata) -> Result<Self, ExecutableAuthorityError> {
        let identity =
            file_identity(file.as_handle()).map_err(|_| ExecutableAuthorityError::Unavailable)?;
        let standard =
            file_standard(file.as_handle()).map_err(|_| ExecutableAuthorityError::Unavailable)?;
        Ok(Self {
            volume: identity.volume_serial,
            file_id: identity.file_id,
            attributes: metadata.file_attributes(),
            links: standard.links,
            delete_pending: standard.delete_pending,
            directory: standard.directory,
            size: metadata.file_size(),
            created: metadata.creation_time(),
            modified: metadata.last_write_time(),
        })
    }

    fn same_object(self, other: Self) -> bool {
        self.volume == other.volume && self.file_id == other.file_id
    }

    fn same_directory_authority(self, other: Self) -> bool {
        self.same_object(other)
            && self.attributes == other.attributes
            && self.delete_pending == other.delete_pending
            && self.directory == other.directory
    }

    fn update_directory_digest(self, digest: &mut Sha256) {
        digest.update(self.volume.to_le_bytes());
        digest.update(self.file_id);
        digest.update(self.attributes.to_le_bytes());
        digest.update([u8::from(self.delete_pending)]);
        digest.update([u8::from(self.directory)]);
    }

    fn update_digest(self, digest: &mut Sha256) {
        digest.update(self.volume.to_le_bytes());
        digest.update(self.file_id);
        digest.update(self.attributes.to_le_bytes());
        digest.update(self.links.to_le_bytes());
        digest.update([u8::from(self.delete_pending)]);
        digest.update([u8::from(self.directory)]);
        digest.update(self.size.to_le_bytes());
        digest.update(self.created.to_le_bytes());
        digest.update(self.modified.to_le_bytes());
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct NormalizedAbsolutePath {
    path: PathBuf,
    drive: u8,
    components: Vec<OsString>,
}

impl NormalizedAbsolutePath {
    fn parse(path: &Path) -> Result<Self, ExecutableAuthorityError> {
        let raw = path
            .to_str()
            .ok_or(ExecutableAuthorityError::InvalidInput)?;
        if raw.contains('/') || raw.encode_utf16().count() > MAX_PATH_UTF16 || !path.is_absolute() {
            return Err(ExecutableAuthorityError::InvalidInput);
        }

        let mut iterator = path.components();
        let drive = match iterator.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(letter) if letter.is_ascii_alphabetic() => letter.to_ascii_uppercase(),
                _ => return Err(ExecutableAuthorityError::InvalidInput),
            },
            _ => return Err(ExecutableAuthorityError::InvalidInput),
        };
        if !matches!(iterator.next(), Some(Component::RootDir)) {
            return Err(ExecutableAuthorityError::InvalidInput);
        }

        let mut components = Vec::new();
        for component in iterator {
            match component {
                Component::Normal(name)
                    if crate::windows::valid_component(name)
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

        let mut normalized = PathBuf::from(format!("{}:\\", drive as char));
        for component in &components {
            normalized.push(component);
        }
        let normalized_string = normalized
            .to_str()
            .ok_or(ExecutableAuthorityError::InvalidInput)?;
        if !normalized_string.eq_ignore_ascii_case(raw) {
            return Err(ExecutableAuthorityError::InvalidInput);
        }
        Ok(Self {
            path: normalized,
            drive,
            components,
        })
    }

    fn root_path(&self) -> PathBuf {
        PathBuf::from(format!("{}:\\", self.drive as char))
    }

    fn drive_root(&self) -> [u16; 4] {
        [u16::from(self.drive), u16::from(b':'), u16::from(b'\\'), 0]
    }
}

struct RetainedDirectory {
    file: File,
    facts: ObjectFacts,
    descriptor: Vec<u8>,
}

pub(super) struct PlatformExecutableLease {
    source_path: PathBuf,
    excluded_project_directory: PathBuf,
    excluded: RetainedDirectory,
    directories: Vec<RetainedDirectory>,
    executable: File,
    executable_facts: ObjectFacts,
    image_attestation: NativeImageAttestation,
    executable_descriptor: Vec<u8>,
    volume: VolumeAttestation,
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
            && self.excluded.descriptor == other.excluded.descriptor
            && self.directories.len() == other.directories.len()
            && self
                .directories
                .iter()
                .zip(&other.directories)
                .all(|(left, right)| {
                    left.facts.same_directory_authority(right.facts)
                        && left.descriptor == right.descriptor
                })
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
            && self.excluded.descriptor == other.excluded.descriptor
            && self.directories.len() == other.directories.len()
            && self
                .directories
                .iter()
                .zip(&other.directories)
                .all(|(left, right)| {
                    left.facts.same_directory_authority(right.facts)
                        && left.descriptor == right.descriptor
                })
            && self.executable_facts == other.executable_facts
            && self.image_attestation == other.image_attestation
            && self.executable_descriptor == other.executable_descriptor
            && self.volume == other.volume
            && self.owner == other.owner
            && self.entry_revision == other.entry_revision
    }

    pub(super) fn executable(&self) -> &File {
        &self.executable
    }
}

pub(super) fn resolve_direct_executable(
    candidate_path: &Path,
    excluded_project_directory: &Path,
) -> Result<PlatformExecutableLease, ExecutableAuthorityError> {
    let candidate = NormalizedAbsolutePath::parse(candidate_path)?;
    let excluded = NormalizedAbsolutePath::parse(excluded_project_directory)?;
    require_exe_extension(&candidate.path)?;
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
    require_exe_extension(&candidate.path)?;
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
    let process = ProcessIdentity::capture().map_err(|_| ExecutableAuthorityError::Unsafe)?;
    let first = capture_directory_once(&path, &excluded, &executable.excluded, &process)?;
    let second = capture_directory_once(&path, &excluded, &executable.excluded, &process)?;
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
    let process = ProcessIdentity::capture().map_err(|_| ExecutableAuthorityError::Unsafe)?;
    let first = capture_directory_once(&path, &excluded, &expected.excluded, &process)?;
    let second = capture_directory_once(&path, &excluded, &expected.excluded, &process)?;
    if !first.same_evidence(&second) {
        return Err(ExecutableAuthorityError::Conflict);
    }
    Ok(second)
}

fn capture_directory_once(
    path: &NormalizedAbsolutePath,
    excluded: &NormalizedAbsolutePath,
    bound_excluded: &RetainedDirectory,
    process: &ProcessIdentity,
) -> Result<PlatformDirectoryLease, ExecutableAuthorityError> {
    let excluded_leaf = reopen_bound_excluded(excluded, bound_excluded, process)?;
    let excluded_facts = excluded_leaf.facts;
    let excluded_descriptor = excluded_leaf.descriptor.clone();
    drop(excluded_leaf);
    let directories = open_directory_chain(path, process)?;
    if directories
        .iter()
        .any(|directory| directory.facts.same_object(bound_excluded.facts))
    {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let confirmed_excluded = reopen_bound_excluded(excluded, bound_excluded, process)?;
    if !excluded_facts.same_directory_authority(confirmed_excluded.facts)
        || excluded_descriptor != confirmed_excluded.descriptor
    {
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
    process: &ProcessIdentity,
) -> Result<RetainedDirectory, ExecutableAuthorityError> {
    let (retained_facts, retained_descriptor) = capture_directory_authority(&bound.file, process)?;
    if !retained_facts.same_directory_authority(bound.facts)
        || retained_descriptor != bound.descriptor
    {
        return Err(ExecutableAuthorityError::Conflict);
    }

    let excluded_chain = open_directory_chain(excluded, process).map_err(|error| match error {
        ExecutableAuthorityError::Missing => ExecutableAuthorityError::Conflict,
        other => other,
    })?;
    let reopened = excluded_chain
        .into_iter()
        .last()
        .ok_or(ExecutableAuthorityError::Unavailable)?;
    if !retained_facts.same_directory_authority(reopened.facts)
        || retained_descriptor != reopened.descriptor
    {
        return Err(ExecutableAuthorityError::Conflict);
    }
    Ok(reopened)
}

fn capture_once(
    candidate: &NormalizedAbsolutePath,
    excluded: &NormalizedAbsolutePath,
) -> Result<PlatformExecutableLease, ExecutableAuthorityError> {
    let process = ProcessIdentity::capture().map_err(|_| ExecutableAuthorityError::Unsafe)?;
    let excluded_chain = open_directory_chain(excluded, &process)?;
    let excluded_leaf = excluded_chain
        .into_iter()
        .last()
        .ok_or(ExecutableAuthorityError::Unavailable)?;
    let excluded_identity = excluded_leaf.facts;

    let root = open_directory(&candidate.root_path())?;
    let root = attest_directory(root, &process)?;
    if root.facts.same_object(excluded_identity) {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let volume = attest_supported_volume(&root, candidate)?;
    let volume_identity = root.facts.volume;

    let mut directories = vec![root];
    let mut current_path = candidate.root_path();
    for component in &candidate.components[..candidate.components.len() - 1] {
        current_path.push(component);
        let directory = attest_directory(open_directory(&current_path)?, &process)?;
        if directory.facts.volume != volume_identity
            || directory.facts.same_object(excluded_identity)
        {
            return Err(ExecutableAuthorityError::Unsafe);
        }
        directories.push(directory);
    }

    let executable = open_executable(&candidate.path)?;
    let executable_facts = ObjectFacts::capture(&executable)?;
    if executable_facts.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0
        || executable_facts.directory
        || executable_facts.delete_pending
        || executable_facts.links != 1
        || executable_facts.volume != volume_identity
    {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let image_attestation = attest_native_image(&executable, executable_facts.size)?;
    if ObjectFacts::capture(&executable)? != executable_facts {
        return Err(ExecutableAuthorityError::Conflict);
    }
    if !attest_no_untrusted_file_control(executable.as_handle(), &process)
        .map_err(|_| ExecutableAuthorityError::Unavailable)?
    {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let executable_security = attest_security(executable.as_handle(), &process, SecurityKind::File)
        .map_err(|_| ExecutableAuthorityError::Unavailable)?;
    let owner = if executable_security.owner_current {
        ExecutableOwner::CurrentUser
    } else {
        ExecutableOwner::TrustedSystem
    };

    let mut digest = Sha256::new();
    digest.update(b"plurum-windows-direct-executable-entry-v1\0");
    for unit in candidate.path.as_os_str().encode_wide() {
        digest.update(unit.to_le_bytes());
    }
    digest.update([0, 0]);
    excluded_leaf.facts.update_directory_digest(&mut digest);
    digest.update(&excluded_leaf.descriptor);
    for directory in &directories {
        directory.facts.update_directory_digest(&mut digest);
        digest.update(&directory.descriptor);
    }
    executable_facts.update_digest(&mut digest);
    image_attestation.update_digest(&mut digest);
    digest.update(&executable_security.descriptor);
    digest.update(volume.serial.to_le_bytes());
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
        executable_descriptor: executable_security.descriptor,
        volume,
        owner,
        entry_revision,
    })
}

fn open_directory_chain(
    path: &NormalizedAbsolutePath,
    process: &ProcessIdentity,
) -> Result<Vec<RetainedDirectory>, ExecutableAuthorityError> {
    let mut current = path.root_path();
    let root = attest_directory(open_directory(&current)?, process)?;
    let volume_identity = root.facts.volume;
    attest_supported_volume(&root, path)?;
    let mut result = vec![root];
    for component in &path.components {
        current.push(component);
        let directory = attest_directory(open_directory(&current)?, process)?;
        if directory.facts.volume != volume_identity {
            return Err(ExecutableAuthorityError::Unsafe);
        }
        result.push(directory);
    }
    Ok(result)
}

fn attest_supported_volume(
    root: &RetainedDirectory,
    path: &NormalizedAbsolutePath,
) -> Result<VolumeAttestation, ExecutableAuthorityError> {
    let volume = attest_local_ntfs(root.file.as_handle(), &path.drive_root())
        .map_err(|_| ExecutableAuthorityError::Unsupported)?;
    if !volume.fixed_drive
        || !volume.ntfs
        || !volume.persistent_acls
        || !volume.direct_volume_mapping
    {
        return Err(ExecutableAuthorityError::Unsupported);
    }
    Ok(volume)
}

fn attest_directory(
    file: File,
    process: &ProcessIdentity,
) -> Result<RetainedDirectory, ExecutableAuthorityError> {
    let (facts, descriptor) = capture_directory_authority(&file, process)?;
    Ok(RetainedDirectory {
        file,
        facts,
        descriptor,
    })
}

fn capture_directory_authority(
    file: &File,
    process: &ProcessIdentity,
) -> Result<(ObjectFacts, Vec<u8>), ExecutableAuthorityError> {
    let facts = ObjectFacts::capture(file)?;
    if facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || facts.attributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || !facts.directory
        || facts.delete_pending
        || !attest_no_untrusted_namespace_control(file.as_handle(), process)
            .map_err(|_| ExecutableAuthorityError::Unavailable)?
    {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let security = attest_security(file.as_handle(), process, SecurityKind::Directory)
        .map_err(|_| ExecutableAuthorityError::Unavailable)?;
    Ok((facts, security.descriptor))
}

fn open_directory(path: &Path) -> Result<File, ExecutableAuthorityError> {
    OpenOptions::new()
        .read(true)
        .access_mode(GENERIC_READ | READ_CONTROL)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(classify_open_error)
}

fn open_executable(path: &Path) -> Result<File, ExecutableAuthorityError> {
    OpenOptions::new()
        .read(true)
        .access_mode(GENERIC_READ | READ_CONTROL)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(classify_open_error)
}

fn require_exe_extension(path: &Path) -> Result<(), ExecutableAuthorityError> {
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        Ok(())
    } else {
        Err(ExecutableAuthorityError::Unsafe)
    }
}

fn classify_open_error(error: std::io::Error) -> ExecutableAuthorityError {
    match error.kind() {
        std::io::ErrorKind::NotFound => ExecutableAuthorityError::Missing,
        std::io::ErrorKind::PermissionDenied => ExecutableAuthorityError::Unsafe,
        _ => ExecutableAuthorityError::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::{require_exe_extension, NormalizedAbsolutePath};
    use crate::runtime::executable::ExecutableAuthorityError;
    use std::path::Path;

    #[test]
    fn normalized_absolute_paths_reject_non_drive_and_alias_forms() {
        assert!(NormalizedAbsolutePath::parse(Path::new(r"C:\safe\value")).is_ok());
        for path in [
            "",
            ".",
            r"relative\value",
            r"C:\",
            r"C:\safe\..\value",
            r"C:\safe\.\value",
            r"\\server\share\value",
            r"\\?\C:\safe\value",
            r"\\.\C:\safe\value",
        ] {
            assert_eq!(
                NormalizedAbsolutePath::parse(Path::new(path)),
                Err(ExecutableAuthorityError::InvalidInput),
                "{path}"
            );
        }
    }

    #[test]
    fn only_explicit_exe_candidates_can_reach_image_attestation() {
        assert_eq!(
            require_exe_extension(Path::new(r"C:\safe\probe.exe")),
            Ok(())
        );
        for path in [
            r"C:\safe\probe",
            r"C:\safe\probe.cmd",
            r"C:\safe\probe.bat",
            r"C:\safe\probe.com",
            r"C:\safe\probe.exe.cmd",
        ] {
            assert_eq!(
                require_exe_extension(Path::new(path)),
                Err(ExecutableAuthorityError::Unsafe),
                "{path}"
            );
        }
    }
}
