use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::sync::{Arc, Weak};

use rustix::fs::{self as rustix_fs, AtFlags, Dir, Mode, OFlags, RenameFlags};
use rustix::io::Errno;

use super::*;

const TRANSACTION_ENTRY: &str = "credentials-transaction.json";
const CREDENTIAL_CANDIDATE_PREFIX: &[u8] = b".credentials-candidate-";
const TRANSACTION_CANDIDATE_PREFIX: &[u8] = b".credentials-transaction-";
const RECOVERY_CANDIDATE_PREFIX: &[u8] = b".credentials-recovery-";
const TEMPORARY_SUFFIX: &[u8] = b".tmp";
const MAX_CREDENTIAL_BYTES: usize = 16_384;
const MAX_TRANSACTION_BYTES: usize = 40_960;
const MAX_DIRECTORY_ENTRIES: usize = 4_096;
const MAX_TEMPORARY_ENTRIES: usize = 1_024;

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
    ) -> Result<Self, PosixStoreError> {
        Ok(Self {
            role,
            transaction_id: ValidatedUuidV4::parse(transaction_id)?,
        })
    }

    fn prefix(self) -> &'static [u8] {
        match self.role {
            TemporaryEntryRole::Credential => CREDENTIAL_CANDIDATE_PREFIX,
            TemporaryEntryRole::Transaction => TRANSACTION_CANDIDATE_PREFIX,
            TemporaryEntryRole::Recovery => RECOVERY_CANDIDATE_PREFIX,
        }
    }

    fn file_name(self) -> OsString {
        let prefix = self.prefix();
        let mut bytes =
            Vec::with_capacity(prefix.len() + LOCK_NONCE_LENGTH + TEMPORARY_SUFFIX.len());
        bytes.extend_from_slice(prefix);
        bytes.extend_from_slice(&self.transaction_id.0);
        bytes.extend_from_slice(TEMPORARY_SUFFIX);
        OsString::from_vec(bytes)
    }

    fn from_file_name(bytes: &[u8]) -> Option<Self> {
        for (role, prefix) in [
            (TemporaryEntryRole::Credential, CREDENTIAL_CANDIDATE_PREFIX),
            (
                TemporaryEntryRole::Transaction,
                TRANSACTION_CANDIDATE_PREFIX,
            ),
            (TemporaryEntryRole::Recovery, RECOVERY_CANDIDATE_PREFIX),
        ] {
            let expected_length = prefix.len() + LOCK_NONCE_LENGTH + TEMPORARY_SUFFIX.len();
            if bytes.len() != expected_length
                || !bytes.starts_with(prefix)
                || !bytes.ends_with(TEMPORARY_SUFFIX)
            {
                continue;
            }
            let transaction_id = &bytes[prefix.len()..prefix.len() + LOCK_NONCE_LENGTH];
            let transaction_id = std::str::from_utf8(transaction_id).ok()?;
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

    pub(crate) fn transaction() -> Self {
        Self::Canonical(CanonicalEntryRole::Transaction)
    }

    pub(crate) fn temporary(
        role: TemporaryEntryRole,
        transaction_id: &str,
    ) -> Result<Self, PosixStoreError> {
        TemporaryEntry::parse(role, transaction_id).map(Self::Temporary)
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
        file: PosixLeaseReadHandle,
    },
}

pub(crate) enum ExclusiveCreateResult {
    Conflict,
    Created(PosixExclusiveWriteHandle),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConditionalMutationResult {
    Applied,
    Conflict,
}

enum CurrentEntry {
    Missing,
    Present {
        file: PosixCredentialReadHandle,
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

fn lock_lease_runtime(lease: &LeaseCore) -> Result<MutexGuard<'_, LeaseRuntime>, PosixStoreError> {
    match lease.runtime.lock() {
        Ok(runtime) => Ok(runtime),
        Err(poisoned) => {
            let mut runtime = poisoned.into_inner();
            if runtime.status == LeaseStatus::Terminal {
                Err(PosixStoreError::Closed)
            } else {
                mark_lost(&mut runtime);
                Err(PosixStoreError::Lost)
            }
        }
    }
}

fn next_generation(runtime: &mut LeaseRuntime) -> Result<u64, PosixStoreError> {
    let next = runtime
        .generation
        .checked_add(1)
        .ok_or(PosixStoreError::Lost)?;
    runtime.generation = next;
    Ok(next)
}

fn current_entry(
    directory: &PosixPrivateDirectory,
    entry: ManagedEntry,
) -> Result<CurrentEntry, PosixStoreError> {
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

fn entry_is_missing(directory: &File, name: &OsStr) -> Result<bool, PosixStoreError> {
    match rustix_fs::statat(directory, name, AtFlags::SYMLINK_NOFOLLOW) {
        Err(error) if error == Errno::NOENT => Ok(true),
        Ok(_) => Ok(false),
        Err(_) => Err(PosixStoreError::Io),
    }
}

fn exact_current_file(
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
    Ok(facts.identity == expected && facts.exact_private_file(uid))
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

pub(crate) struct PosixLeaseReadHandle {
    lease: Weak<LeaseCore>,
    entry: ManagedEntry,
    file: PosixCredentialReadHandle,
    closed: bool,
}

impl PosixLeaseReadHandle {
    fn with_live<T>(
        &self,
        operation: impl FnOnce(&PosixCredentialReadHandle) -> Result<T, PosixStoreError>,
    ) -> Result<T, PosixStoreError> {
        if self.closed {
            return Err(PosixStoreError::Closed);
        }
        let lease = self.lease.upgrade().ok_or(PosixStoreError::Closed)?;
        let mut runtime = lock_lease_runtime(&lease)?;
        lease.verify_or_latch_locked(&mut runtime)?;
        operation(&self.file)
    }

    pub(crate) fn attest(&self) -> Result<CredentialFileAttestation, PosixStoreError> {
        self.with_live(PosixCredentialReadHandle::attest)
    }

    pub(crate) fn read_bounded(&self, max_bytes: usize) -> Result<BoundedRead, PosixStoreError> {
        if max_bytes > self.entry.max_bytes() + 1 {
            return Err(PosixStoreError::Limit);
        }
        self.with_live(|file| file.read_bounded(max_bytes))
    }

    pub(crate) fn close(&mut self) -> Result<(), PosixStoreError> {
        if self.closed {
            return Err(PosixStoreError::Closed);
        }
        self.closed = true;
        self.file.close();
        Ok(())
    }
}

impl Drop for PosixLeaseReadHandle {
    fn drop(&mut self) {
        if !self.closed {
            self.file.close();
            self.closed = true;
        }
    }
}

pub(crate) struct PosixExclusiveWriteHandle {
    lease: Weak<LeaseCore>,
    generation: u64,
    max_bytes: usize,
    file: PosixCredentialReadHandle,
    write_started: bool,
    write_complete: bool,
    closed: bool,
}

impl PosixExclusiveWriteHandle {
    fn with_live<T>(
        &self,
        operation: impl FnOnce(&PosixCredentialReadHandle) -> Result<T, PosixStoreError>,
    ) -> Result<T, PosixStoreError> {
        if self.closed {
            return Err(PosixStoreError::Closed);
        }
        let lease = self.lease.upgrade().ok_or(PosixStoreError::Closed)?;
        let mut runtime = lock_lease_runtime(&lease)?;
        lease.verify_or_latch_locked(&mut runtime)?;
        if runtime.generation != self.generation {
            return Err(PosixStoreError::Lost);
        }
        operation(&self.file)
    }

    pub(crate) fn attest(&self) -> Result<CredentialFileAttestation, PosixStoreError> {
        self.with_live(PosixCredentialReadHandle::attest)
    }

    pub(crate) fn write_all(&mut self, input: &[u8]) -> Result<(), PosixStoreError> {
        if self.closed {
            return Err(PosixStoreError::Closed);
        }
        if self.write_started || input.is_empty() {
            return Err(PosixStoreError::InvalidInput);
        }
        if input.len() > self.max_bytes {
            return Err(PosixStoreError::Limit);
        }

        let lease = self.lease.upgrade().ok_or(PosixStoreError::Closed)?;
        let mut runtime = lock_lease_runtime(&lease)?;
        lease.verify_or_latch_locked(&mut runtime)?;
        if runtime.generation != self.generation {
            return Err(PosixStoreError::Lost);
        }
        let before = self.file.attest()?;
        if before.security.size != 0 {
            return Err(PosixStoreError::Unsafe);
        }

        self.write_started = true;
        let mut bytes = input.to_vec();
        let result = (|| {
            let slot = lock_unpoisoned(&self.file.slot)?;
            let file = slot.as_ref().ok_or(PosixStoreError::Closed)?;
            rustix_fs::ftruncate(file, 0).map_err(|_| PosixStoreError::Io)?;
            write_all_at(file, &bytes, 0)?;
            rustix_fs::ftruncate(
                file,
                u64::try_from(bytes.len()).map_err(|_| PosixStoreError::Limit)?,
            )
            .map_err(|_| PosixStoreError::Io)
        })();
        if let Err(error) = result {
            bytes.fill(0);
            return Err(error);
        }

        let verified: Result<bool, PosixStoreError> = (|| {
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
            return Err(PosixStoreError::Lost);
        }
        self.write_complete = true;
        Ok(())
    }

    pub(crate) fn sync(&self) -> Result<(), PosixStoreError> {
        if !self.write_complete {
            return Err(PosixStoreError::Unsafe);
        }
        self.with_live(|file| {
            let before = file.attest()?;
            {
                let slot = lock_unpoisoned(&file.slot)?;
                let opened = slot.as_ref().ok_or(PosixStoreError::Closed)?;
                rustix_fs::fsync(opened).map_err(|_| PosixStoreError::Io)?;
            }
            let after = file.attest()?;
            if before == after {
                Ok(())
            } else {
                Err(PosixStoreError::Lost)
            }
        })
    }

    pub(crate) fn close(&mut self) -> Result<(), PosixStoreError> {
        if self.closed {
            return Err(PosixStoreError::Closed);
        }
        self.closed = true;
        self.file.close();
        Ok(())
    }
}

impl Drop for PosixExclusiveWriteHandle {
    fn drop(&mut self) {
        if !self.closed {
            self.file.close();
            self.closed = true;
        }
    }
}

impl PosixSetupLease {
    pub(crate) fn attest_directory(&self) -> Result<DirectoryAttestation, PosixStoreError> {
        let mut runtime = lock_lease_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let directory = runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?;
        directory.attest()
    }

    pub(crate) fn observe_entry(
        &self,
        entry: ManagedEntry,
    ) -> Result<ManagedEntryObservation, PosixStoreError> {
        let mut runtime = lock_lease_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let directory = runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?;
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
                file: PosixLeaseReadHandle {
                    lease: Arc::downgrade(&self.core),
                    entry,
                    file,
                    closed: false,
                },
            }),
        }
    }

    pub(crate) fn list_temporary_entries(&self) -> Result<Vec<TemporaryEntry>, PosixStoreError> {
        let mut runtime = lock_lease_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let directory = runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?;
        let state = lock_unpoisoned(&directory.core.state)?;
        directory.core.require_secure_locked(&state)?;
        let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
        let mut stream = Dir::read_from(directory_file).map_err(|_| PosixStoreError::Io)?;
        let mut scanned = 0_usize;
        let mut entries = Vec::new();
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
            if let Some(entry) = TemporaryEntry::from_file_name(bytes) {
                if entries.len() == MAX_TEMPORARY_ENTRIES {
                    return Err(PosixStoreError::Limit);
                }
                entries.push(entry);
            }
        }
        drop(state);
        self.core.verify_or_latch_locked(&mut runtime)?;
        entries.sort_by(|left, right| {
            left.file_name()
                .as_bytes()
                .cmp(right.file_name().as_bytes())
        });
        Ok(entries)
    }

    pub(crate) fn create_temporary_exclusive(
        &self,
        entry: TemporaryEntry,
        expected: &MissingEntrySnapshot,
    ) -> Result<ExclusiveCreateResult, PosixStoreError> {
        let managed = ManagedEntry::Temporary(entry);
        let name = entry.file_name();
        let mut runtime = lock_lease_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let directory = runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?;
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
        let opened = {
            let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
            match rustix_fs::statat(directory_file, name.as_os_str(), AtFlags::SYMLINK_NOFOLLOW) {
                Err(error) if error == Errno::NOENT => {}
                Ok(_) => return Ok(ExclusiveCreateResult::Conflict),
                Err(_) => return Err(PosixStoreError::Io),
            }

            let flags = lock_open_flags() | OFlags::CREATE | OFlags::EXCL;
            match secure_openat(directory_file, name.as_os_str(), flags, private_file_mode()) {
                Ok(opened) => File::from(opened),
                Err(error) if error == Errno::EXIST => {
                    return Ok(ExclusiveCreateResult::Conflict);
                }
                Err(_) => return Err(PosixStoreError::Io),
            }
        };
        let created_result = (|| {
            rustix_fs::fchmod(&opened, private_file_mode()).map_err(|_| PosixStoreError::Io)?;
            let facts = metadata(&opened)?;
            if !facts.exact_private_file(directory.core.process.uid) || facts.size != 0 {
                return Err(PosixStoreError::Unsafe);
            }
            let rebound = {
                let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
                secure_openat(
                    directory_file,
                    name.as_os_str(),
                    read_open_flags(),
                    Mode::empty(),
                )
                .map(File::from)
                .map_err(|_| PosixStoreError::Lost)?
            };
            if metadata(&rebound)?.identity != facts.identity {
                return Err(PosixStoreError::Lost);
            }
            directory.core.require_secure_locked(&state)?;
            let slot = Arc::new(Mutex::new(Some(opened)));
            state.children.retain(|child| child.upgrade().is_some());
            state.children.push(Arc::downgrade(&slot));
            Ok(PosixCredentialReadHandle {
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
        Ok(ExclusiveCreateResult::Created(PosixExclusiveWriteHandle {
            lease: Arc::downgrade(&self.core),
            generation,
            max_bytes: entry.max_bytes(),
            file,
            write_started: false,
            write_complete: false,
            closed: false,
        }))
    }

    pub(crate) fn move_temporary_conditionally(
        &self,
        source: TemporaryEntry,
        expected_source: &PresentEntrySnapshot,
        destination: CanonicalEntryRole,
        expected_destination: ExpectedEntrySnapshot<'_>,
    ) -> Result<ConditionalMutationResult, PosixStoreError> {
        let source_entry = ManagedEntry::Temporary(source);
        let destination_entry = ManagedEntry::Canonical(destination);
        let source_name = source.file_name();
        let destination_name = destination_entry.file_name();
        let mut runtime = lock_lease_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let (directory_core, directory_attestation, current_source, current_destination) = {
            let directory = runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?;
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
        let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
        if !exact_current_file(
            directory_file,
            source_name.as_os_str(),
            source_identity,
            directory_core.process.uid,
        )? {
            return Ok(ConditionalMutationResult::Conflict);
        }

        let rename_result = match expected_destination {
            ExpectedEntrySnapshot::Missing(_) => rustix_fs::renameat_with(
                directory_file,
                source_name.as_os_str(),
                directory_file,
                destination_name.as_os_str(),
                RenameFlags::NOREPLACE,
            ),
            ExpectedEntrySnapshot::Present(snapshot) => {
                if !exact_current_file(
                    directory_file,
                    destination_name.as_os_str(),
                    snapshot.attestation.security.identity,
                    directory_core.process.uid,
                )? {
                    return Ok(ConditionalMutationResult::Conflict);
                }
                rustix_fs::renameat(
                    directory_file,
                    source_name.as_os_str(),
                    directory_file,
                    destination_name.as_os_str(),
                )
            }
        };
        if let Err(error) = rename_result {
            drop(state);
            if error == Errno::EXIST {
                return Ok(ConditionalMutationResult::Conflict);
            }
            if error == Errno::NOSYS || error == Errno::INVAL || error == Errno::NOTSUP {
                return Err(PosixStoreError::Unsupported);
            }
            mark_lost(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        let postcondition: Result<bool, PosixStoreError> = (|| {
            Ok(entry_is_missing(directory_file, source_name.as_os_str())?
                && exact_current_file(
                    directory_file,
                    destination_name.as_os_str(),
                    source_identity,
                    directory_core.process.uid,
                )?)
        })();
        drop(state);
        if !matches!(postcondition, Ok(true)) {
            mark_lost(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        self.core.verify_or_latch_locked(&mut runtime)?;
        if next_generation(&mut runtime).is_err() {
            mark_lost(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        Ok(ConditionalMutationResult::Applied)
    }

    pub(crate) fn remove_conditionally(
        &self,
        entry: ManagedEntry,
        expected: &PresentEntrySnapshot,
    ) -> Result<ConditionalMutationResult, PosixStoreError> {
        let name = entry.file_name();
        let mut runtime = lock_lease_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let (directory_core, directory_attestation, mut current) = {
            let directory = runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?;
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
        let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
        if !exact_current_file(
            directory_file,
            name.as_os_str(),
            expected_identity,
            directory_core.process.uid,
        )? {
            return Ok(ConditionalMutationResult::Conflict);
        }
        if let Err(error) = rustix_fs::unlinkat(directory_file, name.as_os_str(), AtFlags::empty())
        {
            drop(state);
            if error == Errno::NOENT {
                return Ok(ConditionalMutationResult::Conflict);
            }
            mark_lost(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        let postcondition: Result<bool, PosixStoreError> = (|| {
            let path_missing = entry_is_missing(directory_file, name.as_os_str())?;
            let detached = match &mut current {
                CurrentEntry::Present { file, .. } => {
                    let slot = lock_unpoisoned(&file.slot)?;
                    let opened = slot.as_ref().ok_or(PosixStoreError::Closed)?;
                    let facts = metadata(opened)?;
                    facts.identity == expected_identity && facts.links == 0
                }
                CurrentEntry::Missing => false,
            };
            Ok(path_missing && detached)
        })();
        drop(state);
        if !matches!(postcondition, Ok(true)) {
            mark_lost(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        self.core.verify_or_latch_locked(&mut runtime)?;
        if next_generation(&mut runtime).is_err() {
            mark_lost(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        Ok(ConditionalMutationResult::Applied)
    }

    pub(crate) fn sync_directory(&self) -> Result<(), PosixStoreError> {
        let mut runtime = lock_lease_runtime(&self.core)?;
        self.core.verify_or_latch_locked(&mut runtime)?;
        let directory = runtime.directory.as_ref().ok_or(PosixStoreError::Closed)?;
        let state = lock_unpoisoned(&directory.core.state)?;
        directory.core.require_secure_locked(&state)?;
        let directory_file = state.directory.as_ref().ok_or(PosixStoreError::Closed)?;
        rustix_fs::fsync(directory_file).map_err(|_| PosixStoreError::Io)?;
        if directory.core.require_secure_locked(&state).is_err() {
            drop(state);
            mark_lost(&mut runtime);
            return Err(PosixStoreError::Lost);
        }
        drop(state);
        self.core.verify_or_latch_locked(&mut runtime)
    }
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::fs::{self, OpenOptions};
    use std::os::unix::fs::{symlink, MetadataExt, OpenOptionsExt};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    use super::super::tests::{
        acquired_lease, create_private_directory, create_private_file, overwrite_private_file,
        verified_test_isolation, TestRoot, TEST_MARKER,
    };
    use super::*;

    const NONCE_1: &str = "b56c52f5-a090-41eb-a164-1c92e36db94f";
    const NONCE_2: &str = "4657f2a0-739f-4923-86e8-f25f1dc328f9";
    const ID_1: &str = "6d27ba17-aac9-4f72-bfca-bc6fe266fd27";
    const ID_2: &str = "342607ae-47c7-4da9-a01b-d763b8296e67";
    const ID_3: &str = "f168758d-3f57-4d14-b33a-b5ac27553d3e";
    const ID_4: &str = "319c79b8-b5db-46ea-8d2c-50b4872e725d";
    const CHILD_DIRECTORY_ENV: &str = "PLURUM_POSIX_MUTATION_CHILD_DIRECTORY";
    const CHILD_STAGE_ENV: &str = "PLURUM_POSIX_MUTATION_CHILD_STAGE";

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum CrashStage {
        CandidateCreated,
        CandidateSynced,
        JournalRenamed,
        JournalDirectorySynced,
        JournalRemoved,
        JournalRemovalSynced,
    }

    impl CrashStage {
        const ALL: [Self; 6] = [
            Self::CandidateCreated,
            Self::CandidateSynced,
            Self::JournalRenamed,
            Self::JournalDirectorySynced,
            Self::JournalRemoved,
            Self::JournalRemovalSynced,
        ];

        fn parse(value: &str) -> Option<Self> {
            match value {
                "candidate-created" => Some(Self::CandidateCreated),
                "candidate-synced" => Some(Self::CandidateSynced),
                "journal-renamed" => Some(Self::JournalRenamed),
                "journal-directory-synced" => Some(Self::JournalDirectorySynced),
                "journal-removed" => Some(Self::JournalRemoved),
                "journal-removal-synced" => Some(Self::JournalRemovalSynced),
                _ => None,
            }
        }

        fn as_str(self) -> &'static str {
            match self {
                Self::CandidateCreated => "candidate-created",
                Self::CandidateSynced => "candidate-synced",
                Self::JournalRenamed => "journal-renamed",
                Self::JournalDirectorySynced => "journal-directory-synced",
                Self::JournalRemoved => "journal-removed",
                Self::JournalRemovalSynced => "journal-removal-synced",
            }
        }
    }

    fn temporary(role: TemporaryEntryRole, id: &str) -> TemporaryEntry {
        TemporaryEntry::parse(role, id).expect("temporary entry must validate")
    }

    fn missing(lease: &PosixSetupLease, entry: ManagedEntry) -> MissingEntrySnapshot {
        match lease
            .observe_entry(entry)
            .expect("missing observation must complete")
        {
            ManagedEntryObservation::Missing { snapshot } => snapshot,
            ManagedEntryObservation::Opened { .. } => panic!("entry unexpectedly exists"),
        }
    }

    fn opened(
        lease: &PosixSetupLease,
        entry: ManagedEntry,
    ) -> (
        PresentEntrySnapshot,
        CredentialFileAttestation,
        PosixLeaseReadHandle,
    ) {
        match lease
            .observe_entry(entry)
            .expect("opened observation must complete")
        {
            ManagedEntryObservation::Missing { .. } => panic!("entry unexpectedly missing"),
            ManagedEntryObservation::Opened {
                snapshot,
                attestation,
                file,
            } => (*snapshot, attestation, file),
        }
    }

    fn create_written(
        lease: &PosixSetupLease,
        entry: TemporaryEntry,
        bytes: &[u8],
    ) -> PresentEntrySnapshot {
        let expected = missing(lease, ManagedEntry::Temporary(entry));
        let mut file = match lease
            .create_temporary_exclusive(entry, &expected)
            .expect("exclusive creation must complete")
        {
            ExclusiveCreateResult::Conflict => panic!("candidate unexpectedly conflicts"),
            ExclusiveCreateResult::Created(file) => file,
        };
        let before = file.attest().expect("empty candidate must attest");
        assert_eq!(before.security.size, 0);
        file.write_all(bytes)
            .expect("complete candidate write must succeed");
        file.sync().expect("candidate sync must succeed");
        let after = file.attest().expect("written candidate must attest");
        assert_eq!(after.security.identity, before.security.identity);
        assert_eq!(after.security.size, bytes.len() as u64);
        assert_ne!(after.revision, before.revision);
        file.close().expect("candidate handle must close");

        let (snapshot, _, mut reader) = opened(lease, ManagedEntry::Temporary(entry));
        let read = reader
            .read_bounded(entry.max_bytes() + 1)
            .expect("candidate must read within its role bound");
        assert_eq!(read.bytes, bytes);
        assert!(read.end_of_file);
        reader.close().expect("candidate reader must close");
        snapshot
    }

    fn read_entry(lease: &PosixSetupLease, entry: ManagedEntry) -> Vec<u8> {
        let (_, _, mut file) = opened(lease, entry);
        let result = file
            .read_bounded(entry.max_bytes() + 1)
            .expect("managed entry must read");
        assert!(result.end_of_file);
        file.close().expect("managed reader must close");
        result.bytes
    }

    fn verified_mutation_child_fixture() -> Option<(PathBuf, CrashStage)> {
        let directory = PathBuf::from(env::var_os(CHILD_DIRECTORY_ENV)?);
        let stage = env::var(CHILD_STAGE_ENV)
            .ok()
            .and_then(|value| CrashStage::parse(&value))
            .expect("mutation child stage must be exact");
        NormalizedAbsolutePath::parse(&directory)
            .expect("mutation child directory must be a normalized absolute path");

        let (process, _, temporary) = verified_test_isolation();
        let test_root = directory
            .parent()
            .expect("mutation child directory must have a parent");
        assert_eq!(test_root.parent(), Some(temporary.as_path()));
        assert_eq!(directory, test_root.join("plurum"));
        assert_eq!(
            test_root
                .canonicalize()
                .expect("mutation child test root must canonicalize"),
            test_root
        );

        let root_metadata =
            fs::symlink_metadata(test_root).expect("mutation child test root must exist");
        assert!(!root_metadata.file_type().is_symlink());
        assert!(root_metadata.is_dir());
        assert_eq!(root_metadata.uid(), process.uid);
        assert_eq!(
            root_metadata.mode() & PERMISSION_AND_SPECIAL_BITS,
            PRIVATE_DIRECTORY_MODE
        );

        let marker = test_root.join(".plurum-posix-native-test");
        let marker_metadata =
            fs::symlink_metadata(&marker).expect("mutation child test marker must exist");
        assert!(!marker_metadata.file_type().is_symlink());
        assert!(marker_metadata.is_file());
        assert_eq!(marker_metadata.uid(), process.uid);
        assert_eq!(marker_metadata.nlink(), 1);
        assert_eq!(
            marker_metadata.mode() & PERMISSION_AND_SPECIAL_BITS,
            PRIVATE_FILE_MODE
        );
        assert_eq!(
            fs::read_to_string(marker).expect("mutation child marker must be readable"),
            TEST_MARKER
        );
        assert!(
            !directory.exists(),
            "fresh mutation child store must not preexist"
        );
        Some((directory, stage))
    }

    fn exit_at(current: CrashStage, selected: CrashStage) {
        if current == selected {
            std::process::exit(0);
        }
    }

    fn spawn_crash_child(directory: &Path, stage: CrashStage) {
        let status = Command::new(
            env::current_exe().expect("native mutation test binary path must be available"),
        )
        .args([
            "--exact",
            "posix::mutation::tests::mutation_crash_child",
            "--nocapture",
        ])
        .env(CHILD_DIRECTORY_ENV, directory)
        .env(CHILD_STAGE_ENV, stage.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("mutation crash child must start");
        assert!(
            status.success(),
            "mutation crash child failed at {}: {status}",
            stage.as_str()
        );
    }

    fn assert_entry_and_remove(
        lease: &PosixSetupLease,
        entry: ManagedEntry,
        expected: Option<&[u8]>,
    ) -> bool {
        match lease
            .observe_entry(entry)
            .expect("recovered entry observation must complete")
        {
            ManagedEntryObservation::Missing { .. } => {
                assert!(
                    expected.is_none(),
                    "recovered entry is unexpectedly missing"
                );
                false
            }
            ManagedEntryObservation::Opened {
                snapshot, mut file, ..
            } => {
                let expected = expected.expect("recovered entry unexpectedly exists");
                let read = file
                    .read_bounded(entry.max_bytes() + 1)
                    .expect("recovered entry must be bounded");
                assert!(read.end_of_file);
                assert_eq!(read.bytes, expected);
                file.close().expect("recovered reader must close");
                assert_eq!(
                    lease.remove_conditionally(entry, &snapshot),
                    Ok(ConditionalMutationResult::Applied)
                );
                true
            }
        }
    }

    #[test]
    fn managed_entry_names_and_role_bounds_are_exact() {
        let expected = [
            (
                TemporaryEntryRole::Credential,
                ID_1,
                format!(".credentials-candidate-{ID_1}.tmp"),
                MAX_CREDENTIAL_BYTES,
            ),
            (
                TemporaryEntryRole::Transaction,
                ID_2,
                format!(".credentials-transaction-{ID_2}.tmp"),
                MAX_TRANSACTION_BYTES,
            ),
            (
                TemporaryEntryRole::Recovery,
                ID_3,
                format!(".credentials-recovery-{ID_3}.tmp"),
                MAX_CREDENTIAL_BYTES,
            ),
        ];
        for (role, id, name, max_bytes) in expected {
            let entry = temporary(role, id);
            assert_eq!(
                ManagedEntry::temporary(role, id),
                Ok(ManagedEntry::Temporary(entry))
            );
            assert_eq!(entry.file_name(), OsStr::new(&name));
            assert_eq!(entry.max_bytes(), max_bytes);
            assert_eq!(TemporaryEntry::from_file_name(name.as_bytes()), Some(entry));
        }
        assert_eq!(
            ManagedEntry::credential().file_name(),
            OsStr::new(CREDENTIAL_ENTRY)
        );
        assert_eq!(
            ManagedEntry::transaction().file_name(),
            OsStr::new(TRANSACTION_ENTRY)
        );
        assert_eq!(ManagedEntry::credential().max_bytes(), MAX_CREDENTIAL_BYTES);
        assert_eq!(
            ManagedEntry::transaction().max_bytes(),
            MAX_TRANSACTION_BYTES
        );

        for invalid in [
            "",
            "6D27BA17-AAC9-4F72-BFCA-BC6FE266FD27",
            "6d27ba17-aac9-3f72-bfca-bc6fe266fd27",
            "6d27ba17-aac9-4f72-7fca-bc6fe266fd27",
            "6d27ba17-aac9-4f72-bfca-bc6fe266fd27/extra",
        ] {
            assert!(TemporaryEntry::parse(TemporaryEntryRole::Credential, invalid).is_err());
        }
        for invalid_name in [
            b".credentials-candidate-invalid.tmp".as_slice(),
            b".credentials-candidate-6D27BA17-AAC9-4F72-BFCA-BC6FE266FD27.tmp".as_slice(),
            b".credentials-candidate-6d27ba17-aac9-4f72-bfca-bc6fe266fd27".as_slice(),
            b"credentials.json".as_slice(),
            b".credentials-recovery-6d27ba17-aac9-4f72-bfca-bc6fe266fd27.tmp.extra".as_slice(),
        ] {
            assert_eq!(TemporaryEntry::from_file_name(invalid_name), None);
        }
    }

    #[test]
    fn temporary_listing_is_sorted_exact_and_does_not_hide_unsafe_matches() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        let directory_attestation = lease
            .attest_directory()
            .expect("leased directory must attest");
        assert!(directory_attestation.canonical_current);
        let regular = temporary(TemporaryEntryRole::Credential, ID_2);
        let linked = temporary(TemporaryEntryRole::Recovery, ID_1);
        let directory = temporary(TemporaryEntryRole::Transaction, ID_3);
        let hard_linked = temporary(TemporaryEntryRole::Recovery, ID_4);
        create_private_file(&test.store.join(regular.file_name()), b"regular");
        symlink(&test.outside, test.store.join(linked.file_name()))
            .expect("managed symlink fixture must be created");
        create_private_directory(&test.store.join(directory.file_name()));
        let hard_link_source = test.root.join("hard-link-source");
        create_private_file(&hard_link_source, b"hard-linked");
        fs::hard_link(&hard_link_source, test.store.join(hard_linked.file_name()))
            .expect("managed hard-link fixture must be created");
        create_private_file(
            &test.store.join(".credentials-candidate-not-a-uuid.tmp"),
            b"ignored",
        );
        create_private_file(&test.store.join("unrelated"), b"ignored");

        let listed = lease
            .list_temporary_entries()
            .expect("temporary enumeration must succeed");
        let mut expected = vec![regular, linked, directory, hard_linked];
        expected.sort_by_key(|entry| entry.file_name());
        assert_eq!(listed, expected);

        let (_, _, mut regular_file) = opened(&lease, ManagedEntry::Temporary(regular));
        regular_file.close().expect("regular reader must close");
        assert!(matches!(
            lease.observe_entry(ManagedEntry::Temporary(linked)),
            Err(PosixStoreError::Unsafe)
        ));
        assert!(matches!(
            lease.observe_entry(ManagedEntry::Temporary(directory)),
            Err(PosixStoreError::Unsafe)
        ));
        assert!(matches!(
            lease.observe_entry(ManagedEntry::Temporary(hard_linked)),
            Err(PosixStoreError::Unsafe)
        ));
        assert_eq!(
            fs::read_to_string(&test.outside).expect("outside canary must remain readable"),
            "outside-canary\n"
        );
        lease.release().expect("listing lease must release");
    }

    #[test]
    fn exclusive_candidates_are_one_shot_bounded_and_never_truncate_conflicts() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        let entry = temporary(TemporaryEntryRole::Credential, ID_1);
        let expected = missing(&lease, ManagedEntry::Temporary(entry));
        let mut file = match lease
            .create_temporary_exclusive(entry, &expected)
            .expect("exclusive creation must complete")
        {
            ExclusiveCreateResult::Conflict => panic!("candidate unexpectedly conflicts"),
            ExclusiveCreateResult::Created(file) => file,
        };
        assert!(matches!(
            lease.create_temporary_exclusive(entry, &expected),
            Ok(ExclusiveCreateResult::Conflict)
        ));
        assert_eq!(file.write_all(&[]), Err(PosixStoreError::InvalidInput));
        assert_eq!(
            file.write_all(&vec![b'x'; MAX_CREDENTIAL_BYTES + 1]),
            Err(PosixStoreError::Limit)
        );
        file.write_all(b"alpha")
            .expect("bounded candidate write must succeed");
        assert_eq!(file.write_all(b"bravo"), Err(PosixStoreError::InvalidInput));
        file.sync().expect("written candidate must sync");
        file.close().expect("write handle must close");
        assert_eq!(read_entry(&lease, ManagedEntry::Temporary(entry)), b"alpha");

        let symlink_entry = temporary(TemporaryEntryRole::Recovery, ID_2);
        let symlink_missing = missing(&lease, ManagedEntry::Temporary(symlink_entry));
        symlink(&test.outside, test.store.join(symlink_entry.file_name()))
            .expect("candidate symlink must be created");
        assert!(matches!(
            lease.create_temporary_exclusive(symlink_entry, &symlink_missing),
            Ok(ExclusiveCreateResult::Conflict)
        ));
        assert_eq!(
            fs::read_to_string(&test.outside).expect("outside canary must remain readable"),
            "outside-canary\n"
        );
        lease
            .release()
            .expect("exclusive-create lease must release");
    }

    #[test]
    fn transaction_candidates_accept_the_exact_bound_and_reject_one_byte_more() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        let exact_entry = temporary(TemporaryEntryRole::Transaction, ID_1);
        let exact_bytes = vec![b'j'; MAX_TRANSACTION_BYTES];
        let exact_snapshot = create_written(&lease, exact_entry, &exact_bytes);
        assert_eq!(
            lease.remove_conditionally(ManagedEntry::Temporary(exact_entry), &exact_snapshot,),
            Ok(ConditionalMutationResult::Applied)
        );

        let oversized_entry = temporary(TemporaryEntryRole::Transaction, ID_2);
        let expected = missing(&lease, ManagedEntry::Temporary(oversized_entry));
        let mut oversized = match lease
            .create_temporary_exclusive(oversized_entry, &expected)
            .expect("oversized candidate creation must complete")
        {
            ExclusiveCreateResult::Conflict => {
                panic!("oversized candidate unexpectedly conflicts")
            }
            ExclusiveCreateResult::Created(file) => file,
        };
        assert_eq!(
            oversized.write_all(&vec![b'j'; MAX_TRANSACTION_BYTES + 1]),
            Err(PosixStoreError::Limit)
        );
        oversized
            .close()
            .expect("oversized candidate handle must close");
        let (empty_snapshot, empty_attestation, mut empty_reader) =
            opened(&lease, ManagedEntry::Temporary(oversized_entry));
        assert_eq!(empty_attestation.security.size, 0);
        empty_reader
            .close()
            .expect("empty oversized candidate reader must close");
        assert_eq!(
            lease.remove_conditionally(ManagedEntry::Temporary(oversized_entry), &empty_snapshot,),
            Ok(ConditionalMutationResult::Applied)
        );
        lease
            .sync_directory()
            .expect("boundary fixture cleanup must become durable");
        lease.release().expect("boundary lease must release");
    }

    #[test]
    fn temporary_listing_fails_closed_at_the_managed_entry_bound() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        for index in 0..=MAX_TEMPORARY_ENTRIES {
            let id = format!("00000000-0000-4000-8000-{index:012x}");
            let entry = temporary(TemporaryEntryRole::Credential, &id);
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(PRIVATE_FILE_MODE)
                .open(test.store.join(entry.file_name()))
                .expect("bounded-list fixture must be created");
        }
        assert_eq!(lease.list_temporary_entries(), Err(PosixStoreError::Limit));
        lease.release().expect("bounded-list lease must release");
    }

    #[test]
    fn temporary_listing_fails_closed_at_the_overall_directory_bound() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        for index in 0..MAX_DIRECTORY_ENTRIES {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(PRIVATE_FILE_MODE)
                .open(test.store.join(format!("unmanaged-{index:04x}")))
                .expect("overall-list fixture must be created");
        }
        assert_eq!(lease.list_temporary_entries(), Err(PosixStoreError::Limit));
        lease
            .release()
            .expect("overall-list-bound lease must release");
    }

    #[test]
    fn snapshots_are_entry_generation_and_lease_scoped() {
        let test = TestRoot::new();
        let (_, _, mut first_lease) = acquired_lease(&test.store, NONCE_1);
        let first = temporary(TemporaryEntryRole::Credential, ID_1);
        let second = temporary(TemporaryEntryRole::Credential, ID_2);
        let first_missing = missing(&first_lease, ManagedEntry::Temporary(first));
        let second_missing = missing(&first_lease, ManagedEntry::Temporary(second));
        assert!(matches!(
            first_lease.create_temporary_exclusive(second, &first_missing),
            Ok(ExclusiveCreateResult::Conflict)
        ));
        let mut first_file = match first_lease
            .create_temporary_exclusive(first, &first_missing)
            .expect("first candidate creation must complete")
        {
            ExclusiveCreateResult::Conflict => panic!("first candidate unexpectedly conflicts"),
            ExclusiveCreateResult::Created(file) => file,
        };
        assert!(matches!(
            first_lease.create_temporary_exclusive(second, &second_missing),
            Ok(ExclusiveCreateResult::Conflict)
        ));
        first_file
            .write_all(b"first")
            .expect("first candidate must write");
        first_file.sync().expect("first candidate must sync");
        first_file.close().expect("first candidate must close");
        let (first_present, _, mut first_reader) =
            opened(&first_lease, ManagedEntry::Temporary(first));
        first_lease.release().expect("first lease must release");
        assert_eq!(first_reader.attest(), Err(PosixStoreError::Closed));
        first_reader.close().expect("invalidated reader must close");

        let (_, _, mut second_lease) = acquired_lease(&test.store, NONCE_2);
        assert!(matches!(
            second_lease.create_temporary_exclusive(second, &second_missing),
            Ok(ExclusiveCreateResult::Conflict)
        ));
        assert_eq!(
            second_lease.remove_conditionally(ManagedEntry::Temporary(first), &first_present),
            Ok(ConditionalMutationResult::Conflict)
        );
        let (current, _, mut current_reader) =
            opened(&second_lease, ManagedEntry::Temporary(first));
        current_reader.close().expect("current reader must close");
        assert_eq!(
            second_lease.remove_conditionally(ManagedEntry::Temporary(first), &current),
            Ok(ConditionalMutationResult::Applied)
        );
        second_lease
            .sync_directory()
            .expect("removal must become directory-durable");
        second_lease.release().expect("second lease must release");
    }

    #[test]
    fn conditional_move_installs_into_missing_and_existing_canonical_entries() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);

        let first = temporary(TemporaryEntryRole::Credential, ID_1);
        let first_snapshot = create_written(&lease, first, b"first");
        let credential_missing = missing(&lease, ManagedEntry::credential());
        assert_eq!(
            lease.move_temporary_conditionally(
                first,
                &first_snapshot,
                CanonicalEntryRole::Credential,
                ExpectedEntrySnapshot::Missing(&credential_missing),
            ),
            Ok(ConditionalMutationResult::Applied)
        );
        lease
            .sync_directory()
            .expect("first install must become directory-durable");
        assert_eq!(read_entry(&lease, ManagedEntry::credential()), b"first");

        let second = temporary(TemporaryEntryRole::Credential, ID_2);
        let second_snapshot = create_written(&lease, second, b"second");
        let (credential_present, _, mut old_reader) = opened(&lease, ManagedEntry::credential());
        old_reader
            .close()
            .expect("old credential reader must close");
        assert_eq!(
            lease.move_temporary_conditionally(
                second,
                &second_snapshot,
                CanonicalEntryRole::Credential,
                ExpectedEntrySnapshot::Present(&credential_present),
            ),
            Ok(ConditionalMutationResult::Applied)
        );
        lease
            .sync_directory()
            .expect("replacement must become directory-durable");
        assert_eq!(read_entry(&lease, ManagedEntry::credential()), b"second");
        assert!(matches!(
            lease.observe_entry(ManagedEntry::Temporary(first)),
            Ok(ManagedEntryObservation::Missing { .. })
        ));
        assert!(matches!(
            lease.observe_entry(ManagedEntry::Temporary(second)),
            Ok(ManagedEntryObservation::Missing { .. })
        ));
        lease.release().expect("move lease must release");
    }

    #[test]
    fn missing_destination_conflicts_preserve_both_existing_objects() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        let source = temporary(TemporaryEntryRole::Transaction, ID_1);
        let source_snapshot = create_written(&lease, source, b"source-journal");
        let destination_missing = missing(&lease, ManagedEntry::transaction());
        create_private_file(&test.store.join(TRANSACTION_ENTRY), b"late-journal");

        assert_eq!(
            lease.move_temporary_conditionally(
                source,
                &source_snapshot,
                CanonicalEntryRole::Transaction,
                ExpectedEntrySnapshot::Missing(&destination_missing),
            ),
            Ok(ConditionalMutationResult::Conflict)
        );
        assert_eq!(
            read_entry(&lease, ManagedEntry::Temporary(source)),
            b"source-journal"
        );
        assert_eq!(
            read_entry(&lease, ManagedEntry::transaction()),
            b"late-journal"
        );
        lease.release().expect("conflict lease must release");
    }

    #[test]
    fn conditional_moves_reject_stale_source_and_destination_revisions() {
        {
            let test = TestRoot::new();
            let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
            let source = temporary(TemporaryEntryRole::Credential, ID_1);
            let source_snapshot = create_written(&lease, source, b"source");
            let destination_missing = missing(&lease, ManagedEntry::credential());
            overwrite_private_file(&test.store.join(source.file_name()), b"changed-source");

            assert_eq!(
                lease.move_temporary_conditionally(
                    source,
                    &source_snapshot,
                    CanonicalEntryRole::Credential,
                    ExpectedEntrySnapshot::Missing(&destination_missing),
                ),
                Ok(ConditionalMutationResult::Conflict)
            );
            assert_eq!(
                read_entry(&lease, ManagedEntry::Temporary(source)),
                b"changed-source"
            );
            assert!(matches!(
                lease.observe_entry(ManagedEntry::credential()),
                Ok(ManagedEntryObservation::Missing { .. })
            ));
            lease.release().expect("stale-source lease must release");
        }

        {
            let test = TestRoot::new();
            let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
            let initial = temporary(TemporaryEntryRole::Credential, ID_1);
            let initial_snapshot = create_written(&lease, initial, b"initial");
            let destination_missing = missing(&lease, ManagedEntry::credential());
            assert_eq!(
                lease.move_temporary_conditionally(
                    initial,
                    &initial_snapshot,
                    CanonicalEntryRole::Credential,
                    ExpectedEntrySnapshot::Missing(&destination_missing),
                ),
                Ok(ConditionalMutationResult::Applied)
            );

            let source = temporary(TemporaryEntryRole::Credential, ID_2);
            let source_snapshot = create_written(&lease, source, b"source");
            let (destination_snapshot, _, mut destination_reader) =
                opened(&lease, ManagedEntry::credential());
            destination_reader
                .close()
                .expect("destination reader must close");
            overwrite_private_file(&test.store.join(CREDENTIAL_ENTRY), b"changed-destination");

            assert_eq!(
                lease.move_temporary_conditionally(
                    source,
                    &source_snapshot,
                    CanonicalEntryRole::Credential,
                    ExpectedEntrySnapshot::Present(&destination_snapshot),
                ),
                Ok(ConditionalMutationResult::Conflict)
            );
            assert_eq!(
                read_entry(&lease, ManagedEntry::Temporary(source)),
                b"source"
            );
            assert_eq!(
                read_entry(&lease, ManagedEntry::credential()),
                b"changed-destination"
            );
            lease
                .release()
                .expect("stale-destination lease must release");
        }
    }

    #[test]
    fn conditional_move_rejects_an_unsafe_source_without_touching_its_target() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        let source = temporary(TemporaryEntryRole::Credential, ID_1);
        let source_snapshot = create_written(&lease, source, b"source");
        let destination_missing = missing(&lease, ManagedEntry::credential());
        fs::remove_file(test.store.join(source.file_name()))
            .expect("source fixture must be removed");
        symlink(&test.outside, test.store.join(source.file_name()))
            .expect("unsafe source symlink must be created");

        assert_eq!(
            lease.move_temporary_conditionally(
                source,
                &source_snapshot,
                CanonicalEntryRole::Credential,
                ExpectedEntrySnapshot::Missing(&destination_missing),
            ),
            Err(PosixStoreError::Unsafe)
        );
        assert_eq!(
            fs::read_to_string(&test.outside).expect("outside canary must remain readable"),
            "outside-canary\n"
        );
        assert!(!test.store.join(CREDENTIAL_ENTRY).exists());
        lease.release().expect("unsafe-source lease must release");
    }

    #[test]
    fn conditional_remove_requires_the_exact_content_revision() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        let entry = temporary(TemporaryEntryRole::Recovery, ID_1);
        let stale = create_written(&lease, entry, b"alpha");
        overwrite_private_file(&test.store.join(entry.file_name()), b"bravo");

        assert_eq!(
            lease.remove_conditionally(ManagedEntry::Temporary(entry), &stale),
            Ok(ConditionalMutationResult::Conflict)
        );
        assert_eq!(read_entry(&lease, ManagedEntry::Temporary(entry)), b"bravo");
        let (current, _, mut reader) = opened(&lease, ManagedEntry::Temporary(entry));
        reader.close().expect("current recovery reader must close");
        assert_eq!(
            lease.remove_conditionally(ManagedEntry::Temporary(entry), &current),
            Ok(ConditionalMutationResult::Applied)
        );
        lease
            .sync_directory()
            .expect("conditional removal must become durable");
        assert!(!test.store.join(entry.file_name()).exists());
        lease.release().expect("remove lease must release");
    }

    #[test]
    fn native_primitives_preserve_the_portable_journal_commit_order() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        let mut trace = Vec::new();

        let journal_candidate = temporary(TemporaryEntryRole::Transaction, ID_1);
        let journal_source = create_written(&lease, journal_candidate, b"rollback-authority");
        trace.push("journal-file-sync");
        let journal_missing = missing(&lease, ManagedEntry::transaction());
        assert_eq!(
            lease.move_temporary_conditionally(
                journal_candidate,
                &journal_source,
                CanonicalEntryRole::Transaction,
                ExpectedEntrySnapshot::Missing(&journal_missing),
            ),
            Ok(ConditionalMutationResult::Applied)
        );
        trace.push("journal-rename");
        lease
            .sync_directory()
            .expect("journal rename must become durable");
        trace.push("journal-directory-sync");

        let credential_candidate = temporary(TemporaryEntryRole::Credential, ID_2);
        let credential_source = create_written(&lease, credential_candidate, b"active-credential");
        trace.push("credential-file-sync");
        let credential_missing = missing(&lease, ManagedEntry::credential());
        assert_eq!(
            lease.move_temporary_conditionally(
                credential_candidate,
                &credential_source,
                CanonicalEntryRole::Credential,
                ExpectedEntrySnapshot::Missing(&credential_missing),
            ),
            Ok(ConditionalMutationResult::Applied)
        );
        trace.push("credential-rename");
        lease
            .sync_directory()
            .expect("credential rename must become durable");
        trace.push("credential-directory-sync");
        assert_eq!(
            read_entry(&lease, ManagedEntry::credential()),
            b"active-credential"
        );
        trace.push("credential-reopen-verify");

        let (journal_snapshot, _, mut journal_reader) = opened(&lease, ManagedEntry::transaction());
        journal_reader.close().expect("journal reader must close");
        assert_eq!(
            lease.remove_conditionally(ManagedEntry::transaction(), &journal_snapshot),
            Ok(ConditionalMutationResult::Applied)
        );
        trace.push("journal-remove");
        lease
            .sync_directory()
            .expect("journal removal commit point must become durable");
        trace.push("journal-removal-directory-sync");

        assert_eq!(
            trace,
            [
                "journal-file-sync",
                "journal-rename",
                "journal-directory-sync",
                "credential-file-sync",
                "credential-rename",
                "credential-directory-sync",
                "credential-reopen-verify",
                "journal-remove",
                "journal-removal-directory-sync",
            ]
        );
        assert!(matches!(
            lease.observe_entry(ManagedEntry::transaction()),
            Ok(ManagedEntryObservation::Missing { .. })
        ));
        lease
            .release()
            .expect("transaction-order lease must release");
    }

    #[test]
    fn lock_replacement_blocks_mutation_and_terminally_loses_the_lease() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        let source = temporary(TemporaryEntryRole::Credential, ID_1);
        let source_snapshot = create_written(&lease, source, b"candidate");
        let destination_missing = missing(&lease, ManagedEntry::credential());

        let lock = test.store.join(SETUP_LOCK_ENTRY);
        fs::rename(&lock, test.store.join("detached-setup-lock"))
            .expect("held setup lock must be detached");
        create_private_file(&lock, b"replacement");

        assert_eq!(
            lease.move_temporary_conditionally(
                source,
                &source_snapshot,
                CanonicalEntryRole::Credential,
                ExpectedEntrySnapshot::Missing(&destination_missing),
            ),
            Err(PosixStoreError::Lost)
        );
        assert_eq!(
            fs::read(test.store.join(source.file_name()))
                .expect("candidate must survive rejected mutation"),
            b"candidate"
        );
        assert!(!test.store.join(CREDENTIAL_ENTRY).exists());
        assert_eq!(lease.release(), Err(PosixStoreError::Lost));
    }

    #[test]
    fn directory_replacement_blocks_mutation_without_touching_either_directory() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        let source = temporary(TemporaryEntryRole::Credential, ID_1);
        let source_snapshot = create_written(&lease, source, b"detached-candidate");
        let destination_missing = missing(&lease, ManagedEntry::credential());

        let detached = test.root.join("detached-store");
        fs::rename(&test.store, &detached).expect("leased store must be detached");
        create_private_directory(&test.store);
        create_private_file(&test.store.join(CREDENTIAL_ENTRY), b"replacement-directory");

        assert_eq!(
            lease.move_temporary_conditionally(
                source,
                &source_snapshot,
                CanonicalEntryRole::Credential,
                ExpectedEntrySnapshot::Missing(&destination_missing),
            ),
            Err(PosixStoreError::Lost)
        );
        assert_eq!(
            fs::read(detached.join(source.file_name()))
                .expect("detached candidate must remain readable"),
            b"detached-candidate"
        );
        assert_eq!(
            fs::read(test.store.join(CREDENTIAL_ENTRY))
                .expect("replacement directory must remain readable"),
            b"replacement-directory"
        );
        assert_eq!(lease.release(), Err(PosixStoreError::Lost));
    }

    #[test]
    fn namespace_mutation_stales_preexisting_exclusive_write_handles() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        let first = temporary(TemporaryEntryRole::Credential, ID_1);
        let first_missing = missing(&lease, ManagedEntry::Temporary(first));
        let mut first_file = match lease
            .create_temporary_exclusive(first, &first_missing)
            .expect("first stale-handle candidate creation must complete")
        {
            ExclusiveCreateResult::Conflict => panic!("first candidate unexpectedly conflicts"),
            ExclusiveCreateResult::Created(file) => file,
        };

        let second = temporary(TemporaryEntryRole::Credential, ID_2);
        let second_missing = missing(&lease, ManagedEntry::Temporary(second));
        let mut second_file = match lease
            .create_temporary_exclusive(second, &second_missing)
            .expect("second stale-handle candidate creation must complete")
        {
            ExclusiveCreateResult::Conflict => panic!("second candidate unexpectedly conflicts"),
            ExclusiveCreateResult::Created(file) => file,
        };

        assert_eq!(first_file.write_all(b"stale"), Err(PosixStoreError::Lost));
        assert_eq!(first_file.attest(), Err(PosixStoreError::Lost));
        assert_eq!(lease.renew(), LeaseRenewal::Held);
        first_file.close().expect("stale write handle must close");
        second_file
            .close()
            .expect("current write handle must close");
        lease.release().expect("stale-handle lease must release");
    }

    #[test]
    fn poisoned_lease_state_terminates_handles_and_preserves_abandonment_proof() {
        let test = TestRoot::new();
        let (_, _, mut lease) = acquired_lease(&test.store, NONCE_1);
        let entry = temporary(TemporaryEntryRole::Recovery, ID_1);
        let expected = missing(&lease, ManagedEntry::Temporary(entry));
        let mut file = match lease
            .create_temporary_exclusive(entry, &expected)
            .expect("poison fixture creation must complete")
        {
            ExclusiveCreateResult::Conflict => panic!("poison fixture unexpectedly conflicts"),
            ExclusiveCreateResult::Created(file) => file,
        };

        assert!(catch_unwind(AssertUnwindSafe(|| {
            let _runtime = lease
                .core
                .runtime
                .lock()
                .expect("lease mutex must initially be healthy");
            panic!("intentional lease mutex poison");
        }))
        .is_err());
        assert_eq!(lease.release(), Err(PosixStoreError::Lost));
        assert_eq!(file.attest(), Err(PosixStoreError::Closed));
        file.close().expect("invalidated poison handle must close");

        let (prior, disposition, mut recovered) = acquired_lease(&test.store, NONCE_2);
        assert_eq!(prior, PriorLease::ProvenAbandoned);
        assert_eq!(disposition, DirectoryDisposition::Existing);
        recovered
            .release()
            .expect("lease recovered after poison must release");
    }

    #[test]
    fn process_crashes_leave_inspectable_states_and_recoverable_exclusion() {
        const JOURNAL_BYTES: &[u8] = b"rollback-authority";

        for stage in CrashStage::ALL {
            let test = TestRoot::new();
            spawn_crash_child(&test.store, stage);

            let (prior, disposition, mut recovered) = acquired_lease(&test.store, NONCE_2);
            assert_eq!(
                prior,
                PriorLease::ProvenAbandoned,
                "stage {} must retain abandonment proof",
                stage.as_str()
            );
            assert_eq!(disposition, DirectoryDisposition::Existing);

            let candidate_expected = match stage {
                CrashStage::CandidateCreated => Some(&b""[..]),
                CrashStage::CandidateSynced => Some(JOURNAL_BYTES),
                _ => None,
            };
            let journal_expected = match stage {
                CrashStage::JournalRenamed | CrashStage::JournalDirectorySynced => {
                    Some(JOURNAL_BYTES)
                }
                _ => None,
            };
            let candidate = temporary(TemporaryEntryRole::Transaction, ID_1);
            let mut removed = assert_entry_and_remove(
                &recovered,
                ManagedEntry::Temporary(candidate),
                candidate_expected,
            );
            removed |=
                assert_entry_and_remove(&recovered, ManagedEntry::transaction(), journal_expected);
            if removed {
                recovered
                    .sync_directory()
                    .expect("recovered cleanup must become durable");
            }
            assert!(recovered
                .list_temporary_entries()
                .expect("post-recovery listing must succeed")
                .is_empty());
            recovered
                .release()
                .expect("recovered crash-stage lease must release");
        }
    }

    #[test]
    fn mutation_crash_child() {
        let Some((directory, stage)) = verified_mutation_child_fixture() else {
            return;
        };
        let (_, _, lease) = acquired_lease(&directory, NONCE_1);
        let candidate = temporary(TemporaryEntryRole::Transaction, ID_1);
        let expected = missing(&lease, ManagedEntry::Temporary(candidate));
        let mut file = match lease
            .create_temporary_exclusive(candidate, &expected)
            .expect("crash candidate creation must complete")
        {
            ExclusiveCreateResult::Conflict => panic!("crash candidate unexpectedly conflicts"),
            ExclusiveCreateResult::Created(file) => file,
        };
        exit_at(CrashStage::CandidateCreated, stage);

        file.write_all(b"rollback-authority")
            .expect("crash candidate must write");
        file.sync().expect("crash candidate must sync");
        exit_at(CrashStage::CandidateSynced, stage);
        file.close().expect("crash candidate handle must close");

        let (source, _, mut reader) = opened(&lease, ManagedEntry::Temporary(candidate));
        reader.close().expect("crash candidate reader must close");
        let destination = missing(&lease, ManagedEntry::transaction());
        assert_eq!(
            lease.move_temporary_conditionally(
                candidate,
                &source,
                CanonicalEntryRole::Transaction,
                ExpectedEntrySnapshot::Missing(&destination),
            ),
            Ok(ConditionalMutationResult::Applied)
        );
        exit_at(CrashStage::JournalRenamed, stage);

        lease
            .sync_directory()
            .expect("crash journal rename must become durable");
        exit_at(CrashStage::JournalDirectorySynced, stage);

        let (journal, _, mut journal_reader) = opened(&lease, ManagedEntry::transaction());
        journal_reader
            .close()
            .expect("crash journal reader must close");
        assert_eq!(
            lease.remove_conditionally(ManagedEntry::transaction(), &journal),
            Ok(ConditionalMutationResult::Applied)
        );
        exit_at(CrashStage::JournalRemoved, stage);

        lease
            .sync_directory()
            .expect("crash journal removal must become durable");
        exit_at(CrashStage::JournalRemovalSynced, stage);
        panic!("every validated crash stage must terminate the child");
    }
}
