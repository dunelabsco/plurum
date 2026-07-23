use std::ffi::OsStr;
use std::path::Path;
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{
    External, FunctionCallContext, JsObjectValue, KeyCollectionMode, KeyConversion, KeyFilter,
    Object, ObjectRef, Uint8Array,
};
use napi::{Env, Error, JsValue, Result, Status};
use plurum_native_secret_memory::{
    create_guarded_bounded_read_result, create_guarded_loaded_result, zeroize_bytes,
    GuardedObjectRef,
};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::posix as platform;
#[cfg(target_os = "windows")]
use crate::windows as platform;

use platform::{
    acquire_observed_setup_lease, acquire_reconciliation_journal_lease, acquire_setup_lease,
    observe_missing_private_directory, open_private_directory, read_allowlisted_legacy_credential,
    BoundedRead, CanonicalEntryRole, ConditionalMutationResult, CredentialFileAttestation,
    CredentialReadOpenResult, DirectoryAttestation, DirectoryDisposition, ExclusiveCreateResult,
    ExpectedEntrySnapshot, JournalObservation, JournalRemoveResult, JournalReplaceResult,
    JournalRevision, LeaseRenewal, LegacyCredentialReadResult, ManagedEntry,
    ManagedEntryObservation, MissingDirectoryBinding, MissingEntrySnapshot, ObjectIdentity,
    ObservedDirectoryExpectation, ObservedSetupLeaseAcquireResult, PresentEntrySnapshot,
    PriorLease, PrivateDirectoryOpenResult, PrivateManagedEntryObservation,
    ReconciliationJournalLeaseAcquireResult, SetupLeaseAcquireResult, TemporaryEntry,
    TemporaryEntryRole, MAX_ATTESTED_BYTES,
};

type SharedHandle<T> = Arc<Mutex<Option<T>>>;
type BridgeObject = ObjectRef<false>;
#[cfg(any(target_os = "macos", target_os = "linux"))]
type PlatformCredentialReadHandle = platform::PosixCredentialReadHandle;
#[cfg(target_os = "windows")]
type PlatformCredentialReadHandle = platform::WindowsCredentialReadHandle;
#[cfg(any(target_os = "macos", target_os = "linux"))]
type PlatformExclusiveWriteHandle = platform::PosixExclusiveWriteHandle;
#[cfg(target_os = "windows")]
type PlatformExclusiveWriteHandle = platform::WindowsExclusiveWriteHandle;
#[cfg(any(target_os = "macos", target_os = "linux"))]
type PlatformLeaseReadHandle = platform::PosixLeaseReadHandle;
#[cfg(target_os = "windows")]
type PlatformLeaseReadHandle = platform::WindowsLeaseReadHandle;
#[cfg(any(target_os = "macos", target_os = "linux"))]
type PlatformPrivateDirectory = platform::PosixPrivateDirectory;
#[cfg(target_os = "windows")]
type PlatformPrivateDirectory = platform::WindowsPrivateDirectory;
#[cfg(any(target_os = "macos", target_os = "linux"))]
type PlatformSetupLease = platform::PosixSetupLease;
#[cfg(target_os = "windows")]
type PlatformSetupLease = platform::WindowsSetupLease;
#[cfg(any(target_os = "macos", target_os = "linux"))]
type PlatformReconciliationJournalLease = platform::PosixReconciliationJournalLease;
#[cfg(target_os = "windows")]
type PlatformReconciliationJournalLease = platform::WindowsReconciliationJournalLease;
#[cfg(any(target_os = "macos", target_os = "linux"))]
type PlatformStoreError = platform::PosixStoreError;
#[cfg(target_os = "windows")]
type PlatformStoreError = platform::WindowsStoreError;

