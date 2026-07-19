use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{
    External, FunctionCallContext, JsObjectValue, KeyCollectionMode, KeyConversion, KeyFilter,
    Object, ObjectRef, Uint8Array,
};
use napi::{Env, Error, JsValue, Result, Status};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::posix as platform;
#[cfg(target_os = "windows")]
use crate::windows as platform;

use platform::{
    acquire_setup_lease, open_private_directory, BoundedRead, CanonicalEntryRole,
    ConditionalMutationResult, CredentialFileAttestation, CredentialReadOpenResult,
    DirectoryAttestation, DirectoryDisposition, ExclusiveCreateResult, ExpectedEntrySnapshot,
    LeaseRenewal, ManagedEntry, ManagedEntryObservation, MissingEntrySnapshot, ObjectIdentity,
    PresentEntrySnapshot, PriorLease, PrivateDirectoryOpenResult, SetupLeaseAcquireResult,
    TemporaryEntry, TemporaryEntryRole, MAX_ATTESTED_BYTES,
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
type PlatformStoreError = platform::PosixStoreError;
#[cfg(target_os = "windows")]
type PlatformStoreError = platform::WindowsStoreError;

enum SnapshotToken {
    Missing(MissingEntrySnapshot),
    Present(Box<PresentEntrySnapshot>),
}

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

fn bounded_read(env: &Env, value: BoundedRead) -> Result<BridgeObject> {
    let mut result = Object::new(env).map_err(|_| bridge_error())?;
    result
        .set_named_property("bytes", Uint8Array::from(value.bytes))
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("endOfFile", value.end_of_file)
        .map_err(|_| bridge_error())?;
    finish_object(&result)
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

fn make_mutation_adapter(env: &Env) -> Result<BridgeObject> {
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
    finish_object(&result)
}

pub(crate) fn create_adapters(env: &Env) -> Result<BridgeObject> {
    let mut result = Object::new(env).map_err(|_| bridge_error())?;
    result
        .set_named_property("read", make_read_adapter(env)?)
        .map_err(|_| bridge_error())?;
    result
        .set_named_property("mutation", make_mutation_adapter(env)?)
        .map_err(|_| bridge_error())?;
    finish_object(&result)
}
