use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsHandle;

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
    chain.iter().any(|candidate| *candidate == identity)
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

fn state_for(
    process: ProcessIdentity,
    codex_home: NormalizedAbsolutePath,
    excluded: &BoundDirectoryChain,
    home_kind: CodexHomeKind,
    home_binding: [u8; 32],
    namespace_change: [u64; 2],
    dotenv_kind: CodexDotenvKind,
    dotenv_identity: Option<ObjectIdentity>,
    dotenv_binding: [u8; 32],
) -> CodexDotenvState {
    CodexDotenvState {
        process,
        codex_home,
        excluded_project: excluded.path.clone(),
        excluded_chain: excluded.identities.clone(),
        home_kind,
        home_binding,
        namespace_change,
        dotenv_kind,
        dotenv_identity,
        dotenv_binding,
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
            CodexHomeKind::Present,
            binding,
            [0; 2],
            CodexDotenvKind::Unsafe,
            None,
            binding,
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
            let target_missing = match open_object_nofollow(&codex_home.path) {
                Err(error)
                    if matches!(
                        error.raw_os_error(),
                        Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
                    ) =>
                {
                    true
                }
                _ => false,
            };
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
                    CodexHomeKind::Missing,
                    binding,
                    [parent_facts.created, parent_facts.modified],
                    CodexDotenvKind::Missing,
                    None,
                    binding,
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
                    CodexHomeKind::Present,
                    home.binding,
                    namespace_change,
                    CodexDotenvKind::Missing,
                    None,
                    missing_dotenv_binding(home.binding, namespace_change),
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
        CodexHomeKind::Present,
        home.binding,
        home.namespace_change,
        if bytes.is_some() {
            CodexDotenvKind::Present
        } else {
            CodexDotenvKind::Oversized
        },
        Some(file.facts.identity),
        file.binding,
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
    match remove_by_handle(file.as_handle()).map_err(map_win)? {
        MutationAttempt::Applied => {}
        MutationAttempt::Conflict => return Err(WindowsStoreError::Lost),
        MutationAttempt::Unsupported => return Err(WindowsStoreError::Unsupported),
    }
    drop(file);
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
        write_dotenv_lock_state(lock, DOTENV_LOCK_STATE_CLEAN)?;
        if read_dotenv_lock_record(lock, self.path_binding)?
            != (DotenvLockRecord::Clean {
                path_binding: self.path_binding,
            })
        {
            return Err(WindowsStoreError::Lost);
        }
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
        let mut readback = read_exact_at(&file, bytes.len())?;
        let exact = readback == bytes;
        zeroize_bytes(readback.as_mut_slice());
        if !exact {
            return Err(WindowsStoreError::Lost);
        }
        flush_file(file.as_handle()).map_err(map_win)?;
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
    let destination: Vec<u16> = OsStr::new(DOTENV_ENTRY).encode_wide().collect();
    let result = rename_by_handle(
        candidate.as_handle(),
        home.chain.leaf.as_handle(),
        &destination,
        expected_destination.is_some(),
    )
    .map_err(map_win)
    .map_err(CandidateInstallError::RenameUncertain)?;
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
        if let Err(error) = lease.mark_home_created(home.identity) {
            return match remove_created_home(home) {
                Ok(()) => Err(error),
                Err(cleanup) => Err(cleanup),
            };
        }
    }
    lease.verify()?;
    let (candidate, candidate_facts, _) =
        match create_candidate(&home, nonce, desired.as_slice(), max_bytes, false) {
            Ok(candidate) => candidate,
            Err(error) => {
                if created_home {
                    if let Err(cleanup) = remove_created_home(home) {
                        return Err(cleanup);
                    }
                    if let Err(cleanup) = lease.release(None) {
                        return Err(cleanup);
                    }
                } else if let Err(cleanup) = lease.release(Some(&home)) {
                    return Err(cleanup);
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
    use std::os::windows::ffi::OsStringExt;

    use super::*;

    const NONCE: &str = "b56c52f5-a090-41eb-a164-1c92e36db94f";

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
        assert!(DOTENV_LOCK_HEADER_END <= DOTENV_LOCK_PATH_START);
        assert_eq!(DOTENV_LOCK_PATH_END, DOTENV_LOCK_HOME_INTENT_OFFSET);
        assert!(DOTENV_LOCK_HOME_INTENT_OFFSET < DOTENV_LOCK_NONCE_START);
        assert!(DOTENV_LOCK_NONCE_END <= DOTENV_LOCK_HOME_IDENTITY_START);
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
}
