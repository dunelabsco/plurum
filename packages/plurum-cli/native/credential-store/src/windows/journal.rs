use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsHandle;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use plurum_native_secret_memory::zeroize_bytes;
use plurum_windows_syscall::{
    attest_security, create_private_file, flush_file, remove_by_handle, rename_by_handle,
    try_lock_exclusive, unlock, FileCreateAttempt, LockAttempt, MutationAttempt, SecurityKind,
};

use super::*;

const JOURNAL_ENTRY: &str = "host-reconciliation.json";
const JOURNAL_LOCK_ENTRY: &str = "host-reconciliation.lock";
const JOURNAL_CANDIDATE_PREFIX: &str = ".host-reconciliation-";
const JOURNAL_CANDIDATE_SUFFIX: &str = ".tmp";
const MAX_JOURNAL_BYTES: usize = 65_536;
const MAX_DIRECTORY_ENTRIES: usize = 4_096;

// Windows provides no general directory-handle flush. Flushed file contents, synchronous
// by-handle namespace mutations, and retained-handle re-attestation form a process-crash
// boundary here; this module deliberately makes no physical power-loss guarantee.
const JOURNAL_LOCK_RECORD_LENGTH: usize = 96;
const JOURNAL_LOCK_STATE_UNINITIALIZED: u8 = 0;
const JOURNAL_LOCK_STATE_CLEAN: u8 = 1;
const JOURNAL_LOCK_STATE_HELD: u8 = 2;
const JOURNAL_LOCK_HEADER: &[u8] = b"plurum-host-reconciliation-lock-v1";
const JOURNAL_LOCK_HEADER_START: usize = 1;
const JOURNAL_LOCK_HEADER_END: usize = JOURNAL_LOCK_HEADER_START + JOURNAL_LOCK_HEADER.len();
const JOURNAL_LOCK_NONCE_START: usize = 48;
const JOURNAL_LOCK_NONCE_END: usize = JOURNAL_LOCK_NONCE_START + LOCK_NONCE_LENGTH;

#[cfg(test)]
const TEST_FAULT_ACQUIRE_BUSY_AFTER_LOCK_CREATION: u8 = 1;
#[cfg(test)]
const TEST_FAULT_LOCK_INITIALIZE_AFTER_TAIL: u8 = 2;
#[cfg(test)]
const TEST_FAULT_LOCK_INITIALIZE_AFTER_CLEAN: u8 = 3;
#[cfg(test)]
const TEST_FAULT_LOCK_HELD_AFTER_NONCE: u8 = 4;
#[cfg(test)]
const TEST_FAULT_LOCK_HELD_AFTER_STATE: u8 = 5;
#[cfg(test)]
const TEST_FAULT_OBSERVE_AFTER_READ: u8 = 6;
#[cfg(test)]
const TEST_FAULT_CANDIDATE_AFTER_CREATE: u8 = 7;
#[cfg(test)]
const TEST_FAULT_CANDIDATE_AFTER_WRITE: u8 = 8;
#[cfg(test)]
const TEST_FAULT_CANDIDATE_AFTER_READBACK: u8 = 9;
#[cfg(test)]
const TEST_FAULT_CANDIDATE_AFTER_FLUSH: u8 = 10;
#[cfg(test)]
const TEST_FAULT_BEFORE_RECHECK: u8 = 11;
#[cfg(test)]
const TEST_FAULT_BEFORE_RENAME: u8 = 12;
#[cfg(test)]
const TEST_FAULT_AFTER_RENAME: u8 = 13;
#[cfg(test)]
const TEST_FAULT_POST_RENAME_READBACK: u8 = 14;
#[cfg(test)]
const TEST_FAULT_CONFLICT_CLEANUP_BEFORE_REMOVE: u8 = 15;
#[cfg(test)]
const TEST_FAULT_CONFLICT_CLEANUP_AFTER_REMOVE: u8 = 16;
#[cfg(test)]
const TEST_FAULT_REMOVE_BEFORE_DELETE: u8 = 17;
#[cfg(test)]
const TEST_FAULT_REMOVE_AFTER_DELETE: u8 = 18;
#[cfg(test)]
const TEST_FAULT_RELEASE_BEFORE_CLEAN: u8 = 19;
#[cfg(test)]
const TEST_FAULT_RELEASE_AFTER_CLEAN: u8 = 20;
#[cfg(test)]
const TEST_FAULT_RECOVERY_BEFORE_REMOVE: u8 = 21;
#[cfg(test)]
const TEST_FAULT_RECOVERY_AFTER_REMOVE: u8 = 22;
#[cfg(test)]
const TEST_RACE_RECHECK_CANONICAL: u8 = 23;

#[cfg(test)]
thread_local! {
    static TEST_FAULT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
    static TEST_COMPETING_LOCK: std::cell::RefCell<Option<File>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn inject_test_fault(fault: u8) {
    TEST_FAULT.with(|slot| {
        assert_eq!(slot.replace(fault), 0, "journal test fault already armed");
    });
}

#[cfg(test)]
fn take_test_fault(fault: u8) -> bool {
    TEST_FAULT.with(|slot| {
        if slot.get() == fault {
            slot.set(0);
            true
        } else {
            false
        }
    })
}

#[cfg(test)]
fn test_fault_is(fault: u8) -> bool {
    TEST_FAULT.with(|slot| slot.get() == fault)
}

#[cfg(test)]
fn retain_competing_lock(directory: &WindowsPrivateDirectory) -> Result<(), WindowsStoreError> {
    let path = directory.core.path.path.join(JOURNAL_LOCK_ENTRY);
    let competing =
        open_file_nofollow(&path, true, false, true).map_err(|_| WindowsStoreError::Lost)?;
    if try_lock_exclusive(competing.as_handle()).map_err(map_win)? != LockAttempt::Acquired {
        return Err(WindowsStoreError::Lost);
    }
    TEST_COMPETING_LOCK.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_some() {
            return Err(WindowsStoreError::Lost);
        }
        *slot = Some(competing);
        Ok(())
    })
}

#[cfg(test)]
fn take_competing_lock() -> File {
    TEST_COMPETING_LOCK.with(|slot| {
        slot.borrow_mut()
            .take()
            .expect("competing journal lock must be retained")
    })
}

