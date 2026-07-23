use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::Path;

#[cfg(test)]
use std::cell::Cell;

use rustix::fs::{self as rustix_fs, AtFlags, Dir, FlockOperation, Mode, OFlags, RenameFlags};
use rustix::io::Errno;
use sha2::{Digest, Sha256};

use super::*;

const DOTENV_ENTRY: &str = ".env";
const DOTENV_LOCK_ENTRY: &str = "codex-dotenv.lock";
const DOTENV_CANDIDATE_PREFIX: &[u8] = b".plurum-dotenv-";
const DOTENV_CANDIDATE_SUFFIX: &[u8] = b".tmp";
const CODEX_HOME_CANDIDATE_PREFIX: &[u8] = b".plurum-codex-home-";
const CODEX_HOME_CANDIDATE_SUFFIX: &[u8] = b".tmp";
const MAX_CODEX_DOTENV_BYTES: usize = 128 * 1024;
const MAX_CODEX_HOME_ENTRIES: usize = 4_096;
const MAX_CODEX_CANDIDATES: usize = 1_024;

const DOTENV_LOCK_RECORD_LENGTH: usize = 160;
const DOTENV_LOCK_STATE_UNINITIALIZED: u8 = 0;
const DOTENV_LOCK_STATE_CLEAN: u8 = 1;
const DOTENV_LOCK_STATE_HELD: u8 = 2;
const DOTENV_LOCK_STATE_TRANSITION: u8 = 3;
const DOTENV_LOCK_HEADER: &[u8] = b"plurum-codex-dotenv-lock-v1";
const DOTENV_LOCK_HEADER_START: usize = 1;
const DOTENV_LOCK_HEADER_END: usize = DOTENV_LOCK_HEADER_START + DOTENV_LOCK_HEADER.len();
const DOTENV_LOCK_HOME_START: usize = 48;
const DOTENV_LOCK_HOME_END: usize = DOTENV_LOCK_HOME_START + 32;
const DOTENV_LOCK_NONCE_START: usize = 96;
const DOTENV_LOCK_NONCE_END: usize = DOTENV_LOCK_NONCE_START + LOCK_NONCE_LENGTH;
const DOTENV_LOCK_HOME_CLAIM_STAGE: usize = DOTENV_LOCK_NONCE_END;
const DOTENV_LOCK_HOME_CLAIM_IDENTITY_START: usize = 136;
const DOTENV_LOCK_HOME_CLAIM_DEVICE_END: usize =
    DOTENV_LOCK_HOME_CLAIM_IDENTITY_START + std::mem::size_of::<u64>();
const DOTENV_LOCK_HOME_CLAIM_IDENTITY_END: usize =
    DOTENV_LOCK_HOME_CLAIM_DEVICE_END + std::mem::size_of::<u64>();
const DOTENV_HOME_CLAIM_NONE: u8 = 0;
const DOTENV_HOME_CLAIM_PREPARING: u8 = 1;
const DOTENV_HOME_CLAIM_PREPARED: u8 = 2;

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DotenvTestFault {
    ObserveAfterHomeAttestation,
    ObserveAfterFileOpen,
    ObserveAfterRead,
    ObserveAfterRebound,
    LockAfterInitializedClean,
    LockAfterRecovery,
    LockAfterNonceSync,
    LockAfterHeldTransition,
    HomeAfterIntent,
    HomeAfterCandidateCreate,
    HomeAfterCandidateClaim,
    HomeAfterRename,
    CandidateAfterCreate,
    CandidateAfterWrite,
    CandidateAfterReadback,
    CandidateAfterFileSync,
    InstallBeforeRename,
    InstallAfterRename,
    InstallAfterDirectorySync,
    InstallAfterReadback,
    PostInstallObservation,
    PostInstallMismatch,
    RecoveryBeforeUnlink,
    RecoveryAfterUnlink,
    RecoveryAfterDirectorySync,
    ReleaseBeforeClean,
    ReleaseAfterClean,
}

#[cfg(test)]
thread_local! {
    static DOTENV_TEST_FAULT: Cell<Option<DotenvTestFault>> = const { Cell::new(None) };
}

#[cfg(test)]
fn arm_dotenv_test_fault(fault: DotenvTestFault) {
    DOTENV_TEST_FAULT.with(|armed| {
        assert!(
            armed.replace(Some(fault)).is_none(),
            "a Codex dotenv test fault is already armed"
        );
    });
}

#[cfg(test)]
fn take_dotenv_test_fault(fault: DotenvTestFault) -> bool {
    DOTENV_TEST_FAULT.with(|armed| {
        if armed.get() == Some(fault) {
            armed.set(None);
            true
        } else {
            false
        }
    })
}

#[cfg(test)]
fn assert_dotenv_test_fault_consumed() {
    DOTENV_TEST_FAULT.with(|armed| {
        assert!(
            armed.get().is_none(),
            "the armed Codex dotenv test fault was not reached"
        );
    });
}

#[cfg(test)]
macro_rules! fail_on_dotenv_test_fault {
    ($point:ident, $error:expr) => {
        if take_dotenv_test_fault(DotenvTestFault::$point) {
            return Err($error);
        }
    };
}

