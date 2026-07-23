use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::os::unix::ffi::OsStringExt;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

#[cfg(test)]
use std::cell::Cell;

use rustix::fs::{self as rustix_fs, AtFlags, Dir, FlockOperation, Mode, OFlags, RenameFlags};
use rustix::io::Errno;

use super::*;

const JOURNAL_ENTRY: &str = "host-reconciliation.json";
const JOURNAL_LOCK_ENTRY: &str = "host-reconciliation.lock";
const JOURNAL_CANDIDATE_PREFIX: &[u8] = b".host-reconciliation-";
const JOURNAL_CANDIDATE_SUFFIX: &[u8] = b".tmp";
const MAX_JOURNAL_BYTES: usize = 65_536;
const MAX_JOURNAL_READ_BYTES: usize = MAX_JOURNAL_BYTES + 1;
const MAX_DIRECTORY_ENTRIES: usize = 4_096;

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
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum JournalTestFault {
    AcquireAfterInitializedClean,
    AcquireAfterRecovery,
    AcquireAfterCleanTransition,
    AcquireAfterNonceSync,
    AcquireAfterHeldTransition,
    AcquireAfterCreatedLockDirectorySync,
    ObserveBeforeFirstAttestation,
    ObserveAfterFirstAttestation,
    ObserveAfterRead,
    ObserveAfterSecondAttestation,
    CandidateBeforeCreate,
    CandidateAfterCreate,
    CandidateAfterWrite,
    CandidateAfterReadback,
    CandidateAfterFileSync,
    ForceInstallConflict,
    InstallBeforeRename,
    InstallAfterRename,
    InstallAfterDirectorySync,
    ReplaceBeforeInstalledReadback,
    ReplaceAfterInstalledReadback,
    RemoveBeforeUnlink,
    RemoveAfterUnlink,
    RemoveAfterDirectorySync,
    RecoveryBeforeCandidateUnlink,
    RecoveryAfterCandidateUnlink,
    RecoveryAfterDirectorySync,
    ReleaseBeforeCleanTransition,
    ReleaseAfterCleanTransition,
}

#[cfg(test)]
thread_local! {
    static JOURNAL_TEST_FAULT: Cell<Option<JournalTestFault>> = const { Cell::new(None) };
}

#[cfg(test)]
fn arm_journal_test_fault(fault: JournalTestFault) {
    JOURNAL_TEST_FAULT.with(|armed| {
        assert!(
            armed.replace(Some(fault)).is_none(),
            "a journal test fault is already armed"
        );
    });
}

#[cfg(test)]
fn take_journal_test_fault(fault: JournalTestFault) -> bool {
    JOURNAL_TEST_FAULT.with(|armed| {
        if armed.get() == Some(fault) {
            armed.set(None);
            true
        } else {
            false
        }
    })
}

#[cfg(test)]
fn assert_journal_test_fault_consumed() {
    JOURNAL_TEST_FAULT.with(|armed| {
        assert!(
            armed.get().is_none(),
            "the armed journal test fault was not reached"
        );
    });
}

#[cfg(test)]
macro_rules! fail_on_journal_test_fault {
    ($point:ident, $error:expr) => {
        if take_journal_test_fault(JournalTestFault::$point) {
            return Err($error);
        }
    };
}

#[cfg(not(test))]
macro_rules! fail_on_journal_test_fault {
    ($point:ident, $error:expr) => {};
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
    directory: Option<PosixPrivateDirectory>,
    lock: Option<File>,
}

struct JournalLeaseCore {
    nonce: ValidatedUuidV4,
    runtime: Mutex<JournalLeaseRuntime>,
}

#[derive(Clone, Copy)]
enum JournalRevisionState {
    Missing,
    Present(CredentialFileAttestation),
}

pub(crate) struct JournalRevision {
    lease: Weak<JournalLeaseCore>,
    generation: u64,
    directory_identity: ObjectIdentity,
    state: JournalRevisionState,
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
        lease: PosixReconciliationJournalLease,
    },
}

pub(crate) struct PosixReconciliationJournalLease {
    core: Arc<JournalLeaseCore>,
}

struct PresentJournal {
    attestation: CredentialFileAttestation,
    bytes: Vec<u8>,
    file: PosixCredentialReadHandle,
}

impl PresentJournal {
    fn take_bytes(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.bytes)
    }
}

impl Drop for PresentJournal {
    fn drop(&mut self) {
        zeroize_bytes(self.bytes.as_mut_slice());
        self.file.close();
    }
}

enum ObservedJournal {
    Missing,
    Present(PresentJournal),
}

struct PreparedCandidate {
    name: OsString,
    identity: ObjectIdentity,
    file: File,
}

#[cfg(test)]
enum CandidatePreparationFailure {
    Store(PosixStoreError),
    InjectedUncertainty,
}

#[cfg(test)]
impl From<PosixStoreError> for CandidatePreparationFailure {
    fn from(error: PosixStoreError) -> Self {
        Self::Store(error)
    }
}

#[cfg(test)]
type CandidatePreparationResult = Result<(), CandidatePreparationFailure>;

#[cfg(not(test))]
type CandidatePreparationResult = Result<(), PosixStoreError>;

#[cfg(test)]
fn candidate_preparation_store_failure(error: PosixStoreError) -> CandidatePreparationFailure {
    CandidatePreparationFailure::Store(error)
}

#[cfg(not(test))]
fn candidate_preparation_store_failure(error: PosixStoreError) -> PosixStoreError {
    error
}

fn journal_exact_current_file(
    directory: &File,
    name: &OsStr,
    expected: ObjectIdentity,
    uid: u32,
) -> Result<bool, PosixStoreError> {
    let opened = match secure_openat(directory, name, read_open_flags(), Mode::empty()) {
        Ok(opened) => File::from(opened),
        Err(error) if error == Errno::NOENT => return Ok(false),
        Err(_) => return Err(PosixStoreError::Unsafe),
    };
    let facts = metadata(&opened)?;
    Ok(facts.identity == expected
        && facts.exact_private_file(uid)
        && platform::access_is_private(&opened)?)
}

fn journal_lock_unpoisoned(
    mutex: &Mutex<JournalLeaseRuntime>,
) -> Result<MutexGuard<'_, JournalLeaseRuntime>, PosixStoreError> {
    match mutex.lock() {
        Ok(runtime) => Ok(runtime),
        Err(poisoned) => {
            let mut runtime = poisoned.into_inner();
            if runtime.status == JournalLeaseStatus::Terminal {
                Err(PosixStoreError::Closed)
            } else {
                runtime.status = JournalLeaseStatus::Lost;
                Err(PosixStoreError::Lost)
            }
        }
    }
}

fn mark_journal_lost(runtime: &mut JournalLeaseRuntime) {
    if runtime.status != JournalLeaseStatus::Terminal {
        runtime.status = JournalLeaseStatus::Lost;
    }
}

fn next_journal_generation(runtime: &mut JournalLeaseRuntime) -> Result<u64, PosixStoreError> {
    let next = runtime
        .generation
        .checked_add(1)
        .ok_or(PosixStoreError::Lost)?;
    runtime.generation = next;
    Ok(next)
}

fn journal_candidate_name(nonce: ValidatedUuidV4) -> OsString {
    let mut bytes = Vec::with_capacity(
        JOURNAL_CANDIDATE_PREFIX.len() + LOCK_NONCE_LENGTH + JOURNAL_CANDIDATE_SUFFIX.len(),
    );
    bytes.extend_from_slice(JOURNAL_CANDIDATE_PREFIX);
    bytes.extend_from_slice(&nonce.0);
    bytes.extend_from_slice(JOURNAL_CANDIDATE_SUFFIX);
    OsString::from_vec(bytes)
}

