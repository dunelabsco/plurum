use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsHandle;

#[cfg(test)]
use std::cell::Cell;

use plurum_native_secret_memory::zeroize_bytes;
use plurum_windows_syscall::{
    attest_no_untrusted_namespace_control, attest_security, create_private_directory,
    create_private_file, flush_file, remove_by_handle, rename_by_handle, try_lock_exclusive,
    unlock, DirectoryCreateAttempt, FileCreateAttempt, LockAttempt, MutationAttempt, SecurityKind,
};

use super::*;

const DOTENV_ENTRY: &str = ".env";
const DOTENV_LOCK_ENTRY: &str = "codex-dotenv.lock";
const DOTENV_CANDIDATE_PREFIX: &str = ".plurum-codex-dotenv-";
const DOTENV_CANDIDATE_SUFFIX: &str = ".tmp";
const MAX_CODEX_DOTENV_BYTES: usize = 128 * 1_024;
const MAX_DIRECTORY_ENTRIES: usize = 4_096;

// The lock lives in Plurum's private state directory, while its path binding
// and candidate nonce authorize exactly one Codex-home namespace.
const DOTENV_LOCK_RECORD_LENGTH: usize = 160;
const DOTENV_LOCK_STATE_UNINITIALIZED: u8 = 0;
const DOTENV_LOCK_STATE_CLEAN: u8 = 1;
const DOTENV_LOCK_STATE_HELD: u8 = 2;
const DOTENV_LOCK_HEADER: &[u8] = b"plurum-codex-dotenv-lock-v1";
const DOTENV_LOCK_HEADER_START: usize = 1;
const DOTENV_LOCK_HEADER_END: usize = DOTENV_LOCK_HEADER_START + DOTENV_LOCK_HEADER.len();
const DOTENV_LOCK_PATH_START: usize = 40;
const DOTENV_LOCK_PATH_END: usize = DOTENV_LOCK_PATH_START + 32;
const DOTENV_LOCK_HOME_INTENT_OFFSET: usize = 72;
const DOTENV_LOCK_NONCE_START: usize = 80;
const DOTENV_LOCK_NONCE_END: usize = DOTENV_LOCK_NONCE_START + LOCK_NONCE_LENGTH;
const DOTENV_LOCK_HOME_IDENTITY_START: usize = 120;
const DOTENV_LOCK_HOME_VOLUME_END: usize = DOTENV_LOCK_HOME_IDENTITY_START + 8;
const DOTENV_LOCK_HOME_IDENTITY_END: usize = DOTENV_LOCK_HOME_VOLUME_END + 16;
const DOTENV_LOCK_HOME_CHECKSUM_START: usize = DOTENV_LOCK_HOME_IDENTITY_END;
const DOTENV_LOCK_HOME_CHECKSUM_END: usize = DOTENV_LOCK_HOME_CHECKSUM_START + 16;

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DotenvTestFault {
    ObserveAfterRead,
    ObserveAfterRebind,
    HomeAfterIntent,
    HomeAfterCreateBeforeClaim,
    HomeAfterClaim,
    CandidateAfterCreate,
    CandidateAfterWrite,
    CandidateAfterReadback,
    CandidateAfterFlush,
    InstallBeforeRename,
    InstallAfterRename,
    PostInstallObservation,
    RecoveryBeforeCandidateRemove,
    RecoveryAfterCandidateRemove,
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
            "a Windows Codex dotenv test fault is already armed"
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
            "the armed Windows Codex dotenv test fault was not reached"
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
enum CodexHomeKind {
    Missing,
    Present,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CodexDotenvKind {
    Missing,
    Present,
    Oversized,
    Unsafe,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CodexDotenvState {
    process: ProcessIdentity,
    codex_home: NormalizedAbsolutePath,
    excluded_project: NormalizedAbsolutePath,
    excluded_chain: Vec<ObjectIdentity>,
    home_kind: CodexHomeKind,
    home_binding: [u8; 32],
    namespace_change: [u64; 2],
    dotenv_kind: CodexDotenvKind,
    dotenv_identity: Option<ObjectIdentity>,
    dotenv_binding: [u8; 32],
}

impl CodexDotenvState {
    fn same_state(&self, other: &Self) -> bool {
        self.process == other.process
            && self.codex_home == other.codex_home
            && self.excluded_project == other.excluded_project
            && self.excluded_chain == other.excluded_chain
            && self.home_kind == other.home_kind
            && self.home_binding == other.home_binding
            && self.namespace_change == other.namespace_change
            && self.dotenv_kind == other.dotenv_kind
            && self.dotenv_identity == other.dotenv_identity
            && self.dotenv_binding == other.dotenv_binding
    }
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
// directly into the bridge registry and must match the POSIX implementation.
#[allow(clippy::large_enum_variant)]
pub(crate) enum CodexDotenvSynchronizeResult {
    Completed {
        disposition: CodexDotenvSynchronizeDisposition,
        state: CodexDotenvState,
    },
    PreconditionFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DotenvLockRecord {
    Uninitialized,
    Clean {
        path_binding: [u8; 32],
    },
    Held {
        path_binding: [u8; 32],
        nonce: ValidatedUuidV4,
        home_cleanup: HomeCleanupClaim,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HomeCleanupClaim {
    None,
    Preparing(Option<ObjectIdentity>),
    Created(ObjectIdentity),
    Resolved,
}

struct BoundDirectoryChain {
    path: NormalizedAbsolutePath,
    chain: OpenedDirectoryChain,
    identities: Vec<ObjectIdentity>,
}

struct BoundCodexHome {
    process: ProcessIdentity,
    path: NormalizedAbsolutePath,
    chain: OpenedDirectoryChain,
    identities: Vec<ObjectIdentity>,
    identity: ObjectIdentity,
    binding: [u8; 32],
    namespace_change: [u64; 2],
}

struct DotenvFile {
    _file: File,
    facts: MetadataFacts,
    binding: [u8; 32],
}

struct DotenvLockLease {
    directory: WindowsPrivateDirectory,
    lock: Option<File>,
    nonce: ValidatedUuidV4,
    path_binding: [u8; 32],
    home_cleanup: HomeCleanupClaim,
    terminal: bool,
}

enum DotenvLockAcquireResult {
    Acquired(DotenvLockLease),
    Busy,
}

enum CandidateInstallError {
    BeforeRename(WindowsStoreError),
    RenameUncertain(WindowsStoreError),
}

enum HomeInstallError {
    Conflict,
    DefinitelyNotCreated(WindowsStoreError),
    CreationUncertain(WindowsStoreError),
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

fn digest_wide_path(digest: &mut Sha256, path: &Path) {
    for value in path.as_os_str().encode_wide() {
        digest.update(value.to_le_bytes());
    }
}

fn update_namespace_change(digest: &mut Sha256, namespace_change: [u64; 2]) {
    digest.update(namespace_change[0].to_le_bytes());
    digest.update(namespace_change[1].to_le_bytes());
}

fn path_binding(path: &NormalizedAbsolutePath) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(b"plurum-windows-codex-dotenv-path-v1\0");
    digest_wide_path(&mut digest, &path.path);
    let value = digest.finalize();
    let mut result = [0_u8; 32];
    result.copy_from_slice(&value);
    result
}

fn home_identity_checksum(path_binding: [u8; 32], identity: ObjectIdentity) -> [u8; 16] {
    let mut digest = Sha256::new();
    digest.update(b"plurum-windows-codex-home-claim-v1\0");
    digest.update(path_binding);
    digest.update(identity.volume.to_le_bytes());
    digest.update(identity.file_id);
    let value = digest.finalize();
    let mut result = [0_u8; 16];
    result.copy_from_slice(&value[..16]);
    result
}

fn unsafe_binding(
    codex_home: &NormalizedAbsolutePath,
    excluded: &NormalizedAbsolutePath,
    reason: u8,
) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(b"plurum-windows-codex-dotenv-unsafe-v1\0");
    digest_wide_path(&mut digest, &codex_home.path);
    digest_wide_path(&mut digest, &excluded.path);
    digest.update([reason]);
    let value = digest.finalize();
    let mut result = [0_u8; 32];
    result.copy_from_slice(&value);
    result
}

fn chain_files(chain: &OpenedDirectoryChain) -> impl Iterator<Item = &File> {
    chain.ancestors.iter().chain(std::iter::once(&chain.leaf))
}

fn chain_identities(
    chain: &OpenedDirectoryChain,
) -> Result<Vec<ObjectIdentity>, WindowsStoreError> {
    chain_files(chain)
        .map(|file| {
            let facts = metadata(file)?;
            if facts.kind != ObjectKind::Directory
                || facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(WindowsStoreError::Unsafe);
            }
            Ok(facts.identity)
        })
        .collect()
}

fn chain_matches(
    retained: &OpenedDirectoryChain,
    expected: &[ObjectIdentity],
) -> Result<bool, WindowsStoreError> {
    let current = chain_identities(retained)?;
    Ok(current == expected)
}

fn reopen_chain_matches(
    path: &NormalizedAbsolutePath,
    expected: &[ObjectIdentity],
    complete: bool,
) -> Result<bool, WindowsStoreError> {
    let reopened = if complete {
        path.open_complete()
    } else {
        path.open_parent()
    };
    match reopened {
        Ok(chain) => Ok(chain_identities(&chain)? == expected),
        Err(WindowsStoreError::Missing | WindowsStoreError::Unsafe | WindowsStoreError::Lost) => {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

fn chain_binding(
    domain: &[u8],
    path: &NormalizedAbsolutePath,
    chain: &OpenedDirectoryChain,
    process: &ProcessIdentity,
) -> Result<[u8; 32], WindowsStoreError> {
    process.verify().map_err(|_| WindowsStoreError::Lost)?;
    let mut digest = Sha256::new();
    digest.update(domain);
    digest_wide_path(&mut digest, &path.path);
    for file in chain_files(chain) {
        let facts = metadata(file)?;
        digest.update(facts.identity.volume.to_le_bytes());
        digest.update(facts.identity.file_id);
        digest.update(facts.attributes.to_le_bytes());
        digest.update(facts.links.to_le_bytes());
        digest.update([u8::from(facts.delete_pending)]);
    }
    let value = digest.finalize();
    let mut result = [0_u8; 32];
    result.copy_from_slice(&value);
    Ok(result)
}

fn open_bound_directory(
    path: &NormalizedAbsolutePath,
) -> Result<BoundDirectoryChain, WindowsStoreError> {
    let chain = path.open_complete()?;
    let identities = chain_identities(&chain)?;
    if !reopen_chain_matches(path, &identities, true)? {
        return Err(WindowsStoreError::Lost);
    }
    Ok(BoundDirectoryChain {
        path: path.clone(),
        chain,
        identities,
    })
}

fn excluded_is_stable(excluded: &BoundDirectoryChain) -> Result<bool, WindowsStoreError> {
    Ok(chain_matches(&excluded.chain, &excluded.identities)?
        && reopen_chain_matches(&excluded.path, &excluded.identities, true)?)
}

fn chain_contains_identity(chain: &[ObjectIdentity], identity: ObjectIdentity) -> bool {
    chain.contains(&identity)
}

fn outside_excluded_project(
    codex_chain: &[ObjectIdentity],
    excluded: &BoundDirectoryChain,
) -> bool {
    excluded
        .identities
        .last()
        .copied()
        .is_some_and(|identity| !chain_contains_identity(codex_chain, identity))
}

fn trusted_namespace_chain(
    chain: &OpenedDirectoryChain,
    process: &ProcessIdentity,
) -> Result<bool, WindowsStoreError> {
    let named = chain_files(chain).skip(1).collect::<Vec<_>>();
    for directory in named.into_iter().rev() {
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
    Ok(true)
}

fn attest_codex_home(
    process: &ProcessIdentity,
    path: &NormalizedAbsolutePath,
    chain: OpenedDirectoryChain,
    excluded: &BoundDirectoryChain,
) -> Result<BoundCodexHome, WindowsStoreError> {
    process.verify().map_err(|_| WindowsStoreError::Lost)?;
    let identities = chain_identities(&chain)?;
    if !outside_excluded_project(&identities, excluded)
        || !excluded_is_stable(excluded)?
        || !chain_matches(&chain, &identities)?
        || !reopen_chain_matches(path, &identities, true)?
        || !trusted_namespace_chain(&chain, process)?
    {
        return Err(WindowsStoreError::Unsafe);
    }
    let facts = metadata(&chain.leaf)?;
    let security = attest_security(chain.leaf.as_handle(), process, SecurityKind::Directory)
        .map_err(map_win)?;
    if facts.kind != ObjectKind::Directory
        || facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || !security.owner_current
        || !security.semantic_medium_label
        || !attest_no_untrusted_namespace_control(chain.leaf.as_handle(), process)
            .map_err(map_win)?
    {
        return Err(WindowsStoreError::Unsafe);
    }
    let mut digest = Sha256::new();
    digest.update(b"plurum-windows-codex-home-v1\0");
    digest_wide_path(&mut digest, &path.path);
    for identity in &identities {
        digest.update(identity.volume.to_le_bytes());
        digest.update(identity.file_id);
    }
    digest.update(&security.descriptor);
    let value = digest.finalize();
    let mut binding = [0_u8; 32];
    binding.copy_from_slice(&value);
    Ok(BoundCodexHome {
        process: process.clone(),
        path: path.clone(),
        chain,
        identities,
        identity: facts.identity,
        binding,
        namespace_change: [facts.created, facts.modified],
    })
}

fn require_home_stable(home: &BoundCodexHome) -> Result<(), WindowsStoreError> {
    home.process.verify().map_err(|_| WindowsStoreError::Lost)?;
    if !chain_matches(&home.chain, &home.identities)?
        || !reopen_chain_matches(&home.path, &home.identities, true)?
        || !trusted_namespace_chain(&home.chain, &home.process)?
    {
        return Err(WindowsStoreError::Lost);
    }
    let facts = metadata(&home.chain.leaf)?;
    let security = attest_security(
        home.chain.leaf.as_handle(),
        &home.process,
        SecurityKind::Directory,
    )
    .map_err(map_win)?;
    if facts.identity != home.identity
        || facts.kind != ObjectKind::Directory
        || facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || !security.owner_current
        || !security.semantic_medium_label
        || !attest_no_untrusted_namespace_control(home.chain.leaf.as_handle(), &home.process)
            .map_err(map_win)?
    {
        return Err(WindowsStoreError::Lost);
    }
    Ok(())
}

fn open_dotenv_nofollow(path: &Path, writable: bool) -> std::io::Result<File> {
    let mut access = GENERIC_READ | READ_CONTROL | DELETE;
    if writable {
        access |= GENERIC_WRITE;
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(writable)
        .access_mode(access)
        // Deny new in-place writers while allowing atomic namespace replacement.
        .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    options.open(path)
}

fn stable_dotenv_file(
    home: &BoundCodexHome,
    file: File,
    max_bytes: usize,
) -> Result<(DotenvFile, Option<Vec<u8>>), WindowsStoreError> {
    require_home_stable(home)?;
    let before = metadata(&file)?;
    let security_before =
        attest_security(file.as_handle(), &home.process, SecurityKind::File).map_err(map_win)?;
    if !before.exact_file()
        || before.identity.volume != home.identity.volume
        || !security_before.owner_current
        || !security_before.exact_protected_dacl
        || !security_before.semantic_medium_label
    {
        return Err(WindowsStoreError::Unsafe);
    }
    let path = home.path.path.join(DOTENV_ENTRY);
    let rebound = open_dotenv_nofollow(&path, false).map_err(|_| WindowsStoreError::Lost)?;
    if metadata(&rebound)?.identity != before.identity {
        return Err(WindowsStoreError::Lost);
    }

    let read_limit = max_bytes.checked_add(1).ok_or(WindowsStoreError::Limit)?;
    let mut bounded = read_up_to_at(&file, read_limit)?;
    let oversized = usize::try_from(before.size).map_or(true, |size| size > max_bytes);
    let mut bytes = if oversized {
        zeroize_bytes(bounded.as_mut_slice());
        None
    } else if u64::try_from(bounded.len()).map_err(|_| WindowsStoreError::Limit)? == before.size {
        Some(bounded)
    } else {
        zeroize_bytes(bounded.as_mut_slice());
        return Err(WindowsStoreError::Lost);
    };
    #[cfg(test)]
    if take_dotenv_test_fault(DotenvTestFault::ObserveAfterRead) {
        if let Some(bytes) = bytes.as_mut() {
            zeroize_bytes(bytes.as_mut_slice());
        }
        return Err(WindowsStoreError::Io);
    }
    let after_result = (|| {
        let after = metadata(&file)?;
        let security_after = attest_security(file.as_handle(), &home.process, SecurityKind::File)
            .map_err(map_win)?;
        require_home_stable(home)?;
        let current = open_dotenv_nofollow(&path, false).map_err(|_| WindowsStoreError::Lost)?;
        let current_facts = metadata(&current)?;
        Ok((after, security_after, current_facts))
    })();
    let (after, security_after, current_facts) = match after_result {
        Ok(value) => value,
        Err(error) => {
            if let Some(bytes) = bytes.as_mut() {
                zeroize_bytes(bytes.as_mut_slice());
            }
            return Err(error);
        }
    };
    #[cfg(test)]
    if take_dotenv_test_fault(DotenvTestFault::ObserveAfterRebind) {
        if let Some(bytes) = bytes.as_mut() {
            zeroize_bytes(bytes.as_mut_slice());
        }
        return Err(WindowsStoreError::Io);
    }
    if before != after
        || security_before != security_after
        || current_facts.identity != before.identity
        || !current_facts.exact_file()
    {
        if let Some(bytes) = bytes.as_mut() {
            zeroize_bytes(bytes.as_mut_slice());
        }
        return Err(WindowsStoreError::Lost);
    }
    let content = bytes.as_deref().unwrap_or(&[]);
    let binding = digest_metadata(
        b"plurum-windows-codex-dotenv-file-v1\0",
        after,
        true,
        Some(home.identity),
        &security_after.descriptor,
        content,
    );
    Ok((
        DotenvFile {
            _file: file,
            facts: after,
            binding,
        },
        bytes,
    ))
}

fn missing_home_binding(
    process: &ProcessIdentity,
    path: &NormalizedAbsolutePath,
    parent: &OpenedDirectoryChain,
) -> Result<[u8; 32], WindowsStoreError> {
    chain_binding(
        b"plurum-windows-codex-home-missing-v1\0",
        path,
        parent,
        process,
    )
}

fn missing_dotenv_binding(home_binding: [u8; 32], namespace_change: [u64; 2]) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(b"plurum-windows-codex-dotenv-missing-v1\0");
    digest.update(home_binding);
    update_namespace_change(&mut digest, namespace_change);
    let value = digest.finalize();
    let mut result = [0_u8; 32];
    result.copy_from_slice(&value);
    result
}

#[derive(Clone, Copy)]
struct CodexHomeStateFields {
    kind: CodexHomeKind,
    binding: [u8; 32],
    namespace_change: [u64; 2],
}

#[derive(Clone, Copy)]
struct CodexDotenvStateFields {
    kind: CodexDotenvKind,
    identity: Option<ObjectIdentity>,
    binding: [u8; 32],
}

fn state_for(
    process: ProcessIdentity,
    codex_home: NormalizedAbsolutePath,
    excluded: &BoundDirectoryChain,
    home: CodexHomeStateFields,
    dotenv: CodexDotenvStateFields,
) -> CodexDotenvState {
    CodexDotenvState {
        process,
        codex_home,
        excluded_project: excluded.path.clone(),
        excluded_chain: excluded.identities.clone(),
        home_kind: home.kind,
        home_binding: home.binding,
        namespace_change: home.namespace_change,
        dotenv_kind: dotenv.kind,
        dotenv_identity: dotenv.identity,
        dotenv_binding: dotenv.binding,
    }
}

fn unsafe_observation(
    process: ProcessIdentity,
    codex_home: NormalizedAbsolutePath,
    excluded: &BoundDirectoryChain,
    reason: u8,
) -> CodexDotenvObservation {
    let binding = unsafe_binding(&codex_home, &excluded.path, reason);
    CodexDotenvObservation::Unsafe {
        state: state_for(
            process,
            codex_home,
            excluded,
            CodexHomeStateFields {
                kind: CodexHomeKind::Present,
                binding,
                namespace_change: [0; 2],
            },
            CodexDotenvStateFields {
                kind: CodexDotenvKind::Unsafe,
                identity: None,
                binding,
            },
        ),
    }
}

fn observe_internal(
    codex_home_path: &Path,
    excluded_project_path: &Path,
    max_bytes: usize,
) -> Result<CodexDotenvObservation, WindowsStoreError> {
    if max_bytes == 0 || max_bytes > MAX_CODEX_DOTENV_BYTES {
        return Err(WindowsStoreError::Limit);
    }
    let process = ProcessIdentity::capture().map_err(map_win)?;
    let codex_home = NormalizedAbsolutePath::parse(codex_home_path)?;
    let excluded_path = NormalizedAbsolutePath::parse(excluded_project_path)?;
    let excluded = match open_bound_directory(&excluded_path) {
        Ok(excluded) => excluded,
        Err(WindowsStoreError::Missing | WindowsStoreError::Unsafe | WindowsStoreError::Lost) => {
            return Err(WindowsStoreError::Unsafe);
        }
        Err(error) => return Err(error),
    };

    let parent = match codex_home.open_parent() {
        Ok(parent) => parent,
        Err(WindowsStoreError::Missing | WindowsStoreError::Unsafe | WindowsStoreError::Lost) => {
            return Ok(unsafe_observation(process, codex_home, &excluded, 1));
        }
        Err(error) => return Err(error),
    };
    let parent_identities = chain_identities(&parent)?;
    if !outside_excluded_project(&parent_identities, &excluded)
        || !excluded_is_stable(&excluded)?
        || !chain_matches(&parent, &parent_identities)?
        || !reopen_chain_matches(&codex_home, &parent_identities, false)?
        || !trusted_namespace_chain(&parent, &process)?
    {
        return Ok(unsafe_observation(process, codex_home, &excluded, 2));
    }

    let home_chain = match codex_home.open_complete() {
        Ok(chain) => chain,
        Err(WindowsStoreError::Missing) => {
            let target_missing = matches!(
                open_object_nofollow(&codex_home.path),
                Err(error)
                    if matches!(
                        error.raw_os_error(),
                        Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
                    )
            );
            if !target_missing {
                return Ok(unsafe_observation(process, codex_home, &excluded, 3));
            }
            let binding = missing_home_binding(&process, &codex_home, &parent)?;
            let parent_facts = metadata(&parent.leaf)?;
            return Ok(CodexDotenvObservation::Missing {
                state: state_for(
                    process,
                    codex_home,
                    &excluded,
                    CodexHomeStateFields {
                        kind: CodexHomeKind::Missing,
                        binding,
                        namespace_change: [parent_facts.created, parent_facts.modified],
                    },
                    CodexDotenvStateFields {
                        kind: CodexDotenvKind::Missing,
                        identity: None,
                        binding,
                    },
                ),
            });
        }
        Err(WindowsStoreError::Unsafe | WindowsStoreError::Lost) => {
            return Ok(unsafe_observation(process, codex_home, &excluded, 4));
        }
        Err(error) => return Err(error),
    };
    let home = match attest_codex_home(&process, &codex_home, home_chain, &excluded) {
        Ok(home) => home,
        Err(WindowsStoreError::Unsafe | WindowsStoreError::Lost) => {
            return Ok(unsafe_observation(process, codex_home, &excluded, 5));
        }
        Err(error) => return Err(error),
    };
    let path = home.path.path.join(DOTENV_ENTRY);
    let file = match open_dotenv_nofollow(&path, false) {
        Ok(file) => file,
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
            ) =>
        {
            require_home_stable(&home)?;
            let still_missing = matches!(
                open_object_nofollow(&path),
                Err(error)
                    if matches!(
                        error.raw_os_error(),
                        Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
                    )
            );
            if !still_missing {
                return Ok(unsafe_observation(process, codex_home, &excluded, 8));
            }
            let home_facts = metadata(&home.chain.leaf)?;
            let namespace_change = [home_facts.created, home_facts.modified];
            require_home_stable(&home)?;
            return Ok(CodexDotenvObservation::Missing {
                state: state_for(
                    process,
                    codex_home,
                    &excluded,
                    CodexHomeStateFields {
                        kind: CodexHomeKind::Present,
                        binding: home.binding,
                        namespace_change,
                    },
                    CodexDotenvStateFields {
                        kind: CodexDotenvKind::Missing,
                        identity: None,
                        binding: missing_dotenv_binding(home.binding, namespace_change),
                    },
                ),
            });
        }
        Err(_) => return Ok(unsafe_observation(process, codex_home, &excluded, 6)),
    };
    let (file, bytes) = match stable_dotenv_file(&home, file, max_bytes) {
        Ok(result) => result,
        Err(WindowsStoreError::Unsafe | WindowsStoreError::Lost) => {
            return Ok(unsafe_observation(process, codex_home, &excluded, 7));
        }
        Err(error) => return Err(error),
    };
    let state = state_for(
        process,
        codex_home,
        &excluded,
        CodexHomeStateFields {
            kind: CodexHomeKind::Present,
            binding: home.binding,
            namespace_change: home.namespace_change,
        },
        CodexDotenvStateFields {
            kind: if bytes.is_some() {
                CodexDotenvKind::Present
            } else {
                CodexDotenvKind::Oversized
            },
            identity: Some(file.facts.identity),
            binding: file.binding,
        },
    );
    drop(file);
    match bytes {
        Some(bytes) => Ok(CodexDotenvObservation::Present { state, bytes }),
        None => Ok(CodexDotenvObservation::Oversized { state }),
    }
}

pub(crate) fn observe_codex_dotenv(
    codex_home: &Path,
    excluded_project_directory: &Path,
    max_bytes: usize,
) -> Result<CodexDotenvObservation, WindowsStoreError> {
    observe_internal(codex_home, excluded_project_directory, max_bytes)
}

fn observation_state(observation: &CodexDotenvObservation) -> &CodexDotenvState {
    match observation {
        CodexDotenvObservation::Missing { state }
        | CodexDotenvObservation::Present { state, .. }
        | CodexDotenvObservation::Oversized { state }
        | CodexDotenvObservation::Unsafe { state } => state,
    }
}

fn wipe_observation(observation: &mut CodexDotenvObservation) {
    if let CodexDotenvObservation::Present { bytes, .. } = observation {
        zeroize_bytes(bytes.as_mut_slice());
    }
}

fn exact_private_file(
    directory: &WindowsPrivateDirectory,
    file: &File,
    expected_name: &OsStr,
) -> Result<bool, WindowsStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    let parent = directory.core.require_secure_locked(&state)?;
    let facts = metadata(file)?;
    let security = attest_security(
        file.as_handle(),
        &directory.core.process,
        SecurityKind::File,
    )
    .map_err(map_win)?;
    if !facts.exact_file()
        || facts.identity.volume != parent.identity.volume
        || !security.owner_current
        || !security.exact_protected_dacl
        || !security.semantic_medium_label
    {
        return Ok(false);
    }
    let path = directory.core.path.path.join(expected_name);
    Ok(open_file_nofollow(&path, true, false, true)
        .ok()
        .and_then(|current| metadata(&current).ok())
        .is_some_and(|current| current.identity == facts.identity && current.exact_file()))
}

fn recoverable_prefix(actual: &[u8], expected: &[u8]) -> bool {
    (0..=expected.len()).any(|prefix| {
        actual[..prefix] == expected[..prefix] && actual[prefix..].iter().all(|byte| *byte == 0)
    })
}

fn read_dotenv_lock_record(
    file: &File,
    _expected_path_binding: [u8; 32],
) -> Result<DotenvLockRecord, WindowsStoreError> {
    let facts = metadata(file)?;
    if facts.size == 0 {
        return Ok(DotenvLockRecord::Uninitialized);
    }
    if facts.size != DOTENV_LOCK_RECORD_LENGTH as u64 {
        return Err(WindowsStoreError::Unsafe);
    }
    let bytes = read_exact_at(file, DOTENV_LOCK_RECORD_LENGTH)?;
    parse_dotenv_lock_record(&bytes)
}

fn parse_dotenv_lock_record(bytes: &[u8]) -> Result<DotenvLockRecord, WindowsStoreError> {
    if bytes.len() != DOTENV_LOCK_RECORD_LENGTH {
        return Err(WindowsStoreError::Unsafe);
    }
    if bytes[0] == DOTENV_LOCK_STATE_UNINITIALIZED {
        let header_prefix = &bytes[DOTENV_LOCK_HEADER_START..DOTENV_LOCK_HEADER_END];
        let padding = &bytes[DOTENV_LOCK_HEADER_END..DOTENV_LOCK_PATH_START];
        if (header_prefix != DOTENV_LOCK_HEADER
            && recoverable_prefix(header_prefix, DOTENV_LOCK_HEADER)
            && bytes[DOTENV_LOCK_HEADER_END..]
                .iter()
                .all(|byte| *byte == 0))
            || (header_prefix == DOTENV_LOCK_HEADER
                && padding.iter().all(|byte| *byte == 0)
                && bytes[DOTENV_LOCK_HOME_INTENT_OFFSET] <= 3
                && bytes[DOTENV_LOCK_HOME_INTENT_OFFSET + 1..DOTENV_LOCK_NONCE_START]
                    .iter()
                    .all(|byte| *byte == 0)
                && bytes[DOTENV_LOCK_NONCE_END..DOTENV_LOCK_HOME_IDENTITY_START]
                    .iter()
                    .all(|byte| *byte == 0))
        {
            return Ok(DotenvLockRecord::Uninitialized);
        }
        return Err(WindowsStoreError::Unsafe);
    }
    if &bytes[DOTENV_LOCK_HEADER_START..DOTENV_LOCK_HEADER_END] != DOTENV_LOCK_HEADER
        || bytes[DOTENV_LOCK_HEADER_END..DOTENV_LOCK_PATH_START]
            .iter()
            .any(|byte| *byte != 0)
        || bytes[DOTENV_LOCK_HOME_INTENT_OFFSET] > 3
        || bytes[DOTENV_LOCK_HOME_INTENT_OFFSET + 1..DOTENV_LOCK_NONCE_START]
            .iter()
            .any(|byte| *byte != 0)
        || bytes[DOTENV_LOCK_NONCE_END..DOTENV_LOCK_HOME_IDENTITY_START]
            .iter()
            .any(|byte| *byte != 0)
    {
        return Err(WindowsStoreError::Unsafe);
    }
    let mut path_binding = [0_u8; 32];
    path_binding.copy_from_slice(&bytes[DOTENV_LOCK_PATH_START..DOTENV_LOCK_PATH_END]);
    let identity_slot = &bytes[DOTENV_LOCK_HOME_IDENTITY_START..DOTENV_LOCK_HOME_IDENTITY_END];
    let checksum_slot = &bytes[DOTENV_LOCK_HOME_CHECKSUM_START..DOTENV_LOCK_HOME_CHECKSUM_END];
    let evidence_empty =
        identity_slot.iter().all(|byte| *byte == 0) && checksum_slot.iter().all(|byte| *byte == 0);
    let claimed_identity = || {
        let mut volume = [0_u8; 8];
        volume
            .copy_from_slice(&bytes[DOTENV_LOCK_HOME_IDENTITY_START..DOTENV_LOCK_HOME_VOLUME_END]);
        let mut file_id = [0_u8; 16];
        file_id.copy_from_slice(&bytes[DOTENV_LOCK_HOME_VOLUME_END..DOTENV_LOCK_HOME_IDENTITY_END]);
        ObjectIdentity {
            volume: u64::from_le_bytes(volume),
            file_id,
        }
    };
    let checked_identity = || {
        let identity = claimed_identity();
        let checksum = home_identity_checksum(path_binding, identity);
        (identity.file_id.iter().any(|byte| *byte != 0) && checksum_slot == checksum)
            .then_some(identity)
            .ok_or(WindowsStoreError::Unsafe)
    };
    let home_cleanup = match bytes[DOTENV_LOCK_HOME_INTENT_OFFSET] {
        0 if evidence_empty => HomeCleanupClaim::None,
        1 => {
            if evidence_empty {
                HomeCleanupClaim::Preparing(None)
            } else {
                HomeCleanupClaim::Preparing(Some(checked_identity()?))
            }
        }
        2 => HomeCleanupClaim::Created(checked_identity()?),
        3 => HomeCleanupClaim::Resolved,
        _ => return Err(WindowsStoreError::Unsafe),
    };
    match bytes[0] {
        DOTENV_LOCK_STATE_CLEAN => {
            if home_cleanup != HomeCleanupClaim::None {
                return Err(WindowsStoreError::Unsafe);
            }
            let nonce = &bytes[DOTENV_LOCK_NONCE_START..DOTENV_LOCK_NONCE_END];
            if !nonce.iter().all(|byte| *byte == 0)
                && std::str::from_utf8(nonce)
                    .ok()
                    .and_then(|value| ValidatedUuidV4::parse(value).ok())
                    .is_none()
            {
                return Err(WindowsStoreError::Unsafe);
            }
            Ok(DotenvLockRecord::Clean { path_binding })
        }
        DOTENV_LOCK_STATE_HELD => {
            let nonce = std::str::from_utf8(&bytes[DOTENV_LOCK_NONCE_START..DOTENV_LOCK_NONCE_END])
                .map_err(|_| WindowsStoreError::Unsafe)
                .and_then(|value| {
                    ValidatedUuidV4::parse(value).map_err(|_| WindowsStoreError::Unsafe)
                })?;
            Ok(DotenvLockRecord::Held {
                path_binding,
                nonce,
                home_cleanup,
            })
        }
        _ => Err(WindowsStoreError::Unsafe),
    }
}

fn write_dotenv_lock_state(file: &File, state: u8) -> Result<(), WindowsStoreError> {
    write_all_at(file, &[state], 0)?;
    flush_file(file.as_handle()).map_err(map_win)
}

fn initialize_dotenv_lock(file: &File, path_binding: [u8; 32]) -> Result<(), WindowsStoreError> {
    if metadata(file)?.size != 0 {
        write_dotenv_lock_state(file, DOTENV_LOCK_STATE_UNINITIALIZED)?;
    }
    file.set_len(DOTENV_LOCK_RECORD_LENGTH as u64)
        .map_err(|_| WindowsStoreError::Io)?;
    let mut tail = [0_u8; DOTENV_LOCK_RECORD_LENGTH - 1];
    tail[DOTENV_LOCK_HEADER_START - 1..DOTENV_LOCK_HEADER_END - 1]
        .copy_from_slice(DOTENV_LOCK_HEADER);
    tail[DOTENV_LOCK_PATH_START - 1..DOTENV_LOCK_PATH_END - 1].copy_from_slice(&path_binding);
    write_all_at(file, &tail, 1)?;
    flush_file(file.as_handle()).map_err(map_win)?;
    write_dotenv_lock_state(file, DOTENV_LOCK_STATE_CLEAN)?;
    if read_dotenv_lock_record(file, path_binding)? == (DotenvLockRecord::Clean { path_binding }) {
        Ok(())
    } else {
        Err(WindowsStoreError::Lost)
    }
}

fn write_held_dotenv_lock(
    file: &File,
    path_binding: [u8; 32],
    nonce: ValidatedUuidV4,
) -> Result<(), WindowsStoreError> {
    if read_dotenv_lock_record(file, path_binding)? != (DotenvLockRecord::Clean { path_binding }) {
        return Err(WindowsStoreError::Lost);
    }
    write_dotenv_lock_state(file, DOTENV_LOCK_STATE_UNINITIALIZED)?;
    write_all_at(file, &[0], DOTENV_LOCK_HOME_INTENT_OFFSET as u64)?;
    write_all_at(
        file,
        &[0; DOTENV_LOCK_HOME_CHECKSUM_END - DOTENV_LOCK_HOME_IDENTITY_START],
        DOTENV_LOCK_HOME_IDENTITY_START as u64,
    )?;
    write_all_at(file, &nonce.0, DOTENV_LOCK_NONCE_START as u64)?;
    flush_file(file.as_handle()).map_err(map_win)?;
    write_dotenv_lock_state(file, DOTENV_LOCK_STATE_HELD)?;
    if read_dotenv_lock_record(file, path_binding)?
        == (DotenvLockRecord::Held {
            path_binding,
            nonce,
            home_cleanup: HomeCleanupClaim::None,
        })
    {
        Ok(())
    } else {
        Err(WindowsStoreError::Lost)
    }
}

fn clear_held_home_cleanup_claim(
    file: &File,
    path_binding: [u8; 32],
    nonce: ValidatedUuidV4,
    expected: HomeCleanupClaim,
) -> Result<(), WindowsStoreError> {
    if expected == HomeCleanupClaim::None {
        return Ok(());
    }
    if read_dotenv_lock_record(file, path_binding)?
        != (DotenvLockRecord::Held {
            path_binding,
            nonce,
            home_cleanup: expected,
        })
    {
        return Err(WindowsStoreError::Lost);
    }
    write_all_at(file, &[3], DOTENV_LOCK_HOME_INTENT_OFFSET as u64)?;
    flush_file(file.as_handle()).map_err(map_win)?;
    if read_dotenv_lock_record(file, path_binding)?
        != (DotenvLockRecord::Held {
            path_binding,
            nonce,
            home_cleanup: HomeCleanupClaim::Resolved,
        })
    {
        return Err(WindowsStoreError::Lost);
    }
    write_all_at(
        file,
        &[0; DOTENV_LOCK_HOME_CHECKSUM_END - DOTENV_LOCK_HOME_IDENTITY_START],
        DOTENV_LOCK_HOME_IDENTITY_START as u64,
    )?;
    flush_file(file.as_handle()).map_err(map_win)?;
    write_all_at(file, &[0], DOTENV_LOCK_HOME_INTENT_OFFSET as u64)?;
    flush_file(file.as_handle()).map_err(map_win)?;
    if read_dotenv_lock_record(file, path_binding)?
        == (DotenvLockRecord::Held {
            path_binding,
            nonce,
            home_cleanup: HomeCleanupClaim::None,
        })
    {
        Ok(())
    } else {
        Err(WindowsStoreError::Lost)
    }
}

fn open_or_create_dotenv_lock(
    directory: &WindowsPrivateDirectory,
) -> Result<File, WindowsStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let path = directory.core.path.path.join(DOTENV_LOCK_ENTRY);
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
                FileCreateAttempt::Created(file) => file,
                FileCreateAttempt::Conflict => open_file_nofollow(&path, true, false, true)
                    .map_err(|_| WindowsStoreError::Unsafe)?,
            }
        }
        Err(_) => return Err(WindowsStoreError::Unsafe),
    };
    drop(state);
    if exact_private_file(directory, &file, OsStr::new(DOTENV_LOCK_ENTRY))? {
        Ok(file)
    } else {
        Err(WindowsStoreError::Unsafe)
    }
}

fn candidate_name(nonce: ValidatedUuidV4) -> Result<OsString, WindowsStoreError> {
    let value = std::str::from_utf8(&nonce.0).map_err(|_| WindowsStoreError::Lost)?;
    Ok(OsString::from(format!(
        "{DOTENV_CANDIDATE_PREFIX}{value}{DOTENV_CANDIDATE_SUFFIX}"
    )))
}

fn candidate_nonce(name: &OsStr) -> Result<Option<ValidatedUuidV4>, WindowsStoreError> {
    let wide = name.encode_wide().collect::<Vec<_>>();
    let reserved_prefix = wide
        .get(..DOTENV_CANDIDATE_PREFIX.len())
        .is_some_and(|prefix| {
            prefix
                .iter()
                .zip(DOTENV_CANDIDATE_PREFIX.bytes())
                .all(|(actual, expected)| {
                    u8::try_from(*actual)
                        .ok()
                        .is_some_and(|actual| actual.eq_ignore_ascii_case(&expected))
                })
        });
    if !reserved_prefix {
        return Ok(None);
    }
    let value = name.to_str().ok_or(WindowsStoreError::Unsafe)?;
    let expected =
        DOTENV_CANDIDATE_PREFIX.len() + LOCK_NONCE_LENGTH + DOTENV_CANDIDATE_SUFFIX.len();
    if value.len() != expected
        || !value.starts_with(DOTENV_CANDIDATE_PREFIX)
        || !value.ends_with(DOTENV_CANDIDATE_SUFFIX)
    {
        return Err(WindowsStoreError::Unsafe);
    }
    let raw =
        &value[DOTENV_CANDIDATE_PREFIX.len()..DOTENV_CANDIDATE_PREFIX.len() + LOCK_NONCE_LENGTH];
    ValidatedUuidV4::parse(raw)
        .map(Some)
        .map_err(|_| WindowsStoreError::Unsafe)
}

fn open_existing_home_for_mutation(
    process: &ProcessIdentity,
    path: &NormalizedAbsolutePath,
    excluded: &BoundDirectoryChain,
) -> Result<Option<BoundCodexHome>, WindowsStoreError> {
    match path.open_complete() {
        Ok(chain) => attest_codex_home(process, path, chain, excluded).map(Some),
        Err(WindowsStoreError::Missing) => Ok(None),
        Err(error) => Err(error),
    }
}

fn list_candidates(home: &BoundCodexHome) -> Result<Vec<ValidatedUuidV4>, WindowsStoreError> {
    require_home_stable(home)?;
    let mut scanned = 0_usize;
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(&home.path.path).map_err(|_| WindowsStoreError::Io)? {
        let entry = entry.map_err(|_| WindowsStoreError::Io)?;
        scanned = scanned.checked_add(1).ok_or(WindowsStoreError::Limit)?;
        if scanned > MAX_DIRECTORY_ENTRIES {
            return Err(WindowsStoreError::Limit);
        }
        if let Some(nonce) = candidate_nonce(&entry.file_name())? {
            candidates.push(nonce);
        }
    }
    require_home_stable(home)?;
    candidates.sort_by_key(|nonce| nonce.0);
    Ok(candidates)
}

fn remove_exact_candidate(
    home: &BoundCodexHome,
    nonce: ValidatedUuidV4,
) -> Result<(), WindowsStoreError> {
    require_home_stable(home)?;
    let name = candidate_name(nonce)?;
    let path = home.path.path.join(&name);
    let file = match open_dotenv_nofollow(&path, true) {
        Ok(file) => file,
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
            ) =>
        {
            return Ok(());
        }
        Err(_) => return Err(WindowsStoreError::Unsafe),
    };
    let facts = metadata(&file)?;
    let security =
        attest_security(file.as_handle(), &home.process, SecurityKind::File).map_err(map_win)?;
    if !facts.exact_file()
        || facts.identity.volume != home.identity.volume
        || !security.owner_current
        || !security.exact_protected_dacl
        || !security.semantic_medium_label
    {
        return Err(WindowsStoreError::Unsafe);
    }
    fail_on_dotenv_test_fault!(RecoveryBeforeCandidateRemove, WindowsStoreError::Lost);
    match remove_by_handle(file.as_handle()).map_err(map_win)? {
        MutationAttempt::Applied => {}
        MutationAttempt::Conflict => return Err(WindowsStoreError::Lost),
        MutationAttempt::Unsupported => return Err(WindowsStoreError::Unsupported),
    }
    drop(file);
    fail_on_dotenv_test_fault!(RecoveryAfterCandidateRemove, WindowsStoreError::Lost);
    require_home_stable(home)?;
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

fn recover_candidates(
    home: Option<&BoundCodexHome>,
    record: DotenvLockRecord,
) -> Result<(), WindowsStoreError> {
    let Some(home) = home else {
        return Ok(());
    };
    let candidates = list_candidates(home)?;
    match record {
        DotenvLockRecord::Held { nonce, .. } => {
            if candidates.len() > 1 || candidates.iter().any(|candidate| *candidate != nonce) {
                return Err(WindowsStoreError::Unsafe);
            }
            if candidates
                .first()
                .is_some_and(|candidate| *candidate == nonce)
            {
                remove_exact_candidate(home, nonce)?;
            }
        }
        DotenvLockRecord::Clean { .. } | DotenvLockRecord::Uninitialized => {
            if !candidates.is_empty() {
                return Err(WindowsStoreError::Unsafe);
            }
        }
    }
    if list_candidates(home)?.is_empty() {
        Ok(())
    } else {
        Err(WindowsStoreError::Lost)
    }
}

fn acquire_dotenv_lock(
    state_directory: &Path,
    codex_home: &NormalizedAbsolutePath,
    excluded: &BoundDirectoryChain,
    process: &ProcessIdentity,
    nonce: ValidatedUuidV4,
) -> Result<DotenvLockAcquireResult, WindowsStoreError> {
    let directory = match open_private_directory(state_directory)? {
        PrivateDirectoryOpenResult::Missing => return Err(WindowsStoreError::Missing),
        PrivateDirectoryOpenResult::Opened(directory) => directory,
    };
    let lock = open_or_create_dotenv_lock(&directory)?;
    match try_lock_exclusive(lock.as_handle()).map_err(map_win)? {
        LockAttempt::Acquired => {}
        LockAttempt::Busy => return Ok(DotenvLockAcquireResult::Busy),
    }
    let expected_path = path_binding(codex_home);
    let record = read_dotenv_lock_record(&lock, expected_path)?;
    if let DotenvLockRecord::Held { path_binding, .. } = record {
        if path_binding != expected_path {
            return Err(WindowsStoreError::Unsafe);
        }
    }
    let mut home = open_existing_home_for_mutation(process, codex_home, excluded)?;
    let home_cleanup = match record {
        DotenvLockRecord::Held { home_cleanup, .. } => home_cleanup,
        DotenvLockRecord::Uninitialized | DotenvLockRecord::Clean { .. } => HomeCleanupClaim::None,
    };
    match (home_cleanup, home.as_ref()) {
        (HomeCleanupClaim::Preparing(None), Some(_)) => return Err(WindowsStoreError::Lost),
        (
            HomeCleanupClaim::Preparing(Some(expected)) | HomeCleanupClaim::Created(expected),
            Some(home),
        ) if home.identity != expected => {
            return Err(WindowsStoreError::Unsafe);
        }
        _ => {}
    }
    recover_candidates(home.as_ref(), record)?;
    if matches!(
        home_cleanup,
        HomeCleanupClaim::Preparing(Some(_)) | HomeCleanupClaim::Created(_)
    ) {
        let empty = match home.as_ref() {
            Some(home) => home_is_empty(home)?,
            None => false,
        };
        if empty {
            let created_home = home.take().ok_or(WindowsStoreError::Lost)?;
            remove_created_home(created_home)?;
        }
    }
    if let DotenvLockRecord::Held { nonce, .. } = record {
        clear_held_home_cleanup_claim(&lock, expected_path, nonce, home_cleanup)?;
    }
    match record {
        DotenvLockRecord::Uninitialized => initialize_dotenv_lock(&lock, expected_path)?,
        DotenvLockRecord::Clean { path_binding } if path_binding != expected_path => {
            initialize_dotenv_lock(&lock, expected_path)?
        }
        DotenvLockRecord::Clean { .. } => {}
        DotenvLockRecord::Held { .. } => {
            write_dotenv_lock_state(&lock, DOTENV_LOCK_STATE_CLEAN)?;
        }
    }
    write_held_dotenv_lock(&lock, expected_path, nonce)?;
    Ok(DotenvLockAcquireResult::Acquired(DotenvLockLease {
        directory,
        lock: Some(lock),
        nonce,
        path_binding: expected_path,
        home_cleanup: HomeCleanupClaim::None,
        terminal: false,
    }))
}

impl DotenvLockLease {
    fn verify(&self) -> Result<(), WindowsStoreError> {
        if self.terminal {
            return Err(WindowsStoreError::Closed);
        }
        let lock = self.lock.as_ref().ok_or(WindowsStoreError::Closed)?;
        if !exact_private_file(&self.directory, lock, OsStr::new(DOTENV_LOCK_ENTRY))?
            || read_dotenv_lock_record(lock, self.path_binding)?
                != (DotenvLockRecord::Held {
                    path_binding: self.path_binding,
                    nonce: self.nonce,
                    home_cleanup: self.home_cleanup,
                })
        {
            return Err(WindowsStoreError::Lost);
        }
        Ok(())
    }

    fn mark_home_creation_preparing(&mut self) -> Result<(), WindowsStoreError> {
        self.verify()?;
        if self.home_cleanup != HomeCleanupClaim::None {
            return Err(WindowsStoreError::Lost);
        }
        let lock = self.lock.as_ref().ok_or(WindowsStoreError::Closed)?;
        write_all_at(lock, &[1], DOTENV_LOCK_HOME_INTENT_OFFSET as u64)?;
        flush_file(lock.as_handle()).map_err(map_win)?;
        self.home_cleanup = HomeCleanupClaim::Preparing(None);
        self.verify()
    }

    fn mark_home_created(&mut self, identity: ObjectIdentity) -> Result<(), WindowsStoreError> {
        self.verify()?;
        if self.home_cleanup != HomeCleanupClaim::Preparing(None) {
            return Err(WindowsStoreError::Lost);
        }
        let lock = self.lock.as_ref().ok_or(WindowsStoreError::Closed)?;
        write_all_at(
            lock,
            &identity.volume.to_le_bytes(),
            DOTENV_LOCK_HOME_IDENTITY_START as u64,
        )?;
        write_all_at(lock, &identity.file_id, DOTENV_LOCK_HOME_VOLUME_END as u64)?;
        write_all_at(
            lock,
            &home_identity_checksum(self.path_binding, identity),
            DOTENV_LOCK_HOME_CHECKSUM_START as u64,
        )?;
        flush_file(lock.as_handle()).map_err(map_win)?;
        write_all_at(lock, &[2], DOTENV_LOCK_HOME_INTENT_OFFSET as u64)?;
        flush_file(lock.as_handle()).map_err(map_win)?;
        self.home_cleanup = HomeCleanupClaim::Created(identity);
        self.verify()
    }

    fn release(&mut self, home: Option<&BoundCodexHome>) -> Result<(), WindowsStoreError> {
        self.verify()?;
        recover_candidates(
            home,
            DotenvLockRecord::Clean {
                path_binding: self.path_binding,
            },
        )?;
        let lock = self.lock.as_ref().ok_or(WindowsStoreError::Closed)?;
        clear_held_home_cleanup_claim(lock, self.path_binding, self.nonce, self.home_cleanup)?;
        self.home_cleanup = HomeCleanupClaim::None;
        fail_on_dotenv_test_fault!(ReleaseBeforeClean, WindowsStoreError::Lost);
        write_dotenv_lock_state(lock, DOTENV_LOCK_STATE_CLEAN)?;
        if read_dotenv_lock_record(lock, self.path_binding)?
            != (DotenvLockRecord::Clean {
                path_binding: self.path_binding,
            })
        {
            return Err(WindowsStoreError::Lost);
        }
        fail_on_dotenv_test_fault!(ReleaseAfterClean, WindowsStoreError::Lost);
        unlock(lock.as_handle()).map_err(map_win)?;
        self.lock.take();
        self.terminal = true;
        Ok(())
    }
}

impl Drop for DotenvLockLease {
    fn drop(&mut self) {
        self.lock.take();
        self.terminal = true;
    }
}

fn create_codex_home(
    process: &ProcessIdentity,
    path: &NormalizedAbsolutePath,
    excluded: &BoundDirectoryChain,
    expected_parent_binding: [u8; 32],
    expected_parent_namespace: [u64; 2],
) -> Result<BoundCodexHome, HomeInstallError> {
    let parent = path
        .open_parent()
        .map_err(HomeInstallError::DefinitelyNotCreated)?;
    let identities = chain_identities(&parent).map_err(HomeInstallError::DefinitelyNotCreated)?;
    if !outside_excluded_project(&identities, excluded)
        || !excluded_is_stable(excluded).map_err(HomeInstallError::DefinitelyNotCreated)?
        || !chain_matches(&parent, &identities).map_err(HomeInstallError::DefinitelyNotCreated)?
        || !reopen_chain_matches(path, &identities, false)
            .map_err(HomeInstallError::DefinitelyNotCreated)?
        || !trusted_namespace_chain(&parent, process)
            .map_err(HomeInstallError::DefinitelyNotCreated)?
    {
        return Err(HomeInstallError::DefinitelyNotCreated(
            WindowsStoreError::Lost,
        ));
    }
    if missing_home_binding(process, path, &parent)
        .map_err(HomeInstallError::DefinitelyNotCreated)?
        != expected_parent_binding
    {
        return Err(HomeInstallError::Conflict);
    }
    let parent_facts = metadata(&parent.leaf).map_err(HomeInstallError::DefinitelyNotCreated)?;
    if [parent_facts.created, parent_facts.modified] != expected_parent_namespace {
        return Err(HomeInstallError::Conflict);
    }
    match create_private_directory(&path.path, process)
        .map_err(map_win)
        .map_err(HomeInstallError::CreationUncertain)?
    {
        DirectoryCreateAttempt::Created => {}
        DirectoryCreateAttempt::Conflict => return Err(HomeInstallError::Conflict),
    }
    let chain = path
        .open_complete()
        .map_err(|_| HomeInstallError::CreationUncertain(WindowsStoreError::Lost))?;
    let home = attest_codex_home(process, path, chain, excluded)
        .map_err(HomeInstallError::CreationUncertain)?;
    let created = (|| {
        if !chain_matches(&parent, &identities)? || !reopen_chain_matches(path, &identities, false)?
        {
            return Err(WindowsStoreError::Lost);
        }
        let security = attest_security(
            home.chain.leaf.as_handle(),
            process,
            SecurityKind::Directory,
        )
        .map_err(map_win)?;
        if !security.exact_protected_dacl {
            return Err(WindowsStoreError::Unsafe);
        }
        Ok(())
    })();
    match created {
        Ok(()) => Ok(home),
        Err(error) => match remove_created_home(home) {
            Ok(()) => Err(HomeInstallError::DefinitelyNotCreated(error)),
            Err(cleanup) => Err(HomeInstallError::CreationUncertain(cleanup)),
        },
    }
}

fn home_is_empty(home: &BoundCodexHome) -> Result<bool, WindowsStoreError> {
    require_home_stable(home)?;
    let mut entries = std::fs::read_dir(&home.path.path).map_err(|_| WindowsStoreError::Io)?;
    let empty = entries.next().is_none();
    require_home_stable(home)?;
    Ok(empty)
}

fn remove_created_home(home: BoundCodexHome) -> Result<(), WindowsStoreError> {
    if !home_is_empty(&home)? {
        return Err(WindowsStoreError::Lost);
    }
    let security = attest_security(
        home.chain.leaf.as_handle(),
        &home.process,
        SecurityKind::Directory,
    )
    .map_err(map_win)?;
    if !security.owner_current || !security.exact_protected_dacl || !security.semantic_medium_label
    {
        return Err(WindowsStoreError::Lost);
    }
    let path = home.path.path.clone();
    let identity = home.identity;
    let OpenedDirectoryChain { ancestors, leaf } = home.chain;
    drop(leaf);
    let delete_handle =
        open_directory_delete_nofollow(&path).map_err(|_| WindowsStoreError::Lost)?;
    if metadata(&delete_handle)?.identity != identity {
        return Err(WindowsStoreError::Lost);
    }
    match remove_by_handle(delete_handle.as_handle()).map_err(map_win)? {
        MutationAttempt::Applied => {}
        MutationAttempt::Conflict => return Err(WindowsStoreError::Lost),
        MutationAttempt::Unsupported => return Err(WindowsStoreError::Unsupported),
    }
    drop(delete_handle);
    // Retain every parent component until the exact child-name absence is proven.
    let _retained_ancestors = ancestors;
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

fn open_or_create_home_for_install(
    state: &CodexDotenvState,
    excluded: &BoundDirectoryChain,
) -> Result<(BoundCodexHome, bool), HomeInstallError> {
    match open_existing_home_for_mutation(&state.process, &state.codex_home, excluded)
        .map_err(HomeInstallError::DefinitelyNotCreated)?
    {
        Some(home) if state.home_kind == CodexHomeKind::Present => Ok((home, false)),
        Some(_) => Err(HomeInstallError::Conflict),
        None if state.home_kind == CodexHomeKind::Missing => create_codex_home(
            &state.process,
            &state.codex_home,
            excluded,
            state.home_binding,
            state.namespace_change,
        )
        .map(|home| (home, true)),
        None => Err(HomeInstallError::Conflict),
    }
}

fn remove_owned_candidate(
    home: &BoundCodexHome,
    file: File,
    nonce: ValidatedUuidV4,
) -> Result<(), WindowsStoreError> {
    match remove_by_handle(file.as_handle()).map_err(map_win)? {
        MutationAttempt::Applied => {}
        MutationAttempt::Conflict => return Err(WindowsStoreError::Lost),
        MutationAttempt::Unsupported => return Err(WindowsStoreError::Unsupported),
    }
    drop(file);
    require_home_stable(home)?;
    let path = home.path.path.join(candidate_name(nonce)?);
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

fn create_candidate(
    home: &BoundCodexHome,
    nonce: ValidatedUuidV4,
    bytes: &[u8],
    max_bytes: usize,
    allow_empty: bool,
) -> Result<(File, MetadataFacts, [u8; 32]), WindowsStoreError> {
    if (!allow_empty && bytes.is_empty()) || bytes.len() > max_bytes {
        return Err(WindowsStoreError::Limit);
    }
    require_home_stable(home)?;
    let name = candidate_name(nonce)?;
    let path = home.path.path.join(&name);
    let file = match create_private_file(
        &path,
        &home.process,
        GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER | DELETE,
        FILE_SHARE_READ | FILE_SHARE_DELETE,
    )
    .map_err(map_win)?
    {
        FileCreateAttempt::Created(file) => file,
        FileCreateAttempt::Conflict => return Err(WindowsStoreError::Unsafe),
    };
    let prepared = (|| {
        fail_on_dotenv_test_fault!(CandidateAfterCreate, WindowsStoreError::Lost);
        let facts = metadata(&file)?;
        let security = attest_security(file.as_handle(), &home.process, SecurityKind::File)
            .map_err(map_win)?;
        if !facts.exact_file()
            || facts.size != 0
            || facts.identity.volume != home.identity.volume
            || !security.owner_current
            || !security.exact_protected_dacl
            || !security.semantic_medium_label
        {
            return Err(WindowsStoreError::Unsafe);
        }
        let rebound =
            open_file_nofollow(&path, false, true, false).map_err(|_| WindowsStoreError::Lost)?;
        if metadata(&rebound)?.identity != facts.identity {
            return Err(WindowsStoreError::Lost);
        }
        write_all_at(&file, bytes, 0)?;
        file.set_len(u64::try_from(bytes.len()).map_err(|_| WindowsStoreError::Limit)?)
            .map_err(|_| WindowsStoreError::Io)?;
        fail_on_dotenv_test_fault!(CandidateAfterWrite, WindowsStoreError::Lost);
        let mut readback = read_exact_at(&file, bytes.len())?;
        let exact = readback == bytes;
        zeroize_bytes(readback.as_mut_slice());
        if !exact {
            return Err(WindowsStoreError::Lost);
        }
        fail_on_dotenv_test_fault!(CandidateAfterReadback, WindowsStoreError::Lost);
        flush_file(file.as_handle()).map_err(map_win)?;
        fail_on_dotenv_test_fault!(CandidateAfterFlush, WindowsStoreError::Lost);
        let after = metadata(&file)?;
        let security_after = attest_security(file.as_handle(), &home.process, SecurityKind::File)
            .map_err(map_win)?;
        if after.identity != facts.identity
            || after.size != bytes.len() as u64
            || !after.exact_file()
            || security_after != security
        {
            return Err(WindowsStoreError::Lost);
        }
        let binding = digest_metadata(
            b"plurum-windows-codex-dotenv-candidate-v1\0",
            after,
            true,
            Some(home.identity),
            &security_after.descriptor,
            bytes,
        );
        Ok((after, binding))
    })();
    match prepared {
        Ok((facts, binding)) => Ok((file, facts, binding)),
        Err(error) => match remove_owned_candidate(home, file, nonce) {
            Ok(()) => Err(error),
            Err(cleanup) => Err(cleanup),
        },
    }
}

fn exact_named_identity(
    home: &BoundCodexHome,
    name: &OsStr,
    expected: ObjectIdentity,
) -> Result<bool, WindowsStoreError> {
    require_home_stable(home)?;
    let path = home.path.path.join(name);
    let file = match open_file_nofollow(&path, false, true, false) {
        Ok(file) => file,
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
            ) =>
        {
            return Ok(false);
        }
        Err(_) => return Err(WindowsStoreError::Unsafe),
    };
    let facts = metadata(&file)?;
    let security =
        attest_security(file.as_handle(), &home.process, SecurityKind::File).map_err(map_win)?;
    Ok(facts.identity == expected
        && facts.exact_file()
        && security.owner_current
        && security.exact_protected_dacl
        && security.semantic_medium_label)
}

fn dotenv_entry_is_missing(home: &BoundCodexHome) -> Result<bool, WindowsStoreError> {
    require_home_stable(home)?;
    let path = home.path.path.join(DOTENV_ENTRY);
    let missing = match open_object_nofollow(&path) {
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
            ) =>
        {
            true
        }
        Ok(_) => false,
        Err(_) => return Err(WindowsStoreError::Unsafe),
    };
    require_home_stable(home)?;
    Ok(missing)
}

fn dotenv_matches_expected(
    home: &BoundCodexHome,
    identity: ObjectIdentity,
    binding: [u8; 32],
    max_bytes: usize,
) -> Result<bool, WindowsStoreError> {
    Ok(current_dotenv_evidence(home, max_bytes)?
        .is_some_and(|current| current == (identity, binding)))
}

fn current_dotenv_evidence(
    home: &BoundCodexHome,
    max_bytes: usize,
) -> Result<Option<(ObjectIdentity, [u8; 32])>, WindowsStoreError> {
    let path = home.path.path.join(DOTENV_ENTRY);
    let file = match open_dotenv_nofollow(&path, false) {
        Ok(file) => file,
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
            ) =>
        {
            return Ok(None);
        }
        Err(_) => return Err(WindowsStoreError::Unsafe),
    };
    let (file, mut bytes) = stable_dotenv_file(home, file, max_bytes)?;
    let evidence = (file.facts.identity, file.binding);
    if let Some(bytes) = bytes.as_mut() {
        zeroize_bytes(bytes.as_mut_slice());
    }
    Ok(Some(evidence))
}

fn install_candidate(
    home: &BoundCodexHome,
    candidate: &File,
    candidate_facts: MetadataFacts,
    expected_destination: Option<(ObjectIdentity, [u8; 32])>,
    max_bytes: usize,
) -> Result<MutationAttempt, CandidateInstallError> {
    require_home_stable(home).map_err(CandidateInstallError::BeforeRename)?;
    let current_candidate = metadata(candidate).map_err(CandidateInstallError::BeforeRename)?;
    if current_candidate != candidate_facts || !current_candidate.exact_file() {
        return Err(CandidateInstallError::BeforeRename(WindowsStoreError::Lost));
    }
    let destination_matches = match expected_destination {
        Some((identity, binding)) => dotenv_matches_expected(home, identity, binding, max_bytes)
            .map_err(CandidateInstallError::BeforeRename)?,
        None => dotenv_entry_is_missing(home).map_err(CandidateInstallError::BeforeRename)?,
    };
    if !destination_matches {
        return Ok(MutationAttempt::Conflict);
    }
    fail_on_dotenv_test_fault!(
        InstallBeforeRename,
        CandidateInstallError::BeforeRename(WindowsStoreError::Lost)
    );
    let destination: Vec<u16> = OsStr::new(DOTENV_ENTRY).encode_wide().collect();
    let result = rename_by_handle(
        candidate.as_handle(),
        home.chain.leaf.as_handle(),
        &destination,
        expected_destination.is_some(),
    )
    .map_err(map_win)
    .map_err(CandidateInstallError::RenameUncertain)?;
    if matches!(result, MutationAttempt::Applied) {
        fail_on_dotenv_test_fault!(
            InstallAfterRename,
            CandidateInstallError::RenameUncertain(WindowsStoreError::Lost)
        );
    }
    Ok(result)
}

fn remove_installed_candidate(
    home: &BoundCodexHome,
    identity: ObjectIdentity,
) -> Result<(), WindowsStoreError> {
    require_home_stable(home)?;
    let path = home.path.path.join(DOTENV_ENTRY);
    let installed = open_dotenv_nofollow(&path, false).map_err(|_| WindowsStoreError::Lost)?;
    let facts = metadata(&installed)?;
    let security = attest_security(installed.as_handle(), &home.process, SecurityKind::File)
        .map_err(map_win)?;
    if facts.identity != identity
        || !facts.exact_file()
        || !security.owner_current
        || !security.exact_protected_dacl
        || !security.semantic_medium_label
    {
        return Err(WindowsStoreError::Lost);
    }
    let rebound = open_dotenv_nofollow(&path, false).map_err(|_| WindowsStoreError::Lost)?;
    if metadata(&rebound)?.identity != identity {
        return Err(WindowsStoreError::Lost);
    }
    match remove_by_handle(installed.as_handle()).map_err(map_win)? {
        MutationAttempt::Applied => {}
        MutationAttempt::Conflict => return Err(WindowsStoreError::Lost),
        MutationAttempt::Unsupported => return Err(WindowsStoreError::Unsupported),
    }
    drop(installed);
    require_home_stable(home)?;
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

fn rollback_present(
    home: &BoundCodexHome,
    nonce: ValidatedUuidV4,
    installed_identity: ObjectIdentity,
    old_bytes: &[u8],
    max_bytes: usize,
) -> Result<(), WindowsStoreError> {
    let Some((current_identity, _)) = current_dotenv_evidence(home, max_bytes)? else {
        return Err(WindowsStoreError::Lost);
    };
    if current_identity != installed_identity {
        return Err(WindowsStoreError::Lost);
    }
    let (rollback, rollback_facts, _) = create_candidate(home, nonce, old_bytes, max_bytes, true)?;
    let Some((current_identity, current_binding)) = current_dotenv_evidence(home, max_bytes)?
    else {
        return Err(WindowsStoreError::Lost);
    };
    if current_identity != installed_identity {
        return Err(WindowsStoreError::Lost);
    }
    match install_candidate(
        home,
        &rollback,
        rollback_facts,
        Some((current_identity, current_binding)),
        max_bytes,
    ) {
        Ok(MutationAttempt::Applied) => drop(rollback),
        Ok(MutationAttempt::Conflict) => {
            remove_owned_candidate(home, rollback, nonce)?;
            return Err(WindowsStoreError::Lost);
        }
        Ok(MutationAttempt::Unsupported) => {
            remove_owned_candidate(home, rollback, nonce)?;
            return Err(WindowsStoreError::Unsupported);
        }
        Err(CandidateInstallError::BeforeRename(error)) => {
            remove_owned_candidate(home, rollback, nonce)?;
            return Err(error);
        }
        Err(CandidateInstallError::RenameUncertain(error)) => return Err(error),
    }
    let restored = open_dotenv_nofollow(&home.path.path.join(DOTENV_ENTRY), false)
        .map_err(|_| WindowsStoreError::Lost)?;
    let (restored, mut bytes) = stable_dotenv_file(home, restored, max_bytes)?;
    let exact =
        bytes.as_deref() == Some(old_bytes) && restored.facts.identity == rollback_facts.identity;
    if let Some(bytes) = bytes.as_mut() {
        zeroize_bytes(bytes.as_mut_slice());
    }
    drop(restored);
    if exact {
        Ok(())
    } else {
        Err(WindowsStoreError::Lost)
    }
}

fn post_install_observation(
    codex_home: &Path,
    excluded: &Path,
    max_bytes: usize,
) -> Result<CodexDotenvObservation, WindowsStoreError> {
    fail_on_dotenv_test_fault!(PostInstallObservation, WindowsStoreError::Io);
    observe_internal(codex_home, excluded, max_bytes)
}

fn candidate_recheck_matches(
    observed: &CodexDotenvState,
    expected: &CodexDotenvState,
    home: &BoundCodexHome,
    created_home: bool,
) -> bool {
    let home_transition_matches = if created_home {
        expected.home_kind == CodexHomeKind::Missing
    } else {
        expected.home_kind == CodexHomeKind::Present
    };
    let common = home_transition_matches
        && observed.process == expected.process
        && observed.codex_home == expected.codex_home
        && observed.excluded_project == expected.excluded_project
        && observed.excluded_chain == expected.excluded_chain
        && observed.home_kind == CodexHomeKind::Present
        && observed.home_binding
            == if created_home {
                home.binding
            } else {
                expected.home_binding
            };
    if !common {
        return false;
    }
    match expected.dotenv_kind {
        CodexDotenvKind::Missing => {
            observed.dotenv_kind == CodexDotenvKind::Missing
                && observed.dotenv_identity.is_none()
                && observed.dotenv_binding
                    == missing_dotenv_binding(observed.home_binding, observed.namespace_change)
        }
        CodexDotenvKind::Present => {
            !created_home
                && observed.dotenv_kind == CodexDotenvKind::Present
                && observed.dotenv_identity == expected.dotenv_identity
                && observed.dotenv_binding == expected.dotenv_binding
        }
        CodexDotenvKind::Oversized | CodexDotenvKind::Unsafe => false,
    }
}

fn confirm_expected_observation(
    codex_home: &Path,
    excluded_project_directory: &Path,
    expected: &CodexDotenvState,
    max_bytes: usize,
) -> Result<CodexDotenvState, WindowsStoreError> {
    let mut final_observation =
        observe_internal(codex_home, excluded_project_directory, max_bytes)?;
    let matches = observation_state(&final_observation).same_state(expected);
    let state = observation_state(&final_observation).clone();
    wipe_observation(&mut final_observation);
    if matches {
        Ok(state)
    } else {
        Err(WindowsStoreError::Lost)
    }
}

fn cleanup_uninstalled_candidate(
    lease: &mut DotenvLockLease,
    home: BoundCodexHome,
    created_home: bool,
    candidate: File,
    nonce: ValidatedUuidV4,
) -> Result<(), WindowsStoreError> {
    remove_owned_candidate(&home, candidate, nonce)?;
    if created_home {
        remove_created_home(home)?;
        lease.release(None)
    } else {
        lease.release(Some(&home))
    }
}

pub(crate) fn synchronize_codex_dotenv(
    codex_home: &Path,
    state_directory: &Path,
    excluded_project_directory: &Path,
    expected: &CodexDotenvState,
    nonce: &str,
    desired: Option<&[u8]>,
    max_bytes: usize,
) -> Result<CodexDotenvSynchronizeResult, WindowsStoreError> {
    if max_bytes == 0 || max_bytes > MAX_CODEX_DOTENV_BYTES {
        return Err(WindowsStoreError::Limit);
    }
    if let Some(bytes) = desired {
        if bytes.is_empty() || bytes.len() > max_bytes {
            return Err(WindowsStoreError::Limit);
        }
    }
    let parsed_home = NormalizedAbsolutePath::parse(codex_home)?;
    let parsed_excluded = NormalizedAbsolutePath::parse(excluded_project_directory)?;
    if parsed_home != expected.codex_home || parsed_excluded != expected.excluded_project {
        return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
    }
    expected
        .process
        .verify()
        .map_err(|_| WindowsStoreError::Lost)?;
    let excluded = open_bound_directory(&parsed_excluded)?;
    if excluded.identities != expected.excluded_chain || !excluded_is_stable(&excluded)? {
        return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
    }
    let nonce = ValidatedUuidV4::parse(nonce)?;
    if matches!(
        expected.dotenv_kind,
        CodexDotenvKind::Oversized | CodexDotenvKind::Unsafe
    ) {
        return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
    }
    let mut lease = match acquire_dotenv_lock(
        state_directory,
        &parsed_home,
        &excluded,
        &expected.process,
        nonce,
    )? {
        DotenvLockAcquireResult::Acquired(lease) => lease,
        DotenvLockAcquireResult::Busy => {
            return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
        }
    };
    lease.verify()?;

    let mut current = observe_internal(codex_home, excluded_project_directory, max_bytes)?;
    let same = observation_state(&current).same_state(expected);
    if !same {
        wipe_observation(&mut current);
        let home = open_existing_home_for_mutation(&expected.process, &parsed_home, &excluded)?;
        lease.release(home.as_ref())?;
        return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
    }
    if matches!(
        current,
        CodexDotenvObservation::Unsafe { .. } | CodexDotenvObservation::Oversized { .. }
    ) {
        wipe_observation(&mut current);
        let home = open_existing_home_for_mutation(&expected.process, &parsed_home, &excluded)?;
        lease.release(home.as_ref())?;
        return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
    }
    if desired.is_none() {
        wipe_observation(&mut current);
        let state = confirm_expected_observation(
            codex_home,
            excluded_project_directory,
            expected,
            max_bytes,
        )?;
        let home = open_existing_home_for_mutation(&expected.process, &parsed_home, &excluded)?;
        lease.release(home.as_ref())?;
        return Ok(CodexDotenvSynchronizeResult::Completed {
            disposition: CodexDotenvSynchronizeDisposition::Unchanged,
            state,
        });
    }

    let Some(desired) = desired else {
        return Err(WindowsStoreError::Lost);
    };
    let desired = WipedBytes(desired.to_vec());
    let old_missing = matches!(current, CodexDotenvObservation::Missing { .. });
    let old_bytes = match &current {
        CodexDotenvObservation::Present { bytes, .. } => Some(WipedBytes(bytes.clone())),
        _ => None,
    };
    if old_bytes
        .as_ref()
        .is_some_and(|old| old.as_slice() == desired.as_slice())
    {
        wipe_observation(&mut current);
        let state = confirm_expected_observation(
            codex_home,
            excluded_project_directory,
            expected,
            max_bytes,
        )?;
        let home = open_existing_home_for_mutation(&expected.process, &parsed_home, &excluded)?;
        lease.release(home.as_ref())?;
        return Ok(CodexDotenvSynchronizeResult::Completed {
            disposition: CodexDotenvSynchronizeDisposition::Unchanged,
            state,
        });
    }
    wipe_observation(&mut current);

    if expected.home_kind == CodexHomeKind::Missing {
        lease.mark_home_creation_preparing()?;
        fail_on_dotenv_test_fault!(HomeAfterIntent, WindowsStoreError::Lost);
    }
    let (home, created_home) = match open_or_create_home_for_install(expected, &excluded) {
        Ok(home) => home,
        Err(HomeInstallError::Conflict) => {
            let home = open_existing_home_for_mutation(&expected.process, &parsed_home, &excluded)?;
            lease.release(home.as_ref())?;
            return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
        }
        Err(HomeInstallError::DefinitelyNotCreated(error)) => {
            let home = open_existing_home_for_mutation(&expected.process, &parsed_home, &excluded)?;
            lease.release(home.as_ref())?;
            return Err(error);
        }
        Err(HomeInstallError::CreationUncertain(error)) => return Err(error),
    };
    if created_home {
        fail_on_dotenv_test_fault!(HomeAfterCreateBeforeClaim, WindowsStoreError::Lost);
        if let Err(error) = lease.mark_home_created(home.identity) {
            return match remove_created_home(home) {
                Ok(()) => Err(error),
                Err(cleanup) => Err(cleanup),
            };
        }
        fail_on_dotenv_test_fault!(HomeAfterClaim, WindowsStoreError::Lost);
    }
    lease.verify()?;
    let (candidate, candidate_facts, _) =
        match create_candidate(&home, nonce, desired.as_slice(), max_bytes, false) {
            Ok(candidate) => candidate,
            Err(error) => {
                if created_home {
                    remove_created_home(home)?;
                    lease.release(None)?;
                } else {
                    lease.release(Some(&home))?;
                }
                return Err(error);
            }
        };

    let mut rechecked = observe_internal(codex_home, excluded_project_directory, max_bytes)?;
    let recheck_matches =
        candidate_recheck_matches(observation_state(&rechecked), expected, &home, created_home);
    wipe_observation(&mut rechecked);
    if !recheck_matches {
        cleanup_uninstalled_candidate(&mut lease, home, created_home, candidate, nonce)?;
        return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
    }
    lease.verify()?;

    match install_candidate(
        &home,
        &candidate,
        candidate_facts,
        expected
            .dotenv_identity
            .map(|identity| (identity, expected.dotenv_binding)),
        max_bytes,
    ) {
        Ok(MutationAttempt::Applied) => drop(candidate),
        Ok(MutationAttempt::Conflict) => {
            cleanup_uninstalled_candidate(&mut lease, home, created_home, candidate, nonce)?;
            return Ok(CodexDotenvSynchronizeResult::PreconditionFailed);
        }
        Ok(MutationAttempt::Unsupported) => {
            cleanup_uninstalled_candidate(&mut lease, home, created_home, candidate, nonce)?;
            return Err(WindowsStoreError::Unsupported);
        }
        Err(CandidateInstallError::BeforeRename(error)) => {
            cleanup_uninstalled_candidate(&mut lease, home, created_home, candidate, nonce)?;
            return Err(error);
        }
        Err(CandidateInstallError::RenameUncertain(error)) => return Err(error),
    }

    let post = post_install_observation(codex_home, excluded_project_directory, max_bytes);
    let mut post = match post {
        Ok(post) => post,
        Err(error) => {
            let rollback = if old_missing {
                remove_installed_candidate(&home, candidate_facts.identity)
            } else if let Some(old_bytes) = old_bytes.as_ref() {
                rollback_present(
                    &home,
                    nonce,
                    candidate_facts.identity,
                    old_bytes.as_slice(),
                    max_bytes,
                )
            } else {
                Err(WindowsStoreError::Lost)
            };
            if created_home && old_missing && rollback.is_ok() {
                let _ = remove_created_home(home);
            }
            return Err(if rollback.is_ok() {
                error
            } else {
                WindowsStoreError::Lost
            });
        }
    };
    let exact_identity = matches!(
        exact_named_identity(&home, OsStr::new(DOTENV_ENTRY), candidate_facts.identity),
        Ok(true)
    );
    let exact_bytes = exact_identity
        && matches!(
            &post,
            CodexDotenvObservation::Present { bytes, .. } if bytes.as_slice() == desired.as_slice()
        );
    if !exact_bytes {
        wipe_observation(&mut post);
        let rollback = if old_missing {
            remove_installed_candidate(&home, candidate_facts.identity)
        } else if let Some(old_bytes) = old_bytes.as_ref() {
            rollback_present(
                &home,
                nonce,
                candidate_facts.identity,
                old_bytes.as_slice(),
                max_bytes,
            )
        } else {
            Err(WindowsStoreError::Lost)
        };
        if created_home && old_missing && rollback.is_ok() {
            let _ = remove_created_home(home);
        }
        return Err(WindowsStoreError::Lost);
    }
    let state = observation_state(&post).clone();
    wipe_observation(&mut post);
    lease.verify()?;
    lease.release(Some(&home))?;
    Ok(CodexDotenvSynchronizeResult::Completed {
        disposition: CodexDotenvSynchronizeDisposition::Changed,
        state,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::os::windows::ffi::OsStringExt;
    use std::path::{Path, PathBuf};

    use super::super::tests::TestRoot;
    use super::*;

    const NONCE: &str = "b56c52f5-a090-41eb-a164-1c92e36db94f";
    const NONCE_2: &str = "11111111-1111-4111-8111-111111111111";
    const NONCE_3: &str = "22222222-2222-4222-8222-222222222222";
    const NONCE_4: &str = "33333333-3333-4333-8333-333333333333";
    const MAX_BYTES: usize = MAX_CODEX_DOTENV_BYTES;
    const ORIGINAL: &[u8] = b"UNRELATED=value\nPLURUM_API_KEY=plrm_live_windows_original\n";
    const DESIRED: &[u8] = b"UNRELATED=value\nPLURUM_API_KEY=plrm_live_windows_replacement\n";
    const DESIRED_ASSIGNMENT: &[u8] = b"PLURUM_API_KEY=plrm_live_windows_replacement";
    const DESIRED_TOKEN: &[u8] = b"plrm_live_windows_replacement";

    struct Fixture {
        test: TestRoot,
        codex_home: PathBuf,
        excluded_project: PathBuf,
        canary: Vec<u8>,
    }

    impl Fixture {
        fn new(create_home: bool) -> Self {
            let test = TestRoot::new();
            ensure_private_directory(&test.store).expect("state directory must be private");
            let excluded_project = test.root.join("project");
            ensure_private_directory(&excluded_project)
                .expect("excluded project directory must be private");
            let codex_home = test.root.join("codex");
            if create_home {
                ensure_private_directory(&codex_home).expect("Codex home must be private");
            }
            let canary = fs::read(&test.marker).expect("test-root canary must be readable");
            Self {
                test,
                codex_home,
                excluded_project,
                canary,
            }
        }

        fn dotenv(&self) -> PathBuf {
            self.codex_home.join(DOTENV_ENTRY)
        }

        fn synchronize(
            &self,
            expected: &CodexDotenvState,
            nonce: &str,
            desired: Option<&[u8]>,
        ) -> Result<CodexDotenvSynchronizeResult, WindowsStoreError> {
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

        fn acquire_role_lock(
            &self,
            nonce: &str,
        ) -> Result<DotenvLockAcquireResult, WindowsStoreError> {
            let home =
                NormalizedAbsolutePath::parse(&self.codex_home).expect("Codex home must normalize");
            let excluded_path = NormalizedAbsolutePath::parse(&self.excluded_project)
                .expect("excluded project must normalize");
            let excluded =
                open_bound_directory(&excluded_path).expect("excluded project must bind");
            let process = ProcessIdentity::capture().expect("test process must be safe");
            acquire_dotenv_lock(
                &self.test.store,
                &home,
                &excluded,
                &process,
                ValidatedUuidV4::parse(nonce).expect("test nonce must validate"),
            )
        }

        fn bound_home(&self) -> BoundCodexHome {
            let process = ProcessIdentity::capture().expect("test process must be safe");
            let home =
                NormalizedAbsolutePath::parse(&self.codex_home).expect("Codex home must normalize");
            let excluded_path = NormalizedAbsolutePath::parse(&self.excluded_project)
                .expect("excluded project must normalize");
            let excluded =
                open_bound_directory(&excluded_path).expect("excluded project must bind");
            open_existing_home_for_mutation(&process, &home, &excluded)
                .expect("Codex home lookup must succeed")
                .expect("Codex home must exist")
        }

        fn canary_is_intact(&self) {
            assert_eq!(
                fs::read(&self.test.marker).expect("test-root canary must remain readable"),
                self.canary
            );
        }
    }

    fn create_private_test_file(path: &Path, bytes: &[u8]) {
        let process = ProcessIdentity::capture().expect("test process must be safe");
        let mut file = match create_private_file(
            path,
            &process,
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER | DELETE,
            FILE_SHARE_READ | FILE_SHARE_DELETE,
        )
        .expect("private test file creation must complete")
        {
            FileCreateAttempt::Created(file) => file,
            FileCreateAttempt::Conflict => panic!("private test file unexpectedly exists"),
        };
        file.write_all(bytes)
            .expect("private test file bytes must be written");
        flush_file(file.as_handle()).expect("private test file must be flushed");
    }

    fn missing_state(fixture: &Fixture) -> CodexDotenvState {
        match observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES)
            .expect("missing dotenv observation must succeed")
        {
            CodexDotenvObservation::Missing { state } => state,
            mut other => {
                wipe_observation(&mut other);
                panic!("dotenv must be reported missing");
            }
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
        result: Result<CodexDotenvSynchronizeResult, WindowsStoreError>,
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
        result: Result<CodexDotenvSynchronizeResult, WindowsStoreError>,
    ) -> CodexDotenvState {
        match result.expect("dotenv confirmation must succeed") {
            CodexDotenvSynchronizeResult::Completed {
                disposition: CodexDotenvSynchronizeDisposition::Unchanged,
                state,
            } => state,
            _ => panic!("dotenv synchronization must report no change"),
        }
    }

    fn expect_precondition_failed(result: Result<CodexDotenvSynchronizeResult, WindowsStoreError>) {
        assert!(matches!(
            result,
            Ok(CodexDotenvSynchronizeResult::PreconditionFailed)
        ));
    }

    fn observed_role_lock(fixture: &Fixture) -> DotenvLockRecord {
        let normalized =
            NormalizedAbsolutePath::parse(&fixture.codex_home).expect("Codex home must normalize");
        let file = open_file_nofollow(
            &fixture.test.store.join(DOTENV_LOCK_ENTRY),
            true,
            false,
            true,
        )
        .expect("dotenv role lock must open");
        read_dotenv_lock_record(&file, path_binding(&normalized))
            .expect("dotenv role lock must parse")
    }

    fn assert_clean_role_lock(fixture: &Fixture) {
        let normalized =
            NormalizedAbsolutePath::parse(&fixture.codex_home).expect("Codex home must normalize");
        assert_eq!(
            observed_role_lock(fixture),
            DotenvLockRecord::Clean {
                path_binding: path_binding(&normalized)
            }
        );
    }

    fn candidate_paths(home: &Path) -> Vec<PathBuf> {
        if !home.exists() {
            return Vec::new();
        }
        let mut paths = fs::read_dir(home)
            .expect("Codex home must be readable")
            .map(|entry| entry.expect("Codex home entry must load").path())
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(DOTENV_CANDIDATE_PREFIX))
            })
            .collect::<Vec<_>>();
        paths.sort();
        paths
    }

    fn directory_names(path: &Path) -> Vec<OsString> {
        if !path.exists() {
            return Vec::new();
        }
        let mut names = fs::read_dir(path)
            .expect("test directory must be readable")
            .map(|entry| entry.expect("test directory entry must load").file_name())
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    fn assert_plaintexts_absent(root: &Path, plaintexts: &[&[u8]]) {
        fn visit(path: &Path, plaintexts: &[&[u8]]) {
            for entry in fs::read_dir(path).expect("fixture tree must be readable") {
                let entry = entry.expect("fixture entry must load");
                let kind = entry.file_type().expect("fixture entry type must load");
                if kind.is_dir() {
                    visit(&entry.path(), plaintexts);
                } else if kind.is_file() {
                    let bytes = fs::read(entry.path()).expect("fixture file must be readable");
                    for plaintext in plaintexts {
                        assert!(
                            !bytes
                                .windows(plaintext.len())
                                .any(|window| window == *plaintext),
                            "fault cleanup retained a desired dotenv secret fragment"
                        );
                    }
                } else {
                    panic!("fixture cleanup encountered a non-file object");
                }
            }
        }
        assert!(!plaintexts.is_empty());
        assert!(plaintexts.iter().all(|plaintext| !plaintext.is_empty()));
        visit(root, plaintexts);
    }

    fn assert_private_home_and_dotenv(fixture: &Fixture) {
        let process = ProcessIdentity::capture().expect("test process must be safe");
        let home = open_directory_nofollow(&fixture.codex_home, false)
            .expect("Codex home must open without following reparses");
        let home_security = attest_security(home.as_handle(), &process, SecurityKind::Directory)
            .expect("Codex home security must attest");
        assert!(
            home_security.owner_current
                && home_security.exact_protected_dacl
                && home_security.semantic_medium_label
        );
        let dotenv =
            open_dotenv_nofollow(&fixture.dotenv(), false).expect("dotenv must open securely");
        let dotenv_facts = metadata(&dotenv).expect("dotenv metadata must attest");
        let dotenv_security = attest_security(dotenv.as_handle(), &process, SecurityKind::File)
            .expect("dotenv security must attest");
        assert!(dotenv_facts.exact_file());
        assert!(
            dotenv_security.owner_current
                && dotenv_security.exact_protected_dacl
                && dotenv_security.semantic_medium_label
        );
    }

    #[test]
    fn candidate_names_round_trip_only_the_exact_role() {
        let nonce = ValidatedUuidV4::parse(NONCE).expect("valid test nonce");
        let name = candidate_name(nonce).expect("candidate name");
        assert_eq!(candidate_nonce(&name), Ok(Some(nonce)));
        assert_eq!(candidate_nonce(OsStr::new("notes.tmp")), Ok(None));

        for ambiguous in [
            format!("{DOTENV_CANDIDATE_PREFIX}{NONCE}"),
            format!("{DOTENV_CANDIDATE_PREFIX}{NONCE}{DOTENV_CANDIDATE_SUFFIX}.bak"),
            format!(
                "{DOTENV_CANDIDATE_PREFIX}{}{DOTENV_CANDIDATE_SUFFIX}",
                NONCE.to_ascii_uppercase()
            ),
            format!("{DOTENV_CANDIDATE_PREFIX}00000000-0000-5000-8000-000000000000.tmp"),
        ] {
            assert_eq!(
                candidate_nonce(OsStr::new(&ambiguous)),
                Err(WindowsStoreError::Unsafe)
            );
        }

        let mut malformed_utf16 = DOTENV_CANDIDATE_PREFIX.encode_utf16().collect::<Vec<_>>();
        malformed_utf16.push(0xd800);
        assert_eq!(
            candidate_nonce(&OsString::from_wide(&malformed_utf16)),
            Err(WindowsStoreError::Unsafe)
        );
    }

    #[test]
    fn interrupted_lock_fields_accept_only_reachable_prefixes() {
        let expected = b"plurum-lock-field";
        assert!(recoverable_prefix(&[0; 17], expected));
        assert!(recoverable_prefix(expected, expected));

        let mut partial = [0_u8; 17];
        partial[..6].copy_from_slice(&expected[..6]);
        assert!(recoverable_prefix(&partial, expected));

        partial[8] = b'x';
        assert!(!recoverable_prefix(&partial, expected));

        let mut corrupted = *expected;
        corrupted[3] ^= 1;
        assert!(!recoverable_prefix(&corrupted, expected));
    }

    #[test]
    fn lock_record_layout_keeps_roles_disjoint() {
        assert_eq!(DOTENV_LOCK_HEADER_START, 1);
        const { assert!(DOTENV_LOCK_HEADER_END <= DOTENV_LOCK_PATH_START) };
        assert_eq!(DOTENV_LOCK_PATH_END, DOTENV_LOCK_HOME_INTENT_OFFSET);
        const { assert!(DOTENV_LOCK_HOME_INTENT_OFFSET < DOTENV_LOCK_NONCE_START) };
        const { assert!(DOTENV_LOCK_NONCE_END <= DOTENV_LOCK_HOME_IDENTITY_START) };
        assert_eq!(
            DOTENV_LOCK_HOME_IDENTITY_END,
            DOTENV_LOCK_HOME_CHECKSUM_START
        );
        assert_eq!(DOTENV_LOCK_HOME_CHECKSUM_END, DOTENV_LOCK_RECORD_LENGTH);
        assert_eq!(DOTENV_LOCK_NONCE_END - DOTENV_LOCK_NONCE_START, 36);
    }

    fn lock_record(
        state: u8,
        path_binding: [u8; 32],
        nonce: Option<ValidatedUuidV4>,
        cleanup: HomeCleanupClaim,
    ) -> Vec<u8> {
        let mut bytes = vec![0_u8; DOTENV_LOCK_RECORD_LENGTH];
        bytes[0] = state;
        bytes[DOTENV_LOCK_HEADER_START..DOTENV_LOCK_HEADER_END].copy_from_slice(DOTENV_LOCK_HEADER);
        bytes[DOTENV_LOCK_PATH_START..DOTENV_LOCK_PATH_END].copy_from_slice(&path_binding);
        if let Some(nonce) = nonce {
            bytes[DOTENV_LOCK_NONCE_START..DOTENV_LOCK_NONCE_END].copy_from_slice(&nonce.0);
        }
        match cleanup {
            HomeCleanupClaim::None => {}
            HomeCleanupClaim::Preparing(identity) => {
                bytes[DOTENV_LOCK_HOME_INTENT_OFFSET] = 1;
                if let Some(identity) = identity {
                    bytes[DOTENV_LOCK_HOME_IDENTITY_START..DOTENV_LOCK_HOME_VOLUME_END]
                        .copy_from_slice(&identity.volume.to_le_bytes());
                    bytes[DOTENV_LOCK_HOME_VOLUME_END..DOTENV_LOCK_HOME_IDENTITY_END]
                        .copy_from_slice(&identity.file_id);
                    bytes[DOTENV_LOCK_HOME_CHECKSUM_START..DOTENV_LOCK_HOME_CHECKSUM_END]
                        .copy_from_slice(&home_identity_checksum(path_binding, identity));
                }
            }
            HomeCleanupClaim::Created(identity) => {
                bytes[DOTENV_LOCK_HOME_INTENT_OFFSET] = 2;
                bytes[DOTENV_LOCK_HOME_IDENTITY_START..DOTENV_LOCK_HOME_VOLUME_END]
                    .copy_from_slice(&identity.volume.to_le_bytes());
                bytes[DOTENV_LOCK_HOME_VOLUME_END..DOTENV_LOCK_HOME_IDENTITY_END]
                    .copy_from_slice(&identity.file_id);
                bytes[DOTENV_LOCK_HOME_CHECKSUM_START..DOTENV_LOCK_HOME_CHECKSUM_END]
                    .copy_from_slice(&home_identity_checksum(path_binding, identity));
            }
            HomeCleanupClaim::Resolved => {
                bytes[DOTENV_LOCK_HOME_INTENT_OFFSET] = 3;
            }
        }
        bytes
    }

    #[test]
    fn state_zero_accepts_protocol_reachable_rebind_slots() {
        let nonce = ValidatedUuidV4::parse(NONCE).expect("valid test nonce");
        let identity = ObjectIdentity {
            volume: 17,
            file_id: [23; 16],
        };
        let old_path = [31; 32];
        let bytes = lock_record(
            DOTENV_LOCK_STATE_UNINITIALIZED,
            old_path,
            Some(nonce),
            HomeCleanupClaim::Created(identity),
        );
        assert_eq!(
            parse_dotenv_lock_record(&bytes),
            Ok(DotenvLockRecord::Uninitialized)
        );

        for prefix in 0..=DOTENV_LOCK_HEADER.len() {
            let mut partial = vec![0_u8; DOTENV_LOCK_RECORD_LENGTH];
            partial[DOTENV_LOCK_HEADER_START..DOTENV_LOCK_HEADER_START + prefix]
                .copy_from_slice(&DOTENV_LOCK_HEADER[..prefix]);
            assert_eq!(
                parse_dotenv_lock_record(&partial),
                Ok(DotenvLockRecord::Uninitialized)
            );
        }

        for prefix in 0..=LOCK_NONCE_LENGTH {
            let mut partial = lock_record(
                DOTENV_LOCK_STATE_UNINITIALIZED,
                old_path,
                None,
                HomeCleanupClaim::None,
            );
            partial[DOTENV_LOCK_NONCE_START..DOTENV_LOCK_NONCE_START + prefix]
                .copy_from_slice(&nonce.0[..prefix]);
            assert_eq!(
                parse_dotenv_lock_record(&partial),
                Ok(DotenvLockRecord::Uninitialized)
            );
        }
    }

    #[test]
    fn held_records_preserve_cleanup_identity_and_reject_malformed_nonce() {
        let nonce = ValidatedUuidV4::parse(NONCE).expect("valid test nonce");
        let identity = ObjectIdentity {
            volume: 41,
            file_id: [43; 16],
        };
        let path = [47; 32];
        let bytes = lock_record(
            DOTENV_LOCK_STATE_HELD,
            path,
            Some(nonce),
            HomeCleanupClaim::Preparing(Some(identity)),
        );
        assert_eq!(
            parse_dotenv_lock_record(&bytes),
            Ok(DotenvLockRecord::Held {
                path_binding: path,
                nonce,
                home_cleanup: HomeCleanupClaim::Preparing(Some(identity)),
            })
        );

        let mut malformed = lock_record(
            DOTENV_LOCK_STATE_HELD,
            path,
            Some(nonce),
            HomeCleanupClaim::None,
        );
        malformed[DOTENV_LOCK_NONCE_START] = b'x';
        assert_eq!(
            parse_dotenv_lock_record(&malformed),
            Err(WindowsStoreError::Unsafe)
        );
    }

    #[test]
    fn held_cleanup_identity_rejects_every_torn_evidence_byte() {
        let nonce = ValidatedUuidV4::parse(NONCE).expect("valid test nonce");
        let identity = ObjectIdentity {
            volume: 59,
            file_id: [61; 16],
        };
        let path = [67; 32];
        let preparing = lock_record(
            DOTENV_LOCK_STATE_HELD,
            path,
            Some(nonce),
            HomeCleanupClaim::Preparing(Some(identity)),
        );
        for offset in DOTENV_LOCK_HOME_IDENTITY_START..DOTENV_LOCK_HOME_CHECKSUM_END {
            let mut torn = preparing.clone();
            torn[offset] ^= 1;
            assert_eq!(
                parse_dotenv_lock_record(&torn),
                Err(WindowsStoreError::Unsafe)
            );
        }
    }

    #[test]
    fn cleanup_reset_accepts_torn_evidence_only_in_the_resolved_phase() {
        let nonce = ValidatedUuidV4::parse(NONCE).expect("valid test nonce");
        let identity = ObjectIdentity {
            volume: 63,
            file_id: [65; 16],
        };
        let path = [69; 32];
        let mut resolving = lock_record(
            DOTENV_LOCK_STATE_HELD,
            path,
            Some(nonce),
            HomeCleanupClaim::Created(identity),
        );
        resolving[DOTENV_LOCK_HOME_INTENT_OFFSET] = 3;
        for offset in DOTENV_LOCK_HOME_IDENTITY_START..DOTENV_LOCK_HOME_CHECKSUM_END {
            let mut torn = resolving.clone();
            torn[offset] ^= 1;
            assert_eq!(
                parse_dotenv_lock_record(&torn),
                Ok(DotenvLockRecord::Held {
                    path_binding: path,
                    nonce,
                    home_cleanup: HomeCleanupClaim::Resolved,
                })
            );
        }

        resolving[0] = DOTENV_LOCK_STATE_CLEAN;
        assert_eq!(
            parse_dotenv_lock_record(&resolving),
            Err(WindowsStoreError::Unsafe)
        );
    }

    #[test]
    fn immutable_lock_schema_corruption_fails_closed() {
        let nonce = ValidatedUuidV4::parse(NONCE).expect("valid test nonce");
        let path = [70; 32];
        let valid = lock_record(
            DOTENV_LOCK_STATE_HELD,
            path,
            Some(nonce),
            HomeCleanupClaim::None,
        );
        for corrupted in [
            {
                let mut bytes = valid.clone();
                bytes[0] = 9;
                bytes
            },
            {
                let mut bytes = valid.clone();
                bytes[DOTENV_LOCK_HEADER_START] ^= 1;
                bytes
            },
            {
                let mut bytes = valid.clone();
                bytes[DOTENV_LOCK_HEADER_END] = 1;
                bytes
            },
            {
                let mut bytes = valid.clone();
                bytes[DOTENV_LOCK_HOME_INTENT_OFFSET] = 4;
                bytes
            },
        ] {
            assert_eq!(
                parse_dotenv_lock_record(&corrupted),
                Err(WindowsStoreError::Unsafe)
            );
        }
    }

    #[test]
    fn missing_observations_change_when_the_namespace_changes() {
        let home_binding = [71; 32];
        assert_ne!(
            missing_dotenv_binding(home_binding, [73, 79]),
            missing_dotenv_binding(home_binding, [73, 83])
        );

        let mut first = Sha256::new();
        first.update(b"missing-home-parent");
        update_namespace_change(&mut first, [89, 97]);
        let mut second = Sha256::new();
        second.update(b"missing-home-parent");
        update_namespace_change(&mut second, [89, 101]);
        assert_ne!(first.finalize(), second.finalize());
    }

    #[test]
    fn clean_records_require_resolved_cleanup_and_keep_path_binding() {
        let path = [53; 32];
        let clean = lock_record(DOTENV_LOCK_STATE_CLEAN, path, None, HomeCleanupClaim::None);
        assert_eq!(
            parse_dotenv_lock_record(&clean),
            Ok(DotenvLockRecord::Clean { path_binding: path })
        );

        let pending = lock_record(
            DOTENV_LOCK_STATE_CLEAN,
            path,
            None,
            HomeCleanupClaim::Preparing(None),
        );
        assert_eq!(
            parse_dotenv_lock_record(&pending),
            Err(WindowsStoreError::Unsafe)
        );
    }

    #[test]
    fn ntfs_missing_and_present_transactions_are_private_atomic_and_exact() {
        let missing = Fixture::new(false);
        let missing_expected = missing_state(&missing);
        assert!(!missing.codex_home.exists());

        let installed =
            expect_changed(missing.synchronize(&missing_expected, NONCE, Some(DESIRED)));
        assert_eq!(
            fs::read(missing.dotenv()).expect("installed dotenv must be readable"),
            DESIRED
        );
        assert_eq!(present_state(&missing, DESIRED), installed);
        assert_eq!(
            expect_unchanged(missing.synchronize(&installed, NONCE_2, None)),
            installed
        );
        assert_private_home_and_dotenv(&missing);
        assert!(candidate_paths(&missing.codex_home).is_empty());
        assert_eq!(
            directory_names(&missing.codex_home),
            vec![OsString::from(DOTENV_ENTRY)]
        );
        assert_eq!(
            directory_names(&missing.test.store),
            vec![OsString::from(DOTENV_LOCK_ENTRY)]
        );
        assert_clean_role_lock(&missing);
        missing.canary_is_intact();

        let present = Fixture::new(true);
        create_private_test_file(&present.dotenv(), ORIGINAL);
        let present_expected = present_state(&present, ORIGINAL);
        let replaced = expect_changed(present.synchronize(&present_expected, NONCE, Some(DESIRED)));
        assert_eq!(present_state(&present, DESIRED), replaced);
        expect_precondition_failed(present.synchronize(&present_expected, NONCE_2, None));
        assert_eq!(
            fs::read(present.dotenv()).expect("replacement must remain readable"),
            DESIRED
        );
        assert!(candidate_paths(&present.codex_home).is_empty());
        assert_clean_role_lock(&present);
        present.canary_is_intact();
    }

    #[test]
    fn ntfs_bounds_hard_links_and_broad_dacls_are_classified_without_mutation() {
        let fixture = Fixture::new(true);
        let exact = vec![b'x'; MAX_BYTES];
        create_private_test_file(&fixture.dotenv(), &exact);
        let _ = present_state(&fixture, &exact);
        fs::remove_file(fixture.dotenv()).expect("exact-limit fixture must be removed");

        let oversized = vec![b'y'; MAX_BYTES + 1];
        create_private_test_file(&fixture.dotenv(), &oversized);
        let oversized_state =
            match observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES)
                .expect("oversized observation must complete")
            {
                CodexDotenvObservation::Oversized { state } => state,
                _ => panic!("oversized dotenv must be classified"),
            };
        expect_precondition_failed(fixture.synchronize(&oversized_state, NONCE, Some(DESIRED)));
        assert_eq!(
            fs::metadata(fixture.dotenv())
                .expect("oversized fixture must remain")
                .len(),
            (MAX_BYTES + 1) as u64
        );
        fs::remove_file(fixture.dotenv()).expect("oversized fixture must be removed");

        create_private_test_file(&fixture.dotenv(), ORIGINAL);
        let alias = fixture.codex_home.join("dotenv-hard-link-alias");
        fs::hard_link(fixture.dotenv(), &alias).expect("hard-link fixture must be created");
        let mut hard_link_observation =
            observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES);
        let hard_link_synchronize = match hard_link_observation.as_ref() {
            Ok(CodexDotenvObservation::Unsafe { state }) => {
                Some(fixture.synchronize(state, NONCE_2, Some(DESIRED)))
            }
            _ => None,
        };
        let hard_link_bytes = fs::read(fixture.dotenv());
        fs::remove_file(alias).expect("hard-link alias must be removed");
        let hard_link_was_unsafe = matches!(
            &hard_link_observation,
            Ok(CodexDotenvObservation::Unsafe { .. })
        );
        if let Ok(observation) = hard_link_observation.as_mut() {
            wipe_observation(observation);
        }
        assert!(hard_link_was_unsafe);
        expect_precondition_failed(
            hard_link_synchronize.expect("unsafe hard-link state must be synchronized"),
        );
        assert_eq!(
            hard_link_bytes.expect("hard-linked dotenv must remain readable"),
            ORIGINAL
        );

        plurum_windows_syscall::set_broad_dacl_for_tests(&fixture.dotenv(), SecurityKind::File)
            .expect("broad-DACL fixture must be installed");
        let mut broad_observation =
            observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES);
        let broad_synchronize = match broad_observation.as_ref() {
            Ok(CodexDotenvObservation::Unsafe { state }) => {
                Some(fixture.synchronize(state, NONCE_3, Some(DESIRED)))
            }
            _ => None,
        };
        let broad_bytes = fs::read(fixture.dotenv());
        plurum_windows_syscall::set_private_current_user_dacl_for_tests(
            &fixture.dotenv(),
            SecurityKind::File,
        )
        .expect("private dotenv DACL must be restored");
        let broad_was_unsafe = matches!(
            &broad_observation,
            Ok(CodexDotenvObservation::Unsafe { .. })
        );
        if let Ok(observation) = broad_observation.as_mut() {
            wipe_observation(observation);
        }
        assert!(broad_was_unsafe);
        expect_precondition_failed(
            broad_synchronize.expect("unsafe broad-DACL state must be synchronized"),
        );
        assert_eq!(
            broad_bytes.expect("broad-DACL dotenv must remain readable"),
            ORIGINAL
        );

        let _ = present_state(&fixture, ORIGINAL);
        assert_eq!(
            fs::read(fixture.dotenv()).expect("unsafe fixtures must not mutate dotenv"),
            ORIGINAL
        );
        assert!(candidate_paths(&fixture.codex_home).is_empty());
        assert!(!fixture.test.store.join(DOTENV_LOCK_ENTRY).exists());
        fixture.canary_is_intact();
    }

    #[test]
    fn ntfs_safe_inherited_and_unsafe_broad_home_dacls_are_distinguished() {
        let inherited = Fixture::new(true);
        let process = ProcessIdentity::capture().expect("test process must be safe");
        plurum_windows_syscall::set_inherited_current_user_dacl_for_tests(
            &inherited.codex_home,
            SecurityKind::Directory,
        )
        .expect("safe inherited-user home DACL must be installed");
        let inherited_handle = open_directory_nofollow(&inherited.codex_home, false);
        let inherited_security = inherited_handle.as_ref().ok().and_then(|home| {
            attest_security(home.as_handle(), &process, SecurityKind::Directory).ok()
        });
        let mut inherited_observation = observe_codex_dotenv(
            &inherited.codex_home,
            &inherited.excluded_project,
            MAX_BYTES,
        );
        let inherited_synchronize = match inherited_observation.as_ref() {
            Ok(CodexDotenvObservation::Missing { state }) => {
                Some(inherited.synchronize(state, NONCE, Some(DESIRED)))
            }
            _ => None,
        };
        let inherited_bytes = fs::read(inherited.dotenv());
        plurum_windows_syscall::set_private_current_user_dacl_for_tests(
            &inherited.codex_home,
            SecurityKind::Directory,
        )
        .expect("exact private home DACL must be restored");
        let inherited_was_missing = matches!(
            &inherited_observation,
            Ok(CodexDotenvObservation::Missing { .. })
        );
        if let Ok(observation) = inherited_observation.as_mut() {
            wipe_observation(observation);
        }
        let inherited_security =
            inherited_security.expect("inherited-user home security must attest");
        assert!(
            inherited_security.owner_current
                && !inherited_security.exact_protected_dacl
                && inherited_security.semantic_medium_label
        );
        assert!(inherited_was_missing);
        expect_changed(inherited_synchronize.expect("safe inherited-user home must synchronize"));
        assert_eq!(
            inherited_bytes.expect("inherited-user home dotenv must be readable"),
            DESIRED
        );
        let _ = present_state(&inherited, DESIRED);
        assert_private_home_and_dotenv(&inherited);
        assert_clean_role_lock(&inherited);
        inherited.canary_is_intact();

        let broad = Fixture::new(true);
        plurum_windows_syscall::set_broad_dacl_for_tests(
            &broad.codex_home,
            SecurityKind::Directory,
        )
        .expect("broad home DACL must be installed");
        let mut broad_observation =
            observe_codex_dotenv(&broad.codex_home, &broad.excluded_project, MAX_BYTES);
        let broad_synchronize = match broad_observation.as_ref() {
            Ok(CodexDotenvObservation::Unsafe { state }) => {
                Some(broad.synchronize(state, NONCE_2, Some(DESIRED)))
            }
            _ => None,
        };
        let broad_dotenv_exists = broad.dotenv().exists();
        plurum_windows_syscall::set_private_current_user_dacl_for_tests(
            &broad.codex_home,
            SecurityKind::Directory,
        )
        .expect("broad home DACL must be restored");
        let broad_was_unsafe = matches!(
            &broad_observation,
            Ok(CodexDotenvObservation::Unsafe { .. })
        );
        if let Ok(observation) = broad_observation.as_mut() {
            wipe_observation(observation);
        }
        assert!(broad_was_unsafe);
        expect_precondition_failed(
            broad_synchronize.expect("unsafe broad-home state must be synchronized"),
        );
        assert!(!broad_dotenv_exists);
        assert!(!broad.test.store.join(DOTENV_LOCK_ENTRY).exists());
        broad.canary_is_intact();
    }

    #[test]
    fn ntfs_create_delete_aba_invalidates_an_old_missing_precondition() {
        let fixture = Fixture::new(true);
        let expected = missing_state(&fixture);
        let rebound = (0..128).find_map(|attempt| {
            create_private_test_file(&fixture.dotenv(), ORIGINAL);
            fs::remove_file(fixture.dotenv()).expect("transient dotenv must be removed");
            if attempt % 8 == 7 {
                std::thread::sleep(std::time::Duration::from_millis(1));
            } else {
                std::thread::yield_now();
            }
            let current = missing_state(&fixture);
            (!current.same_state(&expected)).then_some(current)
        });
        let rebound = rebound.expect("NTFS namespace evidence must record create/delete ABA");

        expect_precondition_failed(fixture.synchronize(&expected, NONCE, Some(DESIRED)));
        assert!(!fixture.dotenv().exists());
        expect_changed(fixture.synchronize(&rebound, NONCE_2, Some(DESIRED)));
        assert_eq!(
            fs::read(fixture.dotenv()).expect("fresh observation must install dotenv"),
            DESIRED
        );
        assert_clean_role_lock(&fixture);
        fixture.canary_is_intact();
    }

    #[test]
    fn post_read_and_rebind_observation_faults_are_non_mutating() {
        for fault in [
            DotenvTestFault::ObserveAfterRead,
            DotenvTestFault::ObserveAfterRebind,
        ] {
            let fixture = Fixture::new(true);
            create_private_test_file(&fixture.dotenv(), ORIGINAL);
            arm_dotenv_test_fault(fault);
            assert_eq!(
                observe_codex_dotenv(&fixture.codex_home, &fixture.excluded_project, MAX_BYTES,)
                    .err(),
                Some(WindowsStoreError::Io)
            );
            assert_dotenv_test_fault_consumed();
            assert_eq!(
                fs::read(fixture.dotenv()).expect("faulted dotenv must remain readable"),
                ORIGINAL
            );
            assert!(!fixture.test.store.join(DOTENV_LOCK_ENTRY).exists());
            assert!(candidate_paths(&fixture.codex_home).is_empty());
            fixture.canary_is_intact();
        }
    }

    #[test]
    fn missing_home_claim_boundaries_recover_or_fail_closed_by_ownership() {
        let intent = Fixture::new(false);
        let intent_expected = missing_state(&intent);
        arm_dotenv_test_fault(DotenvTestFault::HomeAfterIntent);
        assert_eq!(
            intent
                .synchronize(&intent_expected, NONCE, Some(DESIRED))
                .err(),
            Some(WindowsStoreError::Lost)
        );
        assert_dotenv_test_fault_consumed();
        assert!(!intent.codex_home.exists());
        assert!(matches!(
            observed_role_lock(&intent),
            DotenvLockRecord::Held {
                home_cleanup: HomeCleanupClaim::Preparing(None),
                ..
            }
        ));
        expect_changed(intent.synchronize(&intent_expected, NONCE_2, Some(DESIRED)));
        assert_eq!(
            fs::read(intent.dotenv()).expect("intent recovery must install dotenv"),
            DESIRED
        );
        assert_clean_role_lock(&intent);
        intent.canary_is_intact();

        let unclaimed = Fixture::new(false);
        let unclaimed_expected = missing_state(&unclaimed);
        arm_dotenv_test_fault(DotenvTestFault::HomeAfterCreateBeforeClaim);
        assert_eq!(
            unclaimed
                .synchronize(&unclaimed_expected, NONCE, Some(DESIRED))
                .err(),
            Some(WindowsStoreError::Lost)
        );
        assert_dotenv_test_fault_consumed();
        assert!(unclaimed.codex_home.is_dir());
        assert!(directory_names(&unclaimed.codex_home).is_empty());
        assert_eq!(
            unclaimed.acquire_role_lock(NONCE_2).err(),
            Some(WindowsStoreError::Lost)
        );
        assert!(
            unclaimed.codex_home.is_dir(),
            "an unclaimed home must never be guessed as Plurum-owned"
        );
        remove_created_home(unclaimed.bound_home())
            .expect("the disposable fixture may remove its attested empty home");
        let mut recovered = match unclaimed
            .acquire_role_lock(NONCE_3)
            .expect("role lock must recover after fixture-owned cleanup")
        {
            DotenvLockAcquireResult::Acquired(lease) => lease,
            DotenvLockAcquireResult::Busy => panic!("role lock must not remain busy"),
        };
        recovered
            .release(None)
            .expect("recovered role lock must release");
        let rebound = missing_state(&unclaimed);
        expect_changed(unclaimed.synchronize(&rebound, NONCE_4, Some(DESIRED)));
        assert_clean_role_lock(&unclaimed);
        unclaimed.canary_is_intact();

        let claimed = Fixture::new(false);
        let claimed_expected = missing_state(&claimed);
        arm_dotenv_test_fault(DotenvTestFault::HomeAfterClaim);
        assert_eq!(
            claimed
                .synchronize(&claimed_expected, NONCE, Some(DESIRED))
                .err(),
            Some(WindowsStoreError::Lost)
        );
        assert_dotenv_test_fault_consumed();
        assert!(claimed.codex_home.is_dir());
        assert!(matches!(
            observed_role_lock(&claimed),
            DotenvLockRecord::Held {
                home_cleanup: HomeCleanupClaim::Created(_),
                ..
            }
        ));
        let mut recovered = match claimed
            .acquire_role_lock(NONCE_2)
            .expect("claimed home recovery must acquire the role lock")
        {
            DotenvLockAcquireResult::Acquired(lease) => lease,
            DotenvLockAcquireResult::Busy => panic!("role lock must not remain busy"),
        };
        assert!(
            !claimed.codex_home.exists(),
            "exactly claimed empty home must be removed during recovery"
        );
        recovered
            .release(None)
            .expect("claimed-home recovery lock must release");
        let rebound = missing_state(&claimed);
        expect_changed(claimed.synchronize(&rebound, NONCE_3, Some(DESIRED)));
        assert_clean_role_lock(&claimed);
        claimed.canary_is_intact();
    }

    #[test]
    fn candidate_preparation_and_flush_faults_clean_then_retry() {
        for fault in [
            DotenvTestFault::CandidateAfterCreate,
            DotenvTestFault::CandidateAfterWrite,
            DotenvTestFault::CandidateAfterReadback,
            DotenvTestFault::CandidateAfterFlush,
        ] {
            let fixture = Fixture::new(true);
            let expected = missing_state(&fixture);
            arm_dotenv_test_fault(fault);
            assert_eq!(
                fixture.synchronize(&expected, NONCE, Some(DESIRED)).err(),
                Some(WindowsStoreError::Lost)
            );
            assert_dotenv_test_fault_consumed();
            assert!(!fixture.dotenv().exists());
            assert!(candidate_paths(&fixture.codex_home).is_empty());
            assert_clean_role_lock(&fixture);
            assert_plaintexts_absent(
                &fixture.test.root,
                &[DESIRED, DESIRED_ASSIGNMENT, DESIRED_TOKEN],
            );

            let rebound = missing_state(&fixture);
            expect_changed(fixture.synchronize(&rebound, NONCE_2, Some(DESIRED)));
            assert_eq!(
                fs::read(fixture.dotenv()).expect("candidate retry must install dotenv"),
                DESIRED
            );
            assert!(candidate_paths(&fixture.codex_home).is_empty());
            assert_clean_role_lock(&fixture);
            fixture.canary_is_intact();
        }
    }

    #[test]
    fn atomic_install_faults_distinguish_definite_cleanup_from_uncertainty() {
        let before = Fixture::new(true);
        let before_expected = missing_state(&before);
        arm_dotenv_test_fault(DotenvTestFault::InstallBeforeRename);
        assert_eq!(
            before
                .synchronize(&before_expected, NONCE, Some(DESIRED))
                .err(),
            Some(WindowsStoreError::Lost)
        );
        assert_dotenv_test_fault_consumed();
        assert!(!before.dotenv().exists());
        assert!(candidate_paths(&before.codex_home).is_empty());
        assert_clean_role_lock(&before);
        assert_plaintexts_absent(
            &before.test.root,
            &[DESIRED, DESIRED_ASSIGNMENT, DESIRED_TOKEN],
        );
        let rebound = missing_state(&before);
        expect_changed(before.synchronize(&rebound, NONCE_2, Some(DESIRED)));
        assert_clean_role_lock(&before);

        let after = Fixture::new(true);
        let after_expected = missing_state(&after);
        arm_dotenv_test_fault(DotenvTestFault::InstallAfterRename);
        assert_eq!(
            after
                .synchronize(&after_expected, NONCE, Some(DESIRED))
                .err(),
            Some(WindowsStoreError::Lost)
        );
        assert_dotenv_test_fault_consumed();
        assert_eq!(
            fs::read(after.dotenv()).expect("uncertain rename result must be observable"),
            DESIRED
        );
        assert!(candidate_paths(&after.codex_home).is_empty());
        assert!(matches!(
            observed_role_lock(&after),
            DotenvLockRecord::Held { .. }
        ));
        let installed = present_state(&after, DESIRED);
        assert_eq!(
            expect_unchanged(after.synchronize(&installed, NONCE_2, None)),
            installed
        );
        assert_clean_role_lock(&after);
        after.canary_is_intact();
    }

    #[test]
    fn post_install_failures_roll_back_missing_and_existing_without_plaintext_residue() {
        let missing = Fixture::new(true);
        let missing_expected = missing_state(&missing);
        arm_dotenv_test_fault(DotenvTestFault::PostInstallObservation);
        assert_eq!(
            missing
                .synchronize(&missing_expected, NONCE, Some(DESIRED))
                .err(),
            Some(WindowsStoreError::Io)
        );
        assert_dotenv_test_fault_consumed();
        assert!(!missing.dotenv().exists());
        assert!(candidate_paths(&missing.codex_home).is_empty());
        assert_plaintexts_absent(
            &missing.test.root,
            &[DESIRED, DESIRED_ASSIGNMENT, DESIRED_TOKEN],
        );
        assert!(matches!(
            observed_role_lock(&missing),
            DotenvLockRecord::Held { .. }
        ));
        let rebound = missing_state(&missing);
        assert_eq!(
            expect_unchanged(missing.synchronize(&rebound, NONCE_2, None)),
            rebound
        );
        assert_clean_role_lock(&missing);
        missing.canary_is_intact();

        let present = Fixture::new(true);
        create_private_test_file(&present.dotenv(), ORIGINAL);
        let present_expected = present_state(&present, ORIGINAL);
        arm_dotenv_test_fault(DotenvTestFault::PostInstallObservation);
        assert_eq!(
            present
                .synchronize(&present_expected, NONCE, Some(DESIRED))
                .err(),
            Some(WindowsStoreError::Io)
        );
        assert_dotenv_test_fault_consumed();
        assert_eq!(
            fs::read(present.dotenv()).expect("rollback must restore original dotenv"),
            ORIGINAL
        );
        assert!(candidate_paths(&present.codex_home).is_empty());
        assert_plaintexts_absent(
            &present.test.root,
            &[DESIRED, DESIRED_ASSIGNMENT, DESIRED_TOKEN],
        );
        let restored = present_state(&present, ORIGINAL);
        assert_eq!(
            expect_unchanged(present.synchronize(&restored, NONCE_2, None)),
            restored
        );
        assert_clean_role_lock(&present);
        present.canary_is_intact();

        let missing_home = Fixture::new(false);
        let missing_home_expected = missing_state(&missing_home);
        arm_dotenv_test_fault(DotenvTestFault::PostInstallObservation);
        assert_eq!(
            missing_home
                .synchronize(&missing_home_expected, NONCE, Some(DESIRED))
                .err(),
            Some(WindowsStoreError::Io)
        );
        assert_dotenv_test_fault_consumed();
        assert!(!missing_home.codex_home.exists());
        assert!(candidate_paths(&missing_home.codex_home).is_empty());
        assert_plaintexts_absent(
            &missing_home.test.root,
            &[DESIRED, DESIRED_ASSIGNMENT, DESIRED_TOKEN],
        );
        let rebound = missing_state(&missing_home);
        assert_eq!(
            expect_unchanged(missing_home.synchronize(&rebound, NONCE_2, None)),
            rebound
        );
        assert_clean_role_lock(&missing_home);
        missing_home.canary_is_intact();
    }

    #[test]
    fn role_lock_contention_release_and_abandonment_all_converge() {
        let contention = Fixture::new(true);
        let expected = missing_state(&contention);
        let held = match contention
            .acquire_role_lock(NONCE)
            .expect("fresh role lock must acquire")
        {
            DotenvLockAcquireResult::Acquired(lease) => lease,
            DotenvLockAcquireResult::Busy => panic!("fresh role lock must not be busy"),
        };
        expect_precondition_failed(contention.synchronize(&expected, NONCE_2, Some(DESIRED)));
        assert!(!contention.dotenv().exists());
        drop(held);
        expect_changed(contention.synchronize(&expected, NONCE_3, Some(DESIRED)));
        assert_eq!(
            fs::read(contention.dotenv()).expect("post-contention retry must install"),
            DESIRED
        );
        assert_clean_role_lock(&contention);
        contention.canary_is_intact();

        for fault in [
            DotenvTestFault::ReleaseBeforeClean,
            DotenvTestFault::ReleaseAfterClean,
        ] {
            let fixture = Fixture::new(true);
            let expected = missing_state(&fixture);
            arm_dotenv_test_fault(fault);
            assert_eq!(
                fixture.synchronize(&expected, NONCE, Some(DESIRED)).err(),
                Some(WindowsStoreError::Lost)
            );
            assert_dotenv_test_fault_consumed();
            assert_eq!(
                fs::read(fixture.dotenv()).expect("release fault must retain installed dotenv"),
                DESIRED
            );
            if fault == DotenvTestFault::ReleaseBeforeClean {
                assert!(matches!(
                    observed_role_lock(&fixture),
                    DotenvLockRecord::Held { .. }
                ));
            } else {
                assert!(matches!(
                    observed_role_lock(&fixture),
                    DotenvLockRecord::Clean { .. }
                ));
            }
            let installed = present_state(&fixture, DESIRED);
            assert_eq!(
                expect_unchanged(fixture.synchronize(&installed, NONCE_2, None)),
                installed
            );
            assert!(candidate_paths(&fixture.codex_home).is_empty());
            assert_clean_role_lock(&fixture);
            fixture.canary_is_intact();
        }
    }

    #[test]
    fn candidate_recovery_faults_converge_without_partial_publication() {
        for fault in [
            DotenvTestFault::RecoveryBeforeCandidateRemove,
            DotenvTestFault::RecoveryAfterCandidateRemove,
        ] {
            let fixture = Fixture::new(true);
            let held = match fixture
                .acquire_role_lock(NONCE)
                .expect("fixture role lock must acquire")
            {
                DotenvLockAcquireResult::Acquired(lease) => lease,
                DotenvLockAcquireResult::Busy => panic!("fixture role lock must not be busy"),
            };
            let home = fixture.bound_home();
            let nonce = ValidatedUuidV4::parse(NONCE).expect("fixture nonce must validate");
            let (candidate, _, _) = create_candidate(&home, nonce, DESIRED, MAX_BYTES, false)
                .expect("interrupted candidate must prepare");
            drop(candidate);
            drop(home);
            drop(held);
            assert_eq!(candidate_paths(&fixture.codex_home).len(), 1);
            assert!(matches!(
                observed_role_lock(&fixture),
                DotenvLockRecord::Held { .. }
            ));

            arm_dotenv_test_fault(fault);
            assert_eq!(
                fixture.acquire_role_lock(NONCE_2).err(),
                Some(WindowsStoreError::Lost)
            );
            assert_dotenv_test_fault_consumed();
            assert!(!fixture.dotenv().exists());
            assert_eq!(
                candidate_paths(&fixture.codex_home).len(),
                usize::from(fault == DotenvTestFault::RecoveryBeforeCandidateRemove)
            );

            let mut recovered = match fixture
                .acquire_role_lock(NONCE_3)
                .expect("candidate recovery retry must acquire")
            {
                DotenvLockAcquireResult::Acquired(lease) => lease,
                DotenvLockAcquireResult::Busy => panic!("candidate recovery must not remain busy"),
            };
            let home = fixture.bound_home();
            recovered
                .release(Some(&home))
                .expect("candidate recovery role lock must release");
            drop(home);
            assert!(candidate_paths(&fixture.codex_home).is_empty());
            assert_plaintexts_absent(
                &fixture.test.root,
                &[DESIRED, DESIRED_ASSIGNMENT, DESIRED_TOKEN],
            );
            assert_clean_role_lock(&fixture);

            let rebound = missing_state(&fixture);
            expect_changed(fixture.synchronize(&rebound, NONCE_4, Some(DESIRED)));
            assert_eq!(
                fs::read(fixture.dotenv()).expect("recovered transaction must install"),
                DESIRED
            );
            assert!(candidate_paths(&fixture.codex_home).is_empty());
            assert_clean_role_lock(&fixture);
            fixture.canary_is_intact();
        }
    }
}