enum SnapshotToken {
    Missing(MissingEntrySnapshot),
    Present(Box<PresentEntrySnapshot>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LegacyPaths {
    hermes: String,
    openclaw: String,
    removed_cli: String,
}

#[derive(Debug)]
struct AdapterAuthority {
    legacy_paths: LegacyPaths,
    state_directory: String,
}

struct JournalRevisionToken {
    value: Mutex<Option<JournalRevision>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ObservedEntryState {
    Missing,
    Present(CredentialFileAttestation),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ObservedEntry {
    entry: ManagedEntry,
    state: ObservedEntryState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StoreSnapshot {
    directory: DirectoryAttestation,
    entries: Vec<ObservedEntry>,
}

struct PresentEvidence {
    binding: PlatformPrivateDirectory,
    snapshot: StoreSnapshot,
}

enum EvidenceState {
    Missing(MissingDirectoryBinding),
    Present(PresentEvidence),
}

struct WholePassEvidence {
    authority: Arc<AdapterAuthority>,
    directory: String,
    state: EvidenceState,
}

struct EvidenceToken {
    value: Mutex<Option<WholePassEvidence>>,
}

struct ObservationProgress {
    authority: Arc<AdapterAuthority>,
    directory_path: String,
    directory: Option<PlatformPrivateDirectory>,
    attestations: Vec<DirectoryAttestation>,
    listed_temporaries: Option<Vec<TemporaryEntry>>,
    entries: Vec<ObservedEntry>,
    file_protocols: Vec<Arc<Mutex<ObservationFileProtocol>>>,
    finished: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ObservationFileReadPlan {
    AttestOnly,
    ReadBounded(usize),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ObservationFileStage {
    FirstAttestation,
    Read,
    SecondAttestation,
    Close,
    Complete,
    Failed,
}

struct ObservationFileProtocol {
    declared: CredentialFileAttestation,
    plan: ObservationFileReadPlan,
    stage: ObservationFileStage,
}

const CREDENTIAL_OBSERVATION_READ_BYTES: usize = 16_385;
const TRANSACTION_OBSERVATION_READ_BYTES: usize = 40_961;

fn bridge_error() -> Error {
    Error::new(
        Status::GenericFailure,
        "Native credential operation failed.",
    )
}

fn invalid_request() -> Error {
    Error::new(
        Status::InvalidArg,
        "The native credential request is invalid.",
    )
}

fn native_result<T>(result: std::result::Result<T, PlatformStoreError>) -> Result<T> {
    result.map_err(|_| bridge_error())
}

fn exact_argument_count(context: &FunctionCallContext<'_>, expected: usize) -> Result<()> {
    if context.length() == expected {
        Ok(())
    } else {
        Err(invalid_request())
    }
}

fn argument<T: napi::bindgen_prelude::FromNapiValue>(
    context: &FunctionCallContext<'_>,
    index: usize,
) -> Result<T> {
    context.get(index).map_err(|_| invalid_request())
}

fn property<T: napi::bindgen_prelude::FromNapiValue>(object: &Object<'_>, name: &str) -> Result<T> {
    object
        .get(name)
        .map_err(|_| invalid_request())?
        .ok_or_else(invalid_request)
}

fn exact_keys(object: &Object<'_>, expected: &[&str]) -> Result<()> {
    if object.is_array().map_err(|_| invalid_request())?
        || object.is_typedarray().map_err(|_| invalid_request())?
        || object.is_arraybuffer().map_err(|_| invalid_request())?
        || object.is_dataview().map_err(|_| invalid_request())?
        || object.is_buffer().map_err(|_| invalid_request())?
        || object.is_promise().map_err(|_| invalid_request())?
    {
        return Err(invalid_request());
    }
    let names = object
        .get_all_property_names(
            KeyCollectionMode::OwnOnly,
            KeyFilter::AllProperties,
            KeyConversion::KeepNumbers,
        )
        .map_err(|_| invalid_request())?;
    let length = names.get_array_length().map_err(|_| invalid_request())?;
    let mut actual = Vec::with_capacity(length as usize);
    for index in 0..length {
        actual.push(
            names
                .get_element::<String>(index)
                .map_err(|_| invalid_request())?,
        );
    }
    if actual.len() == expected.len() && actual.iter().all(|key| expected.contains(&key.as_str())) {
        Ok(())
    } else {
        Err(invalid_request())
    }
}

fn finish_object(object: &Object<'_>) -> Result<BridgeObject> {
    object.create_ref::<false>().map_err(|_| bridge_error())
}

fn expect_true(object: &Object<'_>, name: &str) -> Result<()> {
    if property::<bool>(object, name)? {
        Ok(())
    } else {
        Err(invalid_request())
    }
}

fn parse_authority(configuration: &Object<'_>) -> Result<AdapterAuthority> {
    exact_keys(configuration, &["legacyPaths", "stateDirectory"])?;
    let paths = property::<Object<'_>>(configuration, "legacyPaths")?;
    exact_keys(&paths, &["hermes", "openclaw", "removedCli"])?;
    let hermes = property::<String>(&paths, "hermes")?;
    let openclaw = property::<String>(&paths, "openclaw")?;
    let removed_cli = property::<String>(&paths, "removedCli")?;
    let state_directory = property::<String>(configuration, "stateDirectory")?;
    if hermes.is_empty()
        || openclaw.is_empty()
        || removed_cli.is_empty()
        || state_directory.is_empty()
        || hermes.len() > 32_768
        || openclaw.len() > 32_768
        || removed_cli.len() > 32_768
        || state_directory.len() > 32_768
        || hermes.contains('\0')
        || openclaw.contains('\0')
        || removed_cli.contains('\0')
        || state_directory.contains('\0')
    {
        return Err(invalid_request());
    }
    Ok(AdapterAuthority {
        legacy_paths: LegacyPaths {
            hermes,
            openclaw,
            removed_cli,
        },
        state_directory,
    })
}

fn take_journal_revision_property(object: &Object<'_>, name: &str) -> Result<JournalRevision> {
    let external = property::<&External<Arc<JournalRevisionToken>>>(object, name)?;
    external
        .as_ref()
        .value
        .lock()
        .map_err(|_| bridge_error())?
        .take()
        .ok_or_else(invalid_request)
}

fn journal_revision_external(value: JournalRevision) -> External<Arc<JournalRevisionToken>> {
    External::new(Arc::new(JournalRevisionToken {
        value: Mutex::new(Some(value)),
    }))
}

fn take_evidence_property(object: &Object<'_>, name: &str) -> Result<WholePassEvidence> {
    let external = property::<&External<Arc<EvidenceToken>>>(object, name)?;
    external
        .as_ref()
        .value
        .lock()
        .map_err(|_| bridge_error())?
        .take()
        .ok_or_else(invalid_request)
}

fn evidence_external(value: WholePassEvidence) -> External<Arc<EvidenceToken>> {
    External::new(Arc::new(EvidenceToken {
        value: Mutex::new(Some(value)),
    }))
}

fn with_handle<T, R>(
    handle: &SharedHandle<T>,
    operation: impl FnOnce(&mut T) -> std::result::Result<R, PlatformStoreError>,
) -> Result<R> {
    let mut slot = handle.lock().map_err(|_| bridge_error())?;
    let value = slot.as_mut().ok_or_else(bridge_error)?;
    native_result(operation(value))
}

fn take_handle<T>(handle: &SharedHandle<T>) -> Result<T> {
    handle
        .lock()
        .map_err(|_| bridge_error())?
        .take()
        .ok_or_else(bridge_error)
}

fn hexadecimal(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(char::from(DIGITS[usize::from(byte >> 4)]));
        result.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    result
}

fn object_identity(env: &Env, value: ObjectIdentity) -> Result<BridgeObject> {
    let mut identity = Object::new(env).map_err(|_| bridge_error())?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let (volume, object) = (
        format!("posix-device-{:016x}", value.device),
        format!("posix-inode-{:016x}", value.inode),
    );
    #[cfg(target_os = "windows")]
    let (volume, object) = (
        format!("windows-volume-{:016x}", value.volume),
        format!("windows-file-{}", hexadecimal(&value.file_id)),
    );
    identity
        .set_named_property("volume", volume)
        .map_err(|_| bridge_error())?;
    identity
        .set_named_property("object", object)
        .map_err(|_| bridge_error())?;
    finish_object(&identity)
}

fn directory_attestation(env: &Env, value: DirectoryAttestation) -> Result<BridgeObject> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let user_only = value.private_mode && value.private_access;
    #[cfg(target_os = "windows")]
    let user_only = value.private_mode;
    let mut result = Object::new(env).map_err(|_| bridge_error())?;
    result
        .set_named_property("kind", "directory")
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("identity", object_identity(env, value.identity)?)
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("revision", hexadecimal(&value.revision))
        .map_err(|_| bridge_error())?;
    result
        .set_named_property(
            "binding",
            if value.canonical_current {
                "canonical-current"
            } else {
                "detached"
            },
        )
        .map_err(|_| bridge_error())?;
    result
        .set_named_property(
            "owner",
            if value.current_user {
                "current-user"
            } else {
                "other-user"
            },
        )
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("access", if user_only { "user-only" } else { "broader" })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("link", "direct")
        .map_err(|_| bridge_error())?;
    finish_object(&result)
}

fn file_attestation(env: &Env, value: CredentialFileAttestation) -> Result<BridgeObject> {
    let security = value.security;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let user_only = security.private_mode && security.private_access;
    #[cfg(target_os = "windows")]
    let user_only = security.private_mode;
    let links = u32::try_from(security.links).map_err(|_| bridge_error())?;
    let size = u32::try_from(security.size).map_err(|_| bridge_error())?;
    let mut result = Object::new(env).map_err(|_| bridge_error())?;
    result
        .set_named_property("kind", "regular-file")
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("identity", object_identity(env, security.identity)?)
        .map_err(|_| bridge_error())?;
    result
        .set_named_property(
            "parentIdentity",
            object_identity(env, security.parent_identity)?,
        )
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("revision", hexadecimal(&value.revision))
        .map_err(|_| bridge_error())?;
    result
        .set_named_property(
            "binding",
            if security.canonical_current {
                "canonical-current"
            } else {
                "detached"
            },
        )
        .map_err(|_| bridge_error())?;
    result
        .set_named_property(
            "owner",
            if security.current_user {
                "current-user"
            } else {
                "other-user"
            },
        )
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("access", if user_only { "user-only" } else { "broader" })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("link", "direct")
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("links", f64::from(links))
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("size", f64::from(size))
        .map_err(|_| bridge_error())?;
    finish_object(&result)
}

fn bounded_read(env: &Env, value: BoundedRead) -> Result<GuardedObjectRef> {
    create_guarded_bounded_read_result(env, value.bytes, value.end_of_file)
        .map_err(|_| bridge_error())
}

fn parse_canonical_entry(object: &Object<'_>) -> Result<CanonicalEntryRole> {
    exact_keys(object, &["kind", "name", "role"])?;
    if property::<String>(object, "kind")? != "canonical" {
        return Err(invalid_request());
    }
    let role = property::<String>(object, "role")?;
    let name = property::<String>(object, "name")?;
    match (role.as_str(), name.as_str()) {
        ("credential", "credentials.json") => Ok(CanonicalEntryRole::Credential),
        ("transaction", "credentials-transaction.json") => Ok(CanonicalEntryRole::Transaction),
        _ => Err(invalid_request()),
    }
}

fn parse_temporary_entry(object: &Object<'_>) -> Result<TemporaryEntry> {
    exact_keys(object, &["kind", "role", "transactionId"])?;
    if property::<String>(object, "kind")? != "temporary" {
        return Err(invalid_request());
    }
    let role = match property::<String>(object, "role")?.as_str() {
        "credential-candidate" => TemporaryEntryRole::Credential,
        "transaction-candidate" => TemporaryEntryRole::Transaction,
        "recovery-candidate" => TemporaryEntryRole::Recovery,
        _ => return Err(invalid_request()),
    };
    let transaction_id = property::<String>(object, "transactionId")?;
    match native_result(TemporaryEntry::parse(role, &transaction_id)) {
        Ok(entry) => Ok(entry),
        Err(_) => Err(invalid_request()),
    }
}

fn parse_managed_entry(object: &Object<'_>) -> Result<ManagedEntry> {
    match property::<String>(object, "kind")?.as_str() {
        "canonical" => parse_canonical_entry(object).map(ManagedEntry::Canonical),
        "temporary" => parse_temporary_entry(object).map(ManagedEntry::Temporary),
        _ => Err(invalid_request()),
    }
}

fn same_directory_authority(left: DirectoryAttestation, right: DirectoryAttestation) -> bool {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        left.identity == right.identity
            && left.canonical_current == right.canonical_current
            && left.current_user == right.current_user
            && left.private_mode == right.private_mode
            && left.private_access == right.private_access
    }
    #[cfg(target_os = "windows")]
    {
        left.identity == right.identity
            && left.canonical_current == right.canonical_current
            && left.current_user == right.current_user
            && left.private_mode == right.private_mode
    }
}

fn observe_entry_state(
    directory: &PlatformPrivateDirectory,
    entry: ManagedEntry,
) -> std::result::Result<ObservedEntryState, PlatformStoreError> {
    match directory.observe_managed_entry(entry)? {
        PrivateManagedEntryObservation::Missing => Ok(ObservedEntryState::Missing),
        PrivateManagedEntryObservation::Opened {
            attestation,
            mut file,
        } => {
            file.close();
            Ok(ObservedEntryState::Present(attestation))
        }
    }
}

fn capture_store_snapshot(
    directory: &PlatformPrivateDirectory,
) -> std::result::Result<StoreSnapshot, PlatformStoreError> {
    let before = directory.attest()?;
    let mut entries = Vec::new();
    for entry in [ManagedEntry::credential(), ManagedEntry::transaction()] {
        entries.push(ObservedEntry {
            entry,
            state: observe_entry_state(directory, entry)?,
        });
    }
    let temporaries = directory.list_managed_temporary_entries()?;
    for temporary in temporaries {
        let entry = ManagedEntry::Temporary(temporary);
        let state = observe_entry_state(directory, entry)?;
        if state == ObservedEntryState::Missing {
            return Err(PlatformStoreError::Lost);
        }
        entries.push(ObservedEntry { entry, state });
    }
    let after = directory.attest()?;
    if before != after {
        return Err(PlatformStoreError::Lost);
    }
    Ok(StoreSnapshot {
        directory: after,
        entries,
    })
}

fn empty_store_snapshot(
    directory: &PlatformPrivateDirectory,
) -> std::result::Result<bool, PlatformStoreError> {
    let snapshot = capture_store_snapshot(directory)?;
    Ok(snapshot.entries.len() == 2
        && snapshot
            .entries
            .iter()
            .all(|entry| entry.state == ObservedEntryState::Missing))
}

fn present_snapshot_matches(
    directory: &PlatformPrivateDirectory,
    expected: &StoreSnapshot,
) -> std::result::Result<bool, PlatformStoreError> {
    let current = capture_store_snapshot(directory)?;
    Ok(
        same_directory_authority(current.directory, expected.directory)
            && current.entries == expected.entries,
    )
}

fn snapshot_property(object: &Object<'_>, name: &str) -> Result<Arc<SnapshotToken>> {
    let external = property::<&External<Arc<SnapshotToken>>>(object, name)?;
    Ok(Arc::clone(external.as_ref()))
}

fn make_credential_read_handle(
    env: &Env,
    handle: PlatformCredentialReadHandle,
) -> Result<BridgeObject> {
    let shared = Arc::new(Mutex::new(Some(handle)));
    let mut result = Object::new(env).map_err(|_| bridge_error())?;

    let attest_handle = Arc::clone(&shared);
    let attest = env
        .create_function_from_closure::<(), _, _>("attest", move |context| {
            exact_argument_count(&context, 0)?;
            let value = with_handle(&attest_handle, |handle| handle.attest())?;
            file_attestation(context.env, value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("attest", attest)
        .map_err(|_| bridge_error())?;

    let read_handle = Arc::clone(&shared);
    let read = env
        .create_function_from_closure::<(), _, _>("readBounded", move |context| {
            exact_argument_count(&context, 1)?;
            let options = argument::<Object<'_>>(&context, 0)?;
            exact_keys(&options, &["maxBytes"])?;
            let max_bytes = property::<f64>(&options, "maxBytes")?;
            if !max_bytes.is_finite()
                || max_bytes < 0.0
                || max_bytes.fract() != 0.0
                || max_bytes > MAX_ATTESTED_BYTES as f64
            {
                return Err(invalid_request());
            }
            let value = with_handle(&read_handle, |handle| {
                handle.read_bounded(max_bytes as usize)
            })?;
            bounded_read(context.env, value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("readBounded", read)
        .map_err(|_| bridge_error())?;

    let close_handle = Arc::clone(&shared);
    let close = env
        .create_function_from_closure::<(), (), _>("close", move |context| {
            exact_argument_count(&context, 0)?;
            let mut handle = take_handle(&close_handle)?;
            handle.close();
            Ok(())
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("close", close)
        .map_err(|_| bridge_error())?;

    finish_object(&result)
}

fn observation_read_plan(entry: ManagedEntry) -> ObservationFileReadPlan {
    match entry {
        ManagedEntry::Canonical(CanonicalEntryRole::Credential) => {
            ObservationFileReadPlan::ReadBounded(CREDENTIAL_OBSERVATION_READ_BYTES)
        }
        ManagedEntry::Canonical(CanonicalEntryRole::Transaction) => {
            ObservationFileReadPlan::ReadBounded(TRANSACTION_OBSERVATION_READ_BYTES)
        }
        ManagedEntry::Temporary(_) => ObservationFileReadPlan::AttestOnly,
    }
}

fn fail_observation_file(protocol: &Arc<Mutex<ObservationFileProtocol>>) {
    let mut state = match protocol.lock() {
        Ok(state) => state,
        Err(poisoned) => poisoned.into_inner(),
    };
    state.stage = ObservationFileStage::Failed;
}

fn make_observation_read_handle(
    env: &Env,
    handle: PlatformCredentialReadHandle,
    protocol: Arc<Mutex<ObservationFileProtocol>>,
) -> Result<BridgeObject> {
    let shared = Arc::new(Mutex::new(Some(handle)));
    let mut result = Object::new(env).map_err(|_| bridge_error())?;

    let attest_handle = Arc::clone(&shared);
    let attest_protocol = Arc::clone(&protocol);
    let attest = env
        .create_function_from_closure::<(), _, _>("attest", move |context| {
            exact_argument_count(&context, 0)?;
            let expected_stage = {
                let state = attest_protocol.lock().map_err(|_| bridge_error())?;
                match state.stage {
                    ObservationFileStage::FirstAttestation
                    | ObservationFileStage::SecondAttestation => state.stage,
                    _ => return Err(bridge_error()),
                }
            };
            let value = match with_handle(&attest_handle, |handle| handle.attest()) {
                Ok(value) => value,
                Err(error) => {
                    fail_observation_file(&attest_protocol);
                    return Err(error);
                }
            };
            let rendered = match file_attestation(context.env, value) {
                Ok(rendered) => rendered,
                Err(error) => {
                    fail_observation_file(&attest_protocol);
                    return Err(error);
                }
            };
            let mut state = attest_protocol.lock().map_err(|_| bridge_error())?;
            if state.stage != expected_stage || value != state.declared {
                state.stage = ObservationFileStage::Failed;
                return Err(bridge_error());
            }
            state.stage = match expected_stage {
                ObservationFileStage::FirstAttestation => match state.plan {
                    ObservationFileReadPlan::AttestOnly => ObservationFileStage::SecondAttestation,
                    ObservationFileReadPlan::ReadBounded(_) => ObservationFileStage::Read,
                },
                ObservationFileStage::SecondAttestation => ObservationFileStage::Close,
                _ => unreachable!("the stage was restricted above"),
            };
            Ok(rendered)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("attest", attest)
        .map_err(|_| bridge_error())?;

    let read_handle = Arc::clone(&shared);
    let read_protocol = Arc::clone(&protocol);
    let read = env
        .create_function_from_closure::<(), _, _>("readBounded", move |context| {
            exact_argument_count(&context, 1)?;
            let options = argument::<Object<'_>>(&context, 0)?;
            exact_keys(&options, &["maxBytes"])?;
            let max_bytes = property::<f64>(&options, "maxBytes")?;
            let expected = {
                let state = read_protocol.lock().map_err(|_| bridge_error())?;
                match (state.stage, state.plan) {
                    (
                        ObservationFileStage::Read,
                        ObservationFileReadPlan::ReadBounded(expected),
                    ) => expected,
                    _ => return Err(bridge_error()),
                }
            };
            if max_bytes != expected as f64 {
                fail_observation_file(&read_protocol);
                return Err(invalid_request());
            }
            let mut value = match with_handle(&read_handle, |handle| handle.read_bounded(expected))
            {
                Ok(value) => value,
                Err(error) => {
                    fail_observation_file(&read_protocol);
                    return Err(error);
                }
            };
            let valid = {
                let state = read_protocol.lock().map_err(|_| bridge_error())?;
                state.stage == ObservationFileStage::Read
                    && state.plan == ObservationFileReadPlan::ReadBounded(expected)
                    && value.end_of_file
                    && u64::try_from(value.bytes.len()).ok() == Some(state.declared.security.size)
            };
            if !valid {
                zeroize_bytes(&mut value.bytes);
                fail_observation_file(&read_protocol);
                return Err(bridge_error());
            }
            let rendered = match bounded_read(context.env, value) {
                Ok(rendered) => rendered,
                Err(error) => {
                    fail_observation_file(&read_protocol);
                    return Err(error);
                }
            };
            let mut state = read_protocol.lock().map_err(|_| bridge_error())?;
            if state.stage != ObservationFileStage::Read {
                state.stage = ObservationFileStage::Failed;
                return Err(bridge_error());
            }
            state.stage = ObservationFileStage::SecondAttestation;
            Ok(rendered)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("readBounded", read)
        .map_err(|_| bridge_error())?;

    let close_handle = Arc::clone(&shared);
    let close_protocol = Arc::clone(&protocol);
    let close = env
        .create_function_from_closure::<(), (), _>("close", move |context| {
            exact_argument_count(&context, 0)?;
            let valid = close_protocol.lock().map_err(|_| bridge_error())?.stage
                == ObservationFileStage::Close;
            let mut handle = match take_handle(&close_handle) {
                Ok(handle) => handle,
                Err(error) => {
                    fail_observation_file(&close_protocol);
                    return Err(error);
                }
            };
            handle.close();
            let mut state = close_protocol.lock().map_err(|_| bridge_error())?;
            state.stage = if valid {
                ObservationFileStage::Complete
            } else {
                ObservationFileStage::Failed
            };
            if valid {
                Ok(())
            } else {
                Err(bridge_error())
            }
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("close", close)
        .map_err(|_| bridge_error())?;

    finish_object(&result)
}

fn make_lease_read_handle(env: &Env, handle: PlatformLeaseReadHandle) -> Result<BridgeObject> {
    let shared = Arc::new(Mutex::new(Some(handle)));
    let mut result = Object::new(env).map_err(|_| bridge_error())?;

    let attest_handle = Arc::clone(&shared);
    let attest = env
        .create_function_from_closure::<(), _, _>("attest", move |context| {
            exact_argument_count(&context, 0)?;
            let value = with_handle(&attest_handle, |handle| handle.attest())?;
            file_attestation(context.env, value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("attest", attest)
        .map_err(|_| bridge_error())?;

    let read_handle = Arc::clone(&shared);
    let read = env
        .create_function_from_closure::<(), _, _>("readBounded", move |context| {
            exact_argument_count(&context, 1)?;
            let options = argument::<Object<'_>>(&context, 0)?;
            exact_keys(&options, &["maxBytes"])?;
            let max_bytes = property::<f64>(&options, "maxBytes")?;
            if !max_bytes.is_finite()
                || max_bytes < 0.0
                || max_bytes.fract() != 0.0
                || max_bytes > MAX_ATTESTED_BYTES as f64
            {
                return Err(invalid_request());
            }
            let value = with_handle(&read_handle, |handle| {
                handle.read_bounded(max_bytes as usize)
            })?;
            bounded_read(context.env, value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("readBounded", read)
        .map_err(|_| bridge_error())?;

    let close_handle = Arc::clone(&shared);
    let close = env
        .create_function_from_closure::<(), (), _>("close", move |context| {
            exact_argument_count(&context, 0)?;
            let mut handle = take_handle(&close_handle)?;
            native_result(handle.close())
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("close", close)
        .map_err(|_| bridge_error())?;

    finish_object(&result)
}

fn make_write_handle(env: &Env, handle: PlatformExclusiveWriteHandle) -> Result<BridgeObject> {
    let shared = Arc::new(Mutex::new(Some(handle)));
    let mut result = Object::new(env).map_err(|_| bridge_error())?;

    let attest_handle = Arc::clone(&shared);
    let attest = env
        .create_function_from_closure::<(), _, _>("attest", move |context| {
            exact_argument_count(&context, 0)?;
            let value = with_handle(&attest_handle, |handle| handle.attest())?;
            file_attestation(context.env, value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("attest", attest)
        .map_err(|_| bridge_error())?;

    let write_handle = Arc::clone(&shared);
    let write = env
        .create_function_from_closure::<(), (), _>("writeAll", move |context| {
            exact_argument_count(&context, 1)?;
            let bytes = argument::<Uint8Array>(&context, 0)?;
            with_handle(&write_handle, |handle| handle.write_all(bytes.as_ref()))
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("writeAll", write)
        .map_err(|_| bridge_error())?;

    let sync_handle = Arc::clone(&shared);
    let sync = env
        .create_function_from_closure::<(), (), _>("sync", move |context| {
            exact_argument_count(&context, 0)?;
            with_handle(&sync_handle, |handle| handle.sync())
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("sync", sync)
        .map_err(|_| bridge_error())?;

    let close_handle = Arc::clone(&shared);
    let close = env
        .create_function_from_closure::<(), (), _>("close", move |context| {
            exact_argument_count(&context, 0)?;
            let mut handle = take_handle(&close_handle)?;
            native_result(handle.close())
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("close", close)
        .map_err(|_| bridge_error())?;

    finish_object(&result)
}

fn make_private_directory(env: &Env, handle: PlatformPrivateDirectory) -> Result<BridgeObject> {
    let shared = Arc::new(Mutex::new(Some(handle)));
    let mut result = Object::new(env).map_err(|_| bridge_error())?;

    let attest_handle = Arc::clone(&shared);
    let attest = env
        .create_function_from_closure::<(), _, _>("attest", move |context| {
            exact_argument_count(&context, 0)?;
            let value = with_handle(&attest_handle, |handle| handle.attest())?;
            directory_attestation(context.env, value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("attest", attest)
        .map_err(|_| bridge_error())?;

    let open_handle = Arc::clone(&shared);
    let open = env
        .create_function_from_closure::<(), _, _>("openCredentialReadOnly", move |context| {
            exact_argument_count(&context, 1)?;
            let options = argument::<Object<'_>>(&context, 0)?;
            exact_keys(&options, &["entry", "noFollow"])?;
            expect_true(&options, "noFollow")?;
            if property::<String>(&options, "entry")? != "credentials.json" {
                return Err(invalid_request());
            }
            let opened = with_handle(&open_handle, |handle| handle.open_credential_read_only())?;
            let mut result = Object::new(context.env).map_err(|_| bridge_error())?;
            match opened {
                CredentialReadOpenResult::Missing => {
                    result
                        .set_named_property("status", "missing")
                        .map_err(|_| bridge_error())?;
                }
                CredentialReadOpenResult::Opened(file) => {
                    result
                        .set_named_property("status", "opened")
                        .map_err(|_| bridge_error())?;
                    result
                        .set_named_property("file", make_credential_read_handle(context.env, file)?)
                        .map_err(|_| bridge_error())?;
                }
            }
            finish_object(&result)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("openCredentialReadOnly", open)
        .map_err(|_| bridge_error())?;

    let close_handle = Arc::clone(&shared);
    let close = env
        .create_function_from_closure::<(), (), _>("close", move |context| {
            exact_argument_count(&context, 0)?;
            let mut handle = take_handle(&close_handle)?;
            handle.close();
            Ok(())
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("close", close)
        .map_err(|_| bridge_error())?;

    finish_object(&result)
}

fn expected_observation_entry(progress: &ObservationProgress, entry: ManagedEntry) -> bool {
    match progress.entries.len() {
        0 => entry == ManagedEntry::credential() && progress.listed_temporaries.is_none(),
        1 => entry == ManagedEntry::transaction() && progress.listed_temporaries.is_none(),
        index => progress
            .listed_temporaries
            .as_ref()
            .and_then(|temporaries| temporaries.get(index - 2))
            .is_some_and(|expected| entry == ManagedEntry::Temporary(*expected)),
    }
}

fn make_observation_directory(
    env: &Env,
    authority: Arc<AdapterAuthority>,
    directory_path: String,
    directory: PlatformPrivateDirectory,
) -> Result<BridgeObject> {
    let shared = Arc::new(Mutex::new(Some(ObservationProgress {
        authority,
        directory_path,
        directory: Some(directory),
        attestations: Vec::new(),
        listed_temporaries: None,
        entries: Vec::new(),
        file_protocols: Vec::new(),
        finished: false,
    })));
    let mut result = Object::new(env).map_err(|_| bridge_error())?;

    let attest_handle = Arc::clone(&shared);
    let attest = env
        .create_function_from_closure::<(), _, _>("attest", move |context| {
            exact_argument_count(&context, 0)?;
            let mut slot = attest_handle.lock().map_err(|_| bridge_error())?;
            let progress = slot.as_mut().ok_or_else(bridge_error)?;
            if progress.finished || progress.attestations.len() >= 2 {
                return Err(bridge_error());
            }
            let directory = progress.directory.as_ref().ok_or_else(bridge_error)?;
            let value = native_result(directory.attest())?;
            progress.attestations.push(value);
            directory_attestation(context.env, value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("attest", attest)
        .map_err(|_| bridge_error())?;

    let observe_handle = Arc::clone(&shared);
    let observe = env
        .create_function_from_closure::<(), _, _>("observeEntry", move |context| {
            exact_argument_count(&context, 1)?;
            let options = argument::<Object<'_>>(&context, 0)?;
            exact_keys(&options, &["entry", "noFollow"])?;
            expect_true(&options, "noFollow")?;
            let entry = parse_managed_entry(&property::<Object<'_>>(&options, "entry")?)?;

            let mut slot = observe_handle.lock().map_err(|_| bridge_error())?;
            let progress = slot.as_mut().ok_or_else(bridge_error)?;
            if progress.finished
                || progress.attestations.len() != 1
                || !expected_observation_entry(progress, entry)
            {
                return Err(bridge_error());
            }
            let directory = progress.directory.as_ref().ok_or_else(bridge_error)?;
            let observed = native_result(directory.observe_managed_entry(entry))?;
            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            match observed {
                PrivateManagedEntryObservation::Missing => {
                    progress.entries.push(ObservedEntry {
                        entry,
                        state: ObservedEntryState::Missing,
                    });
                    value
                        .set_named_property("status", "missing")
                        .map_err(|_| bridge_error())?;
                }
                PrivateManagedEntryObservation::Opened { attestation, file } => {
                    let protocol = Arc::new(Mutex::new(ObservationFileProtocol {
                        declared: attestation,
                        plan: observation_read_plan(entry),
                        stage: ObservationFileStage::FirstAttestation,
                    }));
                    let rendered_file =
                        make_observation_read_handle(context.env, file, Arc::clone(&protocol))?;
                    progress.entries.push(ObservedEntry {
                        entry,
                        state: ObservedEntryState::Present(attestation),
                    });
                    progress.file_protocols.push(protocol);
                    value
                        .set_named_property("status", "opened")
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property(
                            "attestation",
                            file_attestation(context.env, attestation)?,
                        )
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property("file", rendered_file)
                        .map_err(|_| bridge_error())?;
                }
            }
            finish_object(&value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("observeEntry", observe)
        .map_err(|_| bridge_error())?;

    let list_handle = Arc::clone(&shared);
    let list = env
        .create_function_from_closure::<(), _, _>("listTemporaryEntries", move |context| {
            exact_argument_count(&context, 0)?;
            let mut slot = list_handle.lock().map_err(|_| bridge_error())?;
            let progress = slot.as_mut().ok_or_else(bridge_error)?;
            if progress.finished
                || progress.attestations.len() != 1
                || progress.entries.len() != 2
                || progress.listed_temporaries.is_some()
            {
                return Err(bridge_error());
            }
            let directory = progress.directory.as_ref().ok_or_else(bridge_error)?;
            let entries = native_result(directory.list_managed_temporary_entries())?;
            let result = entries
                .iter()
                .copied()
                .map(|entry| temporary_entry_object(context.env, entry))
                .collect::<Result<Vec<_>>>()?;
            progress.listed_temporaries = Some(entries);
            Ok(result)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("listTemporaryEntries", list)
        .map_err(|_| bridge_error())?;

    let finish_handle = Arc::clone(&shared);
    let finish = env
        .create_function_from_closure::<(), _, _>("finishObservation", move |context| {
            exact_argument_count(&context, 0)?;
            let mut slot = finish_handle.lock().map_err(|_| bridge_error())?;
            let progress = slot.as_mut().ok_or_else(bridge_error)?;
            if progress.finished || progress.attestations.len() != 2 {
                return Err(bridge_error());
            }
            let listed = progress
                .listed_temporaries
                .as_ref()
                .ok_or_else(bridge_error)?;
            if progress.attestations[0] != progress.attestations[1]
                || progress.entries.len() != listed.len() + 2
                || progress.entries[2..].iter().any(|entry| {
                    entry.state == ObservedEntryState::Missing
                        || !matches!(entry.entry, ManagedEntry::Temporary(_))
                })
                || progress.file_protocols.iter().any(|protocol| {
                    protocol
                        .lock()
                        .map_or(true, |state| state.stage != ObservationFileStage::Complete)
                })
            {
                return Err(bridge_error());
            }
            let directory = progress.directory.as_ref().ok_or_else(bridge_error)?;
            let expected = StoreSnapshot {
                directory: progress.attestations[1],
                entries: progress.entries.clone(),
            };
            let current = native_result(capture_store_snapshot(directory))?;
            if current != expected {
                return Err(bridge_error());
            }
            let binding = progress.directory.take().ok_or_else(bridge_error)?;
            progress.finished = true;
            Ok(evidence_external(WholePassEvidence {
                authority: Arc::clone(&progress.authority),
                directory: progress.directory_path.clone(),
                state: EvidenceState::Present(PresentEvidence {
                    binding,
                    snapshot: expected,
                }),
            }))
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("finishObservation", finish)
        .map_err(|_| bridge_error())?;

    let close_handle = Arc::clone(&shared);
    let close = env
        .create_function_from_closure::<(), (), _>("close", move |context| {
            exact_argument_count(&context, 0)?;
            let mut progress = take_handle(&close_handle)?;
            if let Some(mut directory) = progress.directory.take() {
                directory.close();
            }
            Ok(())
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("close", close)
        .map_err(|_| bridge_error())?;

    finish_object(&result)
}

fn temporary_entry_object(env: &Env, entry: TemporaryEntry) -> Result<BridgeObject> {
    let role = match entry.role() {
        TemporaryEntryRole::Credential => "credential-candidate",
        TemporaryEntryRole::Transaction => "transaction-candidate",
        TemporaryEntryRole::Recovery => "recovery-candidate",
    };
    let mut result = Object::new(env).map_err(|_| bridge_error())?;
    result
        .set_named_property("kind", "temporary")
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("role", role)
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("transactionId", entry.transaction_id())
        .map_err(|_| bridge_error())?;
    finish_object(&result)
}

fn make_setup_lease(env: &Env, handle: PlatformSetupLease) -> Result<BridgeObject> {
    let shared = Arc::new(Mutex::new(Some(handle)));
    let mut result = Object::new(env).map_err(|_| bridge_error())?;

    let attest_handle = Arc::clone(&shared);
    let attest = env
        .create_function_from_closure::<(), _, _>("attestDirectory", move |context| {
            exact_argument_count(&context, 0)?;
            let value = with_handle(&attest_handle, |handle| handle.attest_directory())?;
            directory_attestation(context.env, value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("attestDirectory", attest)
        .map_err(|_| bridge_error())?;

    let renew_handle = Arc::clone(&shared);
    let renew = env
        .create_function_from_closure::<(), _, _>("renew", move |context| {
            exact_argument_count(&context, 0)?;
            let status = with_handle(&renew_handle, |handle| Ok(handle.renew()))?;
            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            value
                .set_named_property(
                    "status",
                    match status {
                        LeaseRenewal::Held => "held",
                        LeaseRenewal::Lost => "lost",
                    },
                )
                .map_err(|_| bridge_error())?;
            finish_object(&value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("renew", renew)
        .map_err(|_| bridge_error())?;

    let observe_handle = Arc::clone(&shared);
    let observe = env
        .create_function_from_closure::<(), _, _>("observeEntry", move |context| {
            exact_argument_count(&context, 1)?;
            let entry = parse_managed_entry(&argument::<Object<'_>>(&context, 0)?)?;
            let observation = with_handle(&observe_handle, |handle| handle.observe_entry(entry))?;
            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            match observation {
                ManagedEntryObservation::Missing { snapshot } => {
                    value
                        .set_named_property("status", "missing")
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property(
                            "snapshot",
                            External::new(Arc::new(SnapshotToken::Missing(snapshot))),
                        )
                        .map_err(|_| bridge_error())?;
                }
                ManagedEntryObservation::Opened {
                    snapshot,
                    attestation,
                    file,
                } => {
                    value
                        .set_named_property("status", "opened")
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property(
                            "snapshot",
                            External::new(Arc::new(SnapshotToken::Present(snapshot))),
                        )
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property(
                            "attestation",
                            file_attestation(context.env, attestation)?,
                        )
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property("file", make_lease_read_handle(context.env, file)?)
                        .map_err(|_| bridge_error())?;
                }
            }
            finish_object(&value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("observeEntry", observe)
        .map_err(|_| bridge_error())?;

    let list_handle = Arc::clone(&shared);
    let list = env
        .create_function_from_closure::<(), _, _>("listTemporaryEntries", move |context| {
            exact_argument_count(&context, 0)?;
            let entries = with_handle(&list_handle, |handle| handle.list_temporary_entries())?;
            entries
                .into_iter()
                .map(|entry| temporary_entry_object(context.env, entry))
                .collect::<Result<Vec<_>>>()
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("listTemporaryEntries", list)
        .map_err(|_| bridge_error())?;

    let create_handle = Arc::clone(&shared);
    let create = env
        .create_function_from_closure::<(), _, _>("createTemporaryExclusive", move |context| {
            exact_argument_count(&context, 1)?;
            let options = argument::<Object<'_>>(&context, 0)?;
            exact_keys(&options, &["entry", "expected"])?;
            let entry = parse_temporary_entry(&property::<Object<'_>>(&options, "entry")?)?;
            let expected = snapshot_property(&options, "expected")?;
            let SnapshotToken::Missing(expected) = expected.as_ref() else {
                return Err(invalid_request());
            };
            let created = with_handle(&create_handle, |handle| {
                handle.create_temporary_exclusive(entry, expected)
            })?;
            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            match created {
                ExclusiveCreateResult::Conflict => {
                    value
                        .set_named_property("status", "conflict")
                        .map_err(|_| bridge_error())?;
                }
                ExclusiveCreateResult::Created(file) => {
                    value
                        .set_named_property("status", "created")
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property("file", make_write_handle(context.env, file)?)
                        .map_err(|_| bridge_error())?;
                }
            }
            finish_object(&value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("createTemporaryExclusive", create)
        .map_err(|_| bridge_error())?;

    let move_handle = Arc::clone(&shared);
    let move_entry = env
        .create_function_from_closure::<(), _, _>("moveTemporaryConditionally", move |context| {
            exact_argument_count(&context, 1)?;
            let options = argument::<Object<'_>>(&context, 0)?;
            exact_keys(
                &options,
                &[
                    "destination",
                    "expectedDestination",
                    "expectedSource",
                    "source",
                ],
            )?;
            let source = parse_temporary_entry(&property::<Object<'_>>(&options, "source")?)?;
            let destination =
                parse_canonical_entry(&property::<Object<'_>>(&options, "destination")?)?;
            let expected_source = snapshot_property(&options, "expectedSource")?;
            let expected_destination = snapshot_property(&options, "expectedDestination")?;
            let SnapshotToken::Present(expected_source) = expected_source.as_ref() else {
                return Err(invalid_request());
            };
            let destination_snapshot = match expected_destination.as_ref() {
                SnapshotToken::Missing(snapshot) => ExpectedEntrySnapshot::Missing(snapshot),
                SnapshotToken::Present(snapshot) => {
                    ExpectedEntrySnapshot::Present(snapshot.as_ref())
                }
            };
            let moved = with_handle(&move_handle, |handle| {
                handle.move_temporary_conditionally(
                    source,
                    expected_source.as_ref(),
                    destination,
                    destination_snapshot,
                )
            })?;
            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            value
                .set_named_property(
                    "status",
                    match moved {
                        ConditionalMutationResult::Applied => "moved",
                        ConditionalMutationResult::Conflict => "conflict",
                    },
                )
                .map_err(|_| bridge_error())?;
            finish_object(&value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("moveTemporaryConditionally", move_entry)
        .map_err(|_| bridge_error())?;

    let remove_handle = Arc::clone(&shared);
    let remove = env
        .create_function_from_closure::<(), _, _>("removeConditionally", move |context| {
            exact_argument_count(&context, 1)?;
            let options = argument::<Object<'_>>(&context, 0)?;
            exact_keys(&options, &["entry", "expected"])?;
            let entry = parse_managed_entry(&property::<Object<'_>>(&options, "entry")?)?;
            let expected = snapshot_property(&options, "expected")?;
            let SnapshotToken::Present(expected) = expected.as_ref() else {
                return Err(invalid_request());
            };
            let removed = with_handle(&remove_handle, |handle| {
                handle.remove_conditionally(entry, expected.as_ref())
            })?;
            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            value
                .set_named_property(
                    "status",
                    match removed {
                        ConditionalMutationResult::Applied => "removed",
                        ConditionalMutationResult::Conflict => "conflict",
                    },
                )
                .map_err(|_| bridge_error())?;
            finish_object(&value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("removeConditionally", remove)
        .map_err(|_| bridge_error())?;

    let sync_handle = Arc::clone(&shared);
    let sync = env
        .create_function_from_closure::<(), (), _>("syncDirectory", move |context| {
            exact_argument_count(&context, 0)?;
            with_handle(&sync_handle, |handle| handle.sync_directory())
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("syncDirectory", sync)
        .map_err(|_| bridge_error())?;

    let release_handle = Arc::clone(&shared);
    let release = env
        .create_function_from_closure::<(), (), _>("release", move |context| {
            exact_argument_count(&context, 0)?;
            let mut handle = take_handle(&release_handle)?;
            native_result(handle.release())
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("release", release)
        .map_err(|_| bridge_error())?;

    let abandon_handle = Arc::clone(&shared);
    let abandon = env
        .create_function_from_closure::<(), (), _>("abandon", move |context| {
            exact_argument_count(&context, 0)?;
            let mut handle = take_handle(&abandon_handle)?;
            native_result(handle.abandon())
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("abandon", abandon)
        .map_err(|_| bridge_error())?;

    finish_object(&result)
}

const MAX_RECONCILIATION_JOURNAL_BYTES: usize = 65_536;

struct PendingJournalBytes(Option<Vec<u8>>);

impl PendingJournalBytes {
    fn new(bytes: Vec<u8>) -> Self {
        Self(Some(bytes))
    }

    fn take(&mut self) -> Result<Vec<u8>> {
        self.0.take().ok_or_else(bridge_error)
    }
}

impl Drop for PendingJournalBytes {
    fn drop(&mut self) {
        if let Some(bytes) = self.0.as_mut() {
            zeroize_bytes(bytes.as_mut_slice());
        }
    }
}

fn make_reconciliation_journal_lease(
    env: &Env,
    handle: PlatformReconciliationJournalLease,
) -> Result<BridgeObject> {
    let shared = Arc::new(Mutex::new(Some(handle)));
    let mut result = Object::new(env).map_err(|_| bridge_error())?;

    let renew_handle = Arc::clone(&shared);
    let renew = env
        .create_function_from_closure::<(), _, _>("renew", move |context| {
            exact_argument_count(&context, 0)?;
            let status = with_handle(&renew_handle, |handle| Ok(handle.renew()))?;
            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            value
                .set_named_property(
                    "status",
                    match status {
                        LeaseRenewal::Held => "held",
                        LeaseRenewal::Lost => "lost",
                    },
                )
                .map_err(|_| bridge_error())?;
            finish_object(&value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("renew", renew)
        .map_err(|_| bridge_error())?;

    let observe_handle = Arc::clone(&shared);
    let observe = env
        .create_function_from_closure::<(), GuardedObjectRef, _>("observe", move |context| {
            exact_argument_count(&context, 0)?;
            let observation = with_handle(&observe_handle, |handle| handle.observe())?;
            match observation {
                JournalObservation::Missing { revision } => {
                    let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
                    value
                        .set_named_property("status", "missing")
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property("revision", journal_revision_external(revision))
                        .map_err(|_| bridge_error())?;
                    Ok(GuardedObjectRef::plain(finish_object(&value)?))
                }
                JournalObservation::Present { revision, bytes } => {
                    let mut pending = PendingJournalBytes::new(bytes);
                    let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
                    value
                        .set_named_property("status", "present")
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property("revision", journal_revision_external(revision))
                        .map_err(|_| bridge_error())?;
                    let read =
                        create_guarded_bounded_read_result(context.env, pending.take()?, true)
                            .map_err(|_| bridge_error())?;
                    let continuation = read.secret_continuation().ok_or_else(bridge_error)?;
                    value
                        .set_named_property("read", read)
                        .map_err(|_| bridge_error())?;
                    Ok(continuation.protect(finish_object(&value)?))
                }
            }
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("observe", observe)
        .map_err(|_| bridge_error())?;

    let replace_handle = Arc::clone(&shared);
    let replace = env
        .create_function_from_closure::<(), _, _>("replace", move |context| {
            exact_argument_count(&context, 1)?;
            let options = argument::<Object<'_>>(&context, 0)?;
            exact_keys(&options, &["bytes", "expected"])?;
            let expected = take_journal_revision_property(&options, "expected")?;
            let bytes = property::<Uint8Array>(&options, "bytes")?;
            if bytes.is_empty() || bytes.len() > MAX_RECONCILIATION_JOURNAL_BYTES {
                return Err(invalid_request());
            }
            let replaced = with_handle(&replace_handle, |handle| {
                handle.replace(&expected, bytes.as_ref())
            })?;
            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            match replaced {
                JournalReplaceResult::Conflict => {
                    value
                        .set_named_property("status", "conflict")
                        .map_err(|_| bridge_error())?;
                }
                JournalReplaceResult::Replaced { revision } => {
                    value
                        .set_named_property("status", "replaced")
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property("revision", journal_revision_external(revision))
                        .map_err(|_| bridge_error())?;
                }
            }
            finish_object(&value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("replace", replace)
        .map_err(|_| bridge_error())?;

    let remove_handle = Arc::clone(&shared);
    let remove = env
        .create_function_from_closure::<(), _, _>("remove", move |context| {
            exact_argument_count(&context, 1)?;
            let options = argument::<Object<'_>>(&context, 0)?;
            exact_keys(&options, &["expected"])?;
            let expected = take_journal_revision_property(&options, "expected")?;
            let removed = with_handle(&remove_handle, |handle| handle.remove(&expected))?;
            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            value
                .set_named_property(
                    "status",
                    match removed {
                        JournalRemoveResult::Removed => "removed",
                        JournalRemoveResult::Conflict => "conflict",
                    },
                )
                .map_err(|_| bridge_error())?;
            finish_object(&value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("remove", remove)
        .map_err(|_| bridge_error())?;

    let release_handle = Arc::clone(&shared);
    let release = env
        .create_function_from_closure::<(), (), _>("release", move |context| {
            exact_argument_count(&context, 0)?;
            let mut handle = take_handle(&release_handle)?;
            native_result(handle.release())
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("release", release)
        .map_err(|_| bridge_error())?;

    let abandon_handle = Arc::clone(&shared);
    let abandon = env
        .create_function_from_closure::<(), (), _>("abandon", move |context| {
            exact_argument_count(&context, 0)?;
            let mut handle = take_handle(&abandon_handle)?;
            native_result(handle.abandon())
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("abandon", abandon)
        .map_err(|_| bridge_error())?;

    finish_object(&result)
}

fn make_journal_adapter(env: &Env, authority: Arc<AdapterAuthority>) -> Result<BridgeObject> {
    let mut result = Object::new(env).map_err(|_| bridge_error())?;
    let acquire = env
        .create_function_from_closure::<(), _, _>("acquire", move |context| {
            exact_argument_count(&context, 1)?;
            let options = argument::<Object<'_>>(&context, 0)?;
            exact_keys(&options, &["nonce"])?;
            let nonce = property::<String>(&options, "nonce")?;
            let acquired = match acquire_reconciliation_journal_lease(
                Path::new(&authority.state_directory),
                &nonce,
            ) {
                Ok(value) => value,
                Err(PlatformStoreError::InvalidInput) => return Err(invalid_request()),
                Err(_) => return Err(bridge_error()),
            };
            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            match acquired {
                ReconciliationJournalLeaseAcquireResult::Busy => {
                    value
                        .set_named_property("status", "busy")
                        .map_err(|_| bridge_error())?;
                }
                ReconciliationJournalLeaseAcquireResult::Acquired { prior, lease } => {
                    value
                        .set_named_property("status", "acquired")
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property(
                            "priorLease",
                            match prior {
                                PriorLease::Absent => "absent",
                                PriorLease::ProvenAbandoned => "proven-abandoned",
                            },
                        )
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property(
                            "lease",
                            make_reconciliation_journal_lease(context.env, lease)?,
                        )
                        .map_err(|_| bridge_error())?;
                }
            }
            finish_object(&value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("acquire", acquire)
        .map_err(|_| bridge_error())?;
    finish_object(&result)
}

fn make_read_adapter(env: &Env) -> Result<BridgeObject> {
    let mut result = Object::new(env).map_err(|_| bridge_error())?;
    let open = env
        .create_function_from_closure::<(), _, _>("openPrivateDirectory", move |context| {
            exact_argument_count(&context, 2)?;
            let directory = argument::<String>(&context, 0)?;
            let options = argument::<Object<'_>>(&context, 1)?;
            exact_keys(&options, &["noFollow"])?;
            expect_true(&options, "noFollow")?;
            let opened = native_result(open_private_directory(std::path::Path::new(&directory)))?;
            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            match opened {
                PrivateDirectoryOpenResult::Missing => {
                    value
                        .set_named_property("status", "missing")
                        .map_err(|_| bridge_error())?;
                }
                PrivateDirectoryOpenResult::Opened(directory) => {
                    value
                        .set_named_property("status", "opened")
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property(
                            "directory",
                            make_private_directory(context.env, directory)?,
                        )
                        .map_err(|_| bridge_error())?;
                }
            }
            finish_object(&value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("openPrivateDirectory", open)
        .map_err(|_| bridge_error())?;
    finish_object(&result)
}

fn make_legacy_adapter(env: &Env, authority: Arc<AdapterAuthority>) -> Result<BridgeObject> {
    let mut result = Object::new(env).map_err(|_| bridge_error())?;
    let read = env
        .create_function_from_closure::<(), _, _>("read", move |context| {
            exact_argument_count(&context, 3)?;
            let source = argument::<String>(&context, 0)?;
            let path = argument::<String>(&context, 1)?;
            let options = argument::<Object<'_>>(&context, 2)?;
            exact_keys(&options, &["maxBytes", "noFollow"])?;
            expect_true(&options, "noFollow")?;
            if property::<f64>(&options, "maxBytes")? != 16_384.0 {
                return Err(invalid_request());
            }
            let (allowed, expected_leaf) = match source.as_str() {
                "hermes" => (&authority.legacy_paths.hermes, OsStr::new("plurum.json")),
                "openclaw" => (&authority.legacy_paths.openclaw, OsStr::new("plurum.json")),
                "removed-cli" => (
                    &authority.legacy_paths.removed_cli,
                    OsStr::new("config.json"),
                ),
                _ => return Err(invalid_request()),
            };
            if &path != allowed {
                return Err(invalid_request());
            }
            let read =
                match read_allowlisted_legacy_credential(Path::new(&path), expected_leaf, 16_384) {
                    Ok(value) => value,
                    Err(PlatformStoreError::InvalidInput) => return Err(invalid_request()),
                    Err(_) => return Err(bridge_error()),
                };
            let status = match read {
                LegacyCredentialReadResult::Missing => "missing",
                LegacyCredentialReadResult::Unsafe => "unsafe",
                LegacyCredentialReadResult::Oversized | LegacyCredentialReadResult::Malformed => {
                    "malformed"
                }
                LegacyCredentialReadResult::Loaded(bytes) => {
                    return create_guarded_loaded_result(context.env, bytes)
                        .map_err(|_| bridge_error());
                }
            };
            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            value
                .set_named_property("status", status)
                .map_err(|_| bridge_error())?;
            Ok(GuardedObjectRef::plain(finish_object(&value)?))
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("read", read)
        .map_err(|_| bridge_error())?;
    finish_object(&result)
}

fn make_observation_adapter(env: &Env, authority: Arc<AdapterAuthority>) -> Result<BridgeObject> {
    let mut result = Object::new(env).map_err(|_| bridge_error())?;
    let open = env
        .create_function_from_closure::<(), _, _>("openPrivateDirectory", move |context| {
            exact_argument_count(&context, 2)?;
            let directory_path = argument::<String>(&context, 0)?;
            let options = argument::<Object<'_>>(&context, 1)?;
            exact_keys(&options, &["noFollow"])?;
            expect_true(&options, "noFollow")?;
            let opened = match open_private_directory(Path::new(&directory_path)) {
                Ok(value) => value,
                Err(PlatformStoreError::InvalidInput) => return Err(invalid_request()),
                Err(_) => return Err(bridge_error()),
            };
            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            match opened {
                PrivateDirectoryOpenResult::Missing => {
                    let binding =
                        match observe_missing_private_directory(Path::new(&directory_path)) {
                            Ok(Some(binding)) => binding,
                            Ok(None) => return Err(bridge_error()),
                            Err(PlatformStoreError::InvalidInput) => {
                                return Err(invalid_request());
                            }
                            Err(_) => return Err(bridge_error()),
                        };
                    value
                        .set_named_property("status", "missing")
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property(
                            "evidence",
                            evidence_external(WholePassEvidence {
                                authority: Arc::clone(&authority),
                                directory: directory_path,
                                state: EvidenceState::Missing(binding),
                            }),
                        )
                        .map_err(|_| bridge_error())?;
                }
                PrivateDirectoryOpenResult::Opened(directory) => {
                    value
                        .set_named_property("status", "opened")
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property(
                            "directory",
                            make_observation_directory(
                                context.env,
                                Arc::clone(&authority),
                                directory_path,
                                directory,
                            )?,
                        )
                        .map_err(|_| bridge_error())?;
                }
            }
            finish_object(&value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("openPrivateDirectory", open)
        .map_err(|_| bridge_error())?;
    finish_object(&result)
}

fn make_mutation_adapter(env: &Env, authority: Arc<AdapterAuthority>) -> Result<BridgeObject> {
    let mut result = Object::new(env).map_err(|_| bridge_error())?;
    let acquire = env
        .create_function_from_closure::<(), _, _>("acquireSetupLease", move |context| {
            exact_argument_count(&context, 2)?;
            let directory = argument::<String>(&context, 0)?;
            let options = argument::<Object<'_>>(&context, 1)?;
            exact_keys(&options, &["createDirectory", "noFollow", "nonce"])?;
            expect_true(&options, "noFollow")?;
            expect_true(&options, "createDirectory")?;
            let nonce = property::<String>(&options, "nonce")?;
            let acquired = match acquire_setup_lease(std::path::Path::new(&directory), &nonce) {
                Ok(value) => value,
                Err(PlatformStoreError::InvalidInput) => return Err(invalid_request()),
                Err(_) => return Err(bridge_error()),
            };
            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            match acquired {
                SetupLeaseAcquireResult::Busy => {
                    value
                        .set_named_property("status", "busy")
                        .map_err(|_| bridge_error())?;
                }
                SetupLeaseAcquireResult::Acquired {
                    prior,
                    directory,
                    lease,
                } => {
                    value
                        .set_named_property("status", "acquired")
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property(
                            "priorLease",
                            match prior {
                                PriorLease::Absent => "absent",
                                PriorLease::ProvenAbandoned => "proven-abandoned",
                            },
                        )
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property(
                            "directory",
                            match directory {
                                DirectoryDisposition::Created => "created",
                                DirectoryDisposition::Existing => "existing",
                            },
                        )
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property("lease", make_setup_lease(context.env, lease)?)
                        .map_err(|_| bridge_error())?;
                }
            }
            finish_object(&value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("acquireSetupLease", acquire)
        .map_err(|_| bridge_error())?;

    let observed_authority = Arc::clone(&authority);
    let acquire_observed = env
        .create_function_from_closure::<(), _, _>("acquireObservedSetupLease", move |context| {
            exact_argument_count(&context, 2)?;
            let directory_path = argument::<String>(&context, 0)?;
            let options = argument::<Object<'_>>(&context, 1)?;
            exact_keys(
                &options,
                &["createDirectory", "evidence", "noFollow", "nonce"],
            )?;
            expect_true(&options, "noFollow")?;
            expect_true(&options, "createDirectory")?;
            let evidence_object = property::<Object<'_>>(&options, "evidence")?;
            exact_keys(&evidence_object, &[])?;
            let nonce = property::<String>(&options, "nonce")?;
            let evidence = take_evidence_property(&options, "evidence")?;
            if !Arc::ptr_eq(&evidence.authority, &observed_authority) {
                return Err(invalid_request());
            }

            let mut value = Object::new(context.env).map_err(|_| bridge_error())?;
            if evidence.directory != directory_path {
                value
                    .set_named_property("status", "precondition-failed")
                    .map_err(|_| bridge_error())?;
                return finish_object(&value);
            }

            let acquired = match evidence.state {
                EvidenceState::Missing(binding) => acquire_observed_setup_lease(
                    Path::new(&directory_path),
                    &nonce,
                    ObservedDirectoryExpectation::Missing(&binding),
                    empty_store_snapshot,
                ),
                EvidenceState::Present(present) => {
                    let retained = present.binding.attest();
                    if !matches!(
                        retained,
                        Ok(current) if current == present.snapshot.directory
                    ) {
                        value
                            .set_named_property("status", "precondition-failed")
                            .map_err(|_| bridge_error())?;
                        return finish_object(&value);
                    }
                    acquire_observed_setup_lease(
                        Path::new(&directory_path),
                        &nonce,
                        ObservedDirectoryExpectation::Present,
                        |directory| present_snapshot_matches(directory, &present.snapshot),
                    )
                }
            };
            let acquired = match acquired {
                Ok(value) => value,
                Err(PlatformStoreError::InvalidInput) => {
                    return Err(invalid_request());
                }
                Err(_) => return Err(bridge_error()),
            };
            match acquired {
                ObservedSetupLeaseAcquireResult::Busy => {
                    value
                        .set_named_property("status", "busy")
                        .map_err(|_| bridge_error())?;
                }
                ObservedSetupLeaseAcquireResult::PreconditionFailed => {
                    value
                        .set_named_property("status", "precondition-failed")
                        .map_err(|_| bridge_error())?;
                }
                ObservedSetupLeaseAcquireResult::Acquired {
                    prior,
                    directory,
                    lease,
                } => {
                    value
                        .set_named_property("status", "acquired")
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property(
                            "priorLease",
                            match prior {
                                PriorLease::Absent => "absent",
                                PriorLease::ProvenAbandoned => "proven-abandoned",
                            },
                        )
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property(
                            "directory",
                            match directory {
                                DirectoryDisposition::Created => "created",
                                DirectoryDisposition::Existing => "existing",
                            },
                        )
                        .map_err(|_| bridge_error())?;
                    value
                        .set_named_property("lease", make_setup_lease(context.env, lease)?)
                        .map_err(|_| bridge_error())?;
                }
            }
            finish_object(&value)
        })
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("acquireObservedSetupLease", acquire_observed)
        .map_err(|_| bridge_error())?;
    finish_object(&result)
}

pub(crate) fn create_adapters(env: &Env, configuration: &Object<'_>) -> Result<BridgeObject> {
    let authority = Arc::new(parse_authority(configuration)?);
    let mut result = Object::new(env).map_err(|_| bridge_error())?;
    result
        .set_named_property(
            "journal",
            make_journal_adapter(env, Arc::clone(&authority))?,
        )
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("legacy", make_legacy_adapter(env, Arc::clone(&authority))?)
        .map_err(|_| bridge_error())?;
    result
        .set_named_property(
            "observation",
            make_observation_adapter(env, Arc::clone(&authority))?,
        )
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("read", make_read_adapter(env)?)
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("mutation", make_mutation_adapter(env, authority)?)
        .map_err(|_| bridge_error())?;
    finish_object(&result)
}