fn parse_journal_candidate_name(bytes: &[u8]) -> Option<ValidatedUuidV4> {
    let expected =
        JOURNAL_CANDIDATE_PREFIX.len() + LOCK_NONCE_LENGTH + JOURNAL_CANDIDATE_SUFFIX.len();
    if bytes.len() != expected
        || !bytes.starts_with(JOURNAL_CANDIDATE_PREFIX)
        || !bytes.ends_with(JOURNAL_CANDIDATE_SUFFIX)
    {
        return None;
    }
    let start = JOURNAL_CANDIDATE_PREFIX.len();
    let value = std::str::from_utf8(&bytes[start..start + LOCK_NONCE_LENGTH]).ok()?;
    ValidatedUuidV4::parse(value).ok()
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

fn read_journal_lock_record(file: &File) -> Result<JournalLockRecordState, PosixStoreError> {
    let facts = metadata(file)?;
    if facts.size == 0 {
        return Ok(JournalLockRecordState::Uninitialized);
    }
    if facts.size != JOURNAL_LOCK_RECORD_LENGTH as u64 {
        return Err(PosixStoreError::Unsafe);
    }
    let bytes = read_exact_at(file, JOURNAL_LOCK_RECORD_LENGTH)?;
    if bytes[0] == JOURNAL_LOCK_STATE_UNINITIALIZED {
        return if recoverable_uninitialized_journal_lock_record(&bytes) {
            Ok(JournalLockRecordState::Uninitialized)
        } else {
            Err(PosixStoreError::Unsafe)
        };
    }
    if &bytes[JOURNAL_LOCK_HEADER_START..JOURNAL_LOCK_HEADER_END] != JOURNAL_LOCK_HEADER
        || bytes[JOURNAL_LOCK_HEADER_END..JOURNAL_LOCK_NONCE_START]
            .iter()
            .any(|byte| *byte != 0)
        || bytes[JOURNAL_LOCK_NONCE_END..]
            .iter()
            .any(|byte| *byte != 0)
    {
        return Err(PosixStoreError::Unsafe);
    }
    let nonce = &bytes[JOURNAL_LOCK_NONCE_START..JOURNAL_LOCK_NONCE_END];
    match bytes[0] {
        JOURNAL_LOCK_STATE_CLEAN => {
            if nonce.iter().all(|byte| *byte == 0)
                || std::str::from_utf8(nonce)
                    .ok()
                    .and_then(|value| ValidatedUuidV4::parse(value).ok())
                    .is_some()
            {
                Ok(JournalLockRecordState::Clean)
            } else {
                Err(PosixStoreError::Unsafe)
            }
        }
        JOURNAL_LOCK_STATE_HELD => {
            let nonce = std::str::from_utf8(nonce)
                .map_err(|_| PosixStoreError::Unsafe)
                .and_then(ValidatedUuidV4::parse)?;
            Ok(JournalLockRecordState::Held(nonce))
        }
        _ => Err(PosixStoreError::Unsafe),
    }
}

fn write_journal_lock_state(file: &File, state: u8) -> Result<(), PosixStoreError> {
    write_all_at(file, &[state], 0)?;
    platform::sync_file(file)
}

fn initialize_journal_lock(file: &File) -> Result<(), PosixStoreError> {
    if metadata(file)?.size != 0 {
        write_journal_lock_state(file, JOURNAL_LOCK_STATE_UNINITIALIZED)?;
    }
    file.set_len(JOURNAL_LOCK_RECORD_LENGTH as u64)
        .map_err(|_| PosixStoreError::Io)?;
    let mut record = [0_u8; JOURNAL_LOCK_RECORD_LENGTH];
    record[JOURNAL_LOCK_HEADER_START..JOURNAL_LOCK_HEADER_END].copy_from_slice(JOURNAL_LOCK_HEADER);
    write_all_at(file, &record[1..], 1)?;
    platform::sync_file(file)?;
    write_journal_lock_state(file, JOURNAL_LOCK_STATE_CLEAN)?;
    if read_journal_lock_record(file)? == JournalLockRecordState::Clean {
        Ok(())
    } else {
        Err(PosixStoreError::Lost)
    }
}

fn write_journal_held_record(file: &File, nonce: ValidatedUuidV4) -> Result<(), PosixStoreError> {
    if read_journal_lock_record(file)? != JournalLockRecordState::Clean {
        return Err(PosixStoreError::Lost);
    }
    write_all_at(file, &nonce.0, JOURNAL_LOCK_NONCE_START as u64)?;
    platform::sync_file(file)?;
    fail_on_journal_test_fault!(AcquireAfterNonceSync, PosixStoreError::Lost);
    write_journal_lock_state(file, JOURNAL_LOCK_STATE_HELD)?;
    fail_on_journal_test_fault!(AcquireAfterHeldTransition, PosixStoreError::Lost);
    if read_journal_lock_record(file)? == JournalLockRecordState::Held(nonce) {
        Ok(())
    } else {
        Err(PosixStoreError::Lost)
    }
}

fn exact_journal_lock(
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
    let current = secure_openat(
        directory_file,
        OsStr::new(JOURNAL_LOCK_ENTRY),
        lock_open_flags(),
        Mode::empty(),
    )
    .ok()
    .map(File::from);
    match current {
        Some(current) => {
            let current_facts = metadata(&current)?;
            Ok(current_facts.identity == facts.identity
                && current_facts.exact_private_file(directory.core.process.uid)
                && platform::access_is_private(&current)?)
        }
        None => Ok(false),
    }
}

fn cleanup_exact_created_journal_lock(
    directory: &PosixPrivateDirectory,
    file: &File,
    expected_identity: ObjectIdentity,
) -> Result<(), PosixStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.process.verify()?;
    let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
    directory.core.require_secure_locked(&state)?;
    let retained = metadata(file)?;
    if retained.identity != expected_identity
        || retained.kind != ObjectKind::RegularFile
        || !retained.owned_by(directory.core.process.uid)
        || retained.links > 1
    {
        return Err(PosixStoreError::Lost);
    }
    let current = secure_openat(
        directory_file,
        OsStr::new(JOURNAL_LOCK_ENTRY),
        lock_open_flags(),
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| PosixStoreError::Lost)?;
    if metadata(&current)?.identity != expected_identity {
        return Err(PosixStoreError::Lost);
    }
    rustix_fs::unlinkat(
        directory_file,
        OsStr::new(JOURNAL_LOCK_ENTRY),
        AtFlags::empty(),
    )
    .map_err(|_| PosixStoreError::Lost)?;
    if !entry_is_missing_at(directory_file, OsStr::new(JOURNAL_LOCK_ENTRY))?
        || metadata(file)?.links != 0
    {
        return Err(PosixStoreError::Lost);
    }
    platform::sync_directory(directory_file)
}

fn open_or_create_journal_lock(
    directory: &PosixPrivateDirectory,
) -> Result<(File, Option<ObjectIdentity>), PosixStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
    let mut created = false;
    let file = match secure_openat(
        directory_file,
        OsStr::new(JOURNAL_LOCK_ENTRY),
        lock_open_flags(),
        Mode::empty(),
    ) {
        Ok(file) => File::from(file),
        Err(error) if error == Errno::NOENT => {
            let flags = lock_open_flags() | OFlags::CREATE | OFlags::EXCL;
            match secure_openat(
                directory_file,
                OsStr::new(JOURNAL_LOCK_ENTRY),
                flags,
                private_file_mode(),
            ) {
                Ok(file) => {
                    created = true;
                    File::from(file)
                }
                Err(create_error) if create_error == Errno::EXIST => secure_openat(
                    directory_file,
                    OsStr::new(JOURNAL_LOCK_ENTRY),
                    lock_open_flags(),
                    Mode::empty(),
                )
                .map(File::from)
                .map_err(|_| PosixStoreError::Unsafe)?,
                Err(_) => return Err(PosixStoreError::Io),
            }
        }
        Err(_) => return Err(PosixStoreError::Unsafe),
    };
    drop(state);

    let created_identity = if created {
        let identity = metadata(&file)?.identity;
        let initialized_access = (|| {
            rustix_fs::fchmod(&file, private_file_mode()).map_err(|_| PosixStoreError::Io)?;
            platform::initialize_created_access(&file)?;
            Ok(())
        })();
        if let Err(error) = initialized_access {
            cleanup_exact_created_journal_lock(directory, &file, identity)?;
            return Err(error);
        }
        Some(identity)
    } else {
        None
    };

    match exact_journal_lock(directory, &file) {
        Ok(true) => Ok((file, created_identity)),
        Ok(false) => {
            if let Some(identity) = created_identity {
                cleanup_exact_created_journal_lock(directory, &file, identity)?;
            }
            Err(PosixStoreError::Unsafe)
        }
        Err(error) => {
            if let Some(identity) = created_identity {
                cleanup_exact_created_journal_lock(directory, &file, identity)?;
            }
            Err(error)
        }
    }
}

fn list_journal_candidates(
    directory: &PosixPrivateDirectory,
) -> Result<Vec<ValidatedUuidV4>, PosixStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
    let mut stream = Dir::read_from(directory_file).map_err(|_| PosixStoreError::Io)?;
    let mut scanned = 0_usize;
    let mut candidates = Vec::new();
    while let Some(raw_entry) = stream.read() {
        let raw_entry = raw_entry.map_err(|_| PosixStoreError::Io)?;
        let bytes = raw_entry.file_name().to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        scanned = scanned.checked_add(1).ok_or(PosixStoreError::Limit)?;
        if scanned > MAX_DIRECTORY_ENTRIES {
            return Err(PosixStoreError::Limit);
        }
        if let Some(nonce) = parse_journal_candidate_name(bytes) {
            candidates.push(nonce);
        }
    }
    directory.core.require_secure_locked(&state)?;
    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    candidates.dedup();
    Ok(candidates)
}

fn remove_exact_candidate(
    directory: &PosixPrivateDirectory,
    nonce: ValidatedUuidV4,
) -> Result<(), PosixStoreError> {
    let name = journal_candidate_name(nonce);
    let mut opened = match directory.open_managed_read_only(name.as_os_str())? {
        CredentialReadOpenResult::Missing => return Ok(()),
        CredentialReadOpenResult::Opened(file) => file,
    };
    let security = opened.security_attestation()?;
    if !security.is_secure() {
        return Err(PosixStoreError::Unsafe);
    }
    let expected_identity = security.identity;
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
    if !journal_exact_current_file(
        directory_file,
        name.as_os_str(),
        expected_identity,
        directory.core.process.uid,
    )? {
        return Err(PosixStoreError::Lost);
    }
    fail_on_journal_test_fault!(RecoveryBeforeCandidateUnlink, PosixStoreError::Io);
    rustix_fs::unlinkat(directory_file, name.as_os_str(), AtFlags::empty())
        .map_err(|_| PosixStoreError::Lost)?;
    fail_on_journal_test_fault!(RecoveryAfterCandidateUnlink, PosixStoreError::Lost);
    let postcondition: Result<bool, PosixStoreError> = (|| {
        let path_missing = entry_is_missing_at(directory_file, name.as_os_str())?;
        let slot = lock_unpoisoned(&opened.slot)?;
        let retained = slot.as_ref().ok_or(PosixStoreError::Closed)?;
        let retained_facts = metadata(retained)?;
        Ok(path_missing
            && retained_facts.identity == expected_identity
            && retained_facts.links == 0)
    })();
    drop(state);
    opened.close();
    if !matches!(postcondition, Ok(true)) {
        return Err(PosixStoreError::Lost);
    }
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
    platform::sync_directory(directory_file)?;
    fail_on_journal_test_fault!(RecoveryAfterDirectorySync, PosixStoreError::Lost);
    Ok(())
}

