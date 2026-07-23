use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsHandle;
use std::sync::{Arc, Weak};

use plurum_windows_syscall::{
    create_private_file, flush_file, remove_by_handle, rename_by_handle, FileCreateAttempt,
    MutationAttempt,
};

use super::*;

const TRANSACTION_ENTRY: &str = "credentials-transaction.json";
const CREDENTIAL_CANDIDATE_PREFIX: &str = ".credentials-candidate-";
const TRANSACTION_CANDIDATE_PREFIX: &str = ".credentials-transaction-";
const RECOVERY_CANDIDATE_PREFIX: &str = ".credentials-recovery-";
const TEMPORARY_SUFFIX: &str = ".tmp";
const MAX_CREDENTIAL_BYTES: usize = 16_384;
const MAX_TRANSACTION_BYTES: usize = 40_960;
const MAX_DIRECTORY_ENTRIES: usize = 4_096;
const MAX_TEMPORARY_ENTRIES: usize = 1_024;

#[cfg(test)]
const TEST_FAULT_WRITE_AFTER_TRUNCATE: u8 = 1;
#[cfg(test)]
const TEST_FAULT_SYNC_AFTER_FLUSH: u8 = 2;

#[cfg(test)]
thread_local! {
    static TEST_FAULT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn inject_test_fault(fault: u8) {
    TEST_FAULT.with(|slot| {
        assert_eq!(slot.replace(fault), 0, "test fault already armed");
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CanonicalEntryRole {
    Credential,
    Transaction,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TemporaryEntryRole {
    Credential,
    Transaction,
    Recovery,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TemporaryEntry {
    role: TemporaryEntryRole,
    transaction_id: ValidatedUuidV4,
}

impl TemporaryEntry {
    pub(crate) fn parse(
        role: TemporaryEntryRole,
        transaction_id: &str,
    ) -> Result<Self, WindowsStoreError> {
        Ok(Self {
            role,
            transaction_id: ValidatedUuidV4::parse(transaction_id)?,
        })
    }

    pub(crate) fn role(self) -> TemporaryEntryRole {
        self.role
    }

    pub(crate) fn transaction_id(&self) -> &str {
        std::str::from_utf8(&self.transaction_id.0)
            .expect("validated UUIDv4 bytes are always ASCII")
    }

    fn prefix(self) -> &'static str {
        match self.role {
            TemporaryEntryRole::Credential => CREDENTIAL_CANDIDATE_PREFIX,
            TemporaryEntryRole::Transaction => TRANSACTION_CANDIDATE_PREFIX,
            TemporaryEntryRole::Recovery => RECOVERY_CANDIDATE_PREFIX,
        }
    }

    fn file_name(self) -> OsString {
        let id = std::str::from_utf8(&self.transaction_id.0)
            .expect("validated UUID bytes are always ASCII");
        OsString::from(format!("{}{id}{TEMPORARY_SUFFIX}", self.prefix()))
    }

    fn from_file_name(name: &OsStr) -> Option<Self> {
        let value = name.to_str()?;
        for (role, prefix) in [
            (TemporaryEntryRole::Credential, CREDENTIAL_CANDIDATE_PREFIX),
            (
                TemporaryEntryRole::Transaction,
                TRANSACTION_CANDIDATE_PREFIX,
            ),
            (TemporaryEntryRole::Recovery, RECOVERY_CANDIDATE_PREFIX),
        ] {
            let expected_length = prefix.len() + LOCK_NONCE_LENGTH + TEMPORARY_SUFFIX.len();
            if value.len() != expected_length
                || !value.starts_with(prefix)
                || !value.ends_with(TEMPORARY_SUFFIX)
            {
                continue;
            }
            let transaction_id = &value[prefix.len()..prefix.len() + LOCK_NONCE_LENGTH];
            return Self::parse(role, transaction_id).ok();
        }
        None
    }

    fn max_bytes(self) -> usize {
        if self.role == TemporaryEntryRole::Transaction {
            MAX_TRANSACTION_BYTES
        } else {
            MAX_CREDENTIAL_BYTES
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ManagedEntry {
    Canonical(CanonicalEntryRole),
    Temporary(TemporaryEntry),
}

impl ManagedEntry {
    pub(crate) fn credential() -> Self {
        Self::Canonical(CanonicalEntryRole::Credential)
    }

    fn file_name(self) -> OsString {
        match self {
            Self::Canonical(CanonicalEntryRole::Credential) => OsString::from(CREDENTIAL_ENTRY),
            Self::Canonical(CanonicalEntryRole::Transaction) => OsString::from(TRANSACTION_ENTRY),
            Self::Temporary(entry) => entry.file_name(),
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            Self::Canonical(CanonicalEntryRole::Transaction)
            | Self::Temporary(TemporaryEntry {
                role: TemporaryEntryRole::Transaction,
                ..
            }) => MAX_TRANSACTION_BYTES,
            _ => MAX_CREDENTIAL_BYTES,
        }
    }
}

struct SnapshotScope {
    lease: Weak<LeaseCore>,
    generation: u64,
    directory_identity: ObjectIdentity,
    entry: ManagedEntry,
}

pub(crate) struct MissingEntrySnapshot {
    scope: SnapshotScope,
}

pub(crate) struct PresentEntrySnapshot {
    scope: SnapshotScope,
    attestation: CredentialFileAttestation,
}

#[derive(Clone, Copy)]
pub(crate) enum ExpectedEntrySnapshot<'a> {
    Missing(&'a MissingEntrySnapshot),
    Present(&'a PresentEntrySnapshot),
}

pub(crate) enum ManagedEntryObservation {
    Missing {
        snapshot: MissingEntrySnapshot,
    },
    Opened {
        snapshot: Box<PresentEntrySnapshot>,
        attestation: CredentialFileAttestation,
        file: WindowsLeaseReadHandle,
    },
}

impl ManagedEntryObservation {
    pub(crate) fn is_missing(&self) -> bool {
        matches!(self, Self::Missing { .. })
    }
}

pub(crate) enum ExclusiveCreateResult {
    Conflict,
    Created(WindowsExclusiveWriteHandle),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConditionalMutationResult {
    Applied,
    Conflict,
}

enum CurrentEntry {
    Missing,
    Present {
        file: WindowsCredentialReadHandle,
        attestation: CredentialFileAttestation,
    },
}

fn scope_matches(
    lease: &Arc<LeaseCore>,
    runtime: &LeaseRuntime,
    directory: DirectoryAttestation,
    entry: ManagedEntry,
    scope: &SnapshotScope,
) -> bool {
    scope.generation == runtime.generation
        && scope.directory_identity == directory.identity
        && scope.entry == entry
        && scope
            .lease
            .upgrade()
            .is_some_and(|snapshot_lease| Arc::ptr_eq(&snapshot_lease, lease))
}

fn mark_lost(runtime: &mut LeaseRuntime) {
    if runtime.status != LeaseStatus::Terminal {
        runtime.status = LeaseStatus::Lost;
    }
}

fn lock_lease_runtime(
    lease: &LeaseCore,
) -> Result<MutexGuard<'_, LeaseRuntime>, WindowsStoreError> {
    match lease.runtime.lock() {
        Ok(runtime) => Ok(runtime),
        Err(poisoned) => {
            let mut runtime = poisoned.into_inner();
            if runtime.status == LeaseStatus::Terminal {
                Err(WindowsStoreError::Closed)
            } else {
                mark_lost(&mut runtime);
                Err(WindowsStoreError::Lost)
            }
        }
    }
}

fn next_generation(runtime: &mut LeaseRuntime) -> Result<u64, WindowsStoreError> {
    let next = runtime
        .generation
        .checked_add(1)
        .ok_or(WindowsStoreError::Lost)?;
    runtime.generation = next;
    Ok(next)
}

fn current_entry(
    directory: &WindowsPrivateDirectory,
    entry: ManagedEntry,
) -> Result<CurrentEntry, WindowsStoreError> {
    let name = entry.file_name();
    match directory.open_managed_read_only(name.as_os_str())? {
        CredentialReadOpenResult::Missing => Ok(CurrentEntry::Missing),
        CredentialReadOpenResult::Opened(mut file) => match file.attest() {
            Ok(attestation) => Ok(CurrentEntry::Present { file, attestation }),
            Err(error) => {
                file.close();
                Err(error)
            }
        },
    }
}

fn entry_is_missing(directory: &DirectoryCore, name: &OsStr) -> Result<bool, WindowsStoreError> {
    let path = directory.path.path.join(name);
    match open_file_nofollow(&path, false, true, false) {
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

fn exact_current_file(
    directory: &DirectoryCore,
    name: &OsStr,
    expected: ObjectIdentity,
) -> Result<bool, WindowsStoreError> {
    let path = directory.path.path.join(name);
    let opened = match open_file_nofollow(&path, false, true, false) {
        Ok(opened) => opened,
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
    let facts = metadata(&opened)?;
    let security = attest_security(opened.as_handle(), &directory.process, SecurityKind::File)
        .map_err(map_win)?;
    Ok(facts.identity == expected
        && facts.exact_file()
        && security.owner_current
        && security.exact_protected_dacl
        && security.semantic_medium_label)
}

fn expected_matches(
    lease: &Arc<LeaseCore>,
    runtime: &LeaseRuntime,
    directory: DirectoryAttestation,
    entry: ManagedEntry,
    expected: ExpectedEntrySnapshot<'_>,
    current: &CurrentEntry,
) -> bool {
    match (expected, current) {
        (ExpectedEntrySnapshot::Missing(snapshot), CurrentEntry::Missing) => {
            scope_matches(lease, runtime, directory, entry, &snapshot.scope)
        }
        (ExpectedEntrySnapshot::Present(snapshot), CurrentEntry::Present { attestation, .. }) => {
            scope_matches(lease, runtime, directory, entry, &snapshot.scope)
                && snapshot.attestation == *attestation
        }
        _ => false,
    }
}

pub(crate) struct WindowsLeaseReadHandle {
    lease: Weak<LeaseCore>,
    entry: ManagedEntry,
    file: WindowsCredentialReadHandle,
    closed: bool,
}

impl WindowsLeaseReadHandle {
    fn with_live<T>(
        &self,
        operation: impl FnOnce(&WindowsCredentialReadHandle) -> Result<T, WindowsStoreError>,
    ) -> Result<T, WindowsStoreError> {
        if self.closed {
            return Err(WindowsStoreError::Closed);
        }
        let lease = self.lease.upgrade().ok_or(WindowsStoreError::Closed)?;
        let mut runtime = lock_lease_runtime(&lease)?;
        lease.verify_or_latch_locked(&mut runtime)?;
        operation(&self.file)
    }

    pub(crate) fn attest(&self) -> Result<CredentialFileAttestation, WindowsStoreError> {
        self.with_live(WindowsCredentialReadHandle::attest)
    }

    pub(crate) fn read_bounded(&self, max_bytes: usize) -> Result<BoundedRead, WindowsStoreError> {
        if max_bytes > self.entry.max_bytes() + 1 {
            return Err(WindowsStoreError::Limit);
        }
        self.with_live(|file| file.read_bounded(max_bytes))
    }

    pub(crate) fn close(&mut self) -> Result<(), WindowsStoreError> {
        if self.closed {
            return Err(WindowsStoreError::Closed);
        }
        self.closed = true;
        self.file.close();
        Ok(())
    }
}

impl Drop for WindowsLeaseReadHandle {
    fn drop(&mut self) {
        if !self.closed {
            self.file.close();
            self.closed = true;
        }
    }
}

pub(crate) struct WindowsExclusiveWriteHandle {
    lease: Weak<LeaseCore>,
    generation: u64,
    max_bytes: usize,
    file: WindowsCredentialReadHandle,
    write_started: bool,
    write_complete: bool,
    closed: bool,
}

impl WindowsExclusiveWriteHandle {
    fn with_live<T>(
        &self,
        operation: impl FnOnce(&WindowsCredentialReadHandle) -> Result<T, WindowsStoreError>,
    ) -> Result<T, WindowsStoreError> {
        if self.closed {
            return Err(WindowsStoreError::Closed);
        }
        let lease = self.lease.upgrade().ok_or(WindowsStoreError::Closed)?;
        let mut runtime = lock_lease_runtime(&lease)?;
        lease.verify_or_latch_locked(&mut runtime)?;
        if runtime.generation != self.generation {
            return Err(WindowsStoreError::Lost);
        }
        operation(&self.file)
    }

    pub(crate) fn attest(&self) -> Result<CredentialFileAttestation, WindowsStoreError> {
        self.with_live(WindowsCredentialReadHandle::attest)
    }

    pub(crate) fn write_all(&mut self, input: &[u8]) -> Result<(), WindowsStoreError> {
        if self.closed {
            return Err(WindowsStoreError::Closed);
        }
        if self.write_started || input.is_empty() {
            return Err(WindowsStoreError::InvalidInput);
        }
        if input.len() > self.max_bytes {
            return Err(WindowsStoreError::Limit);
        }
        let lease = self.lease.upgrade().ok_or(WindowsStoreError::Closed)?;
        let mut runtime = lock_lease_runtime(&lease)?;
        lease.verify_or_latch_locked(&mut runtime)?;
        if runtime.generation != self.generation {
            return Err(WindowsStoreError::Lost);
        }
        let before = self.file.attest()?;
        if before.security.size != 0 {
            return Err(WindowsStoreError::Unsafe);
        }

        self.write_started = true;
        let mut bytes = input.to_vec();
        let result = (|| {
            let slot = lock_unpoisoned(&self.file.slot)?;
            let file = slot.as_ref().ok_or(WindowsStoreError::Closed)?;
            file.set_len(0).map_err(|_| WindowsStoreError::Io)?;
            #[cfg(test)]
            if take_test_fault(TEST_FAULT_WRITE_AFTER_TRUNCATE) {
                return Err(WindowsStoreError::Io);
            }
            write_all_at(file, &bytes, 0)?;
            file.set_len(u64::try_from(bytes.len()).map_err(|_| WindowsStoreError::Limit)?)
                .map_err(|_| WindowsStoreError::Io)
        })();
        if result.is_err() {
            bytes.fill(0);
            mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        let verified: Result<bool, WindowsStoreError> = (|| {
            let after = self.file.attest()?;
            let mut readback = self.file.read_bounded(self.max_bytes + 1)?;
            let exact_bytes = readback.end_of_file && readback.bytes == bytes;
            readback.bytes.fill(0);
            Ok(after.security.identity == before.security.identity
                && after.security.parent_identity == before.security.parent_identity
                && after.security.size == input.len() as u64
                && after.revision != before.revision
                && exact_bytes)
        })();
        bytes.fill(0);
        if !matches!(verified, Ok(true)) {
            mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        self.write_complete = true;
        Ok(())
    }

    pub(crate) fn sync(&self) -> Result<(), WindowsStoreError> {
        if !self.write_complete {
            return Err(WindowsStoreError::Unsafe);
        }
        if self.closed {
            return Err(WindowsStoreError::Closed);
        }
        let lease = self.lease.upgrade().ok_or(WindowsStoreError::Closed)?;
        let mut runtime = lock_lease_runtime(&lease)?;
        lease.verify_or_latch_locked(&mut runtime)?;
        if runtime.generation != self.generation {
            return Err(WindowsStoreError::Lost);
        }
        let result: Result<bool, WindowsStoreError> = (|| {
            let before = self.file.attest()?;
            {
                let slot = lock_unpoisoned(&self.file.slot)?;
                let opened = slot.as_ref().ok_or(WindowsStoreError::Closed)?;
                flush_file(opened.as_handle()).map_err(map_win)?;
            }
            #[cfg(test)]
            if take_test_fault(TEST_FAULT_SYNC_AFTER_FLUSH) {
                return Err(WindowsStoreError::Io);
            }
            let after = self.file.attest()?;
            Ok(before == after)
        })();
        if matches!(result, Ok(true)) {
            Ok(())
        } else {
            mark_lost(&mut runtime);
            Err(WindowsStoreError::Lost)
        }
    }

    pub(crate) fn close(&mut self) -> Result<(), WindowsStoreError> {
        if self.closed {
            return Err(WindowsStoreError::Closed);
        }
        self.closed = true;
        self.file.close();
        Ok(())
    }
}

impl Drop for WindowsExclusiveWriteHandle {
    fn drop(&mut self) {
        if !self.closed {
            self.file.close();
            self.closed = true;
        }
    }
}

impl WindowsSetupLease {
    pub(crate) fn attest_directory(&self) -> Result<DirectoryAttestation, WindowsStoreError> {
        let mut runtime = lock_lease_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let directory = runtime
            .directory
            .as_ref()
            .ok_or(WindowsStoreError::Closed)?;
        directory.attest()
    }

    pub(crate) fn observe_entry(
        &self,
        entry: ManagedEntry,
    ) -> Result<ManagedEntryObservation, WindowsStoreError> {
        let mut runtime = lock_lease_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let directory = runtime
            .directory
            .as_ref()
            .ok_or(WindowsStoreError::Closed)?;
        let directory_attestation = directory.attest()?;
        let scope = SnapshotScope {
            lease: Arc::downgrade(&self.core),
            generation: runtime.generation,
            directory_identity: directory_attestation.identity,
            entry,
        };
        match current_entry(directory, entry)? {
            CurrentEntry::Missing => Ok(ManagedEntryObservation::Missing {
                snapshot: MissingEntrySnapshot { scope },
            }),
            CurrentEntry::Present { file, attestation } => Ok(ManagedEntryObservation::Opened {
                snapshot: Box::new(PresentEntrySnapshot { scope, attestation }),
                attestation,
                file: WindowsLeaseReadHandle {
                    lease: Arc::downgrade(&self.core),
                    entry,
                    file,
                    closed: false,
                },
            }),
        }
    }

    pub(crate) fn list_temporary_entries(&self) -> Result<Vec<TemporaryEntry>, WindowsStoreError> {
        let mut runtime = lock_lease_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let directory = runtime
            .directory
            .as_ref()
            .ok_or(WindowsStoreError::Closed)?;
        let state = lock_unpoisoned(&directory.core.state)?;
        directory.core.require_secure_locked(&state)?;
        let mut scanned = 0_usize;
        let mut entries = Vec::new();
        for raw_entry in
            std::fs::read_dir(&directory.core.path.path).map_err(|_| WindowsStoreError::Io)?
        {
            let raw_entry = raw_entry.map_err(|_| WindowsStoreError::Io)?;
            scanned = scanned.checked_add(1).ok_or(WindowsStoreError::Limit)?;
            if scanned > MAX_DIRECTORY_ENTRIES {
                return Err(WindowsStoreError::Limit);
            }
            if let Some(entry) = TemporaryEntry::from_file_name(&raw_entry.file_name()) {
                if entries.len() == MAX_TEMPORARY_ENTRIES {
                    return Err(WindowsStoreError::Limit);
                }
                entries.push(entry);
            }
        }
        directory.core.require_secure_locked(&state)?;
        drop(state);
        self.core.verify_or_latch_locked(&mut runtime)?;
        entries.sort_by_key(|entry| entry.file_name());
        Ok(entries)
    }

    pub(crate) fn create_temporary_exclusive(
        &self,
        entry: TemporaryEntry,
        expected: &MissingEntrySnapshot,
    ) -> Result<ExclusiveCreateResult, WindowsStoreError> {
        let managed = ManagedEntry::Temporary(entry);
        let name = entry.file_name();
        let mut runtime = lock_lease_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let directory = runtime
            .directory
            .as_ref()
            .ok_or(WindowsStoreError::Closed)?;
        let mut state = lock_unpoisoned(&directory.core.state)?;
        let directory_attestation = directory.core.require_secure_locked(&state)?;
        if !scope_matches(
            &self.core,
            &runtime,
            directory_attestation,
            managed,
            &expected.scope,
        ) {
            return Ok(ExclusiveCreateResult::Conflict);
        }
        let path = directory.core.path.path.join(&name);
        let opened = match create_private_file(
            &path,
            &directory.core.process,
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        )
        .map_err(map_win)?
        {
            FileCreateAttempt::Conflict => return Ok(ExclusiveCreateResult::Conflict),
            FileCreateAttempt::Created(file) => file,
        };
        let created_result = (|| {
            let facts = metadata(&opened)?;
            let security = attest_security(
                opened.as_handle(),
                &directory.core.process,
                SecurityKind::File,
            )
            .map_err(map_win)?;
            if !facts.exact_file()
                || facts.size != 0
                || !security.owner_current
                || !security.exact_protected_dacl
                || !security.semantic_medium_label
            {
                return Err(WindowsStoreError::Unsafe);
            }
            let rebound = open_file_nofollow(&path, false, true, false)
                .map_err(|_| WindowsStoreError::Lost)?;
            if metadata(&rebound)?.identity != facts.identity {
                return Err(WindowsStoreError::Lost);
            }
            directory.core.require_secure_locked(&state)?;
            let slot = Arc::new(Mutex::new(Some(opened)));
            state.children.retain(|child| child.upgrade().is_some());
            state.children.push(Arc::downgrade(&slot));
            Ok(WindowsCredentialReadHandle {
                directory: Arc::clone(&directory.core),
                parent_identity: directory_attestation.identity,
                entry_name: name,
                slot,
            })
        })();
        drop(state);
        let file = match created_result {
            Ok(file) => file,
            Err(error) => {
                mark_lost(&mut runtime);
                return Err(error);
            }
        };
        self.core.verify_or_latch_locked(&mut runtime)?;
        let generation = match next_generation(&mut runtime) {
            Ok(generation) => generation,
            Err(error) => {
                mark_lost(&mut runtime);
                return Err(error);
            }
        };
        Ok(ExclusiveCreateResult::Created(
            WindowsExclusiveWriteHandle {
                lease: Arc::downgrade(&self.core),
                generation,
                max_bytes: entry.max_bytes(),
                file,
                write_started: false,
                write_complete: false,
                closed: false,
            },
        ))
    }

    pub(crate) fn move_temporary_conditionally(
        &self,
        source: TemporaryEntry,
        expected_source: &PresentEntrySnapshot,
        destination: CanonicalEntryRole,
        expected_destination: ExpectedEntrySnapshot<'_>,
    ) -> Result<ConditionalMutationResult, WindowsStoreError> {
        let source_entry = ManagedEntry::Temporary(source);
        let destination_entry = ManagedEntry::Canonical(destination);
        let source_name = source.file_name();
        let destination_name = destination_entry.file_name();
        let mut runtime = lock_lease_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let (directory_core, directory_attestation, current_source, current_destination) = {
            let directory = runtime
                .directory
                .as_ref()
                .ok_or(WindowsStoreError::Closed)?;
            (
                Arc::clone(&directory.core),
                directory.attest()?,
                current_entry(directory, source_entry)?,
                current_entry(directory, destination_entry)?,
            )
        };
        if !expected_matches(
            &self.core,
            &runtime,
            directory_attestation,
            source_entry,
            ExpectedEntrySnapshot::Present(expected_source),
            &current_source,
        ) || !expected_matches(
            &self.core,
            &runtime,
            directory_attestation,
            destination_entry,
            expected_destination,
            &current_destination,
        ) {
            return Ok(ConditionalMutationResult::Conflict);
        }
        let source_identity = match &current_source {
            CurrentEntry::Present { attestation, .. } => attestation.security.identity,
            CurrentEntry::Missing => return Ok(ConditionalMutationResult::Conflict),
        };
        self.core.verify_or_latch_locked(&mut runtime)?;

        let state = lock_unpoisoned(&directory_core.state)?;
        directory_core.require_secure_locked(&state)?;
        if !exact_current_file(&directory_core, source_name.as_os_str(), source_identity)? {
            return Ok(ConditionalMutationResult::Conflict);
        }
        if let ExpectedEntrySnapshot::Present(snapshot) = expected_destination {
            if !exact_current_file(
                &directory_core,
                destination_name.as_os_str(),
                snapshot.attestation.security.identity,
            )? {
                return Ok(ConditionalMutationResult::Conflict);
            }
        }
        let source_slot = match &current_source {
            CurrentEntry::Present { file, .. } => lock_unpoisoned(&file.slot)?,
            CurrentEntry::Missing => return Ok(ConditionalMutationResult::Conflict),
        };
        let source_file = source_slot.as_ref().ok_or(WindowsStoreError::Closed)?;
        let destination_wide: Vec<u16> = destination_name.encode_wide().collect();
        let directory_file = state.directory.as_ref().ok_or(WindowsStoreError::Closed)?;
        let rename = match rename_by_handle(
            source_file.as_handle(),
            directory_file.as_handle(),
            &destination_wide,
            matches!(expected_destination, ExpectedEntrySnapshot::Present(_)),
        ) {
            Ok(result) => result,
            Err(_) => {
                drop(source_slot);
                drop(state);
                mark_lost(&mut runtime);
                return Err(WindowsStoreError::Lost);
            }
        };
        match rename {
            MutationAttempt::Applied => {}
            MutationAttempt::Conflict => return Ok(ConditionalMutationResult::Conflict),
            MutationAttempt::Unsupported => return Err(WindowsStoreError::Unsupported),
        }
        let postcondition: Result<bool, WindowsStoreError> = (|| {
            Ok(entry_is_missing(&directory_core, source_name.as_os_str())?
                && exact_current_file(
                    &directory_core,
                    destination_name.as_os_str(),
                    source_identity,
                )?
                && directory_core.require_secure_locked(&state).is_ok())
        })();
        drop(source_slot);
        drop(state);
        if !matches!(postcondition, Ok(true)) {
            mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        self.core.verify_or_latch_locked(&mut runtime)?;
        if next_generation(&mut runtime).is_err() {
            mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        Ok(ConditionalMutationResult::Applied)
    }

    pub(crate) fn remove_conditionally(
        &self,
        entry: ManagedEntry,
        expected: &PresentEntrySnapshot,
    ) -> Result<ConditionalMutationResult, WindowsStoreError> {
        let name = entry.file_name();
        let mut runtime = lock_lease_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let (directory_core, directory_attestation, current) = {
            let directory = runtime
                .directory
                .as_ref()
                .ok_or(WindowsStoreError::Closed)?;
            (
                Arc::clone(&directory.core),
                directory.attest()?,
                current_entry(directory, entry)?,
            )
        };
        if !expected_matches(
            &self.core,
            &runtime,
            directory_attestation,
            entry,
            ExpectedEntrySnapshot::Present(expected),
            &current,
        ) {
            return Ok(ConditionalMutationResult::Conflict);
        }
        let expected_identity = match &current {
            CurrentEntry::Present { attestation, .. } => attestation.security.identity,
            CurrentEntry::Missing => return Ok(ConditionalMutationResult::Conflict),
        };
        self.core.verify_or_latch_locked(&mut runtime)?;

        let state = lock_unpoisoned(&directory_core.state)?;
        directory_core.require_secure_locked(&state)?;
        if !exact_current_file(&directory_core, name.as_os_str(), expected_identity)? {
            return Ok(ConditionalMutationResult::Conflict);
        }
        let proof_path = directory_core.path.path.join(&name);
        let proof = open_file_nofollow(&proof_path, false, false, false)
            .map_err(|_| WindowsStoreError::Lost)?;
        if metadata(&proof)?.identity != expected_identity {
            return Ok(ConditionalMutationResult::Conflict);
        }
        let mut source_slot = match &current {
            CurrentEntry::Present { file, .. } => lock_unpoisoned(&file.slot)?,
            CurrentEntry::Missing => return Ok(ConditionalMutationResult::Conflict),
        };
        let source_file = source_slot.as_ref().ok_or(WindowsStoreError::Closed)?;
        let removal = match remove_by_handle(source_file.as_handle()) {
            Ok(result) => result,
            Err(_) => {
                drop(source_slot);
                drop(state);
                mark_lost(&mut runtime);
                return Err(WindowsStoreError::Lost);
            }
        };
        match removal {
            MutationAttempt::Applied => {}
            MutationAttempt::Conflict => return Ok(ConditionalMutationResult::Conflict),
            MutationAttempt::Unsupported => return Err(WindowsStoreError::Unsupported),
        }
        let delete_handle = match source_slot.take() {
            Some(file) => file,
            None => {
                drop(source_slot);
                drop(state);
                mark_lost(&mut runtime);
                return Err(WindowsStoreError::Lost);
            }
        };
        drop(delete_handle);
        drop(source_slot);
        let postcondition: Result<bool, WindowsStoreError> = (|| {
            Ok(metadata(&proof)?.identity == expected_identity
                && entry_is_missing(&directory_core, name.as_os_str())?
                && directory_core.require_secure_locked(&state).is_ok())
        })();
        drop(state);
        if !matches!(postcondition, Ok(true)) {
            mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        self.core.verify_or_latch_locked(&mut runtime)?;
        if next_generation(&mut runtime).is_err() {
            mark_lost(&mut runtime);
            return Err(WindowsStoreError::Lost);
        }
        Ok(ConditionalMutationResult::Applied)
    }

    /// Windows exposes no documented general directory-handle flush equivalent.
    ///
    /// This is therefore a completed-operation/process-crash barrier only: every prior file
    /// write was flushed, every namespace operation returned synchronously, and all retained
    /// capabilities are re-attested. It deliberately makes no physical power-loss guarantee.
    pub(crate) fn sync_directory(&self) -> Result<(), WindowsStoreError> {
        let mut runtime = lock_lease_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let directory = runtime
            .directory
            .as_ref()
            .ok_or(WindowsStoreError::Closed)?;
        let state = lock_unpoisoned(&directory.core.state)?;
        directory.core.require_secure_locked(&state)?;
        drop(state);
        self.core.verify_or_latch_locked(&mut runtime)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{acquired_lease, TestRoot};
    use super::*;

    const NONCE: &str = "b56c52f5-a090-41eb-a164-1c92e36db94f";
    const ID_1: &str = "6d27ba17-aac9-4f72-bfca-bc6fe266fd27";
    const ID_2: &str = "342607ae-47c7-4da9-a01b-d763b8296e67";

    fn temporary(role: TemporaryEntryRole, id: &str) -> TemporaryEntry {
        TemporaryEntry::parse(role, id).expect("temporary entry must validate")
    }

    fn missing(lease: &WindowsSetupLease, entry: ManagedEntry) -> MissingEntrySnapshot {
        match lease
            .observe_entry(entry)
            .expect("observation must complete")
        {
            ManagedEntryObservation::Missing { snapshot } => snapshot,
            ManagedEntryObservation::Opened { .. } => panic!("entry unexpectedly exists"),
        }
    }

    fn opened(
        lease: &WindowsSetupLease,
        entry: ManagedEntry,
    ) -> (PresentEntrySnapshot, WindowsLeaseReadHandle) {
        match lease
            .observe_entry(entry)
            .expect("observation must complete")
        {
            ManagedEntryObservation::Missing { .. } => panic!("entry unexpectedly missing"),
            ManagedEntryObservation::Opened { snapshot, file, .. } => (*snapshot, file),
        }
    }

    fn create_written(
        lease: &WindowsSetupLease,
        entry: TemporaryEntry,
        bytes: &[u8],
    ) -> PresentEntrySnapshot {
        let expected = missing(lease, ManagedEntry::Temporary(entry));
        let mut file = match lease
            .create_temporary_exclusive(entry, &expected)
            .expect("candidate create must complete")
        {
            ExclusiveCreateResult::Conflict => panic!("candidate unexpectedly conflicts"),
            ExclusiveCreateResult::Created(file) => file,
        };
        file.write_all(bytes).expect("candidate write must succeed");
        file.sync().expect("candidate flush must succeed");
        file.close().expect("candidate must close");
        let (snapshot, mut reader) = opened(lease, ManagedEntry::Temporary(entry));
        let read = reader
            .read_bounded(entry.max_bytes() + 1)
            .expect("candidate must read");
        assert_eq!(read.bytes, bytes);
        assert!(read.end_of_file);
        reader.close().expect("reader must close");
        snapshot
    }

    #[test]
    fn candidate_creation_is_exclusive_bounded_and_never_truncates() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE);
        let entry = temporary(TemporaryEntryRole::Credential, ID_1);
        let expected = missing(&lease, ManagedEntry::Temporary(entry));
        let mut writer = match lease
            .create_temporary_exclusive(entry, &expected)
            .expect("exclusive create must complete")
        {
            ExclusiveCreateResult::Conflict => panic!("fresh name must not conflict"),
            ExclusiveCreateResult::Created(writer) => writer,
        };
        assert_eq!(
            writer.write_all(&[0_u8; MAX_CREDENTIAL_BYTES + 1]),
            Err(WindowsStoreError::Limit)
        );
        writer
            .write_all(b"candidate")
            .expect("bounded write succeeds");
        writer.sync().expect("candidate flush succeeds");
        writer.close().expect("writer closes");
        assert!(matches!(
            lease.create_temporary_exclusive(entry, &expected),
            Ok(ExclusiveCreateResult::Conflict)
        ));
        lease.release().expect("lease releases");
    }

    #[test]
    fn handle_relative_rename_conflicts_replaces_and_removes_conditionally() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE);
        let first = temporary(TemporaryEntryRole::Credential, ID_1);
        let first_snapshot = create_written(&lease, first, b"first");
        let missing_destination = missing(&lease, ManagedEntry::credential());
        assert_eq!(
            lease.move_temporary_conditionally(
                first,
                &first_snapshot,
                CanonicalEntryRole::Credential,
                ExpectedEntrySnapshot::Missing(&missing_destination),
            ),
            Ok(ConditionalMutationResult::Applied)
        );
        lease
            .sync_directory()
            .expect("process-crash barrier succeeds");

        let second = temporary(TemporaryEntryRole::Credential, ID_2);
        let second_snapshot = create_written(&lease, second, b"second");
        let (old_destination, mut old_reader) = opened(&lease, ManagedEntry::credential());
        old_reader.close().expect("old reader closes");
        assert_eq!(
            lease.move_temporary_conditionally(
                second,
                &second_snapshot,
                CanonicalEntryRole::Credential,
                ExpectedEntrySnapshot::Present(&old_destination),
            ),
            Ok(ConditionalMutationResult::Applied)
        );
        let (current, mut current_reader) = opened(&lease, ManagedEntry::credential());
        let bytes = current_reader
            .read_bounded(MAX_CREDENTIAL_BYTES + 1)
            .expect("replacement reads");
        assert_eq!(bytes.bytes, b"second");
        current_reader.close().expect("reader closes");
        assert_eq!(
            lease.remove_conditionally(ManagedEntry::credential(), &old_destination),
            Ok(ConditionalMutationResult::Conflict)
        );
        assert_eq!(
            lease.remove_conditionally(ManagedEntry::credential(), &current),
            Ok(ConditionalMutationResult::Applied)
        );
        lease.release().expect("lease releases");
    }

    #[test]
    fn hard_links_and_stale_generation_snapshots_are_rejected() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE);

        let linked = temporary(TemporaryEntryRole::Credential, ID_1);
        let linked_missing = missing(&lease, ManagedEntry::Temporary(linked));
        let mut linked_writer = match lease
            .create_temporary_exclusive(linked, &linked_missing)
            .expect("linked candidate create must complete")
        {
            ExclusiveCreateResult::Conflict => panic!("linked candidate unexpectedly conflicts"),
            ExclusiveCreateResult::Created(writer) => writer,
        };
        std::fs::hard_link(
            test.store.join(linked.file_name()),
            test.store.join("hard-link-alias"),
        )
        .expect("hard link must be created");
        assert_eq!(linked_writer.attest(), Err(WindowsStoreError::Unsafe));
        assert_eq!(
            linked_writer.write_all(b"must-not-write"),
            Err(WindowsStoreError::Unsafe)
        );
        linked_writer.close().expect("linked writer must close");

        let second = temporary(TemporaryEntryRole::Credential, ID_2);
        let stale_missing = missing(&lease, ManagedEntry::Temporary(second));
        std::fs::remove_file(test.store.join("hard-link-alias"))
            .expect("hard-link alias must be removed");
        std::fs::remove_file(test.store.join(linked.file_name()))
            .expect("linked candidate must be removed");

        let first = temporary(TemporaryEntryRole::Credential, ID_1);
        let first_snapshot = create_written(&lease, first, b"first");
        assert!(matches!(
            lease.create_temporary_exclusive(second, &stale_missing),
            Ok(ExclusiveCreateResult::Conflict)
        ));
        assert_eq!(
            lease.remove_conditionally(ManagedEntry::Temporary(first), &first_snapshot),
            Ok(ConditionalMutationResult::Applied)
        );
        let destination_missing = missing(&lease, ManagedEntry::credential());
        assert_eq!(
            lease.move_temporary_conditionally(
                first,
                &first_snapshot,
                CanonicalEntryRole::Credential,
                ExpectedEntrySnapshot::Missing(&destination_missing),
            ),
            Ok(ConditionalMutationResult::Conflict)
        );
        lease.release().expect("lease releases");
    }

    #[test]
    fn read_and_temporary_enumeration_limits_are_exact() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE);
        let entry = temporary(TemporaryEntryRole::Credential, ID_1);
        let snapshot = create_written(&lease, entry, b"candidate");
        let (_, mut reader) = opened(&lease, ManagedEntry::Temporary(entry));
        let partial = reader
            .read_bounded(4)
            .expect("bounded partial read succeeds");
        assert_eq!(partial.bytes, b"cand");
        assert!(!partial.end_of_file);
        assert_eq!(
            reader.read_bounded(MAX_CREDENTIAL_BYTES + 2),
            Err(WindowsStoreError::Limit)
        );
        reader.close().expect("reader closes");
        assert_eq!(
            lease.remove_conditionally(ManagedEntry::Temporary(entry), &snapshot),
            Ok(ConditionalMutationResult::Applied)
        );

        for index in 0..MAX_TEMPORARY_ENTRIES {
            let name = format!(
                "{CREDENTIAL_CANDIDATE_PREFIX}00000000-0000-4000-8000-{index:012x}{TEMPORARY_SUFFIX}"
            );
            std::fs::write(test.store.join(name), [])
                .expect("temporary test entry must be created");
        }
        assert_eq!(
            lease
                .list_temporary_entries()
                .expect("exact temporary ceiling must enumerate")
                .len(),
            MAX_TEMPORARY_ENTRIES
        );
        let overflow_name = format!(
            "{CREDENTIAL_CANDIDATE_PREFIX}00000000-0000-4000-8000-{MAX_TEMPORARY_ENTRIES:012x}{TEMPORARY_SUFFIX}"
        );
        std::fs::write(test.store.join(overflow_name), [])
            .expect("overflow temporary test entry must be created");
        assert_eq!(
            lease.list_temporary_entries(),
            Err(WindowsStoreError::Limit)
        );
        lease.release().expect("lease releases");
        for index in 0..=MAX_TEMPORARY_ENTRIES {
            let name = format!(
                "{CREDENTIAL_CANDIDATE_PREFIX}00000000-0000-4000-8000-{index:012x}{TEMPORARY_SUFFIX}"
            );
            std::fs::remove_file(test.store.join(name))
                .expect("known temporary enumeration fixture must be removed");
        }
    }

    #[test]
    fn total_directory_scan_limit_is_exact() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE);
        // setup.lock is the remaining entry at every point in this test.
        for index in 0..MAX_DIRECTORY_ENTRIES - 1 {
            std::fs::write(test.store.join(format!("noise-{index:04x}")), [])
                .expect("directory-scan test entry must be created");
        }
        assert!(lease
            .list_temporary_entries()
            .expect("exact directory scan ceiling must succeed")
            .is_empty());
        std::fs::write(test.store.join("noise-overflow"), [])
            .expect("directory-scan overflow entry must be created");
        assert_eq!(
            lease.list_temporary_entries(),
            Err(WindowsStoreError::Limit)
        );
        lease.release().expect("lease releases");
        for index in 0..MAX_DIRECTORY_ENTRIES - 1 {
            std::fs::remove_file(test.store.join(format!("noise-{index:04x}")))
                .expect("known directory-scan fixture must be removed");
        }
        std::fs::remove_file(test.store.join("noise-overflow"))
            .expect("known directory-scan overflow fixture must be removed");
    }

    #[test]
    fn write_and_sync_uncertainty_terminally_lose_the_lease() {
        let write_test = TestRoot::new();
        let (_, _, write_lease) = acquired_lease(&write_test.store, NONCE);
        let write_entry = temporary(TemporaryEntryRole::Credential, ID_1);
        let write_missing = missing(&write_lease, ManagedEntry::Temporary(write_entry));
        let mut writer = match write_lease
            .create_temporary_exclusive(write_entry, &write_missing)
            .expect("write-fault candidate create must complete")
        {
            ExclusiveCreateResult::Conflict => panic!("write-fault candidate conflicts"),
            ExclusiveCreateResult::Created(writer) => writer,
        };
        inject_test_fault(TEST_FAULT_WRITE_AFTER_TRUNCATE);
        assert_eq!(writer.write_all(b"candidate"), Err(WindowsStoreError::Lost));
        assert_eq!(write_lease.renew(), LeaseRenewal::Lost);
        writer.close().expect("lost writer still closes");
        drop(write_lease);

        let sync_test = TestRoot::new();
        let (_, _, sync_lease) = acquired_lease(&sync_test.store, NONCE);
        let sync_entry = temporary(TemporaryEntryRole::Credential, ID_2);
        let sync_missing = missing(&sync_lease, ManagedEntry::Temporary(sync_entry));
        let mut sync_writer = match sync_lease
            .create_temporary_exclusive(sync_entry, &sync_missing)
            .expect("sync-fault candidate create must complete")
        {
            ExclusiveCreateResult::Conflict => panic!("sync-fault candidate conflicts"),
            ExclusiveCreateResult::Created(writer) => writer,
        };
        sync_writer
            .write_all(b"candidate")
            .expect("pre-fault write succeeds");
        inject_test_fault(TEST_FAULT_SYNC_AFTER_FLUSH);
        assert_eq!(sync_writer.sync(), Err(WindowsStoreError::Lost));
        assert_eq!(sync_lease.renew(), LeaseRenewal::Lost);
        sync_writer.close().expect("lost writer still closes");
    }
}