#[cfg(test)]
fn install_test_recheck_race(directory: &DirectoryCore) -> Result<(), WindowsStoreError> {
    attest_journal_directory(directory)?;
    let path = directory.path.path.join(JOURNAL_ENTRY);
    let file = match create_private_file(
        &path,
        &directory.process,
        GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER | DELETE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    )
    .map_err(map_win)?
    {
        FileCreateAttempt::Created(file) => file,
        FileCreateAttempt::Conflict => return Err(WindowsStoreError::Lost),
    };
    write_all_at(&file, b"raced-journal", 0)?;
    file.set_len(b"raced-journal".len() as u64)
        .map_err(|_| WindowsStoreError::Io)?;
    flush_file(file.as_handle()).map_err(map_win)?;
    let (attestation, mut bytes) =
        stable_journal_file(directory, OsStr::new(JOURNAL_ENTRY), &file)?;
    let exact =
        attestation.security.size == b"raced-journal".len() as u64 && bytes == b"raced-journal";
    zeroize_bytes(bytes.as_mut_slice());
    if exact {
        Ok(())
    } else {
        Err(WindowsStoreError::Lost)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct JournalFileAttestation {
    security: FileSecurityAttestation,
    revision: [u8; 32],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum JournalExpectedState {
    Missing,
    Present(JournalFileAttestation),
}

struct JournalRevisionScope {
    lease: Weak<JournalLeaseCore>,
    generation: u64,
    directory_identity: ObjectIdentity,
    state: JournalExpectedState,
}

pub(crate) struct JournalRevision {
    scope: JournalRevisionScope,
    claimed: AtomicBool,
}

impl JournalRevision {
    fn new(
        lease: &Arc<JournalLeaseCore>,
        generation: u64,
        directory_identity: ObjectIdentity,
        state: JournalExpectedState,
    ) -> Self {
        Self {
            scope: JournalRevisionScope {
                lease: Arc::downgrade(lease),
                generation,
                directory_identity,
                state,
            },
            claimed: AtomicBool::new(false),
        }
    }

    fn claim(&self) -> bool {
        self.claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

pub(crate) enum JournalObservation {
    Missing {
        revision: JournalRevision,
    },
    Present {
        revision: JournalRevision,
        bytes: Vec<u8>,
    },
}

pub(crate) enum JournalReplaceResult {
    Replaced { revision: JournalRevision },
    Conflict,
}

pub(crate) enum JournalRemoveResult {
    Removed,
    Conflict,
}

pub(crate) enum ReconciliationJournalLeaseAcquireResult {
    Busy,
    Acquired {
        prior: PriorLease,
        lease: WindowsReconciliationJournalLease,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum JournalLockRecordState {
    Uninitialized,
    Clean,
    Held(ValidatedUuidV4),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum JournalLeaseStatus {
    Held,
    Lost,
    Terminal,
}

struct JournalLeaseRuntime {
    status: JournalLeaseStatus,
    generation: u64,
    directory: Option<WindowsPrivateDirectory>,
    lock: Option<File>,
}

struct JournalLeaseCore {
    nonce: ValidatedUuidV4,
    runtime: Mutex<JournalLeaseRuntime>,
}

pub(crate) struct WindowsReconciliationJournalLease {
    core: Arc<JournalLeaseCore>,
}

enum CurrentJournal {
    Missing,
    Present {
        file: File,
        attestation: JournalFileAttestation,
        bytes: Vec<u8>,
    },
}

struct WipedBytes(Vec<u8>);

impl WipedBytes {
    fn as_slice(&self) -> &[u8] {
        self.0.as_slice()
    }

    fn as_mut_slice(&mut self) -> &mut [u8] {
        self.0.as_mut_slice()
    }
}

impl Drop for WipedBytes {
    fn drop(&mut self) {
        zeroize_bytes(self.0.as_mut_slice());
    }
}

fn candidate_name(nonce: ValidatedUuidV4) -> OsString {
    let value = std::str::from_utf8(&nonce.0).expect("validated UUIDv4 bytes are always ASCII");
    OsString::from(format!(
        "{JOURNAL_CANDIDATE_PREFIX}{value}{JOURNAL_CANDIDATE_SUFFIX}"
    ))
}

fn candidate_nonce(name: &OsStr) -> Option<ValidatedUuidV4> {
    let value = name.to_str()?;
    let expected_length =
        JOURNAL_CANDIDATE_PREFIX.len() + LOCK_NONCE_LENGTH + JOURNAL_CANDIDATE_SUFFIX.len();
    if value.len() != expected_length
        || !value.starts_with(JOURNAL_CANDIDATE_PREFIX)
        || !value.ends_with(JOURNAL_CANDIDATE_SUFFIX)
    {
        return None;
    }
    let nonce =
        &value[JOURNAL_CANDIDATE_PREFIX.len()..JOURNAL_CANDIDATE_PREFIX.len() + LOCK_NONCE_LENGTH];
    ValidatedUuidV4::parse(nonce).ok()
}

fn journal_lock_runtime(
    core: &JournalLeaseCore,
) -> Result<MutexGuard<'_, JournalLeaseRuntime>, WindowsStoreError> {
    match core.runtime.lock() {
        Ok(runtime) => Ok(runtime),
        Err(poisoned) => {
            let mut runtime = poisoned.into_inner();
            if runtime.status == JournalLeaseStatus::Terminal {
                Err(WindowsStoreError::Closed)
            } else {
                runtime.status = JournalLeaseStatus::Lost;
                Err(WindowsStoreError::Lost)
            }
        }
    }
}

fn journal_mark_lost(runtime: &mut JournalLeaseRuntime) {
    if runtime.status != JournalLeaseStatus::Terminal {
        runtime.status = JournalLeaseStatus::Lost;
    }
}

macro_rules! journal_lost_try {
    ($runtime:expr, $operation:expr) => {
        match $operation {
            Ok(value) => value,
            Err(_) => {
                journal_mark_lost($runtime);
                return Err(WindowsStoreError::Lost);
            }
        }
    };
}

fn journal_next_generation(runtime: &mut JournalLeaseRuntime) -> Result<u64, WindowsStoreError> {
    let generation = runtime
        .generation
        .checked_add(1)
        .ok_or(WindowsStoreError::Lost)?;
    runtime.generation = generation;
    Ok(generation)
}

fn journal_entry_is_missing(
    directory: &DirectoryCore,
    name: &OsStr,
) -> Result<bool, WindowsStoreError> {
    let path = directory.path.path.join(name);
    match open_file_nofollow(&path, false, false, false) {
        Ok(_) => Ok(false),
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
            ) =>
        {
            Ok(true)
        }
        Err(_) => Err(WindowsStoreError::Io),
    }
}

fn attest_journal_directory(
    directory: &DirectoryCore,
) -> Result<DirectoryAttestation, WindowsStoreError> {
    let state = lock_unpoisoned(&directory.state)?;
    directory.attest_locked(&state)
}

fn stable_journal_file(
    directory: &DirectoryCore,
    entry_name: &OsStr,
    file: &File,
) -> Result<(JournalFileAttestation, Vec<u8>), WindowsStoreError> {
    if !is_single_entry_name(entry_name) {
        return Err(WindowsStoreError::InvalidInput);
    }
    let state = lock_unpoisoned(&directory.state)?;
    directory
        .process
        .verify()
        .map_err(|_| WindowsStoreError::Lost)?;
    let parent_before = directory.require_secure_locked(&state)?;
    let before = metadata(file)?;
    let security_before = attest_security(file.as_handle(), &directory.process, SecurityKind::File)
        .map_err(map_win)?;
    if !before.exact_file()
        || before.identity.volume != parent_before.identity.volume
        || !security_before.owner_current
        || !security_before.exact_protected_dacl
        || !security_before.semantic_medium_label
    {
        return Err(WindowsStoreError::Unsafe);
    }
    if before.size > MAX_JOURNAL_BYTES as u64 {
        return Err(WindowsStoreError::Limit);
    }

    let current_path = directory.path.path.join(entry_name);
    let rebound = open_file_nofollow(&current_path, false, false, false)
        .map_err(|_| WindowsStoreError::Lost)?;
    if metadata(&rebound)?.identity != before.identity {
        return Err(WindowsStoreError::Lost);
    }

    let expected_size = usize::try_from(before.size).map_err(|_| WindowsStoreError::Limit)?;
    let mut bytes = read_exact_at(file, expected_size)?;
    let verified = (|| {
        let parent_after = directory.require_secure_locked(&state)?;
        let after = metadata(file)?;
        let security_after =
            attest_security(file.as_handle(), &directory.process, SecurityKind::File)
                .map_err(map_win)?;
        let rebound_after = metadata(&rebound)?;
        if parent_before.identity != parent_after.identity
            || before != after
            || security_before != security_after
            || rebound_after.identity != before.identity
        {
            return Err(WindowsStoreError::Lost);
        }
        let security = FileSecurityAttestation {
            identity: after.identity,
            parent_identity: parent_after.identity,
            canonical_current: true,
            current_user: security_after.owner_current,
            private_mode: after.exact_file()
                && security_after.exact_protected_dacl
                && security_after.semantic_medium_label,
            links: after.links,
            size: after.size,
        };
        if !security.is_secure() {
            return Err(WindowsStoreError::Unsafe);
        }
        Ok(JournalFileAttestation {
            security,
            revision: digest_metadata(
                b"plurum-windows-host-reconciliation-revision-v1\0",
                after,
                true,
                Some(parent_after.identity),
                &security_after.descriptor,
                &bytes,
            ),
        })
    })();
    match verified {
        Ok(attestation) => Ok((attestation, bytes)),
        Err(error) => {
            zeroize_bytes(bytes.as_mut_slice());
            Err(error)
        }
    }
}

fn current_journal(directory: &DirectoryCore) -> Result<CurrentJournal, WindowsStoreError> {
    let path = directory.path.path.join(JOURNAL_ENTRY);
    let file = match open_file_nofollow(&path, false, true, false) {
        Ok(file) => file,
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
            ) =>
        {
            let state = lock_unpoisoned(&directory.state)?;
            directory.require_secure_locked(&state)?;
            return Ok(CurrentJournal::Missing);
        }
        Err(_) => return Err(WindowsStoreError::Unsafe),
    };
    let (attestation, bytes) = stable_journal_file(directory, OsStr::new(JOURNAL_ENTRY), &file)?;
    Ok(CurrentJournal::Present {
        file,
        attestation,
        bytes,
    })
}

fn wipe_current(current: &mut CurrentJournal) {
    if let CurrentJournal::Present { bytes, .. } = current {
        zeroize_bytes(bytes.as_mut_slice());
    }
}

fn expected_matches(expected: JournalExpectedState, current: &CurrentJournal) -> bool {
    match (expected, current) {
        (JournalExpectedState::Missing, CurrentJournal::Missing) => true,
        (JournalExpectedState::Present(expected), CurrentJournal::Present { attestation, .. }) => {
            expected == *attestation
        }
        _ => false,
    }
}

fn claim_expected(
    lease: &Arc<JournalLeaseCore>,
    runtime: &JournalLeaseRuntime,
    directory: DirectoryAttestation,
    expected: &JournalRevision,
) -> Option<JournalExpectedState> {
    if !expected.claim() {
        return None;
    }
    let scope = &expected.scope;
    if scope.generation != runtime.generation
        || scope.directory_identity != directory.identity
        || !scope
            .lease
            .upgrade()
            .is_some_and(|snapshot_lease| Arc::ptr_eq(&snapshot_lease, lease))
    {
        return None;
    }
    Some(scope.state)
}

fn secure_journal_lock_object(
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
    Ok(facts.exact_file()
        && facts.size <= JOURNAL_LOCK_RECORD_LENGTH as u64
        && security.owner_current
        && security.exact_protected_dacl
        && security.semantic_medium_label)
}

fn exact_journal_lock(
    directory: &WindowsPrivateDirectory,
    file: &File,
) -> Result<bool, WindowsStoreError> {
    let facts = metadata(file)?;
    if !secure_journal_lock_object(directory, file, facts)? {
        return Ok(false);
    }
    let path = directory.core.path.path.join(JOURNAL_LOCK_ENTRY);
    Ok(open_file_nofollow(&path, true, false, true)
        .ok()
        .and_then(|current| metadata(&current).ok())
        .is_some_and(|current| current.identity == facts.identity && current.exact_file()))
}

fn recoverable_uninitialized_journal_lock_record(bytes: &[u8]) -> bool {
    if bytes.len() != JOURNAL_LOCK_RECORD_LENGTH || bytes[0] != JOURNAL_LOCK_STATE_UNINITIALIZED {
        return false;
    }
    let header = &bytes[JOURNAL_LOCK_HEADER_START..JOURNAL_LOCK_HEADER_END];
    let initialized_prefix = header
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(header.len());
    header[..initialized_prefix] == JOURNAL_LOCK_HEADER[..initialized_prefix]
        && header[initialized_prefix..].iter().all(|byte| *byte == 0)
        && bytes[JOURNAL_LOCK_HEADER_END..]
            .iter()
            .all(|byte| *byte == 0)
}

fn read_journal_lock_record(file: &File) -> Result<JournalLockRecordState, WindowsStoreError> {
    let facts = metadata(file)?;
    if facts.size == 0 {
        return Ok(JournalLockRecordState::Uninitialized);
    }
    if facts.size != JOURNAL_LOCK_RECORD_LENGTH as u64 {
        return Err(WindowsStoreError::Unsafe);
    }
    let bytes = read_exact_at(file, JOURNAL_LOCK_RECORD_LENGTH)?;
    if bytes[0] == JOURNAL_LOCK_STATE_UNINITIALIZED {
        return if recoverable_uninitialized_journal_lock_record(&bytes) {
            Ok(JournalLockRecordState::Uninitialized)
        } else {
            Err(WindowsStoreError::Unsafe)
        };
    }
    if bytes[JOURNAL_LOCK_HEADER_END..JOURNAL_LOCK_NONCE_START]
        .iter()
        .any(|byte| *byte != 0)
        || bytes[JOURNAL_LOCK_NONCE_END..]
            .iter()
            .any(|byte| *byte != 0)
    {
        return Err(WindowsStoreError::Unsafe);
    }
    if &bytes[JOURNAL_LOCK_HEADER_START..JOURNAL_LOCK_HEADER_END] != JOURNAL_LOCK_HEADER {
        return Err(WindowsStoreError::Unsafe);
    }
    match bytes[0] {
        JOURNAL_LOCK_STATE_CLEAN => {
            let nonce = &bytes[JOURNAL_LOCK_NONCE_START..JOURNAL_LOCK_NONCE_END];
            if nonce.iter().all(|byte| *byte == 0)
                || std::str::from_utf8(nonce)
                    .ok()
                    .and_then(|value| ValidatedUuidV4::parse(value).ok())
                    .is_some()
            {
                Ok(JournalLockRecordState::Clean)
            } else {
                Err(WindowsStoreError::Unsafe)
            }
        }
        JOURNAL_LOCK_STATE_HELD => {
            let nonce =
                std::str::from_utf8(&bytes[JOURNAL_LOCK_NONCE_START..JOURNAL_LOCK_NONCE_END])
                    .map_err(|_| WindowsStoreError::Unsafe)
                    .and_then(ValidatedUuidV4::parse)?;
            Ok(JournalLockRecordState::Held(nonce))
        }
        _ => Err(WindowsStoreError::Unsafe),
    }
}

fn write_journal_lock_state(file: &File, state: u8) -> Result<(), WindowsStoreError> {
    write_all_at(file, &[state], 0)?;
    flush_file(file.as_handle()).map_err(map_win)
}

fn initialize_journal_lock_record(file: &File) -> Result<(), WindowsStoreError> {
    if metadata(file)?.size != 0 {
        write_journal_lock_state(file, JOURNAL_LOCK_STATE_UNINITIALIZED)?;
    }
    file.set_len(JOURNAL_LOCK_RECORD_LENGTH as u64)
        .map_err(|_| WindowsStoreError::Io)?;
    let mut tail = [0_u8; JOURNAL_LOCK_RECORD_LENGTH - 1];
    tail[JOURNAL_LOCK_HEADER_START - 1..JOURNAL_LOCK_HEADER_END - 1]
        .copy_from_slice(JOURNAL_LOCK_HEADER);
    write_all_at(file, &tail, 1)?;
    flush_file(file.as_handle()).map_err(map_win)?;
    #[cfg(test)]
    if take_test_fault(TEST_FAULT_LOCK_INITIALIZE_AFTER_TAIL) {
        return Err(WindowsStoreError::Io);
    }
    write_journal_lock_state(file, JOURNAL_LOCK_STATE_CLEAN)?;
    #[cfg(test)]
    if take_test_fault(TEST_FAULT_LOCK_INITIALIZE_AFTER_CLEAN) {
        return Err(WindowsStoreError::Io);
    }
    if read_journal_lock_record(file)? == JournalLockRecordState::Clean {
        Ok(())
    } else {
        Err(WindowsStoreError::Lost)
    }
}

fn write_held_journal_lock(file: &File, nonce: ValidatedUuidV4) -> Result<(), WindowsStoreError> {
    if read_journal_lock_record(file)? != JournalLockRecordState::Clean {
        return Err(WindowsStoreError::Lost);
    }
    write_all_at(file, &nonce.0, JOURNAL_LOCK_NONCE_START as u64)?;
    flush_file(file.as_handle()).map_err(map_win)?;
    #[cfg(test)]
    if take_test_fault(TEST_FAULT_LOCK_HELD_AFTER_NONCE) {
        return Err(WindowsStoreError::Io);
    }
    write_journal_lock_state(file, JOURNAL_LOCK_STATE_HELD)?;
    #[cfg(test)]
    if take_test_fault(TEST_FAULT_LOCK_HELD_AFTER_STATE) {
        return Err(WindowsStoreError::Io);
    }
    if read_journal_lock_record(file)? == JournalLockRecordState::Held(nonce) {
        Ok(())
    } else {
        Err(WindowsStoreError::Lost)
    }
}

fn restore_held_journal_lock(file: &File, nonce: ValidatedUuidV4) -> Result<(), WindowsStoreError> {
    write_all_at(file, &nonce.0, JOURNAL_LOCK_NONCE_START as u64)?;
    flush_file(file.as_handle()).map_err(map_win)?;
    write_journal_lock_state(file, JOURNAL_LOCK_STATE_HELD)?;
    if read_journal_lock_record(file)? == JournalLockRecordState::Held(nonce) {
        Ok(())
    } else {
        Err(WindowsStoreError::Lost)
    }
}

fn open_or_create_journal_lock(
    directory: &WindowsPrivateDirectory,
) -> Result<(File, bool), WindowsStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let path = directory.core.path.path.join(JOURNAL_LOCK_ENTRY);
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
    Ok((file, created))
}

fn release_uncommitted_journal_lock(lock: File) -> Result<(), WindowsStoreError> {
    let result = unlock(lock.as_handle()).map_err(map_win);
    drop(lock);
    result
}

fn list_journal_candidates(
    directory: &WindowsPrivateDirectory,
) -> Result<Vec<ValidatedUuidV4>, WindowsStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let mut count = 0_usize;
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(&directory.core.path.path).map_err(|_| WindowsStoreError::Io)? {
        let entry = entry.map_err(|_| WindowsStoreError::Io)?;
        count = count.checked_add(1).ok_or(WindowsStoreError::Limit)?;
        if count > MAX_DIRECTORY_ENTRIES {
            return Err(WindowsStoreError::Limit);
        }
        if let Some(nonce) = candidate_nonce(&entry.file_name()) {
            candidates.push(nonce);
        }
    }
    directory.core.require_secure_locked(&state)?;
    candidates.sort_by_key(|nonce| nonce.0);
    Ok(candidates)
}

fn remove_exact_candidate(
    directory: &WindowsPrivateDirectory,
    nonce: ValidatedUuidV4,
) -> Result<(), WindowsStoreError> {
    let name = candidate_name(nonce);
    let path = directory.core.path.path.join(&name);
    let file =
        open_file_nofollow(&path, false, true, false).map_err(|_| WindowsStoreError::Unsafe)?;
    let (attestation, mut bytes) = stable_journal_file(&directory.core, &name, &file)?;
    zeroize_bytes(bytes.as_mut_slice());
    let expected_identity = attestation.security.identity;
    let rebound =
        open_file_nofollow(&path, false, false, false).map_err(|_| WindowsStoreError::Lost)?;
    if metadata(&rebound)?.identity != expected_identity {
        return Err(WindowsStoreError::Lost);
    }
    #[cfg(test)]
    if take_test_fault(TEST_FAULT_RECOVERY_BEFORE_REMOVE) {
        return Err(WindowsStoreError::Lost);
    }
    match remove_by_handle(file.as_handle()).map_err(map_win)? {
        MutationAttempt::Applied => {}
        MutationAttempt::Conflict => return Err(WindowsStoreError::Lost),
        MutationAttempt::Unsupported => return Err(WindowsStoreError::Unsupported),
    }
    #[cfg(test)]
    if take_test_fault(TEST_FAULT_RECOVERY_AFTER_REMOVE) {
        return Err(WindowsStoreError::Lost);
    }
    drop(file);
    let retained = metadata(&rebound)?;
    if retained.identity != expected_identity
        || retained.kind != ObjectKind::RegularFile
        || retained.links != 0
        || retained.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || !journal_entry_is_missing(&directory.core, &name)?
    {
        return Err(WindowsStoreError::Lost);
    }
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    Ok(())
}

fn recover_journal_candidates(
    directory: &WindowsPrivateDirectory,
    prior: JournalLockRecordState,
) -> Result<(), WindowsStoreError> {
    let candidates = list_journal_candidates(directory)?;
    match prior {
        JournalLockRecordState::Held(old_nonce) => {
            if candidates.iter().any(|nonce| *nonce != old_nonce) || candidates.len() > 1 {
                return Err(WindowsStoreError::Unsafe);
            }
            if candidates.first().is_some_and(|nonce| *nonce == old_nonce) {
                remove_exact_candidate(directory, old_nonce)?;
            }
        }
        JournalLockRecordState::Uninitialized | JournalLockRecordState::Clean => {
            if !candidates.is_empty() {
                return Err(WindowsStoreError::Unsafe);
            }
        }
    }
    if list_journal_candidates(directory)?.is_empty() {
        Ok(())
    } else {
        Err(WindowsStoreError::Lost)
    }
}

fn remove_candidate_after_conflict(
    directory: &DirectoryCore,
    file: File,
    identity: ObjectIdentity,
    nonce: ValidatedUuidV4,
) -> Result<(), WindowsStoreError> {
    let name = candidate_name(nonce);
    let path = directory.path.path.join(&name);
    let (attestation, mut bytes) = stable_journal_file(directory, &name, &file)?;
    zeroize_bytes(bytes.as_mut_slice());
    if attestation.security.identity != identity {
        return Err(WindowsStoreError::Lost);
    }
    let rebound =
        open_file_nofollow(&path, false, false, false).map_err(|_| WindowsStoreError::Lost)?;
    if metadata(&rebound)?.identity != identity {
        return Err(WindowsStoreError::Lost);
    }
    #[cfg(test)]
    if take_test_fault(TEST_FAULT_CONFLICT_CLEANUP_BEFORE_REMOVE) {
        return Err(WindowsStoreError::Io);
    }
    match remove_by_handle(file.as_handle()).map_err(map_win)? {
        MutationAttempt::Applied => {}
        MutationAttempt::Conflict => return Err(WindowsStoreError::Lost),
        MutationAttempt::Unsupported => return Err(WindowsStoreError::Unsupported),
    }
    #[cfg(test)]
    if take_test_fault(TEST_FAULT_CONFLICT_CLEANUP_AFTER_REMOVE) {
        return Err(WindowsStoreError::Io);
    }
    drop(file);
    let retained = metadata(&rebound)?;
    if retained.identity == identity
        && retained.kind == ObjectKind::RegularFile
        && retained.links == 0
        && retained.attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
        && journal_entry_is_missing(directory, &name)?
    {
        Ok(())
    } else {
        Err(WindowsStoreError::Lost)
    }
}

impl JournalLeaseCore {
    fn verify_held_locked(&self, runtime: &JournalLeaseRuntime) -> Result<(), WindowsStoreError> {
        match runtime.status {
            JournalLeaseStatus::Held => {}
            JournalLeaseStatus::Lost => return Err(WindowsStoreError::Lost),
            JournalLeaseStatus::Terminal => return Err(WindowsStoreError::Closed),
        }
        let directory = runtime
            .directory
            .as_ref()
            .ok_or(WindowsStoreError::Closed)?;
        let lock = runtime.lock.as_ref().ok_or(WindowsStoreError::Closed)?;
        if !exact_journal_lock(directory, lock)?
            || read_journal_lock_record(lock)? != JournalLockRecordState::Held(self.nonce)
        {
            return Err(WindowsStoreError::Lost);
        }
        Ok(())
    }

    fn verify_or_latch_locked(
        &self,
        runtime: &mut JournalLeaseRuntime,
    ) -> Result<(), WindowsStoreError> {
        if let Err(error) = self.verify_held_locked(runtime) {
            if runtime.status != JournalLeaseStatus::Terminal {
                runtime.status = JournalLeaseStatus::Lost;
            }
            return Err(error);
        }
        Ok(())
    }

    fn finish_locked(
        runtime: &mut JournalLeaseRuntime,
        explicit_unlock: bool,
    ) -> Result<(), WindowsStoreError> {
        runtime.status = JournalLeaseStatus::Terminal;
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

pub(crate) fn acquire_reconciliation_journal_lease(
    path: &Path,
    nonce: &str,
) -> Result<ReconciliationJournalLeaseAcquireResult, WindowsStoreError> {
    let nonce = ValidatedUuidV4::parse(nonce)?;
    let directory = match open_private_directory(path)? {
        PrivateDirectoryOpenResult::Missing => return Err(WindowsStoreError::Missing),
        PrivateDirectoryOpenResult::Opened(directory) => directory,
    };
    let (lock, _lock_created) = open_or_create_journal_lock(&directory)?;
    if !exact_journal_lock(&directory, &lock)? {
        return Err(WindowsStoreError::Unsafe);
    }
    #[cfg(test)]
    if take_test_fault(TEST_FAULT_ACQUIRE_BUSY_AFTER_LOCK_CREATION) {
        if !_lock_created {
            return Err(WindowsStoreError::Lost);
        }
        retain_competing_lock(&directory)?;
    }
    match try_lock_exclusive(lock.as_handle()).map_err(map_win) {
        Ok(LockAttempt::Acquired) => {}
        Ok(LockAttempt::Busy) => {
            // Another process may have opened and locked a file this process just created.
            // Unlinking it here would split the lock namespace.
            drop(lock);
            return Ok(ReconciliationJournalLeaseAcquireResult::Busy);
        }
        Err(error) => {
            drop(lock);
            return Err(error);
        }
    }
    if !exact_journal_lock(&directory, &lock)? {
        release_uncommitted_journal_lock(lock)?;
        return Err(WindowsStoreError::Unsafe);
    }

    let record = match read_journal_lock_record(&lock) {
        Ok(record) => record,
        Err(error) => {
            release_uncommitted_journal_lock(lock)?;
            return Err(error);
        }
    };
    if let Err(error) = recover_journal_candidates(&directory, record) {
        release_uncommitted_journal_lock(lock)?;
        return Err(error);
    }
    let prior = match record {
        JournalLockRecordState::Uninitialized => {
            initialize_journal_lock_record(&lock)?;
            PriorLease::Absent
        }
        JournalLockRecordState::Clean => PriorLease::Absent,
        JournalLockRecordState::Held(_) => {
            write_journal_lock_state(&lock, JOURNAL_LOCK_STATE_CLEAN)?;
            PriorLease::ProvenAbandoned
        }
    };
    if let Err(error) = write_held_journal_lock(&lock, nonce) {
        let _ = release_uncommitted_journal_lock(lock);
        return Err(error);
    }
    if !exact_journal_lock(&directory, &lock)?
        || read_journal_lock_record(&lock)? != JournalLockRecordState::Held(nonce)
    {
        let _ = release_uncommitted_journal_lock(lock);
        return Err(WindowsStoreError::Lost);
    }
    Ok(ReconciliationJournalLeaseAcquireResult::Acquired {
        prior,
        lease: WindowsReconciliationJournalLease {
            core: Arc::new(JournalLeaseCore {
                nonce,
                runtime: Mutex::new(JournalLeaseRuntime {
                    status: JournalLeaseStatus::Held,
                    generation: 0,
                    directory: Some(directory),
                    lock: Some(lock),
                }),
            }),
        },
    })
}

impl WindowsReconciliationJournalLease {
    fn verify_held(&self) -> Result<(), WindowsStoreError> {
        let mut runtime = journal_lock_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)
    }

    pub(crate) fn renew(&self) -> LeaseRenewal {
        if self.verify_held().is_ok() {
            LeaseRenewal::Held
        } else {
            LeaseRenewal::Lost
        }
    }

    pub(crate) fn observe(&self) -> Result<JournalObservation, WindowsStoreError> {
        let mut runtime = journal_lock_runtime(&self.core)?;
        if let Err(error) = self.core.verify_held_locked(&runtime) {
            journal_mark_lost(&mut runtime);
            return Err(error);
        }
        let directory = Arc::clone(
            &runtime
                .directory
                .as_ref()
                .ok_or(WindowsStoreError::Closed)?
                .core,
        );
        let directory_attestation = attest_journal_directory(&directory)?;
        let mut current = current_journal(&directory)?;
        #[cfg(test)]
        if take_test_fault(TEST_FAULT_OBSERVE_AFTER_READ) {
            wipe_current(&mut current);
            return Err(WindowsStoreError::Io);
        }
        if let Err(error) = self.core.verify_held_locked(&runtime) {
            wipe_current(&mut current);
            journal_mark_lost(&mut runtime);
            return Err(error);
        }
        match current {
            CurrentJournal::Missing => Ok(JournalObservation::Missing {
                revision: JournalRevision::new(
                    &self.core,
                    runtime.generation,
                    directory_attestation.identity,
                    JournalExpectedState::Missing,
                ),
            }),
            CurrentJournal::Present {
                attestation, bytes, ..
            } => Ok(JournalObservation::Present {
                revision: JournalRevision::new(
                    &self.core,
                    runtime.generation,
                    directory_attestation.identity,
                    JournalExpectedState::Present(attestation),
                ),
                bytes,
            }),
        }
    }

    pub(crate) fn replace(
        &self,
        expected: &JournalRevision,
        input: &[u8],
    ) -> Result<JournalReplaceResult, WindowsStoreError> {
        if input.is_empty() {
            return Err(WindowsStoreError::InvalidInput);
        }
        if input.len() > MAX_JOURNAL_BYTES {
            return Err(WindowsStoreError::Limit);
        }
        let input_length = u64::try_from(input.len()).map_err(|_| WindowsStoreError::Limit)?;
        let mut owned = WipedBytes(input.to_vec());
        let mut runtime = journal_lock_runtime(&self.core)?;
        if let Err(error) = self.core.verify_held_locked(&runtime) {
            journal_mark_lost(&mut runtime);
            return Err(error);
        }
        let directory = Arc::clone(
            &runtime
                .directory
                .as_ref()
                .ok_or(WindowsStoreError::Closed)?
                .core,
        );
        let directory_attestation = attest_journal_directory(&directory)?;
        let expected_state =
            match claim_expected(&self.core, &runtime, directory_attestation, expected) {
                Some(state) => state,
                None => return Ok(JournalReplaceResult::Conflict),
            };
        let mut current = current_journal(&directory)?;
        let current_matches = expected_matches(expected_state, &current);
        wipe_current(&mut current);
        if !current_matches {
            return Ok(JournalReplaceResult::Conflict);
        }
        drop(current);

        let name = candidate_name(self.core.nonce);
        let candidate_path = directory.path.path.join(&name);
        let candidate = match create_private_file(
            &candidate_path,
            &directory.process,
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        )
        .map_err(map_win)?
        {
            FileCreateAttempt::Created(file) => file,
            FileCreateAttempt::Conflict => {
                journal_mark_lost(&mut runtime);
                return Err(WindowsStoreError::Lost);
            }
        };
        #[cfg(test)]
        if take_test_fault(TEST_FAULT_CANDIDATE_AFTER_CREATE) {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        let candidate_facts = journal_lost_try!(&mut runtime, metadata(&candidate));
        let candidate_security = journal_lost_try!(
            &mut runtime,
            attest_security(
                candidate.as_handle(),
                &directory.process,
                SecurityKind::File,
            )
            .map_err(map_win)
        );
        if !candidate_facts.exact_file()
            || candidate_facts.size != 0
            || !candidate_security.owner_current
            || !candidate_security.exact_protected_dacl
            || !candidate_security.semantic_medium_label
        {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        let rebound = journal_lost_try!(
            &mut runtime,
            open_file_nofollow(&candidate_path, false, false, false)
                .map_err(|_| WindowsStoreError::Lost)
        );
        if journal_lost_try!(&mut runtime, metadata(&rebound)).identity != candidate_facts.identity
        {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        if write_all_at(&candidate, owned.as_slice(), 0).is_err() {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        #[cfg(test)]
        if take_test_fault(TEST_FAULT_CANDIDATE_AFTER_WRITE) {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        if candidate.set_len(input_length).is_err() {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        let (before_flush, mut before_flush_bytes) = journal_lost_try!(
            &mut runtime,
            stable_journal_file(&directory, &name, &candidate)
        );
        let exact_before_flush = before_flush_bytes == owned.as_slice();
        zeroize_bytes(before_flush_bytes.as_mut_slice());
        if !exact_before_flush || before_flush.security.identity != candidate_facts.identity {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        #[cfg(test)]
        if take_test_fault(TEST_FAULT_CANDIDATE_AFTER_READBACK) {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        if flush_file(candidate.as_handle()).map_err(map_win).is_err() {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        #[cfg(test)]
        if take_test_fault(TEST_FAULT_CANDIDATE_AFTER_FLUSH) {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        let (flushed, mut flushed_bytes) = journal_lost_try!(
            &mut runtime,
            stable_journal_file(&directory, &name, &candidate)
        );
        let exact_flushed = flushed_bytes == owned.as_slice();
        zeroize_bytes(flushed_bytes.as_mut_slice());
        if !exact_flushed
            || flushed.security.identity != candidate_facts.identity
            || flushed != before_flush
        {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }

        #[cfg(test)]
        if test_fault_is(TEST_FAULT_CONFLICT_CLEANUP_BEFORE_REMOVE)
            || test_fault_is(TEST_FAULT_CONFLICT_CLEANUP_AFTER_REMOVE)
            || test_fault_is(TEST_RACE_RECHECK_CANONICAL)
        {
            journal_lost_try!(&mut runtime, install_test_recheck_race(&directory));
        }
        #[cfg(test)]
        let _ = take_test_fault(TEST_RACE_RECHECK_CANONICAL);
        #[cfg(test)]
        if take_test_fault(TEST_FAULT_BEFORE_RECHECK) {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        let mut rechecked = journal_lost_try!(&mut runtime, current_journal(&directory));
        let still_matches = expected_matches(expected_state, &rechecked);
        wipe_current(&mut rechecked);
        if !still_matches {
            drop(rechecked);
            journal_lost_try!(
                &mut runtime,
                remove_candidate_after_conflict(
                    &directory,
                    candidate,
                    candidate_facts.identity,
                    self.core.nonce,
                )
            );
            return Ok(JournalReplaceResult::Conflict);
        }
        drop(rechecked);
        if let Err(error) = self.core.verify_held_locked(&runtime) {
            journal_mark_lost(&mut runtime);
            return Err(error);
        }

        // FlushFileBuffers protects the candidate contents before the synchronous by-handle
        // namespace mutation. Windows does not expose a general directory-fsync primitive, so
        // the subsequent identity and namespace re-attestation is a process-crash durability
        // barrier only; this does not claim survival across physical power loss.
        let state = journal_lost_try!(&mut runtime, lock_unpoisoned(&directory.state));
        journal_lost_try!(&mut runtime, directory.require_secure_locked(&state));
        let directory_file = journal_lost_try!(
            &mut runtime,
            state.directory.as_ref().ok_or(WindowsStoreError::Closed)
        );
        let destination: Vec<u16> = OsStr::new(JOURNAL_ENTRY).encode_wide().collect();
        #[cfg(test)]
        if take_test_fault(TEST_FAULT_BEFORE_RENAME) {
            drop(state);
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        let renamed = match rename_by_handle(
            candidate.as_handle(),
            directory_file.as_handle(),
            &destination,
            matches!(expected_state, JournalExpectedState::Present(_)),
        ) {
            Ok(result) => result,
            Err(_) => {
                drop(state);
                journal_mark_lost(&mut runtime);
                return Err(WindowsStoreError::Lost);
            }
        };
        match renamed {
            MutationAttempt::Applied =>
            {
                #[cfg(test)]
                if take_test_fault(TEST_FAULT_AFTER_RENAME) {
                    drop(state);
                    journal_mark_lost(&mut runtime);
                    return Err(WindowsStoreError::Lost);
                }
            }
            MutationAttempt::Conflict => {
                drop(state);
                journal_lost_try!(
                    &mut runtime,
                    remove_candidate_after_conflict(
                        &directory,
                        candidate,
                        candidate_facts.identity,
                        self.core.nonce,
                    )
                );
                return Ok(JournalReplaceResult::Conflict);
            }
            MutationAttempt::Unsupported => {
                drop(state);
                journal_lost_try!(
                    &mut runtime,
                    remove_candidate_after_conflict(
                        &directory,
                        candidate,
                        candidate_facts.identity,
                        self.core.nonce,
                    )
                );
                return Err(WindowsStoreError::Unsupported);
            }
        }
        let source_missing =
            journal_lost_try!(&mut runtime, journal_entry_is_missing(&directory, &name));
        let directory_secure = directory.require_secure_locked(&state).is_ok();
        drop(state);
        if !source_missing || !directory_secure {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }

        let mut post = journal_lost_try!(&mut runtime, current_journal(&directory));
        #[cfg(test)]
        if take_test_fault(TEST_FAULT_POST_RENAME_READBACK) {
            wipe_current(&mut post);
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        let (post_attestation, exact_post) = match &post {
            CurrentJournal::Present {
                attestation, bytes, ..
            } => (
                *attestation,
                attestation.security.identity == candidate_facts.identity
                    && bytes.as_slice() == owned.as_slice(),
            ),
            CurrentJournal::Missing => {
                journal_mark_lost(&mut runtime);
                return Err(WindowsStoreError::Lost);
            }
        };
        wipe_current(&mut post);
        drop(post);
        if !exact_post {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        if let Err(error) = self.core.verify_held_locked(&runtime) {
            journal_mark_lost(&mut runtime);
            return Err(error);
        }
        let directory_identity =
            journal_lost_try!(&mut runtime, attest_journal_directory(&directory)).identity;
        let generation = match journal_next_generation(&mut runtime) {
            Ok(generation) => generation,
            Err(error) => {
                journal_mark_lost(&mut runtime);
                return Err(error);
            }
        };
        zeroize_bytes(owned.as_mut_slice());
        Ok(JournalReplaceResult::Replaced {
            revision: JournalRevision::new(
                &self.core,
                generation,
                directory_identity,
                JournalExpectedState::Present(post_attestation),
            ),
        })
    }

    pub(crate) fn remove(
        &self,
        expected: &JournalRevision,
    ) -> Result<JournalRemoveResult, WindowsStoreError> {
        let mut runtime = journal_lock_runtime(&self.core)?;
        if let Err(error) = self.core.verify_held_locked(&runtime) {
            journal_mark_lost(&mut runtime);
            return Err(error);
        }
        let directory = Arc::clone(
            &runtime
                .directory
                .as_ref()
                .ok_or(WindowsStoreError::Closed)?
                .core,
        );
        let directory_attestation = attest_journal_directory(&directory)?;
        let expected_state =
            match claim_expected(&self.core, &runtime, directory_attestation, expected) {
                Some(state) => state,
                None => return Ok(JournalRemoveResult::Conflict),
            };
        let JournalExpectedState::Present(expected_attestation) = expected_state else {
            return Ok(JournalRemoveResult::Conflict);
        };
        let mut current = current_journal(&directory)?;
        let (file, attestation) = match &mut current {
            CurrentJournal::Missing => return Ok(JournalRemoveResult::Conflict),
            CurrentJournal::Present {
                file,
                attestation,
                bytes,
            } => {
                zeroize_bytes(bytes.as_mut_slice());
                (
                    file.try_clone().map_err(|_| WindowsStoreError::Io)?,
                    *attestation,
                )
            }
        };
        drop(current);
        if attestation != expected_attestation {
            return Ok(JournalRemoveResult::Conflict);
        }
        if let Err(error) = self.core.verify_held_locked(&runtime) {
            journal_mark_lost(&mut runtime);
            return Err(error);
        }
        let (mutation_attestation, mut mutation_bytes) =
            stable_journal_file(&directory, OsStr::new(JOURNAL_ENTRY), &file)?;
        zeroize_bytes(mutation_bytes.as_mut_slice());
        if mutation_attestation != expected_attestation {
            return Ok(JournalRemoveResult::Conflict);
        }
        let state = lock_unpoisoned(&directory.state)?;
        directory.require_secure_locked(&state)?;
        let current_path = directory.path.path.join(JOURNAL_ENTRY);
        let rebound = open_file_nofollow(&current_path, false, false, false)
            .map_err(|_| WindowsStoreError::Lost)?;
        let mutation_facts = metadata(&file)?;
        let mutation_security =
            attest_security(file.as_handle(), &directory.process, SecurityKind::File)
                .map_err(map_win)?;
        if !mutation_facts.exact_file()
            || mutation_facts.identity != expected_attestation.security.identity
            || metadata(&rebound)?.identity != expected_attestation.security.identity
            || !mutation_security.owner_current
            || !mutation_security.exact_protected_dacl
            || !mutation_security.semantic_medium_label
        {
            return Ok(JournalRemoveResult::Conflict);
        }
        #[cfg(test)]
        if take_test_fault(TEST_FAULT_REMOVE_BEFORE_DELETE) {
            drop(state);
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        let removed = match remove_by_handle(file.as_handle()) {
            Ok(result) => result,
            Err(_) => {
                drop(state);
                journal_mark_lost(&mut runtime);
                return Err(WindowsStoreError::Lost);
            }
        };
        match removed {
            MutationAttempt::Applied =>
            {
                #[cfg(test)]
                if take_test_fault(TEST_FAULT_REMOVE_AFTER_DELETE) {
                    drop(state);
                    journal_mark_lost(&mut runtime);
                    return Err(WindowsStoreError::Lost);
                }
            }
            MutationAttempt::Conflict => return Ok(JournalRemoveResult::Conflict),
            MutationAttempt::Unsupported => return Err(WindowsStoreError::Unsupported),
        }
        drop(file);
        let missing = journal_lost_try!(
            &mut runtime,
            journal_entry_is_missing(&directory, OsStr::new(JOURNAL_ENTRY))
        );
        let retained = journal_lost_try!(&mut runtime, metadata(&rebound));
        let proof_current = retained.identity == expected_attestation.security.identity
            && retained.kind == ObjectKind::RegularFile
            && retained.links == 0
            && retained.attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0;
        let directory_secure = directory.require_secure_locked(&state).is_ok();
        drop(state);
        if !missing || !proof_current || !directory_secure {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        if let Err(error) = self.core.verify_held_locked(&runtime) {
            journal_mark_lost(&mut runtime);
            return Err(error);
        }
        if journal_next_generation(&mut runtime).is_err() {
            journal_mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        Ok(JournalRemoveResult::Removed)
    }

    pub(crate) fn release(&mut self) -> Result<(), WindowsStoreError> {
        let (mut runtime, poisoned) = match self.core.runtime.lock() {
            Ok(runtime) => (runtime, false),
            Err(poisoned) => (poisoned.into_inner(), true),
        };
        if runtime.status == JournalLeaseStatus::Terminal {
            return Err(WindowsStoreError::Closed);
        }
        if poisoned {
            runtime.status = JournalLeaseStatus::Lost;
            let _ = JournalLeaseCore::finish_locked(&mut runtime, false);
            return Err(WindowsStoreError::Lost);
        }
        let mut clean_started = false;
        let result = (|| {
            self.core.verify_or_latch_locked(&mut runtime)?;
            if !list_journal_candidates(
                runtime
                    .directory
                    .as_ref()
                    .ok_or(WindowsStoreError::Closed)?,
            )?
            .is_empty()
            {
                return Err(WindowsStoreError::Lost);
            }
            #[cfg(test)]
            if take_test_fault(TEST_FAULT_RELEASE_BEFORE_CLEAN) {
                return Err(WindowsStoreError::Lost);
            }
            let lock = runtime.lock.as_ref().ok_or(WindowsStoreError::Closed)?;
            clean_started = true;
            write_journal_lock_state(lock, JOURNAL_LOCK_STATE_CLEAN)?;
            #[cfg(test)]
            if take_test_fault(TEST_FAULT_RELEASE_AFTER_CLEAN) {
                return Err(WindowsStoreError::Lost);
            }
            if read_journal_lock_record(lock)? != JournalLockRecordState::Clean {
                return Err(WindowsStoreError::Lost);
            }
            Ok(())
        })();
        if result.is_err() {
            if clean_started {
                if let Some(lock) = runtime.lock.as_ref() {
                    let _ = restore_held_journal_lock(lock, self.core.nonce);
                }
            }
            runtime.status = JournalLeaseStatus::Lost;
        }
        let unlock_result = JournalLeaseCore::finish_locked(&mut runtime, result.is_ok());
        result.and(unlock_result)
    }

    pub(crate) fn abandon(&mut self) -> Result<(), WindowsStoreError> {
        let (mut runtime, poisoned) = match self.core.runtime.lock() {
            Ok(runtime) => (runtime, false),
            Err(poisoned) => (poisoned.into_inner(), true),
        };
        if runtime.status == JournalLeaseStatus::Terminal {
            return Err(WindowsStoreError::Closed);
        }
        let result = JournalLeaseCore::finish_locked(&mut runtime, !poisoned);
        if poisoned {
            Err(WindowsStoreError::Lost)
        } else {
            result
        }
    }
}

impl Drop for WindowsReconciliationJournalLease {
    fn drop(&mut self) {
        let mut runtime = match self.core.runtime.lock() {
            Ok(runtime) => runtime,
            Err(poisoned) => poisoned.into_inner(),
        };
        if runtime.status != JournalLeaseStatus::Terminal {
            let _ = JournalLeaseCore::finish_locked(&mut runtime, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{acquired_lease, TestRoot};
    use super::*;

    const NONCE_1: &str = "b56c52f5-a090-41eb-a164-1c92e36db94f";
    const NONCE_2: &str = "4657f2a0-739f-4923-86e8-f25f1dc328f9";

    fn ready_store() -> TestRoot {
        let test = TestRoot::new();
        let (_, _, mut setup) = acquired_lease(&test.store, NONCE_1);
        setup.release().expect("setup lease must release");
        test
    }

    fn acquire(path: &Path, nonce: &str) -> (PriorLease, WindowsReconciliationJournalLease) {
        match acquire_reconciliation_journal_lease(path, nonce)
            .expect("journal lease acquisition must complete")
        {
            ReconciliationJournalLeaseAcquireResult::Busy => {
                panic!("journal lease unexpectedly busy")
            }
            ReconciliationJournalLeaseAcquireResult::Acquired { prior, lease } => (prior, lease),
        }
    }

    fn create_private_test_file(path: &Path) -> File {
        let process = ProcessIdentity::capture().expect("test process identity must attest");
        match create_private_file(
            path,
            &process,
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        )
        .expect("private test file creation must complete")
        {
            FileCreateAttempt::Created(file) => file,
            FileCreateAttempt::Conflict => panic!("private test file unexpectedly exists"),
        }
    }

    fn write_test_bytes(file: &File, bytes: &[u8]) {
        write_all_at(file, bytes, 0).expect("test bytes must write");
        file.set_len(u64::try_from(bytes.len()).expect("test length must fit"))
            .expect("test file must truncate");
        flush_file(file.as_handle()).expect("test file must flush");
    }

    fn missing(lease: &WindowsReconciliationJournalLease) -> JournalRevision {
        match lease.observe().expect("missing journal must observe") {
            JournalObservation::Missing { revision } => revision,
            JournalObservation::Present { .. } => panic!("journal unexpectedly exists"),
        }
    }

    fn present(lease: &WindowsReconciliationJournalLease) -> (JournalRevision, Vec<u8>) {
        match lease.observe().expect("present journal must observe") {
            JournalObservation::Missing { .. } => panic!("journal unexpectedly missing"),
            JournalObservation::Present { revision, bytes } => (revision, bytes),
        }
    }

    fn replace(
        lease: &WindowsReconciliationJournalLease,
        expected: &JournalRevision,
        bytes: &[u8],
    ) -> JournalRevision {
        match lease
            .replace(expected, bytes)
            .expect("journal replacement must complete")
        {
            JournalReplaceResult::Conflict => panic!("journal replacement unexpectedly conflicts"),
            JournalReplaceResult::Replaced { revision } => revision,
        }
    }

    fn acquire_error(path: &Path, nonce: &str) -> WindowsStoreError {
        match acquire_reconciliation_journal_lease(path, nonce) {
            Err(error) => error,
            Ok(ReconciliationJournalLeaseAcquireResult::Busy) => {
                panic!("journal acquisition unexpectedly reported contention")
            }
            Ok(ReconciliationJournalLeaseAcquireResult::Acquired { .. }) => {
                panic!("journal acquisition unexpectedly succeeded")
            }
        }
    }

    fn assert_test_fault_consumed() {
        TEST_FAULT.with(|slot| {
            assert_eq!(slot.get(), 0, "journal test fault was not exercised");
        });
    }

    fn assert_journal_and_remove(
        lease: &WindowsReconciliationJournalLease,
        expected: Option<&[u8]>,
    ) {
        match lease.observe().expect("recovered journal must observe") {
            JournalObservation::Missing { .. } => {
                assert!(expected.is_none(), "recovered journal unexpectedly missing");
            }
            JournalObservation::Present { revision, bytes } => {
                assert_eq!(
                    Some(bytes.as_slice()),
                    expected,
                    "recovered journal bytes differ"
                );
                assert!(matches!(
                    lease.remove(&revision),
                    Ok(JournalRemoveResult::Removed)
                ));
            }
        }
    }

    #[test]
    fn journal_requires_an_existing_protected_directory() {
        let test = TestRoot::new();
        assert!(matches!(
            acquire_reconciliation_journal_lease(&test.store, NONCE_1),
            Err(WindowsStoreError::Missing)
        ));
        assert!(!test.store.exists());
    }

    #[test]
    fn journal_lock_only_recovers_exact_partial_initialization_shapes() {
        let test = ready_store();
        let path = test.store.join(JOURNAL_LOCK_ENTRY);
        let file = create_private_test_file(&path);

        let all_zero = [0_u8; JOURNAL_LOCK_RECORD_LENGTH];
        write_test_bytes(&file, &all_zero);
        assert_eq!(
            read_journal_lock_record(&file),
            Ok(JournalLockRecordState::Uninitialized)
        );

        let mut partial_header = [0_u8; JOURNAL_LOCK_RECORD_LENGTH];
        let prefix_length = 7;
        partial_header[JOURNAL_LOCK_HEADER_START..JOURNAL_LOCK_HEADER_START + prefix_length]
            .copy_from_slice(&JOURNAL_LOCK_HEADER[..prefix_length]);
        write_test_bytes(&file, &partial_header);
        assert_eq!(
            read_journal_lock_record(&file),
            Ok(JournalLockRecordState::Uninitialized)
        );
        drop(file);
        let (prior, mut recovered) = acquire(&test.store, NONCE_1);
        assert_eq!(prior, PriorLease::Absent);
        recovered
            .release()
            .expect("partial journal lock initialization must recover");
        let file = open_file_nofollow(&path, true, false, false)
            .expect("recovered journal lock must reopen for test mutation");

        let mut complete_header = [0_u8; JOURNAL_LOCK_RECORD_LENGTH];
        complete_header[JOURNAL_LOCK_HEADER_START..JOURNAL_LOCK_HEADER_END]
            .copy_from_slice(JOURNAL_LOCK_HEADER);
        write_test_bytes(&file, &complete_header);
        assert_eq!(
            read_journal_lock_record(&file),
            Ok(JournalLockRecordState::Uninitialized)
        );

        let mut wrong_role = [0_u8; JOURNAL_LOCK_RECORD_LENGTH];
        wrong_role[JOURNAL_LOCK_HEADER_START..JOURNAL_LOCK_HEADER_START + LOCK_HEADER.len()]
            .copy_from_slice(LOCK_HEADER);
        write_test_bytes(&file, &wrong_role);
        assert_eq!(
            read_journal_lock_record(&file),
            Err(WindowsStoreError::Unsafe)
        );

        let mut arbitrary = [b'x'; JOURNAL_LOCK_RECORD_LENGTH];
        arbitrary[0] = JOURNAL_LOCK_STATE_UNINITIALIZED;
        write_test_bytes(&file, &arbitrary);
        assert_eq!(
            read_journal_lock_record(&file),
            Err(WindowsStoreError::Unsafe)
        );

        drop(file);
        assert_eq!(
            acquire_reconciliation_journal_lease(&test.store, NONCE_2)
                .map(|_| ())
                .expect_err("malformed journal lock must fail statically"),
            WindowsStoreError::Unsafe
        );
        assert_eq!(
            std::fs::read(&path).expect("malformed journal lock must remain readable"),
            arbitrary
        );
        std::fs::remove_file(path).expect("journal lock fixture must be removed");
    }

    #[test]
    fn busy_race_after_lock_creation_preserves_one_lock_namespace() {
        let test = ready_store();
        inject_test_fault(TEST_FAULT_ACQUIRE_BUSY_AFTER_LOCK_CREATION);
        assert!(matches!(
            acquire_reconciliation_journal_lease(&test.store, NONCE_1),
            Ok(ReconciliationJournalLeaseAcquireResult::Busy)
        ));

        let competing = take_competing_lock();
        let expected_identity = metadata(&competing)
            .expect("competing lock metadata must attest")
            .identity;
        let canonical =
            open_file_nofollow(&test.store.join(JOURNAL_LOCK_ENTRY), false, false, false)
                .expect("busy lock must remain in the canonical namespace");
        assert_eq!(
            metadata(&canonical)
                .expect("canonical lock metadata must attest")
                .identity,
            expected_identity
        );
        drop(canonical);
        unlock(competing.as_handle()).expect("competing lock must unlock");
        drop(competing);

        let (prior, mut lease) = acquire(&test.store, NONCE_2);
        assert_eq!(prior, PriorLease::Absent);
        lease.release().expect("surviving lock must remain usable");
    }

    #[test]
    fn lock_transition_faults_recover_only_the_persisted_state() {
        for (fault, expected_prior) in [
            (TEST_FAULT_LOCK_INITIALIZE_AFTER_TAIL, PriorLease::Absent),
            (TEST_FAULT_LOCK_INITIALIZE_AFTER_CLEAN, PriorLease::Absent),
            (TEST_FAULT_LOCK_HELD_AFTER_NONCE, PriorLease::Absent),
            (
                TEST_FAULT_LOCK_HELD_AFTER_STATE,
                PriorLease::ProvenAbandoned,
            ),
        ] {
            let test = ready_store();
            inject_test_fault(fault);
            assert_eq!(acquire_error(&test.store, NONCE_1), WindowsStoreError::Io);
            assert_test_fault_consumed();

            let (prior, mut recovered) = acquire(&test.store, NONCE_2);
            assert_eq!(prior, expected_prior);
            assert_eq!(recovered.renew(), LeaseRenewal::Held);
            recovered.release().expect("recovered lease must release");
        }
    }

    #[test]
    fn observe_fault_preserves_the_held_lease_and_copied_state() {
        let test = ready_store();
        let (_, mut lease) = acquire(&test.store, NONCE_1);
        let absent = missing(&lease);
        replace(&lease, &absent, b"observed-journal");

        inject_test_fault(TEST_FAULT_OBSERVE_AFTER_READ);
        assert!(matches!(lease.observe(), Err(WindowsStoreError::Io)));
        assert_test_fault_consumed();
        assert_eq!(lease.renew(), LeaseRenewal::Held);
        assert_journal_and_remove(&lease, Some(b"observed-journal"));
        lease.release().expect("observed lease must release");
    }

    #[test]
    fn candidate_fault_matrix_recovers_before_and_after_atomic_rename() {
        for (fault, installed) in [
            (TEST_FAULT_CANDIDATE_AFTER_CREATE, false),
            (TEST_FAULT_CANDIDATE_AFTER_WRITE, false),
            (TEST_FAULT_CANDIDATE_AFTER_READBACK, false),
            (TEST_FAULT_CANDIDATE_AFTER_FLUSH, false),
            (TEST_FAULT_BEFORE_RECHECK, false),
            (TEST_FAULT_BEFORE_RENAME, false),
            (TEST_FAULT_AFTER_RENAME, true),
            (TEST_FAULT_POST_RENAME_READBACK, true),
        ] {
            let test = ready_store();
            let (_, lease) = acquire(&test.store, NONCE_1);
            let absent = missing(&lease);
            let candidate = test.store.join(candidate_name(lease.core.nonce));

            inject_test_fault(fault);
            assert!(matches!(
                lease.replace(&absent, b"fault-matrix-journal"),
                Err(WindowsStoreError::Lost)
            ));
            assert_test_fault_consumed();
            assert_eq!(lease.renew(), LeaseRenewal::Lost);
            assert_eq!(candidate.exists(), !installed);
            assert_eq!(test.store.join(JOURNAL_ENTRY).exists(), installed);
            drop(lease);

            let (prior, mut recovered) = acquire(&test.store, NONCE_2);
            assert_eq!(prior, PriorLease::ProvenAbandoned);
            assert!(!candidate.exists());
            assert_journal_and_remove(
                &recovered,
                installed.then_some(&b"fault-matrix-journal"[..]),
            );
            recovered.release().expect("recovered lease must release");
        }
    }

    #[test]
    fn recheck_race_conflicts_after_exact_candidate_cleanup() {
        let test = ready_store();
        let (_, mut lease) = acquire(&test.store, NONCE_1);
        let absent = missing(&lease);
        let candidate = test.store.join(candidate_name(lease.core.nonce));

        inject_test_fault(TEST_RACE_RECHECK_CANONICAL);
        assert!(matches!(
            lease.replace(&absent, b"candidate-that-must-not-win"),
            Ok(JournalReplaceResult::Conflict)
        ));
        assert_test_fault_consumed();
        assert!(!candidate.exists());
        assert_eq!(lease.renew(), LeaseRenewal::Held);
        assert_journal_and_remove(&lease, Some(b"raced-journal"));
        lease.release().expect("raced lease must release");
    }

    #[test]
    fn conflict_cleanup_faults_keep_recovery_ownership() {
        for (fault, candidate_remains) in [
            (TEST_FAULT_CONFLICT_CLEANUP_BEFORE_REMOVE, true),
            (TEST_FAULT_CONFLICT_CLEANUP_AFTER_REMOVE, false),
        ] {
            let test = ready_store();
            let (_, lease) = acquire(&test.store, NONCE_1);
            let absent = missing(&lease);
            let candidate = test.store.join(candidate_name(lease.core.nonce));

            inject_test_fault(fault);
            assert!(matches!(
                lease.replace(&absent, b"candidate-that-must-not-win"),
                Err(WindowsStoreError::Lost)
            ));
            assert_test_fault_consumed();
            assert_eq!(lease.renew(), LeaseRenewal::Lost);
            assert_eq!(candidate.exists(), candidate_remains);
            assert_eq!(
                std::fs::read(test.store.join(JOURNAL_ENTRY))
                    .expect("raced canonical journal must remain"),
                b"raced-journal"
            );
            drop(lease);

            let (prior, mut recovered) = acquire(&test.store, NONCE_2);
            assert_eq!(prior, PriorLease::ProvenAbandoned);
            assert!(!candidate.exists());
            assert_journal_and_remove(&recovered, Some(b"raced-journal"));
            recovered.release().expect("recovered lease must release");
        }
    }

    #[test]
    fn remove_faults_recover_before_and_after_namespace_deletion() {
        for (fault, journal_remains) in [
            (TEST_FAULT_REMOVE_BEFORE_DELETE, true),
            (TEST_FAULT_REMOVE_AFTER_DELETE, false),
        ] {
            let test = ready_store();
            let (_, lease) = acquire(&test.store, NONCE_1);
            let absent = missing(&lease);
            let revision = replace(&lease, &absent, b"remove-fault-journal");

            inject_test_fault(fault);
            assert!(matches!(
                lease.remove(&revision),
                Err(WindowsStoreError::Lost)
            ));
            assert_test_fault_consumed();
            assert_eq!(lease.renew(), LeaseRenewal::Lost);
            assert_eq!(test.store.join(JOURNAL_ENTRY).exists(), journal_remains);
            drop(lease);

            let (prior, mut recovered) = acquire(&test.store, NONCE_2);
            assert_eq!(prior, PriorLease::ProvenAbandoned);
            assert_journal_and_remove(
                &recovered,
                journal_remains.then_some(&b"remove-fault-journal"[..]),
            );
            recovered.release().expect("recovered lease must release");
        }
    }

    #[test]
    fn release_faults_restore_the_held_record_before_unlocking() {
        for fault in [
            TEST_FAULT_RELEASE_BEFORE_CLEAN,
            TEST_FAULT_RELEASE_AFTER_CLEAN,
        ] {
            let test = ready_store();
            let (_, mut lease) = acquire(&test.store, NONCE_1);
            inject_test_fault(fault);
            assert_eq!(lease.release(), Err(WindowsStoreError::Lost));
            assert_test_fault_consumed();

            let lock =
                open_file_nofollow(&test.store.join(JOURNAL_LOCK_ENTRY), false, false, false)
                    .expect("failed release must preserve the journal lock");
            assert_eq!(
                read_journal_lock_record(&lock),
                Ok(JournalLockRecordState::Held(
                    ValidatedUuidV4::parse(NONCE_1).expect("nonce must validate")
                ))
            );
            drop(lock);

            let (prior, mut recovered) = acquire(&test.store, NONCE_2);
            assert_eq!(prior, PriorLease::ProvenAbandoned);
            recovered.release().expect("recovered lease must release");
        }
    }

    #[test]
    fn recovery_faults_leave_old_ownership_until_a_proven_retry() {
        for (fault, candidate_remains) in [
            (TEST_FAULT_RECOVERY_BEFORE_REMOVE, true),
            (TEST_FAULT_RECOVERY_AFTER_REMOVE, false),
        ] {
            let test = ready_store();
            let (_, mut abandoned) = acquire(&test.store, NONCE_1);
            let nonce = abandoned.core.nonce;
            let candidate = test.store.join(candidate_name(nonce));
            let file = create_private_test_file(&candidate);
            write_test_bytes(&file, b"interrupted-candidate");
            drop(file);
            abandoned
                .abandon()
                .expect("fixture journal lease must abandon");

            inject_test_fault(fault);
            assert_eq!(acquire_error(&test.store, NONCE_2), WindowsStoreError::Lost);
            assert_test_fault_consumed();
            assert_eq!(candidate.exists(), candidate_remains);
            let lock =
                open_file_nofollow(&test.store.join(JOURNAL_LOCK_ENTRY), false, false, false)
                    .expect("failed recovery must retain the journal lock");
            assert_eq!(
                read_journal_lock_record(&lock),
                Ok(JournalLockRecordState::Held(nonce))
            );
            drop(lock);

            let (prior, mut recovered) = acquire(&test.store, NONCE_2);
            assert_eq!(prior, PriorLease::ProvenAbandoned);
            assert!(!candidate.exists());
            recovered.release().expect("recovered lease must release");
        }
    }

    #[test]
    fn journal_replace_observe_remove_is_exact_and_bounded() {
        let test = ready_store();
        let (prior, mut lease) = acquire(&test.store, NONCE_1);
        assert_eq!(prior, PriorLease::Absent);
        let missing = missing(&lease);
        assert!(matches!(
            lease.replace(&missing, &[]),
            Err(WindowsStoreError::InvalidInput)
        ));
        assert!(matches!(
            lease.replace(&missing, &vec![0_u8; MAX_JOURNAL_BYTES + 1]),
            Err(WindowsStoreError::Limit)
        ));
        assert!(!test.store.join(candidate_name(lease.core.nonce)).exists());
        let maximum = vec![b'j'; MAX_JOURNAL_BYTES];
        let revision = replace(&lease, &missing, &maximum);
        let (observed_revision, observed) = present(&lease);
        assert_eq!(observed, maximum);
        assert!(matches!(
            lease.replace(&missing, b"stale"),
            Ok(JournalReplaceResult::Conflict)
        ));
        assert!(matches!(
            lease.remove(&revision),
            Ok(JournalRemoveResult::Removed)
        ));
        assert!(matches!(
            lease.remove(&observed_revision),
            Ok(JournalRemoveResult::Conflict)
        ));
        assert!(matches!(
            lease.observe().expect("removed journal must observe"),
            JournalObservation::Missing { .. }
        ));

        let oversized = create_private_test_file(&test.store.join(JOURNAL_ENTRY));
        write_test_bytes(&oversized, &vec![b'o'; MAX_JOURNAL_BYTES + 1]);
        drop(oversized);
        assert!(matches!(lease.observe(), Err(WindowsStoreError::Limit)));
        std::fs::remove_file(test.store.join(JOURNAL_ENTRY))
            .expect("oversized journal fixture must be removed");
        lease.release().expect("journal lease must release");
    }

    #[test]
    fn revisions_are_generation_and_lease_scoped_and_removal_is_exact() {
        let test = ready_store();
        let (_, mut first) = acquire(&test.store, NONCE_1);
        let absent = missing(&first);
        let alpha = replace(&first, &absent, b"alpha");
        assert!(matches!(
            first.replace(&absent, b"replay"),
            Ok(JournalReplaceResult::Conflict)
        ));
        let (observed_alpha, alpha_bytes) = present(&first);
        assert_eq!(alpha_bytes, b"alpha");
        let beta = replace(&first, &observed_alpha, b"beta");
        assert!(matches!(
            first.remove(&alpha),
            Ok(JournalRemoveResult::Conflict)
        ));
        first.release().expect("first journal lease must release");

        let (_, mut second) = acquire(&test.store, NONCE_2);
        assert!(matches!(
            second.replace(&beta, b"cross-lease"),
            Ok(JournalReplaceResult::Conflict)
        ));
        let (current, bytes) = present(&second);
        assert_eq!(bytes, b"beta");
        assert!(matches!(
            second.remove(&current),
            Ok(JournalRemoveResult::Removed)
        ));
        assert!(matches!(
            second.remove(&current),
            Ok(JournalRemoveResult::Conflict)
        ));
        assert!(matches!(
            second.observe(),
            Ok(JournalObservation::Missing { .. })
        ));
        second.release().expect("second journal lease must release");
    }

    #[test]
    fn conditional_conflicts_never_truncate_a_raced_journal() {
        let test = ready_store();
        let (_, mut lease) = acquire(&test.store, NONCE_1);
        let absent = missing(&lease);
        let journal_path = test.store.join(JOURNAL_ENTRY);

        let raced_create = create_private_test_file(&journal_path);
        write_test_bytes(&raced_create, b"external-create");
        drop(raced_create);
        assert!(matches!(
            lease.replace(&absent, b"must-not-replace"),
            Ok(JournalReplaceResult::Conflict)
        ));
        assert_eq!(
            std::fs::read(&journal_path).expect("raced journal must remain readable"),
            b"external-create"
        );

        let (present_revision, _) = present(&lease);
        let raced_update = open_file_nofollow(&journal_path, true, false, false)
            .expect("raced journal must open for controlled test mutation");
        write_test_bytes(&raced_update, b"external-update");
        drop(raced_update);
        assert!(matches!(
            lease.replace(&present_revision, b"must-not-truncate"),
            Ok(JournalReplaceResult::Conflict)
        ));
        assert_eq!(
            std::fs::read(&journal_path).expect("updated journal must remain readable"),
            b"external-update"
        );

        let (current, _) = present(&lease);
        assert!(matches!(
            lease.remove(&current),
            Ok(JournalRemoveResult::Removed)
        ));
        lease.release().expect("journal lease must release");
    }

    #[test]
    fn journal_lock_is_independent_busy_and_record_proves_abandonment() {
        let test = ready_store();
        let (_, _, mut setup) = acquired_lease(&test.store, NONCE_1);
        let (_, mut first) = acquire(&test.store, NONCE_1);
        assert!(matches!(
            acquire_reconciliation_journal_lease(&test.store, NONCE_2),
            Ok(ReconciliationJournalLeaseAcquireResult::Busy)
        ));
        first
            .abandon()
            .expect("journal lease abandonment must close");
        let (prior, mut recovered) = acquire(&test.store, NONCE_2);
        assert_eq!(prior, PriorLease::ProvenAbandoned);
        recovered.release().expect("recovered lease must release");
        setup
            .release()
            .expect("setup lease must remain independent");
    }

    #[test]
    fn clean_release_refuses_candidate_and_preserves_held_recovery_state() {
        let test = ready_store();
        let (_, mut interrupted) = acquire(&test.store, NONCE_1);
        let nonce = ValidatedUuidV4::parse(NONCE_1).expect("nonce must validate");
        let candidate_path = test.store.join(candidate_name(nonce));
        let candidate = create_private_test_file(&candidate_path);
        write_test_bytes(&candidate, b"interrupted-write");
        drop(candidate);

        assert_eq!(interrupted.release(), Err(WindowsStoreError::Lost));
        assert_eq!(
            std::fs::read(&candidate_path).expect("refused release must preserve the candidate"),
            b"interrupted-write"
        );
        let lock = open_file_nofollow(&test.store.join(JOURNAL_LOCK_ENTRY), false, false, false)
            .expect("refused release must preserve the journal lock");
        assert_eq!(
            read_journal_lock_record(&lock),
            Ok(JournalLockRecordState::Held(nonce))
        );
        drop(lock);

        let (prior, mut recovered) = acquire(&test.store, NONCE_2);
        assert_eq!(prior, PriorLease::ProvenAbandoned);
        assert!(!candidate_path.exists());
        recovered.release().expect("recovered lease must release");
    }

    #[test]
    fn journal_rejects_hard_links_and_broad_dacls() {
        let test = ready_store();
        let (_, mut lease) = acquire(&test.store, NONCE_1);
        let missing = match lease.observe().expect("missing journal must observe") {
            JournalObservation::Missing { revision } => revision,
            JournalObservation::Present { .. } => panic!("journal unexpectedly exists"),
        };
        assert!(matches!(
            lease
                .replace(&missing, b"private-journal")
                .expect("journal replacement must complete"),
            JournalReplaceResult::Replaced { .. }
        ));

        let journal_path = test.store.join(JOURNAL_ENTRY);
        let alias = test.store.join("journal-hard-link-alias");
        std::fs::hard_link(&journal_path, &alias).expect("hard-link fixture must create");
        assert!(matches!(lease.observe(), Err(WindowsStoreError::Unsafe)));
        std::fs::remove_file(alias).expect("hard-link fixture must be removed");

        plurum_windows_syscall::set_broad_dacl_for_tests(&journal_path, SecurityKind::File)
            .expect("broad-DACL fixture must create");
        assert!(matches!(lease.observe(), Err(WindowsStoreError::Unsafe)));
        plurum_windows_syscall::set_private_current_user_dacl_for_tests(
            &journal_path,
            SecurityKind::File,
        )
        .expect("journal DACL must be restored");

        let revision = match lease.observe().expect("restored journal must observe") {
            JournalObservation::Missing { .. } => panic!("journal unexpectedly missing"),
            JournalObservation::Present { revision, .. } => revision,
        };
        assert!(matches!(
            lease.remove(&revision),
            Ok(JournalRemoveResult::Removed)
        ));
        lease.release().expect("journal lease must release");
    }

    #[test]
    fn journal_reparse_slots_never_touch_their_targets() {
        use std::os::windows::fs::symlink_file;

        let test = ready_store();
        let canary = std::fs::read(&test.marker).expect("outside canary must be readable");

        let lock_path = test.store.join(JOURNAL_LOCK_ENTRY);
        symlink_file(&test.marker, &lock_path).expect("journal lock symlink must create");
        assert!(matches!(
            acquire_reconciliation_journal_lease(&test.store, NONCE_1),
            Err(WindowsStoreError::Unsafe)
        ));
        assert_eq!(
            std::fs::read(&test.marker).expect("outside canary must remain readable"),
            canary
        );
        std::fs::remove_file(lock_path).expect("journal lock symlink must be removed");

        let (_, mut abandoned) = acquire(&test.store, NONCE_1);
        let journal_path = test.store.join(JOURNAL_ENTRY);
        symlink_file(&test.marker, &journal_path).expect("journal symlink must create");
        assert!(matches!(
            abandoned.observe(),
            Err(WindowsStoreError::Unsafe)
        ));
        assert_eq!(
            std::fs::read(&test.marker).expect("outside canary must remain readable"),
            canary
        );
        std::fs::remove_file(journal_path).expect("journal symlink must be removed");

        let candidate_path = test.store.join(candidate_name(abandoned.core.nonce));
        symlink_file(&test.marker, &candidate_path).expect("candidate symlink must create");
        abandoned
            .abandon()
            .expect("unsafe-candidate fixture lease must abandon");
        assert!(matches!(
            acquire_reconciliation_journal_lease(&test.store, NONCE_2),
            Err(WindowsStoreError::Unsafe)
        ));
        assert_eq!(
            std::fs::read(&test.marker).expect("outside canary must remain readable"),
            canary
        );
        std::fs::remove_file(candidate_path).expect("candidate symlink must be removed");

        let (prior, mut recovered) = acquire(&test.store, NONCE_2);
        assert_eq!(prior, PriorLease::ProvenAbandoned);
        recovered.release().expect("safe recovery must release");
    }

    #[test]
    fn abandoned_exact_candidate_is_recovered_but_foreign_candidate_blocks() {
        let test = ready_store();
        let (_, mut abandoned) = acquire(&test.store, NONCE_1);
        let process = ProcessIdentity::capture().expect("test process identity must attest");
        let stale_name = candidate_name(
            ValidatedUuidV4::parse(NONCE_1).expect("stale candidate nonce must validate"),
        );
        let stale_path = test.store.join(&stale_name);
        let stale = match create_private_file(
            &stale_path,
            &process,
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        )
        .expect("stale candidate must create")
        {
            FileCreateAttempt::Created(file) => file,
            FileCreateAttempt::Conflict => panic!("stale candidate unexpectedly exists"),
        };
        write_all_at(&stale, b"partial", 0).expect("stale candidate must write");
        flush_file(stale.as_handle()).expect("stale candidate must flush");
        drop(stale);
        abandoned
            .abandon()
            .expect("abandoned journal lease must close");

        let (prior, mut recovered) = acquire(&test.store, NONCE_2);
        assert_eq!(prior, PriorLease::ProvenAbandoned);
        let recovered_directory = open_private(&test.store);
        assert!(
            journal_entry_is_missing(&recovered_directory.core, &stale_name)
                .expect("recovered candidate namespace must attest")
        );
        drop(recovered_directory);
        recovered.release().expect("recovered lease must release");

        let (_, mut foreign_owner) = acquire(&test.store, NONCE_2);
        let foreign_nonce =
            ValidatedUuidV4::parse(NONCE_1).expect("foreign candidate nonce must validate");
        let foreign_name = candidate_name(foreign_nonce);
        let foreign_path = test.store.join(&foreign_name);
        let foreign = match create_private_file(
            &foreign_path,
            &process,
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        )
        .expect("foreign candidate must create")
        {
            FileCreateAttempt::Created(file) => file,
            FileCreateAttempt::Conflict => panic!("foreign candidate unexpectedly exists"),
        };
        drop(foreign);
        foreign_owner
            .abandon()
            .expect("foreign-candidate fixture lease must abandon");
        match acquire_reconciliation_journal_lease(&test.store, NONCE_1) {
            Err(WindowsStoreError::Unsafe) => {}
            Err(error) => panic!("unexpected foreign-candidate error: {error:?}"),
            Ok(_) => panic!("foreign candidate under Held record must block"),
        }
        let directory = open_private(&test.store);
        remove_exact_candidate(&directory, foreign_nonce)
            .expect("known test candidate must be removable");
        drop(directory);
        let (prior, mut final_lease) = acquire(&test.store, NONCE_1);
        assert_eq!(prior, PriorLease::ProvenAbandoned);
        final_lease.release().expect("final lease must release");
    }

    fn open_private(path: &Path) -> WindowsPrivateDirectory {
        match open_private_directory(path).expect("private directory must open") {
            PrivateDirectoryOpenResult::Missing => panic!("private directory unexpectedly missing"),
            PrivateDirectoryOpenResult::Opened(directory) => directory,
        }
    }
}