fn reconcile_abandoned_candidate(
    directory: &PosixPrivateDirectory,
    prior: JournalLockRecordState,
) -> Result<PriorLease, PosixStoreError> {
    let candidates = list_journal_candidates(directory)?;
    match prior {
        JournalLockRecordState::Uninitialized | JournalLockRecordState::Clean => {
            if candidates.is_empty() {
                Ok(PriorLease::Absent)
            } else {
                Err(PosixStoreError::Unsafe)
            }
        }
        JournalLockRecordState::Held(old_nonce) => {
            if candidates.iter().any(|candidate| *candidate != old_nonce) {
                return Err(PosixStoreError::Unsafe);
            }
            if candidates == [old_nonce] {
                remove_exact_candidate(directory, old_nonce)?;
            }
            Ok(PriorLease::ProvenAbandoned)
        }
    }
}

fn observed_journal(directory: &PosixPrivateDirectory) -> Result<ObservedJournal, PosixStoreError> {
    let mut file = match directory.open_managed_read_only(OsStr::new(JOURNAL_ENTRY))? {
        CredentialReadOpenResult::Missing => return Ok(ObservedJournal::Missing),
        CredentialReadOpenResult::Opened(file) => file,
    };
    #[cfg(test)]
    {
        if take_journal_test_fault(JournalTestFault::ObserveBeforeFirstAttestation) {
            file.close();
            return Err(PosixStoreError::Io);
        }
    }
    let first = match file.attest_reconciliation_journal() {
        Ok(attestation) => attestation,
        Err(error) => {
            file.close();
            return Err(error);
        }
    };
    #[cfg(test)]
    {
        if take_journal_test_fault(JournalTestFault::ObserveAfterFirstAttestation) {
            file.close();
            return Err(PosixStoreError::Io);
        }
    }
    let mut read = match file.read_reconciliation_journal_bounded(MAX_JOURNAL_READ_BYTES) {
        Ok(read) => read,
        Err(error) => {
            file.close();
            return Err(error);
        }
    };
    #[cfg(test)]
    {
        if take_journal_test_fault(JournalTestFault::ObserveAfterRead) {
            zeroize_bytes(read.bytes.as_mut_slice());
            file.close();
            return Err(PosixStoreError::Io);
        }
    }
    let second = match file.attest_reconciliation_journal() {
        Ok(attestation) => attestation,
        Err(error) => {
            zeroize_bytes(read.bytes.as_mut_slice());
            file.close();
            return Err(error);
        }
    };
    #[cfg(test)]
    {
        if take_journal_test_fault(JournalTestFault::ObserveAfterSecondAttestation) {
            zeroize_bytes(read.bytes.as_mut_slice());
            file.close();
            return Err(PosixStoreError::Io);
        }
    }
    if first != second || !read.end_of_file || read.bytes.len() > MAX_JOURNAL_BYTES {
        zeroize_bytes(read.bytes.as_mut_slice());
        file.close();
        return Err(if read.end_of_file {
            PosixStoreError::Limit
        } else {
            PosixStoreError::Lost
        });
    }
    Ok(ObservedJournal::Present(PresentJournal {
        attestation: second,
        bytes: read.bytes,
        file,
    }))
}

fn revision_for(
    lease: &Arc<JournalLeaseCore>,
    generation: u64,
    directory_identity: ObjectIdentity,
    state: JournalRevisionState,
) -> JournalRevision {
    JournalRevision {
        lease: Arc::downgrade(lease),
        generation,
        directory_identity,
        state,
    }
}

fn revision_scope_matches(
    lease: &Arc<JournalLeaseCore>,
    runtime: &JournalLeaseRuntime,
    directory_identity: ObjectIdentity,
    expected: &JournalRevision,
) -> bool {
    expected.generation == runtime.generation
        && expected.directory_identity == directory_identity
        && expected
            .lease
            .upgrade()
            .is_some_and(|scope| Arc::ptr_eq(&scope, lease))
}

fn revision_matches(
    lease: &Arc<JournalLeaseCore>,
    runtime: &JournalLeaseRuntime,
    directory_identity: ObjectIdentity,
    expected: &JournalRevision,
    current: &ObservedJournal,
) -> bool {
    if !revision_scope_matches(lease, runtime, directory_identity, expected) {
        return false;
    }
    match (expected.state, current) {
        (JournalRevisionState::Missing, ObservedJournal::Missing) => true,
        (
            JournalRevisionState::Present(expected_attestation),
            ObservedJournal::Present(current),
        ) => expected_attestation == current.attestation,
        _ => false,
    }
}

fn create_prepared_candidate(
    directory: &PosixPrivateDirectory,
    nonce: ValidatedUuidV4,
    bytes: &[u8],
) -> Result<PreparedCandidate, PosixStoreError> {
    if bytes.is_empty() {
        return Err(PosixStoreError::InvalidInput);
    }
    if bytes.len() > MAX_JOURNAL_BYTES {
        return Err(PosixStoreError::Limit);
    }
    fail_on_journal_test_fault!(CandidateBeforeCreate, PosixStoreError::Io);
    let name = journal_candidate_name(nonce);
    let state = lock_unpoisoned(&directory.core.state)?;
    let directory_attestation = directory.core.require_secure_locked(&state)?;
    let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
    match rustix_fs::statat(directory_file, name.as_os_str(), AtFlags::SYMLINK_NOFOLLOW) {
        Err(error) if error == Errno::NOENT => {}
        Ok(_) => return Err(PosixStoreError::Unsafe),
        Err(_) => return Err(PosixStoreError::Io),
    }
    let file = secure_openat(
        directory_file,
        name.as_os_str(),
        lock_open_flags() | OFlags::CREATE | OFlags::EXCL,
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
    let identity = metadata(&file)?.identity;
    let prepared: CandidatePreparationResult = (|| {
        rustix_fs::fchmod(&file, private_file_mode()).map_err(|_| PosixStoreError::Io)?;
        platform::initialize_created_access(&file)?;
        let initial = metadata(&file)?;
        if !initial.exact_private_file(directory.core.process.uid)
            || !platform::access_is_private(&file)?
            || initial.size != 0
            || initial.identity != identity
        {
            return Err(candidate_preparation_store_failure(PosixStoreError::Unsafe));
        }
        let rebound = secure_openat(
            directory_file,
            name.as_os_str(),
            read_open_flags(),
            Mode::empty(),
        )
        .map(File::from)
        .map_err(|_| PosixStoreError::Lost)?;
        if metadata(&rebound)?.identity != identity {
            return Err(candidate_preparation_store_failure(PosixStoreError::Lost));
        }
        #[cfg(test)]
        if take_journal_test_fault(JournalTestFault::CandidateAfterCreate) {
            return Err(CandidatePreparationFailure::InjectedUncertainty);
        }
        write_all_at(&file, bytes, 0)?;
        file.set_len(u64::try_from(bytes.len()).map_err(|_| PosixStoreError::Limit)?)
            .map_err(|_| PosixStoreError::Io)?;
        let after = metadata(&file)?;
        if after.identity != identity
            || !after.exact_private_file(directory.core.process.uid)
            || after.size != bytes.len() as u64
            || !platform::access_is_private(&file)?
        {
            return Err(candidate_preparation_store_failure(PosixStoreError::Lost));
        }
        #[cfg(test)]
        if take_journal_test_fault(JournalTestFault::CandidateAfterWrite) {
            return Err(CandidatePreparationFailure::InjectedUncertainty);
        }
        let mut readback = read_exact_at(&file, bytes.len())?;
        let exact = readback == bytes;
        zeroize_bytes(readback.as_mut_slice());
        if !exact {
            return Err(candidate_preparation_store_failure(PosixStoreError::Lost));
        }
        #[cfg(test)]
        if take_journal_test_fault(JournalTestFault::CandidateAfterReadback) {
            return Err(CandidatePreparationFailure::InjectedUncertainty);
        }
        platform::sync_file(&file)?;
        let synced = metadata(&file)?;
        if synced != after
            || !journal_exact_current_file(
                directory_file,
                name.as_os_str(),
                identity,
                directory.core.process.uid,
            )?
        {
            return Err(candidate_preparation_store_failure(PosixStoreError::Lost));
        }
        #[cfg(test)]
        if take_journal_test_fault(JournalTestFault::CandidateAfterFileSync) {
            return Err(CandidatePreparationFailure::InjectedUncertainty);
        }
        directory.core.require_secure_locked(&state)?;
        if directory_attestation.identity != directory.core.require_secure_locked(&state)?.identity
        {
            return Err(candidate_preparation_store_failure(PosixStoreError::Lost));
        }
        Ok(())
    })();
    drop(state);
    #[cfg(not(test))]
    if let Err(error) = prepared {
        let cleanup = cleanup_prepared_candidate(directory, &name, &file, identity);
        return match cleanup {
            Ok(()) => Err(error),
            Err(_) => Err(PosixStoreError::Lost),
        };
    }
    #[cfg(test)]
    if let Err(error) = prepared {
        return match error {
            CandidatePreparationFailure::Store(error) => {
                let cleanup = cleanup_prepared_candidate(directory, &name, &file, identity);
                match cleanup {
                    Ok(()) => Err(error),
                    Err(_) => Err(PosixStoreError::Lost),
                }
            }
            CandidatePreparationFailure::InjectedUncertainty => Err(PosixStoreError::Lost),
        };
    }
    Ok(PreparedCandidate {
        name,
        identity,
        file,
    })
}

fn cleanup_prepared_candidate(
    directory: &PosixPrivateDirectory,
    name: &OsStr,
    file: &File,
    identity: ObjectIdentity,
) -> Result<(), PosixStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
    let retained = metadata(file)?;
    if retained.identity != identity
        || retained.kind != ObjectKind::RegularFile
        || !retained.owned_by(directory.core.process.uid)
        || retained.links > 1
        || !platform::access_is_private(file)?
        || !journal_exact_current_file(directory_file, name, identity, directory.core.process.uid)?
    {
        return Err(PosixStoreError::Lost);
    }
    rustix_fs::unlinkat(directory_file, name, AtFlags::empty())
        .map_err(|_| PosixStoreError::Lost)?;
    if !entry_is_missing_at(directory_file, name)?
        || metadata(file)?.identity != identity
        || metadata(file)?.links != 0
    {
        return Err(PosixStoreError::Lost);
    }
    platform::sync_directory(directory_file)
}

