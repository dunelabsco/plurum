use std::fs::File;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::{NativeRuntimeAuthority, NativeRuntimeAuthorityError};

mod image;

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[path = "executable/posix.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "executable/windows.rs"]
mod platform;

const MAX_REVISION_GENERATION: u64 = u64::MAX - 1;
pub(crate) const MAX_RETAINED_HANDLES: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RetainedHandleFootprint {
    pub(crate) retained: usize,
    pub(crate) capture_peak: usize,
}

impl RetainedHandleFootprint {
    fn executable(
        candidate_components: usize,
        excluded_components: usize,
    ) -> Result<Self, ExecutableAuthorityError> {
        let retained = candidate_components
            .checked_add(2)
            .ok_or(ExecutableAuthorityError::Limit)?;
        let single_capture_peak = excluded_components
            .checked_add(1)
            .ok_or(ExecutableAuthorityError::Limit)?
            .max(retained);
        let capture_peak = retained
            .checked_add(single_capture_peak)
            .ok_or(ExecutableAuthorityError::Limit)?;
        Ok(Self {
            retained,
            capture_peak,
        })
    }

    fn directory(
        directory_components: usize,
        excluded_components: usize,
    ) -> Result<Self, ExecutableAuthorityError> {
        let retained = directory_components
            .checked_add(2)
            .ok_or(ExecutableAuthorityError::Limit)?;
        let single_capture_peak = directory_components
            .checked_add(excluded_components)
            .and_then(|total| total.checked_add(2))
            .ok_or(ExecutableAuthorityError::Limit)?;
        let capture_peak = retained
            .checked_add(single_capture_peak)
            .ok_or(ExecutableAuthorityError::Limit)?;
        Ok(Self {
            retained,
            capture_peak,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExecutableAuthorityError {
    InvalidInput,
    Missing,
    Unsafe,
    Conflict,
    Limit,
    Unsupported,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExecutableOwner {
    CurrentUser,
    TrustedSystem,
}

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
pub(crate) struct ExecutableRevision {
    generation: u64,
    digest: [u8; 32],
}

impl std::fmt::Debug for ExecutableRevision {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExecutableRevision")
            .field("generation", &self.generation)
            .field("digest", &"<opaque>")
            .finish()
    }
}

impl ExecutableRevision {
    pub(crate) fn opaque(self) -> String {
        let mut result = String::with_capacity(18 + self.digest.len() * 2);
        result.push_str("native-direct-v1:");
        append_hex(&mut result, &self.generation.to_be_bytes());
        result.push(':');
        append_hex(&mut result, &self.digest);
        result
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ExecutableChainEntry {
    pub(crate) path: PathBuf,
    pub(crate) owner: ExecutableOwner,
    pub(crate) revision: [u8; 32],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DirectExecutableAttestation {
    pub(crate) source_path: PathBuf,
    pub(crate) resolved_path: PathBuf,
    pub(crate) revision: ExecutableRevision,
    pub(crate) chain: [ExecutableChainEntry; 1],
}

pub(crate) struct DirectExecutableLease {
    attestation: DirectExecutableAttestation,
    retained_handles: usize,
    platform: platform::PlatformExecutableLease,
}

impl DirectExecutableLease {
    pub(crate) fn attestation(&self) -> &DirectExecutableAttestation {
        &self.attestation
    }

    pub(crate) fn retained_handles(&self) -> usize {
        self.retained_handles
    }

    pub(super) fn executable_file(&self) -> &File {
        self.platform.executable()
    }

    #[cfg(target_os = "macos")]
    pub(super) fn mapped_file_offset(&self) -> u64 {
        self.platform.mapped_file_offset()
    }
}

pub(crate) struct DirectDirectoryLease {
    path: PathBuf,
    retained_handles: usize,
    platform: platform::PlatformDirectoryLease,
}

impl DirectDirectoryLease {
    #[cfg(target_os = "windows")]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn directory_file(&self) -> &File {
        self.platform.directory()
    }

    pub(crate) fn retained_handles(&self) -> usize {
        self.retained_handles
    }
}

pub(crate) struct DirectExecutableResolver {
    runtime: NativeRuntimeAuthority,
    next_generation: u64,
}

impl DirectExecutableResolver {
    pub(crate) fn capture() -> Result<Self, ExecutableAuthorityError> {
        Ok(Self {
            runtime: NativeRuntimeAuthority::capture().map_err(map_runtime_capture)?,
            next_generation: 1,
        })
    }

    pub(crate) fn resolve(
        &mut self,
        candidate_path: &Path,
        excluded_project_directory: &Path,
        already_retained: usize,
    ) -> Result<DirectExecutableLease, ExecutableAuthorityError> {
        let footprint =
            platform::direct_executable_footprint(candidate_path, excluded_project_directory)?;
        ensure_handle_capacity(already_retained, footprint.capture_peak)?;
        self.runtime.verify().map_err(map_runtime_verify)?;
        let platform =
            platform::resolve_direct_executable(candidate_path, excluded_project_directory)?;
        self.runtime.verify().map_err(map_runtime_verify)?;

        if self.next_generation > MAX_REVISION_GENERATION {
            return Err(ExecutableAuthorityError::Limit);
        }
        let generation = self.next_generation;
        self.next_generation += 1;

        let entry_revision = platform.entry_revision();
        let mut digest = Sha256::new();
        digest.update(b"plurum-native-direct-executable-revision-v1\0");
        digest.update(crate::TARGET_VALUE.as_bytes());
        digest.update(generation.to_be_bytes());
        digest.update(entry_revision);
        let digest = finalize_digest(digest);
        let revision = ExecutableRevision { generation, digest };
        let path = platform.source_path().to_path_buf();
        Ok(DirectExecutableLease {
            attestation: DirectExecutableAttestation {
                source_path: path.clone(),
                resolved_path: path.clone(),
                revision,
                chain: [ExecutableChainEntry {
                    path,
                    owner: platform.owner(),
                    revision: entry_revision,
                }],
            },
            retained_handles: footprint.retained,
            platform,
        })
    }

    pub(crate) fn resolve_footprint(
        &self,
        candidate_path: &Path,
        excluded_project_directory: &Path,
    ) -> Result<RetainedHandleFootprint, ExecutableAuthorityError> {
        platform::direct_executable_footprint(candidate_path, excluded_project_directory)
    }

    pub(crate) fn reattest_footprint(
        &self,
        expected: &DirectExecutableLease,
    ) -> Result<RetainedHandleFootprint, ExecutableAuthorityError> {
        platform::direct_executable_footprint(
            expected.platform.source_path(),
            expected.platform.excluded_project_directory(),
        )
    }

    pub(crate) fn reattest(
        &self,
        expected: &DirectExecutableLease,
        already_retained: usize,
    ) -> Result<DirectExecutableLease, ExecutableAuthorityError> {
        let footprint = self.reattest_footprint(expected)?;
        ensure_handle_capacity(already_retained, footprint.capture_peak)?;
        self.runtime.verify().map_err(map_runtime_verify)?;
        let platform = platform::resolve_direct_executable(
            expected.platform.source_path(),
            expected.platform.excluded_project_directory(),
        )?;
        if !expected.platform.same_evidence(&platform)
            || expected.attestation.chain[0].revision != platform.entry_revision()
        {
            return Err(ExecutableAuthorityError::Conflict);
        }
        self.runtime.verify().map_err(map_runtime_verify)?;
        Ok(DirectExecutableLease {
            attestation: expected.attestation.clone(),
            retained_handles: footprint.retained,
            platform,
        })
    }

    pub(crate) fn directory_footprint(
        &self,
        path: &Path,
        executable: &DirectExecutableLease,
    ) -> Result<RetainedHandleFootprint, ExecutableAuthorityError> {
        platform::trusted_directory_footprint(path, &executable.platform)
    }

    pub(crate) fn resolve_directory(
        &self,
        path: &Path,
        executable: &DirectExecutableLease,
        already_retained: usize,
    ) -> Result<DirectDirectoryLease, ExecutableAuthorityError> {
        let footprint = self.directory_footprint(path, executable)?;
        ensure_handle_capacity(already_retained, footprint.capture_peak)?;
        self.runtime.verify().map_err(map_runtime_verify)?;
        let platform = platform::resolve_trusted_directory(path, &executable.platform)?;
        self.runtime.verify().map_err(map_runtime_verify)?;
        Ok(DirectDirectoryLease {
            path: platform.path().to_path_buf(),
            retained_handles: footprint.retained,
            platform,
        })
    }

    pub(crate) fn reattest_directory_footprint(
        &self,
        expected: &DirectDirectoryLease,
    ) -> Result<RetainedHandleFootprint, ExecutableAuthorityError> {
        platform::reattest_directory_footprint(&expected.platform)
    }

    pub(crate) fn reattest_directory(
        &self,
        expected: &DirectDirectoryLease,
        already_retained: usize,
    ) -> Result<DirectDirectoryLease, ExecutableAuthorityError> {
        let footprint = self.reattest_directory_footprint(expected)?;
        ensure_handle_capacity(already_retained, footprint.capture_peak)?;
        self.runtime.verify().map_err(map_runtime_verify)?;
        let platform = platform::reattest_trusted_directory(&expected.platform)?;
        if !expected.platform.same_evidence(&platform) {
            return Err(ExecutableAuthorityError::Conflict);
        }
        self.runtime.verify().map_err(map_runtime_verify)?;
        Ok(DirectDirectoryLease {
            path: expected.path.clone(),
            retained_handles: footprint.retained,
            platform,
        })
    }

    #[cfg(target_os = "windows")]
    pub(super) fn windows_process_identity(&self) -> &crate::windows::StandardUserProcessIdentity {
        self.runtime.windows_process_identity()
    }
}

fn ensure_handle_capacity(
    already_retained: usize,
    additional_peak: usize,
) -> Result<(), ExecutableAuthorityError> {
    if additional_peak == 0
        || already_retained
            .checked_add(additional_peak)
            .is_none_or(|total| total > MAX_RETAINED_HANDLES)
    {
        Err(ExecutableAuthorityError::Limit)
    } else {
        Ok(())
    }
}

fn append_hex(target: &mut String, bytes: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        target.push(HEX[(byte >> 4) as usize] as char);
        target.push(HEX[(byte & 0x0f) as usize] as char);
    }
}

fn finalize_digest(digest: Sha256) -> [u8; 32] {
    let bytes = digest.finalize();
    let mut result = [0_u8; 32];
    result.copy_from_slice(&bytes);
    result
}

fn map_runtime_capture(error: NativeRuntimeAuthorityError) -> ExecutableAuthorityError {
    match error {
        NativeRuntimeAuthorityError::Unsafe => ExecutableAuthorityError::Unsafe,
        NativeRuntimeAuthorityError::Lost => ExecutableAuthorityError::Conflict,
        NativeRuntimeAuthorityError::Unavailable => ExecutableAuthorityError::Unavailable,
    }
}

fn map_runtime_verify(error: NativeRuntimeAuthorityError) -> ExecutableAuthorityError {
    match error {
        NativeRuntimeAuthorityError::Unsafe => ExecutableAuthorityError::Unsafe,
        NativeRuntimeAuthorityError::Lost => ExecutableAuthorityError::Conflict,
        NativeRuntimeAuthorityError::Unavailable => ExecutableAuthorityError::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_hex, ensure_handle_capacity, ExecutableAuthorityError, ExecutableRevision,
        RetainedHandleFootprint, MAX_RETAINED_HANDLES,
    };

    #[test]
    fn opaque_revision_has_one_fixed_non_path_shape() {
        let revision = ExecutableRevision {
            generation: 7,
            digest: [0xa5; 32],
        };
        assert_eq!(
            revision.opaque(),
            "native-direct-v1:0000000000000007:a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5"
        );
        assert!(!format!("{revision:?}").contains("a5a5"));
    }

    #[test]
    fn hex_encoding_is_exact_and_lowercase() {
        let mut value = String::new();
        append_hex(&mut value, &[0, 1, 15, 16, 254, 255]);
        assert_eq!(value, "00010f10feff");
    }

    #[test]
    fn executable_and_directory_footprints_enforce_the_exact_handle_boundary() {
        assert_eq!(
            RetainedHandleFootprint::executable(62, 1),
            Ok(RetainedHandleFootprint {
                retained: 64,
                capture_peak: 128,
            })
        );
        assert_eq!(
            RetainedHandleFootprint::executable(63, 1)
                .and_then(|footprint| ensure_handle_capacity(0, footprint.capture_peak)),
            Err(ExecutableAuthorityError::Limit)
        );
        assert_eq!(
            RetainedHandleFootprint::directory(61, 2),
            Ok(RetainedHandleFootprint {
                retained: 63,
                capture_peak: 128,
            })
        );
        assert_eq!(
            RetainedHandleFootprint::directory(62, 2)
                .and_then(|footprint| ensure_handle_capacity(0, footprint.capture_peak)),
            Err(ExecutableAuthorityError::Limit)
        );
        assert_eq!(
            RetainedHandleFootprint::executable(usize::MAX, 1),
            Err(ExecutableAuthorityError::Limit)
        );
        assert_eq!(
            RetainedHandleFootprint::directory(usize::MAX, 1),
            Err(ExecutableAuthorityError::Limit)
        );
        assert_eq!(ensure_handle_capacity(MAX_RETAINED_HANDLES - 1, 1), Ok(()));
        assert_eq!(
            ensure_handle_capacity(MAX_RETAINED_HANDLES, 1),
            Err(ExecutableAuthorityError::Limit)
        );
    }
}