#[cfg(not(test))]
macro_rules! fail_on_dotenv_test_fault {
    ($point:ident, $error:expr) => {};
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectorySecurityFacts {
    identity: ObjectIdentity,
    kind: ObjectKind,
    mode: u32,
    uid: u32,
    gid: u32,
}

impl From<MetadataFacts> for DirectorySecurityFacts {
    fn from(facts: MetadataFacts) -> Self {
        Self {
            identity: facts.identity,
            kind: facts.kind,
            mode: facts.mode,
            uid: facts.uid,
            gid: facts.gid,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CodexDotenvSnapshotKind {
    MissingHome {
        parent_facts: MetadataFacts,
    },
    MissingFile {
        home_facts: MetadataFacts,
    },
    Present {
        home_facts: DirectorySecurityFacts,
        file_facts: MetadataFacts,
    },
    Oversized {
        home_facts: DirectorySecurityFacts,
        file_facts: MetadataFacts,
    },
    Unsafe,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CodexDotenvState {
    process: ProcessIdentity,
    home: NormalizedAbsolutePath,
    excluded_project: NormalizedAbsolutePath,
    kind: CodexDotenvSnapshotKind,
    fingerprint: [u8; 32],
}

pub(crate) enum CodexDotenvObservation {
    Missing {
        state: CodexDotenvState,
    },
    Present {
        state: CodexDotenvState,
        bytes: Vec<u8>,
    },
    Oversized {
        state: CodexDotenvState,
    },
    Unsafe {
        state: CodexDotenvState,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CodexDotenvSynchronizeDisposition {
    Changed,
    Unchanged,
}

// Keep the shared platform interface value-shaped; its opaque state is moved
// directly into the bridge registry and must match the Windows implementation.
#[allow(clippy::large_enum_variant)]
pub(crate) enum CodexDotenvSynchronizeResult {
    Completed {
        disposition: CodexDotenvSynchronizeDisposition,
        state: CodexDotenvState,
    },
    PreconditionFailed,
}

struct CodexDotenvContext {
    process: ProcessIdentity,
    home: NormalizedAbsolutePath,
    excluded_project: NormalizedAbsolutePath,
}

struct CodexHome {
    process: ProcessIdentity,
    path: NormalizedAbsolutePath,
    parent: File,
    directory: File,
}

enum InternalObservation {
    MissingHome {
        state: CodexDotenvState,
    },
    MissingFile {
        state: CodexDotenvState,
    },
    Present {
        state: CodexDotenvState,
        bytes: Vec<u8>,
    },
    Oversized {
        state: CodexDotenvState,
    },
    Unsafe {
        state: CodexDotenvState,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HomeCreationClaim {
    None,
    Preparing,
    Prepared(ObjectIdentity),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DotenvLockRecordState {
    Uninitialized,
    Clean {
        home_binding: [u8; 32],
    },
    Transition,
    Held {
        home_binding: [u8; 32],
        nonce: ValidatedUuidV4,
        home_claim: HomeCreationClaim,
    },
}

struct HeldDotenvLock {
    directory: PosixPrivateDirectory,
    lock: Option<File>,
    nonce: ValidatedUuidV4,
    home_binding: [u8; 32],
    home_claim: HomeCreationClaim,
    terminal: bool,
}

struct PreparedCandidate {
    name: OsString,
    identity: ObjectIdentity,
    file: File,
}

struct WipedBytes(Vec<u8>);

impl WipedBytes {
    fn as_slice(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl Drop for WipedBytes {
    fn drop(&mut self) {
        zeroize_bytes(self.0.as_mut_slice());
    }
}

fn validate_max_bytes(max_bytes: usize) -> Result<(), PosixStoreError> {
    if max_bytes == 0 || max_bytes > MAX_CODEX_DOTENV_BYTES {
        Err(PosixStoreError::InvalidInput)
    } else {
        Ok(())
    }
}

fn parse_context(
    codex_home: &Path,
    excluded_project: &Path,
) -> Result<CodexDotenvContext, PosixStoreError> {
    let process = ProcessIdentity::capture()?;
    let home = NormalizedAbsolutePath::parse(codex_home)?;
    let excluded_project = NormalizedAbsolutePath::parse(excluded_project)?;
    if home.components.len() >= excluded_project.components.len()
        && home.components[..excluded_project.components.len()] == excluded_project.components[..]
    {
        return Err(PosixStoreError::Unsafe);
    }
    Ok(CodexDotenvContext {
        process,
        home,
        excluded_project,
    })
}

fn update_identity(digest: &mut Sha256, identity: ObjectIdentity) {
    digest.update(identity.device.to_le_bytes());
    digest.update(identity.inode.to_le_bytes());
}

fn update_facts(digest: &mut Sha256, facts: MetadataFacts, include_times: bool) {
    update_identity(digest, facts.identity);
    digest.update(facts.mode.to_le_bytes());
    digest.update(facts.uid.to_le_bytes());
    digest.update(facts.gid.to_le_bytes());
    digest.update(facts.links.to_le_bytes());
    digest.update(facts.size.to_le_bytes());
    if include_times {
        digest.update(facts.modified_seconds.to_le_bytes());
        digest.update(facts.modified_nanoseconds.to_le_bytes());
        digest.update(facts.changed_seconds.to_le_bytes());
        digest.update(facts.changed_nanoseconds.to_le_bytes());
    }
}

fn update_directory_security(digest: &mut Sha256, facts: DirectorySecurityFacts) {
    update_identity(digest, facts.identity);
    digest.update(facts.mode.to_le_bytes());
    digest.update(facts.uid.to_le_bytes());
    digest.update(facts.gid.to_le_bytes());
}

fn finish_digest(digest: Sha256) -> [u8; 32] {
    let value = digest.finalize();
    let mut result = [0_u8; 32];
    result.copy_from_slice(&value);
    result
}

fn home_binding(path: &NormalizedAbsolutePath) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(b"plurum-posix-codex-home-binding-v1\0");
    digest.update(path.path.as_os_str().as_bytes());
    finish_digest(digest)
}

fn unsafe_state(context: &CodexDotenvContext) -> CodexDotenvState {
    let mut digest = Sha256::new();
    digest.update(b"plurum-posix-codex-dotenv-unsafe-v1\0");
    digest.update(context.home.path.as_os_str().as_bytes());
    CodexDotenvState {
        process: context.process,
        home: context.home.clone(),
        excluded_project: context.excluded_project.clone(),
        kind: CodexDotenvSnapshotKind::Unsafe,
        fingerprint: finish_digest(digest),
    }
}

fn secure_codex_directory(facts: MetadataFacts, process: ProcessIdentity) -> bool {
    facts.kind == ObjectKind::Directory
        && facts.owned_by(process.uid)
        && facts.mode & 0o7000 == 0
        && facts.mode & 0o022 == 0
        && facts.mode & 0o700 == 0o700
}

fn same_directory_security_binding(left: MetadataFacts, right: MetadataFacts) -> bool {
    DirectorySecurityFacts::from(left) == DirectorySecurityFacts::from(right)
}

fn open_codex_home(context: &CodexDotenvContext) -> Result<Option<CodexHome>, PosixStoreError> {
    let parent = match context.home.open_parent() {
        Ok(parent) => parent,
        Err(PosixStoreError::Missing) => return Ok(None),
        Err(error) => return Err(error),
    };
    match rustix_fs::statat(
        &parent,
        context.home.final_name(),
        AtFlags::SYMLINK_NOFOLLOW,
    ) {
        Err(error) if error == Errno::NOENT => return Ok(None),
        Ok(_) => {}
        Err(_) => return Err(PosixStoreError::Io),
    }
    let directory = secure_openat(
        &parent,
        context.home.final_name(),
        directory_open_flags(),
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|error| {
        if error == Errno::NOENT {
            PosixStoreError::Lost
        } else {
            PosixStoreError::Unsafe
        }
    })?;
    let home = CodexHome {
        process: context.process,
        path: context.home.clone(),
        parent,
        directory,
    };
    home.attest()?;
    Ok(Some(home))
}

impl CodexHome {
    fn attest(&self) -> Result<MetadataFacts, PosixStoreError> {
        self.process.verify()?;
        let facts = metadata(&self.directory)?;
        if !secure_codex_directory(facts, self.process)
            || !platform::access_is_private(&self.directory)?
        {
            return Err(PosixStoreError::Unsafe);
        }
        let parent_current = secure_openat(
            &self.parent,
            self.path.final_name(),
            directory_open_flags(),
            Mode::empty(),
        )
        .map(File::from)
        .map_err(|_| PosixStoreError::Lost)?;
        let complete_current = self
            .path
            .open_complete()
            .map_err(|_| PosixStoreError::Lost)?;
        if metadata(&parent_current)?.identity != facts.identity
            || metadata(&complete_current)?.identity != facts.identity
        {
            return Err(PosixStoreError::Lost);
        }
        Ok(facts)
    }
}

fn stable_missing_parent(
    context: &CodexDotenvContext,
) -> Result<(File, MetadataFacts), PosixStoreError> {
    let parent = context.home.open_parent()?;
    let before = metadata(&parent)?;
    if !secure_codex_directory(before, context.process) || !platform::access_is_private(&parent)? {
        return Err(PosixStoreError::Unsafe);
    }
    if !entry_is_missing_at(&parent, context.home.final_name())? {
        return Err(PosixStoreError::Lost);
    }
    let reopened = context.home.open_parent()?;
    let after = metadata(&parent)?;
    let rebound = metadata(&reopened)?;
    context.process.verify()?;
    if after != before
        || rebound != before
        || !entry_is_missing_at(&parent, context.home.final_name())?
        || !entry_is_missing_at(&reopened, context.home.final_name())?
    {
        return Err(PosixStoreError::Lost);
    }
    Ok((parent, before))
}

fn state_missing_home(context: &CodexDotenvContext, parent: MetadataFacts) -> CodexDotenvState {
    let mut digest = Sha256::new();
    digest.update(b"plurum-posix-codex-dotenv-missing-home-v1\0");
    digest.update(context.home.path.as_os_str().as_bytes());
    update_facts(&mut digest, parent, true);
    CodexDotenvState {
        process: context.process,
        home: context.home.clone(),
        excluded_project: context.excluded_project.clone(),
        kind: CodexDotenvSnapshotKind::MissingHome {
            parent_facts: parent,
        },
        fingerprint: finish_digest(digest),
    }
}

fn state_for_home(
    context: &CodexDotenvContext,
    home: MetadataFacts,
    file: Option<MetadataFacts>,
    oversized: bool,
    bytes: &[u8],
) -> CodexDotenvState {
    let mut digest = Sha256::new();
    digest.update(if file.is_some() {
        b"plurum-posix-codex-dotenv-present-v1\0".as_slice()
    } else {
        b"plurum-posix-codex-dotenv-missing-file-v1\0".as_slice()
    });
    let home_security = DirectorySecurityFacts::from(home);
    let kind = match file {
        None => {
            update_facts(&mut digest, home, true);
            CodexDotenvSnapshotKind::MissingFile { home_facts: home }
        }
        Some(file) => {
            update_directory_security(&mut digest, home_security);
            update_facts(&mut digest, file, true);
            if !oversized {
                digest.update(bytes);
            }
            if oversized {
                CodexDotenvSnapshotKind::Oversized {
                    home_facts: home_security,
                    file_facts: file,
                }
            } else {
                CodexDotenvSnapshotKind::Present {
                    home_facts: home_security,
                    file_facts: file,
                }
            }
        }
    };
    CodexDotenvState {
        process: context.process,
        home: context.home.clone(),
        excluded_project: context.excluded_project.clone(),
        kind,
        fingerprint: finish_digest(digest),
    }
}

fn exact_secure_dotenv_file(
    home: &CodexHome,
    file: &File,
    expected_identity: ObjectIdentity,
) -> Result<bool, PosixStoreError> {
    let home_facts = home.attest()?;
    let facts = metadata(file)?;
    if facts.identity != expected_identity
        || !facts.exact_private_file(home.process.uid)
        || !platform::access_is_private(file)?
    {
        return Ok(false);
    }
    let current = secure_openat(
        &home.directory,
        OsStr::new(DOTENV_ENTRY),
        read_open_flags(),
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| PosixStoreError::Lost)?;
    Ok(metadata(&current)?.identity == expected_identity && home.attest()? == home_facts)
}

fn observe_open_home(
    context: &CodexDotenvContext,
    home: &CodexHome,
    max_bytes: usize,
) -> Result<InternalObservation, PosixStoreError> {
    let home_before = home.attest()?;
    fail_on_dotenv_test_fault!(ObserveAfterHomeAttestation, PosixStoreError::Io);
    match rustix_fs::statat(
        &home.directory,
        OsStr::new(DOTENV_ENTRY),
        AtFlags::SYMLINK_NOFOLLOW,
    ) {
        Err(error) if error == Errno::NOENT => {
            let home_after = home.attest()?;
            if home_after != home_before
                || !entry_is_missing_at(&home.directory, OsStr::new(DOTENV_ENTRY))?
            {
                return Err(PosixStoreError::Lost);
            }
            return Ok(InternalObservation::MissingFile {
                state: state_for_home(context, home_after, None, false, &[]),
            });
        }
        Ok(_) => {}
        Err(_) => return Err(PosixStoreError::Io),
    }

    let file = secure_openat(
        &home.directory,
        OsStr::new(DOTENV_ENTRY),
        read_open_flags(),
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|error| {
        if error == Errno::NOENT {
            PosixStoreError::Lost
        } else {
            PosixStoreError::Unsafe
        }
    })?;
    fail_on_dotenv_test_fault!(ObserveAfterFileOpen, PosixStoreError::Io);
    let before = metadata(&file)?;
    if !before.exact_private_file(context.process.uid) || !platform::access_is_private(&file)? {
        return Err(PosixStoreError::Unsafe);
    }
    if usize::try_from(before.size).map_or(true, |size| size > max_bytes) {
        let rebound = secure_openat(
            &home.directory,
            OsStr::new(DOTENV_ENTRY),
            read_open_flags(),
            Mode::empty(),
        )
        .map(File::from)
        .map_err(|_| PosixStoreError::Lost)?;
        let after = metadata(&file)?;
        if after != before
            || metadata(&rebound)?.identity != before.identity
            || home.attest()? != home_before
        {
            return Err(PosixStoreError::Lost);
        }
        return Ok(InternalObservation::Oversized {
            state: state_for_home(context, home_before, Some(before), true, &[]),
        });
    }

    let read_limit = max_bytes.checked_add(1).ok_or(PosixStoreError::Limit)?;
    let mut bytes = read_up_to_at(&file, read_limit)?;
    #[cfg(test)]
    if take_dotenv_test_fault(DotenvTestFault::ObserveAfterRead) {
        zeroize_bytes(bytes.as_mut_slice());
        return Err(PosixStoreError::Io);
    }
    let after = match metadata(&file) {
        Ok(after) => after,
        Err(error) => {
            zeroize_bytes(bytes.as_mut_slice());
            return Err(error);
        }
    };
    let rebound = match secure_openat(
        &home.directory,
        OsStr::new(DOTENV_ENTRY),
        read_open_flags(),
        Mode::empty(),
    ) {
        Ok(rebound) => File::from(rebound),
        Err(_) => {
            zeroize_bytes(bytes.as_mut_slice());
            return Err(PosixStoreError::Lost);
        }
    };
    let home_after = match home.attest() {
        Ok(home_after) => home_after,
        Err(error) => {
            zeroize_bytes(bytes.as_mut_slice());
            return Err(error);
        }
    };
    #[cfg(test)]
    if take_dotenv_test_fault(DotenvTestFault::ObserveAfterRebound) {
        zeroize_bytes(bytes.as_mut_slice());
        return Err(PosixStoreError::Io);
    }
    let stable = (|| {
        Ok(before == after
            && home_before == home_after
            && metadata(&rebound)?.identity == before.identity
            && exact_secure_dotenv_file(home, &file, before.identity)?
            && u64::try_from(bytes.len()).ok() == Some(after.size))
    })();
    let stable = match stable {
        Ok(stable) => stable,
        Err(error) => {
            zeroize_bytes(bytes.as_mut_slice());
            return Err(error);
        }
    };
    if !stable {
        zeroize_bytes(bytes.as_mut_slice());
        return Err(PosixStoreError::Lost);
    }
    if bytes.len() > max_bytes {
        zeroize_bytes(bytes.as_mut_slice());
        return Ok(InternalObservation::Oversized {
            state: state_for_home(context, home_after, Some(after), true, &[]),
        });
    }
    Ok(InternalObservation::Present {
        state: state_for_home(context, home_after, Some(after), false, &bytes),
        bytes,
    })
}

fn observe_internal(
    context: &CodexDotenvContext,
    max_bytes: usize,
) -> Result<InternalObservation, PosixStoreError> {
    match open_codex_home(context) {
        Ok(Some(home)) => match observe_open_home(context, &home, max_bytes) {
            Err(PosixStoreError::Unsafe) => Ok(InternalObservation::Unsafe {
                state: unsafe_state(context),
            }),
            result => result,
        },
        Ok(None) => match stable_missing_parent(context) {
            Ok((_, parent)) => Ok(InternalObservation::MissingHome {
                state: state_missing_home(context, parent),
            }),
            Err(PosixStoreError::Unsafe) => Ok(InternalObservation::Unsafe {
                state: unsafe_state(context),
            }),
            Err(error) => Err(error),
        },
        Err(PosixStoreError::Unsafe) => Ok(InternalObservation::Unsafe {
            state: unsafe_state(context),
        }),
        Err(error) => Err(error),
    }
}

fn take_internal_state(observation: &InternalObservation) -> &CodexDotenvState {
    match observation {
        InternalObservation::MissingHome { state }
        | InternalObservation::MissingFile { state }
        | InternalObservation::Present { state, .. }
        | InternalObservation::Oversized { state }
        | InternalObservation::Unsafe { state } => state,
    }
}

pub(crate) fn observe_codex_dotenv(
    codex_home: &Path,
    excluded_project: &Path,
    max_bytes: usize,
) -> Result<CodexDotenvObservation, PosixStoreError> {
    validate_max_bytes(max_bytes)?;
    let context = match parse_context(codex_home, excluded_project) {
        Ok(context) => context,
        Err(PosixStoreError::Unsafe) => {
            let process = ProcessIdentity::capture()?;
            let home = NormalizedAbsolutePath::parse(codex_home)?;
            let excluded_project = NormalizedAbsolutePath::parse(excluded_project)?;
            let context = CodexDotenvContext {
                process,
                home,
                excluded_project,
            };
            return Ok(CodexDotenvObservation::Unsafe {
                state: unsafe_state(&context),
            });
        }
        Err(error) => return Err(error),
    };
    match observe_internal(&context, max_bytes)? {
        InternalObservation::MissingHome { state } | InternalObservation::MissingFile { state } => {
            Ok(CodexDotenvObservation::Missing { state })
        }
        InternalObservation::Present { state, bytes } => {
            Ok(CodexDotenvObservation::Present { state, bytes })
        }
        InternalObservation::Oversized { state } => Ok(CodexDotenvObservation::Oversized { state }),
        InternalObservation::Unsafe { state } => Ok(CodexDotenvObservation::Unsafe { state }),
    }
}

fn clean_lock_record(home: [u8; 32]) -> [u8; DOTENV_LOCK_RECORD_LENGTH] {
    let mut record = [0_u8; DOTENV_LOCK_RECORD_LENGTH];
    record[0] = DOTENV_LOCK_STATE_CLEAN;
    record[DOTENV_LOCK_HEADER_START..DOTENV_LOCK_HEADER_END].copy_from_slice(DOTENV_LOCK_HEADER);
    record[DOTENV_LOCK_HOME_START..DOTENV_LOCK_HOME_END].copy_from_slice(&home);
    record
}

fn recoverable_uninitialized_lock_record(bytes: &[u8], home: [u8; 32]) -> bool {
    if bytes.len() != DOTENV_LOCK_RECORD_LENGTH
        || bytes.first().copied() != Some(DOTENV_LOCK_STATE_UNINITIALIZED)
    {
        return false;
    }
    let header = &bytes[DOTENV_LOCK_HEADER_START..DOTENV_LOCK_HEADER_END];
    let partial_new_record = {
        let mut intended = clean_lock_record(home);
        intended[0] = DOTENV_LOCK_STATE_UNINITIALIZED;
        (1..=bytes.len()).any(|prefix| {
            bytes[..prefix] == intended[..prefix] && bytes[prefix..].iter().all(|byte| *byte == 0)
        })
    };
    let rebound_clean_record = header == DOTENV_LOCK_HEADER
        && bytes[DOTENV_LOCK_HEADER_END..DOTENV_LOCK_HOME_START]
            .iter()
            .all(|byte| *byte == 0)
        && bytes[DOTENV_LOCK_HOME_END..DOTENV_LOCK_NONCE_START]
            .iter()
            .all(|byte| *byte == 0)
        && bytes[DOTENV_LOCK_NONCE_END..].iter().all(|byte| *byte == 0);
    partial_new_record || rebound_clean_record
}

fn read_dotenv_lock_record(
    file: &File,
    expected_home: [u8; 32],
) -> Result<DotenvLockRecordState, PosixStoreError> {
    let facts = metadata(file)?;
    if facts.size == 0 {
        return Ok(DotenvLockRecordState::Uninitialized);
    }
    if facts.size != DOTENV_LOCK_RECORD_LENGTH as u64 {
        return Err(PosixStoreError::Unsafe);
    }
    let mut bytes = read_exact_at(file, DOTENV_LOCK_RECORD_LENGTH)?;
    let result = (|| {
        if bytes[0] == DOTENV_LOCK_STATE_UNINITIALIZED {
            return if recoverable_uninitialized_lock_record(&bytes, expected_home) {
                Ok(DotenvLockRecordState::Uninitialized)
            } else {
                Err(PosixStoreError::Unsafe)
            };
        }
        if bytes[0] == DOTENV_LOCK_STATE_TRANSITION {
            return if &bytes[DOTENV_LOCK_HEADER_START..DOTENV_LOCK_HEADER_END] == DOTENV_LOCK_HEADER
                && bytes[DOTENV_LOCK_HEADER_END..DOTENV_LOCK_HOME_START]
                    .iter()
                    .all(|byte| *byte == 0)
                && bytes[DOTENV_LOCK_HOME_END..DOTENV_LOCK_NONCE_START]
                    .iter()
                    .all(|byte| *byte == 0)
                && bytes[DOTENV_LOCK_HOME_CLAIM_STAGE + 1..DOTENV_LOCK_HOME_CLAIM_IDENTITY_START]
                    .iter()
                    .all(|byte| *byte == 0)
                && bytes[DOTENV_LOCK_HOME_CLAIM_IDENTITY_END..]
                    .iter()
                    .all(|byte| *byte == 0)
            {
                Ok(DotenvLockRecordState::Transition)
            } else {
                Err(PosixStoreError::Unsafe)
            };
        }
        if &bytes[DOTENV_LOCK_HEADER_START..DOTENV_LOCK_HEADER_END] != DOTENV_LOCK_HEADER
            || bytes[DOTENV_LOCK_HEADER_END..DOTENV_LOCK_HOME_START]
                .iter()
                .any(|byte| *byte != 0)
            || bytes[DOTENV_LOCK_HOME_END..DOTENV_LOCK_NONCE_START]
                .iter()
                .any(|byte| *byte != 0)
            || bytes[DOTENV_LOCK_HOME_CLAIM_STAGE + 1..DOTENV_LOCK_HOME_CLAIM_IDENTITY_START]
                .iter()
                .any(|byte| *byte != 0)
            || bytes[DOTENV_LOCK_HOME_CLAIM_IDENTITY_END..]
                .iter()
                .any(|byte| *byte != 0)
        {
            return Err(PosixStoreError::Unsafe);
        }
        let mut home = [0_u8; 32];
        home.copy_from_slice(&bytes[DOTENV_LOCK_HOME_START..DOTENV_LOCK_HOME_END]);
        match bytes[0] {
            DOTENV_LOCK_STATE_CLEAN => {
                let nonce = &bytes[DOTENV_LOCK_NONCE_START..DOTENV_LOCK_NONCE_END];
                if bytes[DOTENV_LOCK_HOME_CLAIM_STAGE] != DOTENV_HOME_CLAIM_NONE
                    || bytes
                        [DOTENV_LOCK_HOME_CLAIM_IDENTITY_START..DOTENV_LOCK_HOME_CLAIM_IDENTITY_END]
                        .iter()
                        .any(|byte| *byte != 0)
                    || nonce.iter().any(|byte| *byte != 0)
                {
                    return Err(PosixStoreError::Unsafe);
                }
                Ok(DotenvLockRecordState::Clean { home_binding: home })
            }
            DOTENV_LOCK_STATE_HELD => {
                let nonce =
                    std::str::from_utf8(&bytes[DOTENV_LOCK_NONCE_START..DOTENV_LOCK_NONCE_END])
                        .map_err(|_| PosixStoreError::Unsafe)
                        .and_then(ValidatedUuidV4::parse)?;
                let identity_bytes = &bytes
                    [DOTENV_LOCK_HOME_CLAIM_IDENTITY_START..DOTENV_LOCK_HOME_CLAIM_IDENTITY_END];
                let home_claim = match bytes[DOTENV_LOCK_HOME_CLAIM_STAGE] {
                    DOTENV_HOME_CLAIM_NONE if identity_bytes.iter().all(|byte| *byte == 0) => {
                        HomeCreationClaim::None
                    }
                    DOTENV_HOME_CLAIM_PREPARING => HomeCreationClaim::Preparing,
                    DOTENV_HOME_CLAIM_PREPARED => {
                        let device = u64::from_le_bytes(
                            bytes[DOTENV_LOCK_HOME_CLAIM_IDENTITY_START
                                ..DOTENV_LOCK_HOME_CLAIM_DEVICE_END]
                                .try_into()
                                .map_err(|_| PosixStoreError::Unsafe)?,
                        );
                        let inode = u64::from_le_bytes(
                            bytes[DOTENV_LOCK_HOME_CLAIM_DEVICE_END
                                ..DOTENV_LOCK_HOME_CLAIM_IDENTITY_END]
                                .try_into()
                                .map_err(|_| PosixStoreError::Unsafe)?,
                        );
                        HomeCreationClaim::Prepared(ObjectIdentity { device, inode })
                    }
                    _ => return Err(PosixStoreError::Unsafe),
                };
                Ok(DotenvLockRecordState::Held {
                    home_binding: home,
                    nonce,
                    home_claim,
                })
            }
            _ => Err(PosixStoreError::Unsafe),
        }
    })();
    zeroize_bytes(bytes.as_mut_slice());
    result
}

fn write_dotenv_lock_state(file: &File, state: u8) -> Result<(), PosixStoreError> {
    write_all_at(file, &[state], 0)?;
    platform::sync_file(file)
}

fn initialize_clean_dotenv_lock(file: &File, home: [u8; 32]) -> Result<(), PosixStoreError> {
    if metadata(file)?.size != 0 {
        write_dotenv_lock_state(file, DOTENV_LOCK_STATE_UNINITIALIZED)?;
    }
    file.set_len(DOTENV_LOCK_RECORD_LENGTH as u64)
        .map_err(|_| PosixStoreError::Io)?;
    let record = clean_lock_record(home);
    write_all_at(file, &record[1..], 1)?;
    platform::sync_file(file)?;
    write_dotenv_lock_state(file, DOTENV_LOCK_STATE_CLEAN)?;
    if read_dotenv_lock_record(file, home)? == (DotenvLockRecordState::Clean { home_binding: home })
    {
        Ok(())
    } else {
        Err(PosixStoreError::Lost)
    }
}

fn reset_clean_dotenv_lock(file: &File, home: [u8; 32]) -> Result<(), PosixStoreError> {
    write_dotenv_lock_state(file, DOTENV_LOCK_STATE_TRANSITION)?;
    let record = clean_lock_record(home);
    write_all_at(file, &record[1..], 1)?;
    platform::sync_file(file)?;
    write_dotenv_lock_state(file, DOTENV_LOCK_STATE_CLEAN)?;
    if read_dotenv_lock_record(file, home)? == (DotenvLockRecordState::Clean { home_binding: home })
    {
        Ok(())
    } else {
        Err(PosixStoreError::Lost)
    }
}

fn write_held_dotenv_lock(
    file: &File,
    home: [u8; 32],
    nonce: ValidatedUuidV4,
) -> Result<(), PosixStoreError> {
    if read_dotenv_lock_record(file, home)? != (DotenvLockRecordState::Clean { home_binding: home })
    {
        return Err(PosixStoreError::Lost);
    }
    write_dotenv_lock_state(file, DOTENV_LOCK_STATE_TRANSITION)?;
    if read_dotenv_lock_record(file, home)? != DotenvLockRecordState::Transition {
        return Err(PosixStoreError::Lost);
    }
    write_all_at(file, &nonce.0, DOTENV_LOCK_NONCE_START as u64)?;
    platform::sync_file(file)?;
    fail_on_dotenv_test_fault!(LockAfterNonceSync, PosixStoreError::Lost);
    write_dotenv_lock_state(file, DOTENV_LOCK_STATE_HELD)?;
    fail_on_dotenv_test_fault!(LockAfterHeldTransition, PosixStoreError::Lost);
    if read_dotenv_lock_record(file, home)?
        == (DotenvLockRecordState::Held {
            home_binding: home,
            nonce,
            home_claim: HomeCreationClaim::None,
        })
    {
        Ok(())
    } else {
        Err(PosixStoreError::Lost)
    }
}

fn write_home_creation_intent(
    file: &File,
    home: [u8; 32],
    nonce: ValidatedUuidV4,
) -> Result<(), PosixStoreError> {
    if read_dotenv_lock_record(file, home)?
        != (DotenvLockRecordState::Held {
            home_binding: home,
            nonce,
            home_claim: HomeCreationClaim::None,
        })
    {
        return Err(PosixStoreError::Lost);
    }
    write_all_at(
        file,
        &[DOTENV_HOME_CLAIM_PREPARING],
        DOTENV_LOCK_HOME_CLAIM_STAGE as u64,
    )?;
    platform::sync_file(file)?;
    if read_dotenv_lock_record(file, home)?
        == (DotenvLockRecordState::Held {
            home_binding: home,
            nonce,
            home_claim: HomeCreationClaim::Preparing,
        })
    {
        Ok(())
    } else {
        Err(PosixStoreError::Lost)
    }
}

fn write_prepared_home_claim(
    file: &File,
    home: [u8; 32],
    nonce: ValidatedUuidV4,
    identity: ObjectIdentity,
) -> Result<(), PosixStoreError> {
    if read_dotenv_lock_record(file, home)?
        != (DotenvLockRecordState::Held {
            home_binding: home,
            nonce,
            home_claim: HomeCreationClaim::Preparing,
        })
    {
        return Err(PosixStoreError::Lost);
    }
    let mut bytes = [0_u8; 2 * std::mem::size_of::<u64>()];
    bytes[..std::mem::size_of::<u64>()].copy_from_slice(&identity.device.to_le_bytes());
    bytes[std::mem::size_of::<u64>()..].copy_from_slice(&identity.inode.to_le_bytes());
    write_all_at(file, &bytes, DOTENV_LOCK_HOME_CLAIM_IDENTITY_START as u64)?;
    platform::sync_file(file)?;
    write_all_at(
        file,
        &[DOTENV_HOME_CLAIM_PREPARED],
        DOTENV_LOCK_HOME_CLAIM_STAGE as u64,
    )?;
    platform::sync_file(file)?;
    if read_dotenv_lock_record(file, home)?
        == (DotenvLockRecordState::Held {
            home_binding: home,
            nonce,
            home_claim: HomeCreationClaim::Prepared(identity),
        })
    {
        Ok(())
    } else {
        Err(PosixStoreError::Lost)
    }
}

fn exact_dotenv_lock(
    directory: &PosixPrivateDirectory,
    file: &File,
) -> Result<bool, PosixStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
    let facts = metadata(file)?;
    if !facts.exact_private_file(directory.core.process.uid) || !platform::access_is_private(file)?
    {
        return Ok(false);
    }
    let current = match secure_openat(
        directory_file,
        OsStr::new(DOTENV_LOCK_ENTRY),
        lock_open_flags(),
        Mode::empty(),
    ) {
        Ok(current) => File::from(current),
        Err(_) => return Ok(false),
    };
    let current_facts = metadata(&current)?;
    Ok(current_facts.identity == facts.identity
        && current_facts.exact_private_file(directory.core.process.uid)
        && platform::access_is_private(&current)?)
}

fn cleanup_created_dotenv_lock(
    directory: &PosixPrivateDirectory,
    file: &File,
    expected: ObjectIdentity,
) -> Result<(), PosixStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
    let retained = metadata(file)?;
    if retained.identity != expected
        || retained.kind != ObjectKind::RegularFile
        || !retained.owned_by(directory.core.process.uid)
        || retained.links > 1
    {
        return Err(PosixStoreError::Lost);
    }
    match secure_openat(
        directory_file,
        OsStr::new(DOTENV_LOCK_ENTRY),
        lock_open_flags(),
        Mode::empty(),
    ) {
        Ok(current) => {
            if metadata(&File::from(current))?.identity != expected {
                return Err(PosixStoreError::Lost);
            }
        }
        Err(error) if error == Errno::NOENT && retained.links == 0 => {
            platform::sync_directory(directory_file)?;
            return Ok(());
        }
        Err(_) => return Err(PosixStoreError::Lost),
    }
    rustix_fs::unlinkat(
        directory_file,
        OsStr::new(DOTENV_LOCK_ENTRY),
        AtFlags::empty(),
    )
    .map_err(|_| PosixStoreError::Lost)?;
    if !entry_is_missing_at(directory_file, OsStr::new(DOTENV_LOCK_ENTRY))?
        || metadata(file)?.links != 0
    {
        return Err(PosixStoreError::Lost);
    }
    platform::sync_directory(directory_file)
}

fn open_or_create_dotenv_lock(
    directory: &PosixPrivateDirectory,
) -> Result<(File, bool), PosixStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
    let mut created = false;
    let file = match secure_openat(
        directory_file,
        OsStr::new(DOTENV_LOCK_ENTRY),
        lock_open_flags(),
        Mode::empty(),
    ) {
        Ok(file) => File::from(file),
        Err(error) if error == Errno::NOENT => {
            let flags = lock_open_flags() | OFlags::CREATE | OFlags::EXCL;
            match secure_openat(
                directory_file,
                OsStr::new(DOTENV_LOCK_ENTRY),
                flags,
                private_file_mode(),
            ) {
                Ok(file) => {
                    created = true;
                    File::from(file)
                }
                Err(error) if error == Errno::EXIST => {
                    let existing = secure_openat(
                        directory_file,
                        OsStr::new(DOTENV_LOCK_ENTRY),
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
    drop(state);
    let created_identity = if created {
        let identity = metadata(&file)?.identity;
        if let Err(error) = (|| {
            rustix_fs::fchmod(&file, private_file_mode()).map_err(|_| PosixStoreError::Io)?;
            platform::initialize_created_access(&file)
        })() {
            cleanup_created_dotenv_lock(directory, &file, identity)?;
            return Err(error);
        }
        Some(identity)
    } else {
        None
    };
    match exact_dotenv_lock(directory, &file) {
        Ok(true) => {}
        Ok(false) => {
            if let Some(identity) = created_identity {
                cleanup_created_dotenv_lock(directory, &file, identity)?;
            }
            return Err(PosixStoreError::Unsafe);
        }
        Err(error) => {
            if let Some(identity) = created_identity {
                cleanup_created_dotenv_lock(directory, &file, identity)?;
            }
            return Err(error);
        }
    }
    Ok((file, created))
}

fn candidate_name(nonce: ValidatedUuidV4) -> OsString {
    let mut bytes = Vec::with_capacity(
        DOTENV_CANDIDATE_PREFIX.len() + LOCK_NONCE_LENGTH + DOTENV_CANDIDATE_SUFFIX.len(),
    );
    bytes.extend_from_slice(DOTENV_CANDIDATE_PREFIX);
    bytes.extend_from_slice(&nonce.0);
    bytes.extend_from_slice(DOTENV_CANDIDATE_SUFFIX);
    OsString::from_vec(bytes)
}

fn home_candidate_name(nonce: ValidatedUuidV4) -> OsString {
    let mut bytes = Vec::with_capacity(
        CODEX_HOME_CANDIDATE_PREFIX.len() + LOCK_NONCE_LENGTH + CODEX_HOME_CANDIDATE_SUFFIX.len(),
    );
    bytes.extend_from_slice(CODEX_HOME_CANDIDATE_PREFIX);
    bytes.extend_from_slice(&nonce.0);
    bytes.extend_from_slice(CODEX_HOME_CANDIDATE_SUFFIX);
    OsString::from_vec(bytes)
}

fn exact_claimed_home_candidate(
    context: &CodexDotenvContext,
    parent: &File,
    name: &OsStr,
    directory: &File,
    expected: ObjectIdentity,
) -> Result<Option<ObjectIdentity>, PosixStoreError> {
    context.process.verify()?;
    let parent_before = metadata(parent)?;
    if !secure_codex_directory(parent_before, context.process)
        || !platform::access_is_private(parent)?
    {
        return Err(PosixStoreError::Unsafe);
    }
    let facts = metadata(directory)?;
    if facts.identity != expected
        || facts.kind != ObjectKind::Directory
        || !facts.owned_by(context.process.uid)
        || !directory_is_empty(directory)?
    {
        return Ok(None);
    }
    let current = secure_openat(parent, name, directory_open_flags(), Mode::empty())
        .map(File::from)
        .map_err(|_| PosixStoreError::Lost)?;
    if metadata(&current)?.identity != facts.identity
        || !same_directory_security_binding(metadata(parent)?, parent_before)
    {
        return Ok(None);
    }
    Ok(Some(facts.identity))
}

fn cleanup_home_candidate(
    context: &CodexDotenvContext,
    nonce: ValidatedUuidV4,
    expected: ObjectIdentity,
) -> Result<(), PosixStoreError> {
    let parent = context.home.open_parent()?;
    let name = home_candidate_name(nonce);
    match rustix_fs::statat(&parent, name.as_os_str(), AtFlags::SYMLINK_NOFOLLOW) {
        Err(error) if error == Errno::NOENT => return Ok(()),
        Ok(_) => {}
        Err(_) => return Err(PosixStoreError::Io),
    }
    let directory = secure_openat(
        &parent,
        name.as_os_str(),
        directory_open_flags(),
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| PosixStoreError::Unsafe)?;
    let Some(identity) =
        exact_claimed_home_candidate(context, &parent, name.as_os_str(), &directory, expected)?
    else {
        return Err(PosixStoreError::Unsafe);
    };
    rustix_fs::unlinkat(&parent, name.as_os_str(), AtFlags::REMOVEDIR)
        .map_err(|_| PosixStoreError::Lost)?;
    if !entry_is_missing_at(&parent, name.as_os_str())?
        || metadata(&directory)?.identity != identity
    {
        return Err(PosixStoreError::Lost);
    }
    platform::sync_directory(&parent)
}

fn candidate_nonce(name: &[u8]) -> Result<Option<ValidatedUuidV4>, PosixStoreError> {
    if !name.starts_with(DOTENV_CANDIDATE_PREFIX) {
        return Ok(None);
    }
    let expected =
        DOTENV_CANDIDATE_PREFIX.len() + LOCK_NONCE_LENGTH + DOTENV_CANDIDATE_SUFFIX.len();
    if name.len() != expected || !name.ends_with(DOTENV_CANDIDATE_SUFFIX) {
        return Err(PosixStoreError::Unsafe);
    }
    let start = DOTENV_CANDIDATE_PREFIX.len();
    let value = std::str::from_utf8(&name[start..start + LOCK_NONCE_LENGTH])
        .map_err(|_| PosixStoreError::Unsafe)?;
    ValidatedUuidV4::parse(value)
        .map(Some)
        .map_err(|_| PosixStoreError::Unsafe)
}

fn list_dotenv_candidates(home: &CodexHome) -> Result<Vec<ValidatedUuidV4>, PosixStoreError> {
    let before = home.attest()?;
    let mut stream = Dir::read_from(&home.directory).map_err(|_| PosixStoreError::Io)?;
    let mut scanned = 0_usize;
    let mut candidates = Vec::new();
    while let Some(raw) = stream.read() {
        let raw = raw.map_err(|_| PosixStoreError::Io)?;
        let name = raw.file_name().to_bytes();
        if name == b"." || name == b".." {
            continue;
        }
        scanned = scanned.checked_add(1).ok_or(PosixStoreError::Limit)?;
        if scanned > MAX_CODEX_HOME_ENTRIES {
            return Err(PosixStoreError::Limit);
        }
        if let Some(nonce) = candidate_nonce(name)? {
            if candidates.len() == MAX_CODEX_CANDIDATES {
                return Err(PosixStoreError::Limit);
            }
            candidates.push(nonce);
        }
    }
    if home.attest()? != before {
        return Err(PosixStoreError::Lost);
    }
    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(candidates)
}

fn exact_candidate(
    home: &CodexHome,
    file: &File,
    name: &OsStr,
    expected: ObjectIdentity,
) -> Result<bool, PosixStoreError> {
    let home_facts = home.attest()?;
    let facts = metadata(file)?;
    if facts.identity != expected
        || !facts.exact_private_file(home.process.uid)
        || !platform::access_is_private(file)?
    {
        return Ok(false);
    }
    let current = match secure_openat(&home.directory, name, read_open_flags(), Mode::empty()) {
        Ok(current) => File::from(current),
        Err(_) => return Ok(false),
    };
    Ok(metadata(&current)?.identity == expected
        && metadata(&current)?.exact_private_file(home.process.uid)
        && platform::access_is_private(&current)?
        && home.attest()? == home_facts)
}

fn remove_exact_candidate(
    home: &CodexHome,
    name: &OsStr,
    file: &File,
    expected: ObjectIdentity,
) -> Result<(), PosixStoreError> {
    if !exact_candidate(home, file, name, expected)? {
        return Err(PosixStoreError::Lost);
    }
    fail_on_dotenv_test_fault!(RecoveryBeforeUnlink, PosixStoreError::Io);
    rustix_fs::unlinkat(&home.directory, name, AtFlags::empty())
        .map_err(|_| PosixStoreError::Lost)?;
    fail_on_dotenv_test_fault!(RecoveryAfterUnlink, PosixStoreError::Lost);
    if !entry_is_missing_at(&home.directory, name)? || metadata(file)?.links != 0 {
        return Err(PosixStoreError::Lost);
    }
    platform::sync_directory(&home.directory)?;
    fail_on_dotenv_test_fault!(RecoveryAfterDirectorySync, PosixStoreError::Lost);
    home.attest()?;
    Ok(())
}

fn recover_abandoned_dotenv_candidate(
    context: &CodexDotenvContext,
    prior_nonce: ValidatedUuidV4,
) -> Result<(), PosixStoreError> {
    let home = match open_codex_home(context)? {
        None => return Ok(()),
        Some(home) => home,
    };
    let candidates = list_dotenv_candidates(&home)?;
    if candidates.is_empty() {
        return Ok(());
    }
    if candidates.as_slice() != [prior_nonce] {
        return Err(PosixStoreError::Unsafe);
    }
    let name = candidate_name(prior_nonce);
    let file = secure_openat(
        &home.directory,
        name.as_os_str(),
        read_open_flags(),
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| PosixStoreError::Lost)?;
    let identity = metadata(&file)?.identity;
    remove_exact_candidate(&home, name.as_os_str(), &file, identity)
}

fn recover_abandoned_transaction(
    context: &CodexDotenvContext,
    prior_nonce: ValidatedUuidV4,
    home_claim: HomeCreationClaim,
) -> Result<(), PosixStoreError> {
    match home_claim {
        HomeCreationClaim::None => recover_abandoned_dotenv_candidate(context, prior_nonce),
        HomeCreationClaim::Preparing => {
            let parent = context.home.open_parent()?;
            let candidate = home_candidate_name(prior_nonce);
            match rustix_fs::statat(&parent, candidate.as_os_str(), AtFlags::SYMLINK_NOFOLLOW) {
                Err(error) if error == Errno::NOENT => Ok(()),
                Ok(_) => Err(PosixStoreError::Lost),
                Err(_) => Err(PosixStoreError::Io),
            }
        }
        HomeCreationClaim::Prepared(expected_identity) => {
            let parent = context.home.open_parent()?;
            let candidate = home_candidate_name(prior_nonce);
            let candidate_exists = match rustix_fs::statat(
                &parent,
                candidate.as_os_str(),
                AtFlags::SYMLINK_NOFOLLOW,
            ) {
                Ok(_) => true,
                Err(error) if error == Errno::NOENT => false,
                Err(_) => return Err(PosixStoreError::Io),
            };
            drop(parent);
            if candidate_exists {
                return cleanup_home_candidate(context, prior_nonce, expected_identity);
            }

            let Some(home) = open_codex_home(context)? else {
                return Ok(());
            };
            if metadata(&home.directory)?.identity != expected_identity {
                return Ok(());
            }
            recover_abandoned_dotenv_candidate(context, prior_nonce)?;
            match rustix_fs::statat(
                &home.directory,
                OsStr::new(DOTENV_ENTRY),
                AtFlags::SYMLINK_NOFOLLOW,
            ) {
                Ok(_) => Ok(()),
                Err(error) if error == Errno::NOENT && directory_is_empty(&home.directory)? => {
                    if metadata(&home.directory)?.identity != expected_identity {
                        return Err(PosixStoreError::Lost);
                    }
                    cleanup_empty_created_home(&home)
                }
                Err(error) if error == Errno::NOENT => Ok(()),
                Err(_) => Err(PosixStoreError::Io),
            }
        }
    }
}

enum DotenvLockAcquireResult {
    Busy,
    Acquired(HeldDotenvLock),
}

fn acquire_dotenv_lock(
    context: &CodexDotenvContext,
    state_directory: &Path,
    nonce: ValidatedUuidV4,
) -> Result<DotenvLockAcquireResult, PosixStoreError> {
    let directory = match open_private_directory(state_directory)? {
        PrivateDirectoryOpenResult::Missing => return Err(PosixStoreError::Missing),
        PrivateDirectoryOpenResult::Opened(directory) => directory,
    };
    let binding = home_binding(&context.home);
    let (lock, created) = open_or_create_dotenv_lock(&directory)?;
    match rustix_fs::flock(&lock, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => {}
        Err(error) if error == Errno::WOULDBLOCK || error == Errno::AGAIN => {
            return Ok(DotenvLockAcquireResult::Busy);
        }
        Err(_) => return Err(PosixStoreError::Io),
    }
    if !exact_dotenv_lock(&directory, &lock)? {
        return Err(PosixStoreError::Unsafe);
    }
    match read_dotenv_lock_record(&lock, binding)? {
        DotenvLockRecordState::Uninitialized => {
            initialize_clean_dotenv_lock(&lock, binding)?;
            fail_on_dotenv_test_fault!(LockAfterInitializedClean, PosixStoreError::Lost);
        }
        DotenvLockRecordState::Clean { home_binding } => {
            if home_binding != binding {
                reset_clean_dotenv_lock(&lock, binding)?;
            }
        }
        DotenvLockRecordState::Transition => {
            reset_clean_dotenv_lock(&lock, binding)?;
        }
        DotenvLockRecordState::Held {
            home_binding,
            nonce: prior_nonce,
            home_claim,
        } => {
            if home_binding != binding {
                return Err(PosixStoreError::Unsafe);
            }
            recover_abandoned_transaction(context, prior_nonce, home_claim)?;
            fail_on_dotenv_test_fault!(LockAfterRecovery, PosixStoreError::Lost);
            reset_clean_dotenv_lock(&lock, binding)?;
        }
    }
    write_held_dotenv_lock(&lock, binding, nonce)?;
    if created {
        let state = lock_unpoisoned(&directory.core.state)?;
        platform::sync_directory(state.directory.as_ref().ok_or(PosixStoreError::Closed)?)?;
    }
    if !exact_dotenv_lock(&directory, &lock)?
        || read_dotenv_lock_record(&lock, binding)?
            != (DotenvLockRecordState::Held {
                home_binding: binding,
                nonce,
                home_claim: HomeCreationClaim::None,
            })
    {
        return Err(PosixStoreError::Lost);
    }
    Ok(DotenvLockAcquireResult::Acquired(HeldDotenvLock {
        directory,
        lock: Some(lock),
        nonce,
        home_binding: binding,
        home_claim: HomeCreationClaim::None,
        terminal: false,
    }))
}

impl HeldDotenvLock {
    fn verify(&self) -> Result<(), PosixStoreError> {
        if self.terminal {
            return Err(PosixStoreError::Closed);
        }
        let lock = self.lock.as_ref().ok_or(PosixStoreError::Closed)?;
        if !exact_dotenv_lock(&self.directory, lock)?
            || read_dotenv_lock_record(lock, self.home_binding)?
                != (DotenvLockRecordState::Held {
                    home_binding: self.home_binding,
                    nonce: self.nonce,
                    home_claim: self.home_claim,
                })
        {
            return Err(PosixStoreError::Lost);
        }
        Ok(())
    }

    fn begin_home_creation(&mut self) -> Result<(), PosixStoreError> {
        self.verify()?;
        if self.home_claim != HomeCreationClaim::None {
            return Err(PosixStoreError::Lost);
        }
        let lock = self.lock.as_ref().ok_or(PosixStoreError::Closed)?;
        write_home_creation_intent(lock, self.home_binding, self.nonce)?;
        self.home_claim = HomeCreationClaim::Preparing;
        self.verify()
    }

    fn claim_prepared_home(&mut self, identity: ObjectIdentity) -> Result<(), PosixStoreError> {
        self.verify()?;
        if self.home_claim != HomeCreationClaim::Preparing {
            return Err(PosixStoreError::Lost);
        }
        let lock = self.lock.as_ref().ok_or(PosixStoreError::Closed)?;
        write_prepared_home_claim(lock, self.home_binding, self.nonce, identity)?;
        self.home_claim = HomeCreationClaim::Prepared(identity);
        self.verify()
    }

    fn release(&mut self, context: &CodexDotenvContext) -> Result<(), PosixStoreError> {
        self.verify()?;
        if let Some(home) = open_codex_home(context)? {
            if !list_dotenv_candidates(&home)?.is_empty() {
                return Err(PosixStoreError::Lost);
            }
        }
        let lock = self.lock.as_ref().ok_or(PosixStoreError::Closed)?;
        fail_on_dotenv_test_fault!(ReleaseBeforeClean, PosixStoreError::Lost);
        reset_clean_dotenv_lock(lock, self.home_binding)?;
        fail_on_dotenv_test_fault!(ReleaseAfterClean, PosixStoreError::Lost);
        if read_dotenv_lock_record(lock, self.home_binding)?
            != (DotenvLockRecordState::Clean {
                home_binding: self.home_binding,
            })
        {
            return Err(PosixStoreError::Lost);
        }
        let lock = self.lock.take().ok_or(PosixStoreError::Closed)?;
        rustix_fs::flock(&lock, FlockOperation::Unlock).map_err(|_| PosixStoreError::Lost)?;
        self.terminal = true;
        Ok(())
    }
}

impl Drop for HeldDotenvLock {
    fn drop(&mut self) {
        if let Some(lock) = self.lock.take() {
            let _ = rustix_fs::flock(&lock, FlockOperation::Unlock);
        }
        self.terminal = true;
    }
}

fn cleanup_empty_created_home(home: &CodexHome) -> Result<(), PosixStoreError> {
    home.process.verify()?;
    let facts = metadata(&home.directory)?;
    if facts.kind != ObjectKind::Directory
        || !facts.owned_by(home.process.uid)
        || facts.mode & PERMISSION_AND_SPECIAL_BITS != PRIVATE_DIRECTORY_MODE
        || !platform::access_is_private(&home.directory)?
        || !directory_is_empty(&home.directory)?
    {
        return Err(PosixStoreError::Lost);
    }
    let current = secure_openat(
        &home.parent,
        home.path.final_name(),
        directory_open_flags(),
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| PosixStoreError::Lost)?;
    if metadata(&current)?.identity != facts.identity {
        return Err(PosixStoreError::Lost);
    }
    rustix_fs::unlinkat(&home.parent, home.path.final_name(), AtFlags::REMOVEDIR)
        .map_err(|_| PosixStoreError::Lost)?;
    if !entry_is_missing_at(&home.parent, home.path.final_name())? {
        return Err(PosixStoreError::Lost);
    }
    platform::sync_directory(&home.parent)
}

fn create_codex_home(
    context: &CodexDotenvContext,
    expected_parent: MetadataFacts,
    lock: &mut HeldDotenvLock,
) -> Result<Option<CodexHome>, PosixStoreError> {
    let (parent, parent_facts) = stable_missing_parent(context)?;
    if parent_facts != expected_parent {
        return Ok(None);
    }
    lock.begin_home_creation()?;
    fail_on_dotenv_test_fault!(HomeAfterIntent, PosixStoreError::Lost);
    let candidate_name = home_candidate_name(lock.nonce);
    match rustix_fs::mkdirat(
        &parent,
        candidate_name.as_os_str(),
        private_directory_mode(),
    ) {
        Ok(()) => {}
        Err(error) if error == Errno::EXIST => return Ok(None),
        Err(_) => return Err(PosixStoreError::Io),
    }
    fail_on_dotenv_test_fault!(HomeAfterCandidateCreate, PosixStoreError::Lost);
    let directory = secure_openat(
        &parent,
        candidate_name.as_os_str(),
        directory_open_flags(),
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| PosixStoreError::Lost)?;
    let created = metadata(&directory)?;
    if created.kind != ObjectKind::Directory || !created.owned_by(context.process.uid) {
        return Err(PosixStoreError::Unsafe);
    }
    let rebound = secure_openat(
        &parent,
        candidate_name.as_os_str(),
        directory_open_flags(),
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| PosixStoreError::Lost)?;
    if metadata(&rebound)?.identity != created.identity
        || !same_directory_security_binding(metadata(&parent)?, parent_facts)
    {
        return Err(PosixStoreError::Lost);
    }
    lock.claim_prepared_home(created.identity)?;
    fail_on_dotenv_test_fault!(HomeAfterCandidateClaim, PosixStoreError::Lost);

    rustix_fs::fchmod(&directory, private_directory_mode()).map_err(|_| PosixStoreError::Io)?;
    platform::initialize_created_access(&directory)?;
    let initialized = metadata(&directory)?;
    if initialized.identity != created.identity
        || initialized.kind != ObjectKind::Directory
        || !initialized.owned_by(context.process.uid)
        || initialized.mode & PERMISSION_AND_SPECIAL_BITS != PRIVATE_DIRECTORY_MODE
        || !platform::access_is_private(&directory)?
        || !directory_is_empty(&directory)?
    {
        return Err(PosixStoreError::Unsafe);
    }
    platform::sync_directory(&parent)?;
    match rustix_fs::renameat_with(
        &parent,
        candidate_name.as_os_str(),
        &parent,
        context.home.final_name(),
        RenameFlags::NOREPLACE,
    ) {
        Ok(()) => {}
        Err(error) if error == Errno::EXIST => return Err(PosixStoreError::Lost),
        Err(_) => return Err(PosixStoreError::Io),
    }
    fail_on_dotenv_test_fault!(HomeAfterRename, PosixStoreError::Lost);
    platform::sync_directory(&parent)?;
    if !entry_is_missing_at(&parent, candidate_name.as_os_str())? {
        return Err(PosixStoreError::Lost);
    }
    let home = CodexHome {
        process: context.process,
        path: context.home.clone(),
        parent,
        directory,
    };
    let installed = home.attest()?;
    if installed.identity != created.identity
        || installed.mode & PERMISSION_AND_SPECIAL_BITS != PRIVATE_DIRECTORY_MODE
    {
        return Err(PosixStoreError::Lost);
    }
    Ok(Some(home))
}

fn prepare_candidate(
    home: &CodexHome,
    nonce: ValidatedUuidV4,
    desired: &[u8],
    max_bytes: usize,
) -> Result<PreparedCandidate, PosixStoreError> {
    if desired.is_empty() || desired.len() > max_bytes {
        return Err(PosixStoreError::InvalidInput);
    }
    if !list_dotenv_candidates(home)?.is_empty() {
        return Err(PosixStoreError::Unsafe);
    }
    let name = candidate_name(nonce);
    match rustix_fs::statat(&home.directory, name.as_os_str(), AtFlags::SYMLINK_NOFOLLOW) {
        Err(error) if error == Errno::NOENT => {}
        Ok(_) => return Err(PosixStoreError::Unsafe),
        Err(_) => return Err(PosixStoreError::Io),
    }
    let flags = lock_open_flags() | OFlags::CREATE | OFlags::EXCL;
    let file = secure_openat(
        &home.directory,
        name.as_os_str(),
        flags,
        private_file_mode(),
    )
    .map(File::from)
    .map_err(|error| {
        if error == Errno::EXIST {
            PosixStoreError::Unsafe
        } else {
            PosixStoreError::Io
        }
    })?;
    fail_on_dotenv_test_fault!(CandidateAfterCreate, PosixStoreError::Lost);
    let identity = metadata(&file)?.identity;
    let prepared = (|| {
        rustix_fs::fchmod(&file, private_file_mode()).map_err(|_| PosixStoreError::Io)?;
        platform::initialize_created_access(&file)?;
        let empty = metadata(&file)?;
        if !empty.exact_private_file(home.process.uid)
            || empty.size != 0
            || !platform::access_is_private(&file)?
        {
            return Err(PosixStoreError::Unsafe);
        }
        let rebound = secure_openat(
            &home.directory,
            name.as_os_str(),
            read_open_flags(),
            Mode::empty(),
        )
        .map(File::from)
        .map_err(|_| PosixStoreError::Lost)?;
        if metadata(&rebound)?.identity != identity
            || !exact_candidate(home, &file, &name, identity)?
        {
            return Err(PosixStoreError::Lost);
        }
        rustix_fs::ftruncate(&file, 0).map_err(|_| PosixStoreError::Io)?;
        write_all_at(&file, desired, 0)?;
        rustix_fs::ftruncate(
            &file,
            u64::try_from(desired.len()).map_err(|_| PosixStoreError::Limit)?,
        )
        .map_err(|_| PosixStoreError::Io)?;
        fail_on_dotenv_test_fault!(CandidateAfterWrite, PosixStoreError::Lost);
        let mut readback = read_up_to_at(
            &file,
            max_bytes.checked_add(1).ok_or(PosixStoreError::Limit)?,
        )?;
        let matches = (|| {
            Ok(readback == desired
                && metadata(&file)?.size == desired.len() as u64
                && exact_candidate(home, &file, &name, identity)?)
        })();
        zeroize_bytes(readback.as_mut_slice());
        let matches = matches?;
        if !matches {
            return Err(PosixStoreError::Lost);
        }
        fail_on_dotenv_test_fault!(CandidateAfterReadback, PosixStoreError::Lost);
        platform::sync_file(&file)?;
        fail_on_dotenv_test_fault!(CandidateAfterFileSync, PosixStoreError::Lost);
        let mut synced = read_up_to_at(
            &file,
            max_bytes.checked_add(1).ok_or(PosixStoreError::Limit)?,
        )?;
        let synced_matches = (|| {
            Ok(synced == desired
                && metadata(&file)?.size == desired.len() as u64
                && exact_candidate(home, &file, &name, identity)?)
        })();
        zeroize_bytes(synced.as_mut_slice());
        let synced_matches = synced_matches?;
        if !synced_matches {
            return Err(PosixStoreError::Lost);
        }
        Ok(())
    })();
    match prepared {
        Ok(()) => Ok(PreparedCandidate {
            name,
            identity,
            file,
        }),
        Err(error) => Err(error),
    }
}

fn cleanup_candidate(
    home: &CodexHome,
    candidate: &PreparedCandidate,
) -> Result<(), PosixStoreError> {
    remove_exact_candidate(
        home,
        candidate.name.as_os_str(),
        &candidate.file,
        candidate.identity,
    )
}

fn state_matches_observation(
    observation: &InternalObservation,
    expected: &CodexDotenvState,
) -> bool {
    take_internal_state(observation) == expected
}

fn wipe_internal_observation(observation: &mut InternalObservation) {
    if let InternalObservation::Present { bytes, .. } = observation {
        zeroize_bytes(bytes.as_mut_slice());
    }
}

fn exact_destination_precondition(
    home: &CodexHome,
    expected: &CodexDotenvState,
    created_home: bool,
) -> Result<bool, PosixStoreError> {
    let home_facts = home.attest()?;
    match expected.kind {
        CodexDotenvSnapshotKind::MissingHome { .. } if created_home => {
            entry_is_missing_at(&home.directory, OsStr::new(DOTENV_ENTRY))
        }
        CodexDotenvSnapshotKind::MissingFile {
            home_facts: expected_home,
        } if DirectorySecurityFacts::from(home_facts)
            == DirectorySecurityFacts::from(expected_home) =>
        {
            entry_is_missing_at(&home.directory, OsStr::new(DOTENV_ENTRY))
        }
        CodexDotenvSnapshotKind::Present {
            home_facts: expected_home,
            file_facts,
        } if DirectorySecurityFacts::from(home_facts) == expected_home => {
            let current = match secure_openat(
                &home.directory,
                OsStr::new(DOTENV_ENTRY),
                read_open_flags(),
                Mode::empty(),
            ) {
                Ok(current) => File::from(current),
                Err(error) if error == Errno::NOENT => return Ok(false),
                Err(_) => return Err(PosixStoreError::Unsafe),
            };
            Ok(metadata(&current)? == file_facts
                && exact_secure_dotenv_file(home, &current, file_facts.identity)?)
        }
        _ => Ok(false),
    }
}

fn install_candidate(
    home: &CodexHome,
    expected: &CodexDotenvState,
    created_home: bool,
    candidate: &PreparedCandidate,
) -> Result<bool, PosixStoreError> {
    if !exact_candidate(
        home,
        &candidate.file,
        candidate.name.as_os_str(),
        candidate.identity,
    )? || !exact_destination_precondition(home, expected, created_home)?
    {
        return Ok(false);
    }
    fail_on_dotenv_test_fault!(InstallBeforeRename, PosixStoreError::Lost);
    let rename = match expected.kind {
        CodexDotenvSnapshotKind::MissingHome { .. }
        | CodexDotenvSnapshotKind::MissingFile { .. } => rustix_fs::renameat_with(
            &home.directory,
            candidate.name.as_os_str(),
            &home.directory,
            OsStr::new(DOTENV_ENTRY),
            RenameFlags::NOREPLACE,
        ),
        CodexDotenvSnapshotKind::Present { .. } => rustix_fs::renameat(
            &home.directory,
            candidate.name.as_os_str(),
            &home.directory,
            OsStr::new(DOTENV_ENTRY),
        ),
        _ => return Ok(false),
    };
    if let Err(error) = rename {
        if error == Errno::EXIST {
            return Ok(false);
        }
        return Err(PosixStoreError::Lost);
    }
    fail_on_dotenv_test_fault!(InstallAfterRename, PosixStoreError::Lost);
    let destination = secure_openat(
        &home.directory,
        OsStr::new(DOTENV_ENTRY),
        read_open_flags(),
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| PosixStoreError::Lost)?;
    if !entry_is_missing_at(&home.directory, candidate.name.as_os_str())?
        || metadata(&destination)?.identity != candidate.identity
        || !exact_secure_dotenv_file(home, &destination, candidate.identity)?
    {
        return Err(PosixStoreError::Lost);
    }
    platform::sync_directory(&home.directory).map_err(|_| PosixStoreError::Lost)?;
    fail_on_dotenv_test_fault!(InstallAfterDirectorySync, PosixStoreError::Lost);
    if !exact_secure_dotenv_file(home, &destination, candidate.identity)? {
        return Err(PosixStoreError::Lost);
    }
    fail_on_dotenv_test_fault!(InstallAfterReadback, PosixStoreError::Lost);
    Ok(true)
}

fn remove_installed_candidate(
    home: &CodexHome,
    installed_identity: ObjectIdentity,
) -> Result<(), PosixStoreError> {
    let installed = secure_openat(
        &home.directory,
        OsStr::new(DOTENV_ENTRY),
        read_open_flags(),
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| PosixStoreError::Lost)?;
    if metadata(&installed)?.identity != installed_identity
        || !exact_secure_dotenv_file(home, &installed, installed_identity)?
    {
        return Err(PosixStoreError::Lost);
    }
    rustix_fs::unlinkat(&home.directory, OsStr::new(DOTENV_ENTRY), AtFlags::empty())
        .map_err(|_| PosixStoreError::Lost)?;
    if !entry_is_missing_at(&home.directory, OsStr::new(DOTENV_ENTRY))?
        || metadata(&installed)?.links != 0
    {
        return Err(PosixStoreError::Lost);
    }
    platform::sync_directory(&home.directory)
}

fn rollback_present(
    home: &CodexHome,
    nonce: ValidatedUuidV4,
    installed_identity: ObjectIdentity,
    old_bytes: &[u8],
    max_bytes: usize,
) -> Result<(), PosixStoreError> {
    let current = secure_openat(
        &home.directory,
        OsStr::new(DOTENV_ENTRY),
        read_open_flags(),
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| PosixStoreError::Lost)?;
    if metadata(&current)?.identity != installed_identity
        || !exact_secure_dotenv_file(home, &current, installed_identity)?
    {
        return Err(PosixStoreError::Lost);
    }
    let rollback = prepare_candidate(home, nonce, old_bytes, max_bytes)?;
    if !exact_secure_dotenv_file(home, &current, installed_identity)?
        || !exact_candidate(
            home,
            &rollback.file,
            rollback.name.as_os_str(),
            rollback.identity,
        )?
    {
        return Err(PosixStoreError::Lost);
    }
    rustix_fs::renameat(
        &home.directory,
        rollback.name.as_os_str(),
        &home.directory,
        OsStr::new(DOTENV_ENTRY),
    )
    .map_err(|_| PosixStoreError::Lost)?;
    let restored = secure_openat(
        &home.directory,
        OsStr::new(DOTENV_ENTRY),
        read_open_flags(),
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| PosixStoreError::Lost)?;
    if metadata(&restored)?.identity != rollback.identity
        || !entry_is_missing_at(&home.directory, rollback.name.as_os_str())?
        || !exact_secure_dotenv_file(home, &restored, rollback.identity)?
    {
        return Err(PosixStoreError::Lost);
    }
    platform::sync_directory(&home.directory)?;
    let mut readback = read_up_to_at(
        &restored,
        max_bytes.checked_add(1).ok_or(PosixStoreError::Limit)?,
    )?;
    let exact = readback == old_bytes
        && metadata(&restored)?.size == old_bytes.len() as u64
        && exact_secure_dotenv_file(home, &restored, rollback.identity)?;
    zeroize_bytes(readback.as_mut_slice());
    if exact {
        Ok(())
    } else {
        Err(PosixStoreError::Lost)
    }
}

fn post_install_observation(
    context: &CodexDotenvContext,
    max_bytes: usize,
) -> Result<InternalObservation, PosixStoreError> {
    fail_on_dotenv_test_fault!(PostInstallObservation, PosixStoreError::Io);
    observe_internal(context, max_bytes)
}

fn force_post_install_mismatch() -> bool {
    #[cfg(test)]
    {
        take_dotenv_test_fault(DotenvTestFault::PostInstallMismatch)
    }
    #[cfg(not(test))]
    {
        false
    }
}

fn synchronize_inner(
    context: &CodexDotenvContext,
    state_directory: &Path,
    expected: &CodexDotenvState,
    nonce: ValidatedUuidV4,
    desired: Option<&[u8]>,
    max_bytes: usize,
) -> Result<CodexDotenvSynchronizeResult, PosixStoreError> {
    if expected.process != context.process
        || expected.home != context.home
        || expected.excluded_project != context.excluded_project
    {
        return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
    }
    if matches!(
        expected.kind,
        CodexDotenvSnapshotKind::Unsafe | CodexDotenvSnapshotKind::Oversized { .. }
    ) {
        return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
    }

    let mut lock = match acquire_dotenv_lock(context, state_directory, nonce)? {
        DotenvLockAcquireResult::Busy => {
            return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
        }
        DotenvLockAcquireResult::Acquired(lock) => lock,
    };
    lock.verify()?;
    let mut current = observe_internal(context, max_bytes)?;
    if !state_matches_observation(&current, expected) {
        wipe_internal_observation(&mut current);
        lock.release(context)?;
        return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
    }

    if desired.is_none() {
        wipe_internal_observation(&mut current);
        let mut final_observation = observe_internal(context, max_bytes)?;
        if !state_matches_observation(&final_observation, expected) {
            wipe_internal_observation(&mut final_observation);
            return Err(PosixStoreError::Lost);
        }
        wipe_internal_observation(&mut final_observation);
        lock.release(context)?;
        return Ok(CodexDotenvSynchronizeResult::Completed {
            disposition: CodexDotenvSynchronizeDisposition::Unchanged,
            state: expected.clone(),
        });
    }
    let desired = desired.ok_or(PosixStoreError::InvalidInput)?;

    let old_bytes = if let InternalObservation::Present { bytes, .. } = &mut current {
        if bytes.as_slice() == desired {
            zeroize_bytes(bytes.as_mut_slice());
            let mut final_observation = observe_internal(context, max_bytes)?;
            if !state_matches_observation(&final_observation, expected) {
                wipe_internal_observation(&mut final_observation);
                return Err(PosixStoreError::Lost);
            }
            wipe_internal_observation(&mut final_observation);
            lock.release(context)?;
            return Ok(CodexDotenvSynchronizeResult::Completed {
                disposition: CodexDotenvSynchronizeDisposition::Unchanged,
                state: expected.clone(),
            });
        }
        Some(WipedBytes(std::mem::take(bytes)))
    } else {
        None
    };
    let old_missing = old_bytes.is_none();

    let (home, created_home) = match expected.kind {
        CodexDotenvSnapshotKind::MissingHome { parent_facts } => {
            let Some(home) = create_codex_home(context, parent_facts, &mut lock)? else {
                lock.release(context)?;
                return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
            };
            (home, true)
        }
        _ => (
            open_codex_home(context)?.ok_or(PosixStoreError::Lost)?,
            false,
        ),
    };
    lock.verify()?;
    let candidate = match prepare_candidate(&home, nonce, desired, max_bytes) {
        Ok(candidate) => candidate,
        Err(error) => {
            if created_home && list_dotenv_candidates(&home)?.is_empty() {
                cleanup_empty_created_home(&home)?;
            }
            return Err(error);
        }
    };
    lock.verify()?;

    if !exact_destination_precondition(&home, expected, created_home)? {
        cleanup_candidate(&home, &candidate)?;
        if created_home {
            cleanup_empty_created_home(&home)?;
        }
        lock.release(context)?;
        return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
    }

    match install_candidate(&home, expected, created_home, &candidate)? {
        false => {
            cleanup_candidate(&home, &candidate)?;
            if created_home {
                cleanup_empty_created_home(&home)?;
            }
            lock.release(context)?;
            Ok(CodexDotenvSynchronizeResult::PreconditionFailed)
        }
        true => {
            lock.verify()?;
            let mut installed = match post_install_observation(context, max_bytes) {
                Ok(installed) => installed,
                Err(error) => {
                    let rollback = if old_missing {
                        remove_installed_candidate(&home, candidate.identity)
                    } else if let Some(old_bytes) = old_bytes.as_ref() {
                        rollback_present(
                            &home,
                            nonce,
                            candidate.identity,
                            old_bytes.as_slice(),
                            max_bytes,
                        )
                    } else {
                        Err(PosixStoreError::Lost)
                    };
                    if rollback.is_ok() && created_home && old_missing {
                        cleanup_empty_created_home(&home)?;
                    }
                    if rollback.is_ok() {
                        lock.release(context)?;
                        return Err(error);
                    }
                    return Err(PosixStoreError::Lost);
                }
            };
            let (state, matches) = match &mut installed {
                InternalObservation::Present { state, bytes } => {
                    let matches = bytes.as_slice() == desired && !force_post_install_mismatch();
                    zeroize_bytes(bytes.as_mut_slice());
                    (state.clone(), matches)
                }
                _ => (take_internal_state(&installed).clone(), false),
            };
            if !matches {
                let rollback = if old_missing {
                    remove_installed_candidate(&home, candidate.identity)
                } else if let Some(old_bytes) = old_bytes.as_ref() {
                    rollback_present(
                        &home,
                        nonce,
                        candidate.identity,
                        old_bytes.as_slice(),
                        max_bytes,
                    )
                } else {
                    Err(PosixStoreError::Lost)
                };
                if rollback.is_ok() && created_home && old_missing {
                    cleanup_empty_created_home(&home)?;
                }
                if rollback.is_ok() {
                    lock.release(context)?;
                }
                return Err(PosixStoreError::Lost);
            }
            lock.release(context)?;
            Ok(CodexDotenvSynchronizeResult::Completed {
                disposition: CodexDotenvSynchronizeDisposition::Changed,
                state,
            })
        }
    }
}

pub(crate) fn synchronize_codex_dotenv(
    codex_home: &Path,
    state_directory: &Path,
    excluded_project: &Path,
    expected: &CodexDotenvState,
    nonce: &str,
    desired: Option<&[u8]>,
    max_bytes: usize,
) -> Result<CodexDotenvSynchronizeResult, PosixStoreError> {
    validate_max_bytes(max_bytes)?;
    if desired.is_some_and(|bytes| bytes.is_empty() || bytes.len() > max_bytes) {
        return Err(PosixStoreError::InvalidInput);
    }
    let nonce = ValidatedUuidV4::parse(nonce)?;
    let context = match parse_context(codex_home, excluded_project) {
        Ok(context) => context,
        Err(PosixStoreError::Unsafe) => {
            let home = NormalizedAbsolutePath::parse(codex_home)?;
            let excluded = NormalizedAbsolutePath::parse(excluded_project)?;
            if home.components.len() >= excluded.components.len()
                && home.components[..excluded.components.len()] == excluded.components[..]
            {
                return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
            }
            return Err(PosixStoreError::Unsafe);
        }
        Err(error) => return Err(error),
    };
    let mut owned = desired.map(|bytes| bytes.to_vec());
    let result = synchronize_inner(
        &context,
        state_directory,
        expected,
        nonce,
        owned.as_deref(),
        max_bytes,
    );
    if let Some(bytes) = &mut owned {
        zeroize_bytes(bytes.as_mut_slice());
    }
    result
}

#[cfg(test)]
mod tests {
    use std::fs::{self, OpenOptions};
    #[cfg(target_os = "macos")]
    use std::os::fd::AsFd;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    use std::path::{Path, PathBuf};

    use super::super::tests::{create_private_directory, create_private_file, TestRoot};
    use super::*;

    const NONCE_1: &str = "11111111-1111-4111-8111-111111111111";
    const NONCE_2: &str = "22222222-2222-4222-8222-222222222222";
    const NONCE_3: &str = "33333333-3333-4333-8333-333333333333";
    const NONCE_4: &str = "44444444-4444-4444-8444-444444444444";
    const MAX_BYTES: usize = MAX_CODEX_DOTENV_BYTES;
    const ORIGINAL: &[u8] = b"UNRELATED=value\nPLURUM_API_KEY=plrm_live_original\n";
    const DESIRED: &[u8] = b"UNRELATED=value\nPLURUM_API_KEY=plrm_live_replacement\n";

    struct Fixture {
        test: TestRoot,
        codex_home: PathBuf,
        excluded_project: PathBuf,
    }

    impl Fixture {
        fn new(create_home: bool) -> Self {
            let test = TestRoot::new();
            create_private_directory(&test.store);
            let excluded_project = test.root.join("project");
            create_private_directory(&excluded_project);
            let codex_home = test.root.join("codex");
            if create_home {
                create_private_directory(&codex_home);
            }
            Self {
                test,
                codex_home,
                excluded_project,
            }
        }

        fn dotenv(&self) -> PathBuf {
            self.codex_home.join(DOTENV_ENTRY)
        }

        fn home_candidate(&self, nonce: &str) -> PathBuf {
            let nonce = ValidatedUuidV4::parse(nonce).expect("test nonce must be valid");
            self.codex_home
                .parent()
                .expect("Codex home must have a parent")
                .join(home_candidate_name(nonce))
        }

        fn synchronize(
            &self,
            expected: &CodexDotenvState,
            nonce: &str,
            desired: Option<&[u8]>,
        ) -> Result<CodexDotenvSynchronizeResult, PosixStoreError> {
            synchronize_codex_dotenv(
                &self.codex_home,
                &self.test.store,
                &self.excluded_project,
                expected,
                nonce,
                desired,
                MAX_BYTES,
            )
        }

        fn canary_is_intact(&self) {
            assert_eq!(
                fs::read(&self.test.outside).expect("outside canary must remain readable"),
                b"outside-canary\n"
            );
        }
    }

    fn missing_state(fixture: &Fixture) -> CodexDotenvState {
        match observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES)
            .expect("missing dotenv observation must succeed")
        {
            CodexDotenvObservation::Missing { state } => state,
            _ => panic!("dotenv must be reported missing"),
        }
    }

    fn present_state(fixture: &Fixture, expected_bytes: &[u8]) -> CodexDotenvState {
        match observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES)
            .expect("present dotenv observation must succeed")
        {
            CodexDotenvObservation::Present { state, mut bytes } => {
                assert_eq!(bytes, expected_bytes);
                zeroize_bytes(bytes.as_mut_slice());
                state
            }
            _ => panic!("dotenv must be reported present"),
        }
    }

    fn expect_changed(
        result: Result<CodexDotenvSynchronizeResult, PosixStoreError>,
    ) -> CodexDotenvState {
        match result.expect("dotenv synchronization must succeed") {
            CodexDotenvSynchronizeResult::Completed {
                disposition: CodexDotenvSynchronizeDisposition::Changed,
                state,
            } => state,
            _ => panic!("dotenv synchronization must report a change"),
        }
    }

    fn expect_unchanged(
        result: Result<CodexDotenvSynchronizeResult, PosixStoreError>,
    ) -> CodexDotenvState {
        match result.expect("dotenv confirmation must succeed") {
            CodexDotenvSynchronizeResult::Completed {
                disposition: CodexDotenvSynchronizeDisposition::Unchanged,
                state,
            } => state,
            _ => panic!("dotenv synchronization must report no change"),
        }
    }

    fn expect_precondition_failed(result: Result<CodexDotenvSynchronizeResult, PosixStoreError>) {
        assert!(matches!(
            result,
            Ok(CodexDotenvSynchronizeResult::PreconditionFailed)
        ));
    }

    fn lock_record(fixture: &Fixture) -> DotenvLockRecordState {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(fixture.test.store.join(DOTENV_LOCK_ENTRY))
            .expect("dotenv lock must open");
        let normalized =
            NormalizedAbsolutePath::parse(&fixture.codex_home).expect("Codex home must normalize");
        read_dotenv_lock_record(&file, home_binding(&normalized))
            .expect("dotenv lock record must be valid")
    }

    fn assert_clean_lock(fixture: &Fixture) {
        let normalized =
            NormalizedAbsolutePath::parse(&fixture.codex_home).expect("Codex home must normalize");
        assert_eq!(
            lock_record(fixture),
            DotenvLockRecordState::Clean {
                home_binding: home_binding(&normalized),
            }
        );
    }

    fn candidate_paths(home: &Path) -> Vec<PathBuf> {
        let mut paths = fs::read_dir(home)
            .expect("Codex home must be readable")
            .map(|entry| entry.expect("Codex home entry must load").path())
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.as_bytes().starts_with(DOTENV_CANDIDATE_PREFIX))
            })
            .collect::<Vec<_>>();
        paths.sort();
        paths
    }

    #[test]
    fn missing_home_is_created_privately_and_installed_atomically() {
        let fixture = Fixture::new(false);
        let expected = missing_state(&fixture);
        assert!(!fixture.codex_home.exists());

        let installed = expect_changed(fixture.synchronize(&expected, NONCE_1, Some(DESIRED)));
        assert_eq!(
            fs::symlink_metadata(&fixture.codex_home)
                .expect("created Codex home metadata must load")
                .mode()
                & PERMISSION_AND_SPECIAL_BITS,
            PRIVATE_DIRECTORY_MODE
        );
        let dotenv_metadata =
            fs::symlink_metadata(fixture.dotenv()).expect("installed dotenv metadata must load");
        assert_eq!(
            dotenv_metadata.mode() & PERMISSION_AND_SPECIAL_BITS,
            PRIVATE_FILE_MODE
        );
        assert_eq!(dotenv_metadata.nlink(), 1);
        assert_eq!(
            fs::read(fixture.dotenv()).expect("installed dotenv must be readable"),
            DESIRED
        );
        assert_eq!(present_state(&fixture, DESIRED), installed);
        assert!(candidate_paths(&fixture.codex_home).is_empty());
        assert_clean_lock(&fixture);
        fixture.canary_is_intact();
    }

    #[test]
    fn missing_home_transaction_claims_recover_or_fail_closed_without_guessing_ownership() {
        let intent = Fixture::new(false);
        let intent_state = missing_state(&intent);
        arm_dotenv_test_fault(DotenvTestFault::HomeAfterIntent);
        assert!(intent
            .synchronize(&intent_state, NONCE_1, Some(DESIRED))
            .is_err());
        assert_dotenv_test_fault_consumed();
        assert!(!intent.codex_home.exists());
        assert!(!intent.home_candidate(NONCE_1).exists());
        expect_changed(intent.synchronize(&intent_state, NONCE_2, Some(DESIRED)));
        assert_clean_lock(&intent);

        let unclaimed = Fixture::new(false);
        let unclaimed_state = missing_state(&unclaimed);
        arm_dotenv_test_fault(DotenvTestFault::HomeAfterCandidateCreate);
        assert!(unclaimed
            .synchronize(&unclaimed_state, NONCE_1, Some(DESIRED))
            .is_err());
        assert_dotenv_test_fault_consumed();
        assert!(!unclaimed.codex_home.exists());
        assert!(unclaimed.home_candidate(NONCE_1).is_dir());
        assert_eq!(
            unclaimed
                .synchronize(&unclaimed_state, NONCE_2, Some(DESIRED))
                .err(),
            Some(PosixStoreError::Lost)
        );
        assert!(unclaimed.home_candidate(NONCE_1).is_dir());
        unclaimed.canary_is_intact();

        for fault in [
            DotenvTestFault::HomeAfterCandidateClaim,
            DotenvTestFault::HomeAfterRename,
        ] {
            let fixture = Fixture::new(false);
            let expected = missing_state(&fixture);
            arm_dotenv_test_fault(fault);
            assert!(fixture
                .synchronize(&expected, NONCE_1, Some(DESIRED))
                .is_err());
            assert_dotenv_test_fault_consumed();
            expect_precondition_failed(fixture.synchronize(&expected, NONCE_2, Some(DESIRED)));
            assert!(!fixture.codex_home.exists());
            assert!(!fixture.home_candidate(NONCE_1).exists());
            let rebound = missing_state(&fixture);
            expect_changed(fixture.synchronize(&rebound, NONCE_3, Some(DESIRED)));
            assert_eq!(
                fs::read(fixture.dotenv()).expect("recovered dotenv must be readable"),
                DESIRED
            );
            assert_clean_lock(&fixture);
            fixture.canary_is_intact();
        }
    }

    #[test]
    fn foreign_home_candidate_collision_is_preserved_without_wedging_the_lock() {
        let fixture = Fixture::new(false);
        let foreign = fixture.home_candidate(NONCE_1);
        create_private_directory(&foreign);
        let foreign_canary = foreign.join("foreign-canary");
        create_private_file(&foreign_canary, b"foreign-home-candidate\n");
        let expected = missing_state(&fixture);

        expect_precondition_failed(fixture.synchronize(&expected, NONCE_1, Some(DESIRED)));
        assert_eq!(
            fs::read(&foreign_canary).expect("foreign home candidate must remain readable"),
            b"foreign-home-candidate\n"
        );
        assert!(!fixture.codex_home.exists());
        assert_clean_lock(&fixture);

        expect_changed(fixture.synchronize(&expected, NONCE_2, Some(DESIRED)));
        assert_eq!(
            fs::read(&foreign_canary).expect("foreign home candidate must remain untouched"),
            b"foreign-home-candidate\n"
        );
        assert_eq!(
            fs::read(fixture.dotenv()).expect("fresh nonce must install dotenv"),
            DESIRED
        );
        assert_clean_lock(&fixture);
        fixture.canary_is_intact();
    }

    #[test]
    fn existing_readable_home_is_allowed_but_writable_or_linked_homes_are_unsafe() {
        let fixture = Fixture::new(true);
        fs::set_permissions(&fixture.codex_home, fs::Permissions::from_mode(0o755))
            .expect("readable Codex home mode must be set");
        let expected = missing_state(&fixture);
        expect_changed(fixture.synchronize(&expected, NONCE_1, Some(DESIRED)));
        assert_eq!(
            fs::symlink_metadata(&fixture.codex_home)
                .expect("Codex home metadata must load")
                .mode()
                & PERMISSION_AND_SPECIAL_BITS,
            0o755
        );
        fs::set_permissions(
            &fixture.codex_home,
            fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE),
        )
        .expect("private Codex home mode must be restored");

        let writable = Fixture::new(true);
        fs::set_permissions(&writable.codex_home, fs::Permissions::from_mode(0o770))
            .expect("group-writable Codex home mode must be set");
        let unsafe_state =
            match observe_codex_dotenv(&writable.codex_home, &writable.excluded_project, MAX_BYTES)
                .expect("unsafe Codex home observation must complete")
            {
                CodexDotenvObservation::Unsafe { state } => state,
                _ => panic!("group-writable Codex home must be unsafe"),
            };
        expect_precondition_failed(writable.synchronize(&unsafe_state, NONCE_1, Some(DESIRED)));
        assert!(!writable.dotenv().exists());
        fs::set_permissions(
            &writable.codex_home,
            fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE),
        )
        .expect("private Codex home mode must be restored");

        let linked = Fixture::new(false);
        let real = linked.test.root.join("real-codex");
        create_private_directory(&real);
        symlink(&real, &linked.codex_home).expect("Codex home symlink must be created");
        assert!(matches!(
            observe_codex_dotenv(&linked.codex_home, &linked.excluded_project, MAX_BYTES),
            Ok(CodexDotenvObservation::Unsafe { .. })
        ));
        fs::remove_file(&linked.codex_home).expect("Codex home symlink must be removed");
        linked.canary_is_intact();
    }

    #[test]
    fn unsafe_dotenv_entries_are_classified_without_following_them() {
        let fixture = Fixture::new(true);
        create_private_file(&fixture.dotenv(), ORIGINAL);
        fs::set_permissions(fixture.dotenv(), fs::Permissions::from_mode(0o644))
            .expect("broad dotenv mode must be set");
        assert!(matches!(
            observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES),
            Ok(CodexDotenvObservation::Unsafe { .. })
        ));
        fs::set_permissions(
            fixture.dotenv(),
            fs::Permissions::from_mode(PRIVATE_FILE_MODE),
        )
        .expect("private dotenv mode must be restored");
        let _ = present_state(&fixture, ORIGINAL);

        fs::remove_file(fixture.dotenv()).expect("dotenv fixture must be removed");
        let source = fixture.codex_home.join("hard-link-source");
        create_private_file(&source, ORIGINAL);
        fs::hard_link(&source, fixture.dotenv()).expect("hard-linked dotenv must be created");
        assert!(matches!(
            observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES),
            Ok(CodexDotenvObservation::Unsafe { .. })
        ));
        fs::remove_file(fixture.dotenv()).expect("hard-linked dotenv must be removed");
        fs::remove_file(source).expect("hard-link source must be removed");

        symlink(&fixture.test.outside, fixture.dotenv()).expect("dotenv symlink must be created");
        assert!(matches!(
            observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES),
            Ok(CodexDotenvObservation::Unsafe { .. })
        ));
        fs::remove_file(fixture.dotenv()).expect("dotenv symlink must be removed");

        #[cfg(target_os = "linux")]
        {
            let home = rustix_fs::open(&fixture.codex_home, directory_open_flags(), Mode::empty())
                .expect("Codex home descriptor must open");
            rustix_fs::mkfifoat(&home, DOTENV_ENTRY, private_file_mode())
                .expect("dotenv FIFO must be created");
            assert!(matches!(
                observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES),
                Ok(CodexDotenvObservation::Unsafe { .. })
            ));
            rustix_fs::unlinkat(&home, DOTENV_ENTRY, AtFlags::empty())
                .expect("dotenv FIFO must be removed");
        }
        fixture.canary_is_intact();
    }

    #[test]
    fn bounded_observation_distinguishes_exact_limit_and_oversized_files() {
        let fixture = Fixture::new(true);
        let exact = vec![b'x'; MAX_BYTES];
        create_private_file(&fixture.dotenv(), &exact);
        assert!(matches!(
            observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES),
            Ok(CodexDotenvObservation::Present { .. })
        ));
        fs::remove_file(fixture.dotenv()).expect("exact-limit dotenv must be removed");

        let oversized = vec![b'y'; MAX_BYTES + 1];
        create_private_file(&fixture.dotenv(), &oversized);
        let oversized_state =
            match observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES)
                .expect("oversized dotenv observation must complete")
            {
                CodexDotenvObservation::Oversized { state } => state,
                _ => panic!("oversized dotenv must be classified"),
            };
        expect_precondition_failed(fixture.synchronize(&oversized_state, NONCE_1, Some(DESIRED)));
        assert_eq!(
            fs::symlink_metadata(fixture.dotenv())
                .expect("oversized dotenv metadata must remain")
                .len(),
            (MAX_BYTES + 1) as u64
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_extended_acls_on_home_dotenv_and_lock_are_unsafe() {
        let fixture = Fixture::new(true);
        let process = ProcessIdentity::capture().expect("test process must be supported");

        let home = File::open(&fixture.codex_home).expect("Codex home descriptor must open");
        plurum_native_macos_acl::install_current_user_read_acl(home.as_fd(), process.uid)
            .expect("Codex home ACL fixture must install");
        assert!(matches!(
            observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES),
            Ok(CodexDotenvObservation::Unsafe { .. })
        ));
        plurum_native_macos_acl::clear_extended_acl(home.as_fd())
            .expect("Codex home ACL fixture must clear");

        create_private_file(&fixture.dotenv(), ORIGINAL);
        let dotenv = File::open(fixture.dotenv()).expect("dotenv descriptor must open");
        plurum_native_macos_acl::install_current_user_read_acl(dotenv.as_fd(), process.uid)
            .expect("dotenv ACL fixture must install");
        assert!(matches!(
            observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES),
            Ok(CodexDotenvObservation::Unsafe { .. })
        ));
        plurum_native_macos_acl::clear_extended_acl(dotenv.as_fd())
            .expect("dotenv ACL fixture must clear");

        let expected = present_state(&fixture, ORIGINAL);
        assert_eq!(
            expect_unchanged(fixture.synchronize(&expected, NONCE_1, None)),
            expected
        );
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(fixture.test.store.join(DOTENV_LOCK_ENTRY))
            .expect("dotenv lock descriptor must open");
        plurum_native_macos_acl::install_current_user_read_acl(lock.as_fd(), process.uid)
            .expect("dotenv lock ACL fixture must install");
        assert_eq!(
            fixture.synchronize(&expected, NONCE_2, None).err(),
            Some(PosixStoreError::Unsafe)
        );
        plurum_native_macos_acl::clear_extended_acl(lock.as_fd())
            .expect("dotenv lock ACL fixture must clear");
        assert_eq!(
            fs::read(fixture.dotenv()).expect("dotenv must remain readable"),
            ORIGINAL
        );
        fixture.canary_is_intact();
    }

    #[test]
    fn confirmations_preserve_identity_and_replacements_invalidate_old_state() {
        let fixture = Fixture::new(true);
        create_private_file(&fixture.dotenv(), ORIGINAL);
        let expected = present_state(&fixture, ORIGINAL);
        let before =
            fs::symlink_metadata(fixture.dotenv()).expect("dotenv metadata must be readable");

        assert_eq!(
            expect_unchanged(fixture.synchronize(&expected, NONCE_1, None)),
            expected
        );
        assert_eq!(
            expect_unchanged(fixture.synchronize(&expected, NONCE_2, Some(ORIGINAL))),
            expected
        );
        let confirmed =
            fs::symlink_metadata(fixture.dotenv()).expect("confirmed dotenv metadata must load");
        assert_eq!(confirmed.ino(), before.ino());
        assert_eq!(confirmed.mtime(), before.mtime());
        assert_eq!(confirmed.mtime_nsec(), before.mtime_nsec());

        let installed = expect_changed(fixture.synchronize(&expected, NONCE_3, Some(DESIRED)));
        let after = fs::symlink_metadata(fixture.dotenv()).expect("replacement metadata must load");
        assert_ne!(after.ino(), before.ino());
        assert_eq!(present_state(&fixture, DESIRED), installed);
        expect_precondition_failed(fixture.synchronize(&expected, NONCE_4, None));
        assert_eq!(
            fs::read(fixture.dotenv()).expect("replacement must remain readable"),
            DESIRED
        );
        assert_clean_lock(&fixture);
    }

    #[test]
    fn byte_reversion_with_a_new_identity_fails_the_old_precondition() {
        let fixture = Fixture::new(true);
        create_private_file(&fixture.dotenv(), ORIGINAL);
        let expected = present_state(&fixture, ORIGINAL);
        let retained = fixture.codex_home.join("retained-original");
        fs::rename(fixture.dotenv(), &retained).expect("original dotenv must be retained");
        create_private_file(&fixture.dotenv(), ORIGINAL);

        let reverted = present_state(&fixture, ORIGINAL);
        assert_ne!(reverted, expected);
        expect_precondition_failed(fixture.synchronize(&expected, NONCE_1, Some(DESIRED)));
        assert_eq!(
            fs::read(fixture.dotenv()).expect("reverted dotenv must remain"),
            ORIGINAL
        );
        fs::remove_file(retained).expect("retained original must be removed");
    }

    #[test]
    fn create_delete_aba_fails_an_old_missing_file_precondition() {
        let fixture = Fixture::new(true);
        let expected = missing_state(&fixture);
        create_private_file(&fixture.dotenv(), ORIGINAL);
        fs::remove_file(fixture.dotenv()).expect("transient dotenv must be removed");

        let rebound = missing_state(&fixture);
        assert_ne!(rebound, expected);
        expect_precondition_failed(fixture.synchronize(&expected, NONCE_1, Some(DESIRED)));
        assert!(!fixture.dotenv().exists());
        fixture.canary_is_intact();
    }

    #[test]
    fn invalid_paths_exclusions_and_bounds_never_mutate() {
        let fixture = Fixture::new(true);
        assert_eq!(
            observe_codex_dotenv(Path::new("relative"), &fixture.excluded_project, MAX_BYTES).err(),
            Some(PosixStoreError::InvalidInput)
        );
        assert_eq!(
            observe_codex_dotenv(
                &fixture.test.root.join("codex").join("..").join("other"),
                &fixture.excluded_project,
                MAX_BYTES,
            )
            .err(),
            Some(PosixStoreError::InvalidInput)
        );
        assert_eq!(
            observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, 0).err(),
            Some(PosixStoreError::InvalidInput)
        );
        assert_eq!(
            observe_codex_dotenv(
                &fixture.codex_home,
                &fixture.excluded_project,
                MAX_BYTES + 1,
            )
            .err(),
            Some(PosixStoreError::InvalidInput)
        );

        let nested_home = fixture.excluded_project.join("codex");
        let unsafe_state =
            match observe_codex_dotenv(&nested_home, &fixture.excluded_project, MAX_BYTES)
                .expect("excluded path observation must complete")
            {
                CodexDotenvObservation::Unsafe { state } => state,
                _ => panic!("Codex home inside the project must be unsafe"),
            };
        expect_precondition_failed(synchronize_codex_dotenv(
            &nested_home,
            &fixture.test.store,
            &fixture.excluded_project,
            &unsafe_state,
            NONCE_1,
            Some(DESIRED),
            MAX_BYTES,
        ));
        assert!(!nested_home.exists());
        fixture.canary_is_intact();
    }

    #[test]
    fn unsafe_missing_home_parent_is_not_created() {
        let fixture = Fixture::new(false);
        let parent = fixture.test.root.join("unsafe-parent");
        create_private_directory(&parent);
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o770))
            .expect("unsafe parent mode must be set");
        let home = parent.join("codex");
        assert!(matches!(
            observe_codex_dotenv(&home, &fixture.excluded_project, MAX_BYTES),
            Ok(CodexDotenvObservation::Unsafe { .. })
        ));
        assert!(!home.exists());
        fs::set_permissions(&parent, fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE))
            .expect("private parent mode must be restored");
    }

    #[test]
    fn invalid_mutation_inputs_and_missing_state_directory_are_non_mutating() {
        let fixture = Fixture::new(true);
        let expected = missing_state(&fixture);

        assert_eq!(
            fixture
                .synchronize(&expected, "not-a-uuid", Some(DESIRED))
                .err(),
            Some(PosixStoreError::InvalidInput)
        );
        assert_eq!(
            fixture.synchronize(&expected, NONCE_1, Some(&[])).err(),
            Some(PosixStoreError::InvalidInput)
        );
        let oversized = vec![b'x'; MAX_BYTES + 1];
        assert_eq!(
            fixture
                .synchronize(&expected, NONCE_1, Some(&oversized))
                .err(),
            Some(PosixStoreError::InvalidInput)
        );
        assert!(!fixture.dotenv().exists());
        assert!(!fixture.test.store.join(DOTENV_LOCK_ENTRY).exists());

        fs::remove_dir(&fixture.test.store).expect("empty state directory must be removed");
        assert_eq!(
            fixture.synchronize(&expected, NONCE_1, Some(DESIRED)).err(),
            Some(PosixStoreError::Missing)
        );
        assert!(!fixture.dotenv().exists());
        fixture.canary_is_intact();
    }

    #[test]
    fn observation_fault_boundaries_leave_the_dotenv_untouched() {
        for fault in [
            DotenvTestFault::ObserveAfterHomeAttestation,
            DotenvTestFault::ObserveAfterFileOpen,
            DotenvTestFault::ObserveAfterRead,
            DotenvTestFault::ObserveAfterRebound,
        ] {
            let fixture = Fixture::new(true);
            create_private_file(&fixture.dotenv(), ORIGINAL);
            arm_dotenv_test_fault(fault);
            assert!(observe_codex_dotenv(
                &fixture.codex_home,
                &fixture.excluded_project,
                MAX_BYTES,
            )
            .is_err());
            assert_dotenv_test_fault_consumed();
            assert_eq!(
                fs::read(fixture.dotenv()).expect("faulted dotenv must remain readable"),
                ORIGINAL
            );
            assert!(!fixture.test.store.join(DOTENV_LOCK_ENTRY).exists());
            fixture.canary_is_intact();
        }
    }

    #[test]
    fn candidate_preparation_faults_are_recovered_on_retry() {
        for fault in [
            DotenvTestFault::CandidateAfterCreate,
            DotenvTestFault::CandidateAfterWrite,
            DotenvTestFault::CandidateAfterReadback,
            DotenvTestFault::CandidateAfterFileSync,
        ] {
            let fixture = Fixture::new(true);
            let expected = missing_state(&fixture);
            arm_dotenv_test_fault(fault);
            assert!(fixture
                .synchronize(&expected, NONCE_1, Some(DESIRED))
                .is_err());
            assert_dotenv_test_fault_consumed();
            assert!(!fixture.dotenv().exists());
            assert_eq!(candidate_paths(&fixture.codex_home).len(), 1);
            assert!(matches!(
                lock_record(&fixture),
                DotenvLockRecordState::Held { .. }
            ));

            expect_precondition_failed(fixture.synchronize(&expected, NONCE_2, Some(DESIRED)));
            let rebound = missing_state(&fixture);
            let installed = expect_changed(fixture.synchronize(&rebound, NONCE_3, Some(DESIRED)));
            assert_eq!(present_state(&fixture, DESIRED), installed);
            assert!(candidate_paths(&fixture.codex_home).is_empty());
            assert_clean_lock(&fixture);
            fixture.canary_is_intact();
        }
    }

    #[test]
    fn install_faults_recover_before_and_after_the_atomic_rename() {
        for fault in [
            DotenvTestFault::InstallBeforeRename,
            DotenvTestFault::InstallAfterRename,
            DotenvTestFault::InstallAfterDirectorySync,
            DotenvTestFault::InstallAfterReadback,
        ] {
            let fixture = Fixture::new(true);
            let expected = missing_state(&fixture);
            arm_dotenv_test_fault(fault);
            assert!(fixture
                .synchronize(&expected, NONCE_1, Some(DESIRED))
                .is_err());
            assert_dotenv_test_fault_consumed();
            assert!(matches!(
                lock_record(&fixture),
                DotenvLockRecordState::Held { .. }
            ));

            if fault == DotenvTestFault::InstallBeforeRename {
                assert!(!fixture.dotenv().exists());
                assert_eq!(candidate_paths(&fixture.codex_home).len(), 1);
                expect_precondition_failed(fixture.synchronize(&expected, NONCE_2, Some(DESIRED)));
                let rebound = missing_state(&fixture);
                expect_changed(fixture.synchronize(&rebound, NONCE_3, Some(DESIRED)));
            } else {
                assert_eq!(
                    fs::read(fixture.dotenv()).expect("renamed dotenv must be readable"),
                    DESIRED
                );
                assert!(candidate_paths(&fixture.codex_home).is_empty());
                let installed = present_state(&fixture, DESIRED);
                assert_eq!(
                    expect_unchanged(fixture.synchronize(&installed, NONCE_2, None)),
                    installed
                );
            }
            assert_eq!(
                fs::read(fixture.dotenv()).expect("recovered dotenv must be readable"),
                DESIRED
            );
            assert!(candidate_paths(&fixture.codex_home).is_empty());
            assert_clean_lock(&fixture);
        }
    }

    #[test]
    fn verified_post_install_failures_roll_back_without_plaintext_residue() {
        for fault in [
            DotenvTestFault::PostInstallObservation,
            DotenvTestFault::PostInstallMismatch,
        ] {
            let missing = Fixture::new(true);
            let missing_expected = missing_state(&missing);
            arm_dotenv_test_fault(fault);
            assert!(missing
                .synchronize(&missing_expected, NONCE_1, Some(DESIRED))
                .is_err());
            assert_dotenv_test_fault_consumed();
            assert!(!missing.dotenv().exists());
            assert!(candidate_paths(&missing.codex_home).is_empty());
            assert_clean_lock(&missing);
            missing.canary_is_intact();

            let present = Fixture::new(true);
            create_private_file(&present.dotenv(), ORIGINAL);
            let present_expected = present_state(&present, ORIGINAL);
            arm_dotenv_test_fault(fault);
            assert!(present
                .synchronize(&present_expected, NONCE_1, Some(DESIRED))
                .is_err());
            assert_dotenv_test_fault_consumed();
            assert_eq!(
                fs::read(present.dotenv()).expect("rolled-back dotenv must be readable"),
                ORIGINAL
            );
            let _ = present_state(&present, ORIGINAL);
            assert!(candidate_paths(&present.codex_home).is_empty());
            assert_clean_lock(&present);
            present.canary_is_intact();

            let missing_home = Fixture::new(false);
            let missing_home_state = missing_state(&missing_home);
            arm_dotenv_test_fault(fault);
            assert!(missing_home
                .synchronize(&missing_home_state, NONCE_1, Some(DESIRED))
                .is_err());
            assert_dotenv_test_fault_consumed();
            assert!(!missing_home.codex_home.exists());
            assert!(!missing_home.home_candidate(NONCE_1).exists());
            assert_clean_lock(&missing_home);
            missing_home.canary_is_intact();
        }
    }

    #[test]
    fn release_faults_leave_a_recoverable_role_lock() {
        for fault in [
            DotenvTestFault::ReleaseBeforeClean,
            DotenvTestFault::ReleaseAfterClean,
        ] {
            let fixture = Fixture::new(true);
            let expected = missing_state(&fixture);
            arm_dotenv_test_fault(fault);
            assert!(fixture
                .synchronize(&expected, NONCE_1, Some(DESIRED))
                .is_err());
            assert_dotenv_test_fault_consumed();
            assert_eq!(
                fs::read(fixture.dotenv()).expect("installed dotenv must remain"),
                DESIRED
            );
            let installed = present_state(&fixture, DESIRED);
            assert_eq!(
                expect_unchanged(fixture.synchronize(&installed, NONCE_2, None)),
                installed
            );
            assert_clean_lock(&fixture);
        }
    }

    #[test]
    fn recovery_faults_converge_without_publishing_partial_bytes() {
        for fault in [
            DotenvTestFault::RecoveryBeforeUnlink,
            DotenvTestFault::RecoveryAfterUnlink,
            DotenvTestFault::RecoveryAfterDirectorySync,
            DotenvTestFault::LockAfterRecovery,
        ] {
            let fixture = Fixture::new(true);
            let expected = missing_state(&fixture);
            arm_dotenv_test_fault(DotenvTestFault::InstallBeforeRename);
            assert!(fixture
                .synchronize(&expected, NONCE_1, Some(DESIRED))
                .is_err());
            assert_dotenv_test_fault_consumed();

            arm_dotenv_test_fault(fault);
            assert!(fixture
                .synchronize(&expected, NONCE_2, Some(DESIRED))
                .is_err());
            assert_dotenv_test_fault_consumed();
            assert!(!fixture.dotenv().exists());
            assert!(matches!(
                lock_record(&fixture),
                DotenvLockRecordState::Held { .. }
            ));

            expect_precondition_failed(fixture.synchronize(&expected, NONCE_3, Some(DESIRED)));
            let rebound = missing_state(&fixture);
            expect_changed(fixture.synchronize(&rebound, NONCE_4, Some(DESIRED)));
            assert_eq!(
                fs::read(fixture.dotenv()).expect("recovered dotenv must be readable"),
                DESIRED
            );
            assert!(candidate_paths(&fixture.codex_home).is_empty());
            assert_clean_lock(&fixture);
        }
    }

    #[test]
    fn lock_transition_faults_are_recoverable() {
        for fault in [
            DotenvTestFault::LockAfterInitializedClean,
            DotenvTestFault::LockAfterNonceSync,
            DotenvTestFault::LockAfterHeldTransition,
        ] {
            let fixture = Fixture::new(true);
            let expected = missing_state(&fixture);
            arm_dotenv_test_fault(fault);
            assert!(fixture
                .synchronize(&expected, NONCE_1, Some(DESIRED))
                .is_err());
            assert_dotenv_test_fault_consumed();
            assert!(!fixture.dotenv().exists());
            expect_changed(fixture.synchronize(&expected, NONCE_2, Some(DESIRED)));
            assert_eq!(
                fs::read(fixture.dotenv()).expect("retry dotenv must be readable"),
                DESIRED
            );
            assert_clean_lock(&fixture);
        }
    }

    #[test]
    fn partial_uninitialized_role_lock_records_recover_safely() {
        for prefix in [
            0,
            DOTENV_LOCK_HEADER_END / 2,
            DOTENV_LOCK_HOME_START + 16,
            DOTENV_LOCK_RECORD_LENGTH,
        ] {
            let fixture = Fixture::new(true);
            let expected = missing_state(&fixture);
            let normalized = NormalizedAbsolutePath::parse(&fixture.codex_home)
                .expect("Codex home must normalize");
            let mut record = clean_lock_record(home_binding(&normalized));
            record[0] = DOTENV_LOCK_STATE_UNINITIALIZED;
            let lock_path = fixture.test.store.join(DOTENV_LOCK_ENTRY);
            create_private_file(&lock_path, b"");
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&lock_path)
                .expect("partial dotenv lock must open");
            lock.set_len(DOTENV_LOCK_RECORD_LENGTH as u64)
                .expect("partial dotenv lock must be sized");
            if prefix != 0 {
                write_all_at(&lock, &record[..prefix], 0)
                    .expect("partial dotenv lock prefix must be written");
            }
            platform::sync_file(&lock).expect("partial dotenv lock must sync");
            assert_eq!(
                read_dotenv_lock_record(&lock, home_binding(&normalized)),
                Ok(DotenvLockRecordState::Uninitialized)
            );
            drop(lock);

            expect_changed(fixture.synchronize(&expected, NONCE_1, Some(DESIRED)));
            assert_eq!(
                fs::read(fixture.dotenv()).expect("recovered dotenv must be readable"),
                DESIRED
            );
            assert_clean_lock(&fixture);
        }

        let fixture = Fixture::new(true);
        let expected = missing_state(&fixture);
        let normalized =
            NormalizedAbsolutePath::parse(&fixture.codex_home).expect("Codex home must normalize");
        let lock_path = fixture.test.store.join(DOTENV_LOCK_ENTRY);
        let mut old_binding_record = clean_lock_record([0x55; 32]);
        old_binding_record[0] = DOTENV_LOCK_STATE_UNINITIALIZED;
        create_private_file(&lock_path, &old_binding_record);
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .expect("rebound dotenv lock must open");
        assert_eq!(
            read_dotenv_lock_record(&lock, home_binding(&normalized)),
            Ok(DotenvLockRecordState::Uninitialized)
        );
        drop(lock);
        expect_changed(fixture.synchronize(&expected, NONCE_1, Some(DESIRED)));
        assert_clean_lock(&fixture);
    }

    #[test]
    fn transition_role_lock_discards_torn_nonce_claim_and_rebind_payloads() {
        for (index, nonce_prefix) in [0, 1, LOCK_NONCE_LENGTH / 2, LOCK_NONCE_LENGTH]
            .into_iter()
            .enumerate()
        {
            let fixture = Fixture::new(true);
            let expected = missing_state(&fixture);
            let normalized = NormalizedAbsolutePath::parse(&fixture.codex_home)
                .expect("Codex home must normalize");
            let binding = if index % 2 == 0 {
                home_binding(&normalized)
            } else {
                [0x55; 32]
            };
            let mut record = clean_lock_record(binding);
            record[0] = DOTENV_LOCK_STATE_TRANSITION;
            record[DOTENV_LOCK_NONCE_START..DOTENV_LOCK_NONCE_START + nonce_prefix]
                .copy_from_slice(&NONCE_1.as_bytes()[..nonce_prefix]);
            record[DOTENV_LOCK_HOME_CLAIM_STAGE] = DOTENV_HOME_CLAIM_PREPARED;
            record[DOTENV_LOCK_HOME_CLAIM_IDENTITY_START..DOTENV_LOCK_HOME_CLAIM_IDENTITY_END]
                .fill(0xA5);
            let lock_path = fixture.test.store.join(DOTENV_LOCK_ENTRY);
            create_private_file(&lock_path, &record);
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&lock_path)
                .expect("transition dotenv lock must open");
            assert_eq!(
                read_dotenv_lock_record(&lock, home_binding(&normalized)),
                Ok(DotenvLockRecordState::Transition)
            );
            drop(lock);

            expect_changed(fixture.synchronize(&expected, NONCE_2, Some(DESIRED)));
            assert_eq!(
                fs::read(fixture.dotenv()).expect("transition recovery must install dotenv"),
                DESIRED
            );
            assert_clean_lock(&fixture);
        }

        for mut malformed in [
            [0xA5; DOTENV_LOCK_RECORD_LENGTH],
            clean_lock_record([0x55; 32]),
        ] {
            let fixture = Fixture::new(true);
            let expected = missing_state(&fixture);
            malformed[0] = DOTENV_LOCK_STATE_TRANSITION;
            malformed[DOTENV_LOCK_HEADER_START] ^= 0x01;
            let lock_path = fixture.test.store.join(DOTENV_LOCK_ENTRY);
            create_private_file(&lock_path, &malformed);
            assert_eq!(
                fixture.synchronize(&expected, NONCE_1, Some(DESIRED)).err(),
                Some(PosixStoreError::Unsafe)
            );
            assert_eq!(
                fs::read(&lock_path).expect("malformed transition lock must remain"),
                malformed
            );
            assert!(!fixture.dotenv().exists());
            fixture.canary_is_intact();
        }
    }

    #[test]
    fn lock_contention_fails_the_precondition_and_recovers_after_abandonment() {
        let fixture = Fixture::new(true);
        let expected = missing_state(&fixture);
        let context = parse_context(&fixture.codex_home, &fixture.excluded_project)
            .expect("Codex context must parse");
        let held = match acquire_dotenv_lock(
            &context,
            &fixture.test.store,
            ValidatedUuidV4::parse(NONCE_1).expect("nonce must validate"),
        )
        .expect("dotenv lock must be acquired")
        {
            DotenvLockAcquireResult::Acquired(lock) => lock,
            DotenvLockAcquireResult::Busy => panic!("fresh dotenv lock must not be busy"),
        };

        expect_precondition_failed(fixture.synchronize(&expected, NONCE_2, Some(DESIRED)));
        assert!(!fixture.dotenv().exists());
        drop(held);

        expect_changed(fixture.synchronize(&expected, NONCE_3, Some(DESIRED)));
        assert_eq!(
            fs::read(fixture.dotenv()).expect("post-contention dotenv must be readable"),
            DESIRED
        );
        assert_clean_lock(&fixture);
    }

    #[test]
    fn unsafe_and_malformed_role_locks_never_touch_their_targets() {
        let fixture = Fixture::new(true);
        let expected = missing_state(&fixture);
        let lock = fixture.test.store.join(DOTENV_LOCK_ENTRY);

        symlink(&fixture.test.outside, &lock).expect("dotenv lock symlink must be created");
        assert_eq!(
            fixture.synchronize(&expected, NONCE_1, Some(DESIRED)).err(),
            Some(PosixStoreError::Unsafe)
        );
        fixture.canary_is_intact();
        fs::remove_file(&lock).expect("dotenv lock symlink must be removed");

        let source = fixture.test.store.join("lock-source");
        create_private_file(&source, b"");
        fs::hard_link(&source, &lock).expect("hard-linked dotenv lock must be created");
        assert_eq!(
            fixture.synchronize(&expected, NONCE_1, Some(DESIRED)).err(),
            Some(PosixStoreError::Unsafe)
        );
        fs::remove_file(&lock).expect("hard-linked dotenv lock must be removed");
        fs::remove_file(source).expect("hard-link source must be removed");

        create_private_file(&lock, b"");
        fs::set_permissions(&lock, fs::Permissions::from_mode(0o644))
            .expect("broad dotenv lock mode must be set");
        assert_eq!(
            fixture.synchronize(&expected, NONCE_1, Some(DESIRED)).err(),
            Some(PosixStoreError::Unsafe)
        );
        fs::set_permissions(&lock, fs::Permissions::from_mode(PRIVATE_FILE_MODE))
            .expect("private dotenv lock mode must be restored");
        fs::remove_file(&lock).expect("broad dotenv lock must be removed");

        create_private_file(&lock, b"malformed");
        assert_eq!(
            fixture.synchronize(&expected, NONCE_1, Some(DESIRED)).err(),
            Some(PosixStoreError::Unsafe)
        );
        assert_eq!(
            fs::read(&lock).expect("malformed dotenv lock must remain"),
            b"malformed"
        );
        fs::remove_file(lock).expect("malformed dotenv lock must be removed");
        assert!(!fixture.dotenv().exists());
        fixture.canary_is_intact();
    }

    #[test]
    fn foreign_candidates_are_preserved_and_block_installation() {
        let fixture = Fixture::new(true);
        let foreign_nonce = ValidatedUuidV4::parse(NONCE_4).expect("nonce must validate");
        let foreign = fixture.codex_home.join(candidate_name(foreign_nonce));
        create_private_file(&foreign, b"foreign");
        let expected = missing_state(&fixture);

        assert_eq!(
            fixture.synchronize(&expected, NONCE_1, Some(DESIRED)).err(),
            Some(PosixStoreError::Unsafe)
        );
        assert!(!fixture.dotenv().exists());
        assert_eq!(
            fs::read(&foreign).expect("foreign candidate must remain"),
            b"foreign"
        );
        assert!(matches!(
            lock_record(&fixture),
            DotenvLockRecordState::Held { .. }
        ));
        fs::remove_file(&foreign).expect("foreign candidate fixture must be removed");

        let recovered_expected = missing_state(&fixture);
        expect_changed(fixture.synchronize(&recovered_expected, NONCE_2, Some(DESIRED)));
        assert_clean_lock(&fixture);
        fixture.canary_is_intact();
    }
}