fn atomic_install_candidate(
    directory: &PosixPrivateDirectory,
    candidate: &PreparedCandidate,
    expected: &JournalRevision,
) -> Result<ConditionalMutationResult, PosixStoreError> {
    let state = lock_unpoisoned(&directory.core.state)?;
    directory.core.require_secure_locked(&state)?;
    let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
    if !journal_exact_current_file(
        directory_file,
        candidate.name.as_os_str(),
        candidate.identity,
        directory.core.process.uid,
    )? {
        return Ok(ConditionalMutationResult::Conflict);
    }
    let destination = OsStr::new(JOURNAL_ENTRY);
    #[cfg(test)]
    if take_journal_test_fault(JournalTestFault::ForceInstallConflict) {
        return Ok(ConditionalMutationResult::Conflict);
    }
    fail_on_journal_test_fault!(InstallBeforeRename, PosixStoreError::Lost);
    let result = match expected.state {
        JournalRevisionState::Missing => rustix_fs::renameat_with(
            directory_file,
            candidate.name.as_os_str(),
            directory_file,
            destination,
            RenameFlags::NOREPLACE,
        ),
        JournalRevisionState::Present(attestation) => {
            if !journal_exact_current_file(
                directory_file,
                destination,
                attestation.security.identity,
                directory.core.process.uid,
            )? {
                return Ok(ConditionalMutationResult::Conflict);
            }
            rustix_fs::renameat(
                directory_file,
                candidate.name.as_os_str(),
                directory_file,
                destination,
            )
        }
    };
    if let Err(error) = result {
        if error == Errno::EXIST {
            return Ok(ConditionalMutationResult::Conflict);
        }
        if error == Errno::NOSYS || error == Errno::INVAL || error == Errno::NOTSUP {
            return Err(PosixStoreError::Unsupported);
        }
        return Err(PosixStoreError::Lost);
    }
    fail_on_journal_test_fault!(InstallAfterRename, PosixStoreError::Lost);
    if !entry_is_missing_at(directory_file, candidate.name.as_os_str())?
        || !journal_exact_current_file(
            directory_file,
            destination,
            candidate.identity,
            directory.core.process.uid,
        )?
    {
        return Err(PosixStoreError::Lost);
    }
    platform::sync_directory(directory_file)?;
    fail_on_journal_test_fault!(InstallAfterDirectorySync, PosixStoreError::Lost);
    directory.core.require_secure_locked(&state)?;
    Ok(ConditionalMutationResult::Applied)
}

impl JournalLeaseCore {
    fn verify_held_locked(&self, runtime: &JournalLeaseRuntime) -> Result<(), PosixStoreError> {
        match runtime.status {
            JournalLeaseStatus::Held => {}
            JournalLeaseStatus::Lost => return Err(PosixStoreError::Lost),
            JournalLeaseStatus::Terminal => return Err(PosixStoreError::Closed),
        }
        let directory = runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?;
        let lock = runtime.lock.as_ref().ok_or(PosixStoreError::Closed)?;
        if !exact_journal_lock(directory, lock)?
            || read_journal_lock_record(lock)? != JournalLockRecordState::Held(self.nonce)
        {
            return Err(PosixStoreError::Lost);
        }
        Ok(())
    }

    fn verify_or_latch_locked(
        &self,
        runtime: &mut JournalLeaseRuntime,
    ) -> Result<(), PosixStoreError> {
        if let Err(error) = self.verify_held_locked(runtime) {
            if runtime.status != JournalLeaseStatus::Terminal {
                runtime.status = JournalLeaseStatus::Lost;
            }
            return Err(error);
        }
        Ok(())
    }

    fn finish_locked(runtime: &mut JournalLeaseRuntime) {
        runtime.status = JournalLeaseStatus::Terminal;
        if let Some(mut directory) = runtime.directory.take() {
            directory.close();
        }
        if let Some(lock) = runtime.lock.take() {
            let _ = rustix_fs::flock(&lock, FlockOperation::Unlock);
        }
    }
}

pub(crate) fn acquire_reconciliation_journal_lease(
    path: &Path,
    nonce: &str,
) -> Result<ReconciliationJournalLeaseAcquireResult, PosixStoreError> {
    let nonce = ValidatedUuidV4::parse(nonce)?;
    let directory = match open_private_directory(path)? {
        PrivateDirectoryOpenResult::Missing => return Err(PosixStoreError::Missing),
        PrivateDirectoryOpenResult::Opened(directory) => directory,
    };
    let (lock, created_identity) = open_or_create_journal_lock(&directory)?;
    let lock_created = created_identity.is_some();
    match rustix_fs::flock(&lock, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => {}
        Err(error) if error == Errno::WOULDBLOCK || error == Errno::AGAIN => {
            return Ok(ReconciliationJournalLeaseAcquireResult::Busy);
        }
        Err(_) => return Err(PosixStoreError::Io),
    }
    if !exact_journal_lock(&directory, &lock)? {
        return Err(PosixStoreError::Unsafe);
    }

    let record = match read_journal_lock_record(&lock)? {
        JournalLockRecordState::Uninitialized => {
            initialize_journal_lock(&lock)?;
            fail_on_journal_test_fault!(AcquireAfterInitializedClean, PosixStoreError::Lost);
            JournalLockRecordState::Clean
        }
        record => record,
    };
    let prior = reconcile_abandoned_candidate(&directory, record)?;
    fail_on_journal_test_fault!(AcquireAfterRecovery, PosixStoreError::Lost);
    if record != JournalLockRecordState::Clean {
        write_journal_lock_state(&lock, JOURNAL_LOCK_STATE_CLEAN)?;
        fail_on_journal_test_fault!(AcquireAfterCleanTransition, PosixStoreError::Lost);
        if read_journal_lock_record(&lock)? != JournalLockRecordState::Clean {
            return Err(PosixStoreError::Lost);
        }
    }
    write_journal_held_record(&lock, nonce)?;

    if lock_created {
        let state = lock_unpoisoned(&directory.core.state)?;
        directory.core.require_secure_locked(&state)?;
        let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
        platform::sync_directory(directory_file)?;
        fail_on_journal_test_fault!(AcquireAfterCreatedLockDirectorySync, PosixStoreError::Lost);
    }
    if !exact_journal_lock(&directory, &lock)?
        || read_journal_lock_record(&lock)? != JournalLockRecordState::Held(nonce)
    {
        return Err(PosixStoreError::Lost);
    }

    Ok(ReconciliationJournalLeaseAcquireResult::Acquired {
        prior,
        lease: PosixReconciliationJournalLease {
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

impl PosixReconciliationJournalLease {
    fn verify_held(&self) -> Result<(), PosixStoreError> {
        let mut runtime = journal_lock_unpoisoned(&self.core.runtime)?;
        self.core.verify_or_latch_locked(&mut runtime)
    }

    pub(crate) fn renew(&self) -> LeaseRenewal {
        if self.verify_held().is_ok() {
            LeaseRenewal::Held
        } else {
            LeaseRenewal::Lost
        }
    }

    pub(crate) fn observe(&self) -> Result<JournalObservation, PosixStoreError> {
        let mut runtime = journal_lock_unpoisoned(&self.core.runtime)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let directory = runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?;
        let directory_attestation = directory.attest()?;
        let current = observed_journal(directory)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let revision_state = match &current {
            ObservedJournal::Missing => JournalRevisionState::Missing,
            ObservedJournal::Present(current) => JournalRevisionState::Present(current.attestation),
        };
        let revision = revision_for(
            &self.core,
            runtime.generation,
            directory_attestation.identity,
            revision_state,
        );
        match current {
            ObservedJournal::Missing => Ok(JournalObservation::Missing { revision }),
            ObservedJournal::Present(mut current) => Ok(JournalObservation::Present {
                revision,
                bytes: current.take_bytes(),
            }),
        }
    }

    pub(crate) fn replace(
        &self,
        expected: &JournalRevision,
        input: &[u8],
    ) -> Result<JournalReplaceResult, PosixStoreError> {
        if input.is_empty() {
            return Err(PosixStoreError::InvalidInput);
        }
        if input.len() > MAX_JOURNAL_BYTES {
            return Err(PosixStoreError::Limit);
        }
        let mut bytes = input.to_vec();
        let result = (|| {
            let mut runtime = journal_lock_unpoisoned(&self.core.runtime)?;
            self.core.verify_or_latch_locked(&mut runtime)?;
            let directory_attestation = runtime
                .directory
                .as_ref()
                .ok_or(PosixStoreError::Closed)?
                .attest()?;
            let initial =
                observed_journal(runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?)?;
            if !revision_matches(
                &self.core,
                &runtime,
                directory_attestation.identity,
                expected,
                &initial,
            ) {
                return Ok(JournalReplaceResult::Conflict);
            }
            drop(initial);

            let candidate = match create_prepared_candidate(
                runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?,
                self.core.nonce,
                &bytes,
            ) {
                Ok(candidate) => candidate,
                Err(error @ (PosixStoreError::Lost | PosixStoreError::Unsafe)) => {
                    mark_journal_lost(&mut runtime);
                    return Err(error);
                }
                Err(error) => return Err(error),
            };
            self.core.verify_or_latch_locked(&mut runtime)?;
            let current = match observed_journal(
                runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?,
            ) {
                Ok(current) => current,
                Err(error) => {
                    mark_journal_lost(&mut runtime);
                    return Err(error);
                }
            };
            if !revision_matches(
                &self.core,
                &runtime,
                directory_attestation.identity,
                expected,
                &current,
            ) {
                drop(current);
                let cleanup = cleanup_prepared_candidate(
                    runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?,
                    candidate.name.as_os_str(),
                    &candidate.file,
                    candidate.identity,
                );
                if cleanup.is_err() {
                    mark_journal_lost(&mut runtime);
                    return Err(PosixStoreError::Lost);
                }
                return Ok(JournalReplaceResult::Conflict);
            }
            drop(current);

            let installed = atomic_install_candidate(
                runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?,
                &candidate,
                expected,
            );
            match installed {
                Ok(ConditionalMutationResult::Applied) => {}
                Ok(ConditionalMutationResult::Conflict) => {
                    let cleanup = cleanup_prepared_candidate(
                        runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?,
                        candidate.name.as_os_str(),
                        &candidate.file,
                        candidate.identity,
                    );
                    if cleanup.is_err() {
                        mark_journal_lost(&mut runtime);
                        return Err(PosixStoreError::Lost);
                    }
                    return Ok(JournalReplaceResult::Conflict);
                }
                Err(error) => {
                    mark_journal_lost(&mut runtime);
                    return Err(error);
                }
            }
            #[cfg(test)]
            if take_journal_test_fault(JournalTestFault::ReplaceBeforeInstalledReadback) {
                mark_journal_lost(&mut runtime);
                return Err(PosixStoreError::Lost);
            }
            self.core.verify_or_latch_locked(&mut runtime)?;
            let installed = match observed_journal(
                runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?,
            ) {
                Ok(installed) => installed,
                Err(error) => {
                    mark_journal_lost(&mut runtime);
                    return Err(error);
                }
            };
            let installed_attestation = match &installed {
                ObservedJournal::Present(installed)
                    if installed.attestation.security.identity == candidate.identity
                        && installed.bytes == bytes =>
                {
                    installed.attestation
                }
                _ => {
                    mark_journal_lost(&mut runtime);
                    return Err(PosixStoreError::Lost);
                }
            };
            #[cfg(test)]
            if take_journal_test_fault(JournalTestFault::ReplaceAfterInstalledReadback) {
                mark_journal_lost(&mut runtime);
                return Err(PosixStoreError::Lost);
            }
            drop(installed);
            let generation = match next_journal_generation(&mut runtime) {
                Ok(generation) => generation,
                Err(error) => {
                    mark_journal_lost(&mut runtime);
                    return Err(error);
                }
            };
            let revision = revision_for(
                &self.core,
                generation,
                directory_attestation.identity,
                JournalRevisionState::Present(installed_attestation),
            );
            Ok(JournalReplaceResult::Replaced { revision })
        })();
        zeroize_bytes(bytes.as_mut_slice());
        result
    }

    pub(crate) fn remove(
        &self,
        expected: &JournalRevision,
    ) -> Result<JournalRemoveResult, PosixStoreError> {
        let mut runtime = journal_lock_unpoisoned(&self.core.runtime)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let directory_attestation = runtime
            .directory
            .as_ref()
            .ok_or(PosixStoreError::Closed)?
            .attest()?;
        let mut current =
            observed_journal(runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?)?;
        if !matches!(expected.state, JournalRevisionState::Present(_))
            || !revision_matches(
                &self.core,
                &runtime,
                directory_attestation.identity,
                expected,
                &current,
            )
        {
            return Ok(JournalRemoveResult::Conflict);
        }
        self.core.verify_or_latch_locked(&mut runtime)?;
        let directory_core = Arc::clone(
            &runtime
                .directory
                .as_ref()
                .ok_or(PosixStoreError::Closed)?
                .core,
        );
        let present = match &mut current {
            ObservedJournal::Present(present) => present,
            ObservedJournal::Missing => return Ok(JournalRemoveResult::Conflict),
        };
        let expected_identity = present.attestation.security.identity;
        let state = lock_unpoisoned(&directory_core.state)?;
        directory_core.require_secure_locked(&state)?;
        let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
        if !journal_exact_current_file(
            directory_file,
            OsStr::new(JOURNAL_ENTRY),
            expected_identity,
            directory_core.process.uid,
        )? {
            return Ok(JournalRemoveResult::Conflict);
        }
        fail_on_journal_test_fault!(RemoveBeforeUnlink, PosixStoreError::Io);
        if rustix_fs::unlinkat(directory_file, OsStr::new(JOURNAL_ENTRY), AtFlags::empty()).is_err()
        {
            drop(state);
            mark_journal_lost(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        #[cfg(test)]
        if take_journal_test_fault(JournalTestFault::RemoveAfterUnlink) {
            drop(state);
            mark_journal_lost(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        let postcondition: Result<bool, PosixStoreError> = (|| {
            let path_missing = entry_is_missing_at(directory_file, OsStr::new(JOURNAL_ENTRY))?;
            let slot = lock_unpoisoned(&present.file.slot)?;
            let retained = slot.as_ref().ok_or(PosixStoreError::Closed)?;
            let facts = metadata(retained)?;
            Ok(path_missing && facts.identity == expected_identity && facts.links == 0)
        })();
        if !matches!(postcondition, Ok(true)) {
            drop(state);
            mark_journal_lost(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        if platform::sync_directory(directory_file).is_err()
            || directory_core.require_secure_locked(&state).is_err()
        {
            drop(state);
            mark_journal_lost(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        #[cfg(test)]
        if take_journal_test_fault(JournalTestFault::RemoveAfterDirectorySync) {
            drop(state);
            mark_journal_lost(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        drop(state);
        drop(current);
        self.core.verify_or_latch_locked(&mut runtime)?;
        let observed = observed_journal(runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?);
        if !matches!(observed, Ok(ObservedJournal::Missing)) {
            mark_journal_lost(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        if next_journal_generation(&mut runtime).is_err() {
            mark_journal_lost(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        Ok(JournalRemoveResult::Removed)
    }

    pub(crate) fn release(&mut self) -> Result<(), PosixStoreError> {
        let (mut runtime, poisoned) = match self.core.runtime.lock() {
            Ok(runtime) => (runtime, false),
            Err(poisoned) => (poisoned.into_inner(), true),
        };
        if runtime.status == JournalLeaseStatus::Terminal {
            return Err(PosixStoreError::Closed);
        }
        if poisoned {
            runtime.status = JournalLeaseStatus::Lost;
            JournalLeaseCore::finish_locked(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        let result = (|| {
            self.core.verify_or_latch_locked(&mut runtime)?;
            if !list_journal_candidates(runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?)?
                .is_empty()
            {
                return Err(PosixStoreError::Lost);
            }
            let lock = runtime.lock.as_ref().ok_or(PosixStoreError::Closed)?;
            fail_on_journal_test_fault!(ReleaseBeforeCleanTransition, PosixStoreError::Lost);
            write_journal_lock_state(lock, JOURNAL_LOCK_STATE_CLEAN)?;
            fail_on_journal_test_fault!(ReleaseAfterCleanTransition, PosixStoreError::Lost);
            if read_journal_lock_record(lock)? != JournalLockRecordState::Clean {
                return Err(PosixStoreError::Lost);
            }
            Ok(())
        })();
        if result.is_err() {
            runtime.status = JournalLeaseStatus::Lost;
        }
        JournalLeaseCore::finish_locked(&mut runtime);
        result
    }

    pub(crate) fn abandon(&mut self) -> Result<(), PosixStoreError> {
        let (mut runtime, poisoned) = match self.core.runtime.lock() {
            Ok(runtime) => (runtime, false),
            Err(poisoned) => (poisoned.into_inner(), true),
        };
        if runtime.status == JournalLeaseStatus::Terminal {
            return Err(PosixStoreError::Closed);
        }
        JournalLeaseCore::finish_locked(&mut runtime);
        if poisoned {
            Err(PosixStoreError::Lost)
        } else {
            Ok(())
        }
    }
}

impl Drop for PosixReconciliationJournalLease {
    fn drop(&mut self) {
        let mut runtime = match self.core.runtime.lock() {
            Ok(runtime) => runtime,
            Err(poisoned) => poisoned.into_inner(),
        };
        if runtime.status != JournalLeaseStatus::Terminal {
            JournalLeaseCore::finish_locked(&mut runtime);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::os::unix::fs::{symlink, OpenOptionsExt, PermissionsExt};

    use super::super::tests::{acquired_lease, create_private_file, TestRoot};
    use super::*;

    const NONCE_1: &str = "b56c52f5-a090-41eb-a164-1c92e36db94f";
    const NONCE_2: &str = "4657f2a0-739f-4923-86e8-f25f1dc328f9";
    const NONCE_3: &str = "c5a8d21a-9679-43bd-93c7-2c476388d8aa";

    fn acquired(path: &Path, nonce: &str) -> (PriorLease, PosixReconciliationJournalLease) {
        match acquire_reconciliation_journal_lease(path, nonce)
            .expect("journal lease acquisition must complete")
        {
            ReconciliationJournalLeaseAcquireResult::Busy => {
                panic!("journal lease unexpectedly busy")
            }
            ReconciliationJournalLeaseAcquireResult::Acquired { prior, lease } => (prior, lease),
        }
    }

    fn missing(lease: &PosixReconciliationJournalLease) -> JournalRevision {
        match lease.observe().expect("missing journal must observe") {
            JournalObservation::Missing { revision } => revision,
            JournalObservation::Present { .. } => panic!("journal unexpectedly present"),
        }
    }

    fn present(lease: &PosixReconciliationJournalLease) -> (JournalRevision, Vec<u8>) {
        match lease.observe().expect("present journal must observe") {
            JournalObservation::Missing { .. } => panic!("journal unexpectedly missing"),
            JournalObservation::Present { revision, bytes } => (revision, bytes),
        }
    }

    fn replace(
        lease: &PosixReconciliationJournalLease,
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

    fn ready_test_root() -> TestRoot {
        let test = TestRoot::new();
        let (_, _, mut credential_lease) = acquired_lease(&test.store, NONCE_1);
        credential_lease
            .release()
            .expect("directory fixture lease must release");
        test
    }

    fn candidate_path(test: &TestRoot, nonce: &str) -> PathBuf {
        test.store.join(journal_candidate_name(
            ValidatedUuidV4::parse(nonce).expect("candidate nonce must validate"),
        ))
    }

    fn journal_lock_record(test: &TestRoot) -> JournalLockRecordState {
        let lock =
            File::open(test.store.join(JOURNAL_LOCK_ENTRY)).expect("journal lock record must open");
        read_journal_lock_record(&lock).expect("journal lock record must validate")
    }

    fn assert_held_record(test: &TestRoot, nonce: &str) {
        assert_eq!(
            journal_lock_record(test),
            JournalLockRecordState::Held(
                ValidatedUuidV4::parse(nonce).expect("held nonce must validate")
            )
        );
    }

    fn arm_fault(fault: JournalTestFault) {
        arm_journal_test_fault(fault);
    }

    fn assert_fault_consumed() {
        assert_journal_test_fault_consumed();
    }

    #[test]
    fn journal_requires_an_existing_protected_directory() {
        let test = TestRoot::new();
        assert!(matches!(
            acquire_reconciliation_journal_lease(&test.store, NONCE_1),
            Err(PosixStoreError::Missing)
        ));
        assert!(!test.store.exists());
    }

    #[test]
    fn acquire_faults_preserve_exact_recoverable_lock_record_transitions() {
        {
            let test = ready_test_root();
            arm_fault(JournalTestFault::AcquireAfterInitializedClean);
            assert!(matches!(
                acquire_reconciliation_journal_lease(&test.store, NONCE_1),
                Err(PosixStoreError::Lost)
            ));
            assert_fault_consumed();
            assert_eq!(journal_lock_record(&test), JournalLockRecordState::Clean);
            let (prior, mut recovered) = acquired(&test.store, NONCE_2);
            assert_eq!(prior, PriorLease::Absent);
            recovered.release().expect("clean lock must reacquire");
        }

        {
            let test = ready_test_root();
            arm_fault(JournalTestFault::AcquireAfterNonceSync);
            assert!(matches!(
                acquire_reconciliation_journal_lease(&test.store, NONCE_1),
                Err(PosixStoreError::Lost)
            ));
            assert_fault_consumed();
            assert_eq!(journal_lock_record(&test), JournalLockRecordState::Clean);
            let (prior, mut recovered) = acquired(&test.store, NONCE_2);
            assert_eq!(prior, PriorLease::Absent);
            recovered
                .release()
                .expect("clean nonce-payload interruption must reacquire");
        }

        for fault in [
            JournalTestFault::AcquireAfterHeldTransition,
            JournalTestFault::AcquireAfterCreatedLockDirectorySync,
        ] {
            let test = ready_test_root();
            arm_fault(fault);
            assert!(matches!(
                acquire_reconciliation_journal_lease(&test.store, NONCE_1),
                Err(PosixStoreError::Lost)
            ));
            assert_fault_consumed();
            assert_held_record(&test, NONCE_1);
            let (prior, mut recovered) = acquired(&test.store, NONCE_2);
            assert_eq!(prior, PriorLease::ProvenAbandoned);
            recovered
                .release()
                .expect("held acquisition interruption must recover");
        }

        {
            let test = ready_test_root();
            let (_, mut abandoned) = acquired(&test.store, NONCE_1);
            create_private_file(&candidate_path(&test, NONCE_1), b"recover-me");
            abandoned
                .abandon()
                .expect("recovery fixture lease must abandon");

            arm_fault(JournalTestFault::AcquireAfterRecovery);
            assert!(matches!(
                acquire_reconciliation_journal_lease(&test.store, NONCE_2),
                Err(PosixStoreError::Lost)
            ));
            assert_fault_consumed();
            assert!(!candidate_path(&test, NONCE_1).exists());
            assert_held_record(&test, NONCE_1);

            let (prior, mut recovered) = acquired(&test.store, NONCE_3);
            assert_eq!(prior, PriorLease::ProvenAbandoned);
            recovered
                .release()
                .expect("post-recovery interruption must recover again");
        }

        {
            let test = ready_test_root();
            let (_, mut abandoned) = acquired(&test.store, NONCE_1);
            abandoned
                .abandon()
                .expect("clean-transition fixture lease must abandon");

            arm_fault(JournalTestFault::AcquireAfterCleanTransition);
            assert!(matches!(
                acquire_reconciliation_journal_lease(&test.store, NONCE_2),
                Err(PosixStoreError::Lost)
            ));
            assert_fault_consumed();
            assert_eq!(journal_lock_record(&test), JournalLockRecordState::Clean);

            let (prior, mut recovered) = acquired(&test.store, NONCE_3);
            assert_eq!(prior, PriorLease::Absent);
            recovered
                .release()
                .expect("clean-transition interruption must reacquire");
        }
    }

    #[test]
    fn stable_observe_faults_never_return_partial_bytes_or_damage_the_journal() {
        let test = ready_test_root();
        let (_, mut lease) = acquired(&test.store, NONCE_1);
        let absent = missing(&lease);
        replace(&lease, &absent, b"stable-observation");

        for fault in [
            JournalTestFault::ObserveBeforeFirstAttestation,
            JournalTestFault::ObserveAfterFirstAttestation,
            JournalTestFault::ObserveAfterRead,
            JournalTestFault::ObserveAfterSecondAttestation,
        ] {
            arm_fault(fault);
            assert!(matches!(lease.observe(), Err(PosixStoreError::Io)));
            assert_fault_consumed();
            assert_eq!(lease.renew(), LeaseRenewal::Held);
            let (_, bytes) = present(&lease);
            assert_eq!(bytes, b"stable-observation");
            assert_eq!(
                fs::read(test.store.join(JOURNAL_ENTRY))
                    .expect("journal must remain directly readable"),
                b"stable-observation"
            );
        }
        lease
            .release()
            .expect("observation-fault lease must release");
    }

    #[test]
    fn pre_candidate_failure_is_non_mutating_and_keeps_the_lease_usable() {
        let test = ready_test_root();
        let (_, mut lease) = acquired(&test.store, NONCE_1);
        let absent = missing(&lease);

        arm_fault(JournalTestFault::CandidateBeforeCreate);
        assert!(matches!(
            lease.replace(&absent, b"never-created"),
            Err(PosixStoreError::Io)
        ));
        assert_fault_consumed();
        assert_eq!(lease.renew(), LeaseRenewal::Held);
        assert!(!candidate_path(&test, NONCE_1).exists());
        assert!(!test.store.join(JOURNAL_ENTRY).exists());
        assert!(matches!(
            lease.observe(),
            Ok(JournalObservation::Missing { .. })
        ));
        lease
            .release()
            .expect("pre-candidate failure must permit clean release");
    }

    #[test]
    fn candidate_preparation_uncertainties_latch_lost_and_recover_exact_residue() {
        for fault in [
            JournalTestFault::CandidateAfterCreate,
            JournalTestFault::CandidateAfterWrite,
            JournalTestFault::CandidateAfterReadback,
            JournalTestFault::CandidateAfterFileSync,
        ] {
            let test = ready_test_root();
            let (_, lease) = acquired(&test.store, NONCE_1);
            let absent = missing(&lease);

            arm_fault(fault);
            assert!(matches!(
                lease.replace(&absent, b"candidate-payload"),
                Err(PosixStoreError::Lost)
            ));
            assert_fault_consumed();
            assert_eq!(lease.renew(), LeaseRenewal::Lost);
            assert_held_record(&test, NONCE_1);
            assert!(
                candidate_path(&test, NONCE_1).exists(),
                "{fault:?} must preserve the exact interrupted candidate"
            );
            assert!(!test.store.join(JOURNAL_ENTRY).exists());
            drop(lease);

            let (prior, mut recovered) = acquired(&test.store, NONCE_2);
            assert_eq!(prior, PriorLease::ProvenAbandoned);
            assert!(!candidate_path(&test, NONCE_1).exists());
            assert!(matches!(
                recovered.observe(),
                Ok(JournalObservation::Missing { .. })
            ));
            recovered
                .release()
                .expect("candidate uncertainty must recover");
        }
    }

    #[test]
    fn install_uncertainties_distinguish_precommit_residue_from_committed_journal() {
        for fault in [
            JournalTestFault::InstallBeforeRename,
            JournalTestFault::InstallAfterRename,
            JournalTestFault::InstallAfterDirectorySync,
            JournalTestFault::ReplaceBeforeInstalledReadback,
            JournalTestFault::ReplaceAfterInstalledReadback,
        ] {
            let test = ready_test_root();
            let (_, lease) = acquired(&test.store, NONCE_1);
            let absent = missing(&lease);

            arm_fault(fault);
            assert!(matches!(
                lease.replace(&absent, b"installed-payload"),
                Err(PosixStoreError::Lost)
            ));
            assert_fault_consumed();
            assert_eq!(lease.renew(), LeaseRenewal::Lost);
            assert_held_record(&test, NONCE_1);

            let before_commit = fault == JournalTestFault::InstallBeforeRename;
            assert_eq!(
                candidate_path(&test, NONCE_1).exists(),
                before_commit,
                "{fault:?} candidate residue must identify the commit boundary"
            );
            assert_eq!(
                test.store.join(JOURNAL_ENTRY).exists(),
                !before_commit,
                "{fault:?} installed path must identify the commit boundary"
            );
            if !before_commit {
                assert_eq!(
                    fs::read(test.store.join(JOURNAL_ENTRY))
                        .expect("committed journal must remain readable"),
                    b"installed-payload"
                );
            }
            drop(lease);

            let (prior, mut recovered) = acquired(&test.store, NONCE_2);
            assert_eq!(prior, PriorLease::ProvenAbandoned);
            assert!(!candidate_path(&test, NONCE_1).exists());
            match recovered.observe().expect("recovered journal must observe") {
                JournalObservation::Missing { .. } => assert!(before_commit),
                JournalObservation::Present { bytes, .. } => {
                    assert!(!before_commit);
                    assert_eq!(bytes, b"installed-payload");
                }
            }
            recovered
                .release()
                .expect("install uncertainty must recover");
        }
    }

    #[test]
    fn immediate_install_conflict_cleans_candidate_without_losing_the_lease() {
        let test = ready_test_root();
        let (_, mut lease) = acquired(&test.store, NONCE_1);
        let absent = missing(&lease);

        arm_fault(JournalTestFault::ForceInstallConflict);
        assert!(matches!(
            lease.replace(&absent, b"conflicting-payload"),
            Ok(JournalReplaceResult::Conflict)
        ));
        assert_fault_consumed();
        assert_eq!(lease.renew(), LeaseRenewal::Held);
        assert!(!candidate_path(&test, NONCE_1).exists());
        assert!(!test.store.join(JOURNAL_ENTRY).exists());
        assert!(matches!(
            lease.observe(),
            Ok(JournalObservation::Missing { .. })
        ));
        lease
            .release()
            .expect("clean conflict handling must permit release");
    }

    #[test]
    fn remove_faults_preserve_the_preunlink_value_or_recover_committed_absence() {
        {
            let test = ready_test_root();
            let (_, mut lease) = acquired(&test.store, NONCE_1);
            let absent = missing(&lease);
            let installed = replace(&lease, &absent, b"remove-me");

            arm_fault(JournalTestFault::RemoveBeforeUnlink);
            assert!(matches!(lease.remove(&installed), Err(PosixStoreError::Io)));
            assert_fault_consumed();
            assert_eq!(lease.renew(), LeaseRenewal::Held);
            let (current, bytes) = present(&lease);
            assert_eq!(bytes, b"remove-me");
            assert!(matches!(
                lease.remove(&current),
                Ok(JournalRemoveResult::Removed)
            ));
            lease
                .release()
                .expect("pre-unlink failure must permit clean recovery");
        }

        for fault in [
            JournalTestFault::RemoveAfterUnlink,
            JournalTestFault::RemoveAfterDirectorySync,
        ] {
            let test = ready_test_root();
            let (_, lease) = acquired(&test.store, NONCE_1);
            let absent = missing(&lease);
            let installed = replace(&lease, &absent, b"remove-me");

            arm_fault(fault);
            assert!(matches!(
                lease.remove(&installed),
                Err(PosixStoreError::Lost)
            ));
            assert_fault_consumed();
            assert_eq!(lease.renew(), LeaseRenewal::Lost);
            assert_held_record(&test, NONCE_1);
            assert!(!test.store.join(JOURNAL_ENTRY).exists());
            drop(lease);

            let (prior, mut recovered) = acquired(&test.store, NONCE_2);
            assert_eq!(prior, PriorLease::ProvenAbandoned);
            assert!(matches!(
                recovered.observe(),
                Ok(JournalObservation::Missing { .. })
            ));
            recovered
                .release()
                .expect("post-unlink uncertainty must recover");
        }
    }

    #[test]
    fn abandoned_candidate_cleanup_faults_remain_bound_to_the_held_nonce() {
        for fault in [
            JournalTestFault::RecoveryBeforeCandidateUnlink,
            JournalTestFault::RecoveryAfterCandidateUnlink,
            JournalTestFault::RecoveryAfterDirectorySync,
        ] {
            let test = ready_test_root();
            let (_, mut abandoned) = acquired(&test.store, NONCE_1);
            create_private_file(&candidate_path(&test, NONCE_1), b"recover-me");
            abandoned
                .abandon()
                .expect("recovery-fault fixture lease must abandon");

            arm_fault(fault);
            assert!(matches!(
                acquire_reconciliation_journal_lease(&test.store, NONCE_2),
                Err(PosixStoreError::Io | PosixStoreError::Lost)
            ));
            assert_fault_consumed();
            assert_held_record(&test, NONCE_1);
            assert_eq!(
                candidate_path(&test, NONCE_1).exists(),
                fault == JournalTestFault::RecoveryBeforeCandidateUnlink
            );

            let (prior, mut recovered) = acquired(&test.store, NONCE_3);
            assert_eq!(prior, PriorLease::ProvenAbandoned);
            assert!(!candidate_path(&test, NONCE_1).exists());
            recovered
                .release()
                .expect("recovery-cleanup interruption must recover");
        }
    }

    #[test]
    fn release_faults_make_the_held_to_clean_commit_boundary_explicit() {
        {
            let test = ready_test_root();
            let (_, mut lease) = acquired(&test.store, NONCE_1);
            arm_fault(JournalTestFault::ReleaseBeforeCleanTransition);
            assert_eq!(lease.release(), Err(PosixStoreError::Lost));
            assert_fault_consumed();
            assert_held_record(&test, NONCE_1);

            let (prior, mut recovered) = acquired(&test.store, NONCE_2);
            assert_eq!(prior, PriorLease::ProvenAbandoned);
            recovered
                .release()
                .expect("pre-clean release interruption must recover");
        }

        {
            let test = ready_test_root();
            let (_, mut lease) = acquired(&test.store, NONCE_1);
            arm_fault(JournalTestFault::ReleaseAfterCleanTransition);
            assert_eq!(lease.release(), Err(PosixStoreError::Lost));
            assert_fault_consumed();
            assert_eq!(journal_lock_record(&test), JournalLockRecordState::Clean);

            let (prior, mut recovered) = acquired(&test.store, NONCE_2);
            assert_eq!(prior, PriorLease::Absent);
            recovered
                .release()
                .expect("post-clean release interruption must reacquire");
        }
    }

    #[test]
    fn uninitialized_journal_lock_recovers_after_a_partial_initialization() {
        let test = TestRoot::new();
        let (_, _, mut credential_lease) = acquired_lease(&test.store, NONCE_1);
        credential_lease
            .release()
            .expect("directory fixture lease must release");

        let mut partial_record = [0_u8; JOURNAL_LOCK_RECORD_LENGTH];
        partial_record[0] = JOURNAL_LOCK_STATE_UNINITIALIZED;
        let initialized_header_bytes = JOURNAL_LOCK_HEADER.len() / 2;
        partial_record
            [JOURNAL_LOCK_HEADER_START..JOURNAL_LOCK_HEADER_START + initialized_header_bytes]
            .copy_from_slice(&JOURNAL_LOCK_HEADER[..initialized_header_bytes]);
        create_private_file(
            &test.store.join(JOURNAL_LOCK_ENTRY),
            partial_record.as_slice(),
        );

        let (prior, mut journal_lease) = acquired(&test.store, NONCE_2);
        assert_eq!(prior, PriorLease::Absent);
        assert_eq!(journal_lease.renew(), LeaseRenewal::Held);
        journal_lease
            .release()
            .expect("recovered journal lease must release");

        let lock = File::open(test.store.join(JOURNAL_LOCK_ENTRY))
            .expect("recovered journal lock must open");
        assert_eq!(
            read_journal_lock_record(&lock),
            Ok(JournalLockRecordState::Clean)
        );

        let mut corrupt_record = partial_record;
        corrupt_record[JOURNAL_LOCK_HEADER_START] = b'x';
        let writable = OpenOptions::new()
            .read(true)
            .write(true)
            .open(test.store.join(JOURNAL_LOCK_ENTRY))
            .expect("journal lock fixture must open for corruption");
        write_all_at(&writable, &corrupt_record, 0)
            .expect("corrupt journal lock fixture must write");
        platform::sync_file(&writable).expect("corrupt journal lock fixture must sync");
        assert!(matches!(
            acquire_reconciliation_journal_lease(&test.store, NONCE_3),
            Err(PosixStoreError::Unsafe)
        ));
    }

    #[test]
    fn credential_and_journal_locks_nest_but_journal_writers_serialize() {
        let test = TestRoot::new();
        let (_, _, mut credential_lease) = acquired_lease(&test.store, NONCE_1);
        let (prior, mut journal_lease) = acquired(&test.store, NONCE_2);
        assert_eq!(prior, PriorLease::Absent);
        assert_eq!(credential_lease.renew(), LeaseRenewal::Held);
        assert_eq!(journal_lease.renew(), LeaseRenewal::Held);
        assert!(matches!(
            acquire_reconciliation_journal_lease(&test.store, NONCE_3),
            Ok(ReconciliationJournalLeaseAcquireResult::Busy)
        ));
        journal_lease.release().expect("journal lease must release");
        credential_lease
            .release()
            .expect("credential lease must release");
    }

    #[test]
    fn revisions_are_generation_and_lease_scoped_and_removal_is_exact() {
        let test = TestRoot::new();
        let (_, _, mut credential_lease) = acquired_lease(&test.store, NONCE_1);
        credential_lease
            .release()
            .expect("directory fixture lease must release");

        let (_, mut first) = acquired(&test.store, NONCE_1);
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

        let (_, mut second) = acquired(&test.store, NONCE_2);
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
    fn journal_byte_bounds_are_exact_and_conflicts_never_truncate() {
        let test = TestRoot::new();
        let (_, _, mut credential_lease) = acquired_lease(&test.store, NONCE_1);
        credential_lease
            .release()
            .expect("directory fixture lease must release");
        let (_, mut lease) = acquired(&test.store, NONCE_1);
        let absent = missing(&lease);
        assert!(matches!(
            lease.replace(&absent, b""),
            Err(PosixStoreError::InvalidInput)
        ));
        assert!(matches!(
            lease.replace(&absent, &vec![b'x'; MAX_JOURNAL_BYTES + 1]),
            Err(PosixStoreError::Limit)
        ));
        assert!(!test
            .store
            .join(journal_candidate_name(
                ValidatedUuidV4::parse(NONCE_1).expect("nonce must validate")
            ))
            .exists());

        let maximum = vec![b'm'; MAX_JOURNAL_BYTES];
        let installed = replace(&lease, &absent, &maximum);
        let (observed, bytes) = present(&lease);
        assert_eq!(bytes, maximum);
        assert!(matches!(
            lease.replace(&absent, b"stale"),
            Ok(JournalReplaceResult::Conflict)
        ));
        assert!(matches!(
            lease.remove(&installed),
            Ok(JournalRemoveResult::Removed)
        ));
        assert!(matches!(
            lease.remove(&observed),
            Ok(JournalRemoveResult::Conflict)
        ));
        lease.release().expect("bounded journal lease must release");
    }

    #[test]
    fn abandoned_exact_nonce_candidate_is_removed_and_other_candidates_block() {
        let test = TestRoot::new();
        let (_, _, mut credential_lease) = acquired_lease(&test.store, NONCE_1);
        credential_lease
            .release()
            .expect("directory fixture lease must release");

        let (_, mut abandoned) = acquired(&test.store, NONCE_1);
        let exact_name =
            journal_candidate_name(ValidatedUuidV4::parse(NONCE_1).expect("nonce must validate"));
        create_private_file(&test.store.join(&exact_name), b"partial-candidate");
        abandoned.abandon().expect("fixture lease must abandon");
        let (prior, mut recovered) = acquired(&test.store, NONCE_2);
        assert_eq!(prior, PriorLease::ProvenAbandoned);
        assert!(!test.store.join(exact_name).exists());
        recovered.release().expect("recovered lease must release");

        let (_, mut second_abandoned) = acquired(&test.store, NONCE_1);
        let foreign_name =
            journal_candidate_name(ValidatedUuidV4::parse(NONCE_3).expect("nonce must validate"));
        create_private_file(&test.store.join(&foreign_name), b"foreign-candidate");
        second_abandoned
            .abandon()
            .expect("second fixture lease must abandon");
        assert!(matches!(
            acquire_reconciliation_journal_lease(&test.store, NONCE_2),
            Err(PosixStoreError::Unsafe)
        ));
        assert_eq!(
            fs::read(test.store.join(&foreign_name))
                .expect("foreign candidate must remain untouched"),
            b"foreign-candidate"
        );
        fs::remove_file(test.store.join(foreign_name))
            .expect("foreign candidate fixture must be removed");
        let (_, mut final_lease) = acquired(&test.store, NONCE_2);
        final_lease.release().expect("final lease must release");
    }

    #[test]
    fn clean_release_refuses_and_preserves_a_held_exact_nonce_candidate() {
        let test = TestRoot::new();
        let (_, _, mut credential_lease) = acquired_lease(&test.store, NONCE_1);
        credential_lease
            .release()
            .expect("directory fixture lease must release");

        let (_, mut interrupted) = acquired(&test.store, NONCE_1);
        let exact_name =
            journal_candidate_name(ValidatedUuidV4::parse(NONCE_1).expect("nonce must validate"));
        create_private_file(&test.store.join(&exact_name), b"interrupted-write");

        assert_eq!(interrupted.release(), Err(PosixStoreError::Lost));
        assert_eq!(
            fs::read(test.store.join(&exact_name))
                .expect("refused release must preserve the exact candidate"),
            b"interrupted-write"
        );
        let lock = File::open(test.store.join(JOURNAL_LOCK_ENTRY))
            .expect("refused release must preserve the journal lock");
        assert_eq!(
            read_journal_lock_record(&lock),
            Ok(JournalLockRecordState::Held(
                ValidatedUuidV4::parse(NONCE_1).expect("nonce must validate")
            ))
        );
        drop(lock);

        let (prior, mut recovered) = acquired(&test.store, NONCE_2);
        assert_eq!(prior, PriorLease::ProvenAbandoned);
        assert!(!test.store.join(exact_name).exists());
        recovered.release().expect("recovered lease must release");
    }

    #[test]
    fn unsafe_journal_lock_slot_and_candidate_never_touch_outside_files() {
        let test = TestRoot::new();
        let (_, _, mut credential_lease) = acquired_lease(&test.store, NONCE_1);
        credential_lease
            .release()
            .expect("directory fixture lease must release");
        symlink(&test.outside, test.store.join(JOURNAL_LOCK_ENTRY))
            .expect("unsafe journal lock symlink must be created");
        assert!(matches!(
            acquire_reconciliation_journal_lease(&test.store, NONCE_1),
            Err(PosixStoreError::Unsafe)
        ));
        assert_eq!(
            fs::read_to_string(&test.outside).expect("outside canary must remain readable"),
            "outside-canary\n"
        );
        fs::remove_file(test.store.join(JOURNAL_LOCK_ENTRY))
            .expect("unsafe journal lock symlink must be removed");

        let (_, mut abandoned) = acquired(&test.store, NONCE_1);
        let candidate =
            journal_candidate_name(ValidatedUuidV4::parse(NONCE_1).expect("nonce must validate"));
        symlink(&test.outside, test.store.join(&candidate))
            .expect("unsafe candidate symlink must be created");
        abandoned
            .abandon()
            .expect("unsafe-candidate fixture lease must abandon");
        assert!(matches!(
            acquire_reconciliation_journal_lease(&test.store, NONCE_2),
            Err(PosixStoreError::Unsafe)
        ));
        assert_eq!(
            fs::read_to_string(&test.outside).expect("outside canary must remain readable"),
            "outside-canary\n"
        );
        fs::remove_file(test.store.join(candidate))
            .expect("unsafe candidate symlink must be removed");
        let (_, mut recovered) = acquired(&test.store, NONCE_2);
        recovered.release().expect("safe recovery must release");
    }

    #[test]
    fn unsafe_journal_objects_are_rejected_without_following_links() {
        let test = TestRoot::new();
        let (_, _, mut credential_lease) = acquired_lease(&test.store, NONCE_1);
        credential_lease
            .release()
            .expect("directory fixture lease must release");
        let (_, mut lease) = acquired(&test.store, NONCE_1);

        symlink(&test.outside, test.store.join(JOURNAL_ENTRY))
            .expect("unsafe journal symlink must be created");
        assert!(matches!(lease.observe(), Err(PosixStoreError::Unsafe)));
        assert_eq!(
            fs::read_to_string(&test.outside).expect("outside canary must remain readable"),
            "outside-canary\n"
        );
        fs::remove_file(test.store.join(JOURNAL_ENTRY))
            .expect("unsafe journal symlink must be removed");

        let hard_link_source = test.root.join("journal-hard-link-source");
        create_private_file(&hard_link_source, b"hard-linked");
        fs::hard_link(&hard_link_source, test.store.join(JOURNAL_ENTRY))
            .expect("hard-linked journal fixture must be created");
        assert!(matches!(lease.observe(), Err(PosixStoreError::Unsafe)));
        assert_eq!(
            fs::read(&hard_link_source).expect("hard-link source must remain readable"),
            b"hard-linked"
        );
        fs::remove_file(test.store.join(JOURNAL_ENTRY))
            .expect("hard-linked journal fixture must be removed");
        fs::remove_file(hard_link_source).expect("hard-link source fixture must be removed");

        let broad = test.store.join(JOURNAL_ENTRY);
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o644)
            .open(&broad)
            .expect("broad-mode journal fixture must be created");
        file.write_all(b"broad").expect("broad fixture must write");
        file.sync_all().expect("broad fixture must sync");
        fs::set_permissions(&broad, fs::Permissions::from_mode(0o644))
            .expect("broad fixture mode must be exact");
        assert!(matches!(lease.observe(), Err(PosixStoreError::Unsafe)));
        lease.release().expect("unsafe-object lease must release");
        fs::remove_file(broad).expect("broad fixture must be removed");
    }
}
