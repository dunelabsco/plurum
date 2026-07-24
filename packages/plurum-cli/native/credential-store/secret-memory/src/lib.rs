#![deny(unsafe_op_in_unsafe_fn)]

use std::cell::UnsafeCell;
use std::ffi::{c_char, c_void};
use std::ptr;
use std::rc::Rc;
use std::sync::atomic::{compiler_fence, Ordering};
#[cfg(test)]
use std::sync::Arc;

use napi::bindgen_prelude::{JsValue, ObjectRef, ToNapiValue};
use napi::{sys, Env, Error, Result, Status};

const LOADED: &[u8] = b"loaded";
const STATUS_PROPERTY: &[u8] = b"status\0";
const BYTES_PROPERTY: &[u8] = b"bytes\0";
const END_OF_FILE_PROPERTY: &[u8] = b"endOfFile\0";

fn boundary_error() -> Error {
    Error::new(
        Status::GenericFailure,
        "Native credential operation failed.",
    )
}

fn require_ok(status: sys::napi_status) -> Result<()> {
    if status == sys::Status::napi_ok {
        Ok(())
    } else {
        Err(boundary_error())
    }
}

fn zeroize_raw(data: *mut u8, length: usize) {
    for offset in 0..length {
        // SAFETY: every caller supplies writable allocation storage covering
        // exactly `length` bytes.
        unsafe { ptr::write_volatile(data.add(offset), 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

/// Reliably overwrites every byte in a mutable slice with zero.
///
/// This is the safe zeroization boundary for ordinary initialized byte
/// buffers in the native credential store. It does not erase independent
/// copies that a caller may have made elsewhere.
pub fn zeroize_bytes(bytes: &mut [u8]) {
    zeroize_raw(bytes.as_mut_ptr(), bytes.len());
}

#[cfg(test)]
#[derive(Default)]
struct WipeProbe {
    calls: std::sync::atomic::AtomicUsize,
    all_zero: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl WipeProbe {
    fn new() -> Self {
        Self {
            calls: std::sync::atomic::AtomicUsize::new(0),
            all_zero: std::sync::atomic::AtomicBool::new(true),
        }
    }

    fn record(&self, all_zero: bool) {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if !all_zero {
            self.all_zero.store(false, Ordering::SeqCst);
        }
    }
}

struct SecretBacking {
    bytes: UnsafeCell<Vec<u8>>,
    #[cfg(test)]
    probe: Option<Arc<WipeProbe>>,
}

impl SecretBacking {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            bytes: UnsafeCell::new(bytes),
            #[cfg(test)]
            probe: None,
        }
    }

    #[cfg(test)]
    fn with_probe(bytes: Vec<u8>, probe: Arc<WipeProbe>) -> Self {
        Self {
            bytes: UnsafeCell::new(bytes),
            probe: Some(probe),
        }
    }

    fn allocation(&self) -> (*mut u8, usize, usize) {
        // SAFETY: this helper never creates a Rust reference to the byte
        // allocation after it becomes visible to JavaScript. The Vec itself
        // remains pinned inside this environment-thread-owned allocation.
        let bytes = unsafe { &mut *self.bytes.get() };
        (bytes.as_mut_ptr(), bytes.len(), bytes.capacity())
    }

    fn wipe(&self) {
        let (data, _, capacity) = self.allocation();
        // The external allocation owns every byte through capacity, including
        // spare Vec storage that may have held an earlier secret value.
        zeroize_raw(data, capacity);

        #[cfg(test)]
        if let Some(probe) = &self.probe {
            let all_zero = (0..capacity).all(|offset| {
                // SAFETY: the allocation is still retained by `self`, and the
                // preceding loop initialized every byte through capacity.
                unsafe { ptr::read_volatile(data.add(offset)) == 0 }
            });
            probe.record(all_zero);
        }
    }
}

impl Drop for SecretBacking {
    fn drop(&mut self) {
        self.wipe();
    }
}

struct PendingSecret {
    backing: Rc<SecretBacking>,
    armed: bool,
}

impl PendingSecret {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            backing: Rc::new(SecretBacking::new(bytes)),
            armed: true,
        }
    }

    #[cfg(test)]
    fn with_probe(bytes: Vec<u8>, probe: Arc<WipeProbe>) -> Self {
        Self {
            backing: Rc::new(SecretBacking::with_probe(bytes, probe)),
            armed: true,
        }
    }

    fn attached(mut self) -> AttachedSecret {
        let result = AttachedSecret {
            backing: Rc::clone(&self.backing),
            armed: true,
        };
        self.armed = false;
        result
    }
}

impl Drop for PendingSecret {
    fn drop(&mut self) {
        if self.armed {
            self.backing.wipe();
        }
    }
}

struct AttachedSecret {
    backing: Rc<SecretBacking>,
    armed: bool,
}

impl AttachedSecret {
    fn fork(&self) -> Self {
        Self {
            backing: Rc::clone(&self.backing),
            armed: true,
        }
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for AttachedSecret {
    fn drop(&mut self) {
        if self.armed {
            self.backing.wipe();
        }
    }
}

// Node-API finalizers run only after JavaScript can no longer reach the
// external ArrayBuffer. They perform no Node-API calls and cannot report a
// secondary failure.
unsafe extern "C" fn finalize_secret(
    _env: sys::napi_env,
    finalize_data: *mut c_void,
    _finalize_hint: *mut c_void,
) {
    if finalize_data.is_null() {
        return;
    }
    // SAFETY: successful `napi_add_finalizer` takes exactly the Box pointer
    // produced in `attach_external_arraybuffer`, once, for this callback.
    let backing = unsafe { Box::from_raw(finalize_data.cast::<Rc<SecretBacking>>()) };
    backing.wipe();
    drop(backing);
}

trait NapiOps: Sync {
    fn create_object(&self, env: sys::napi_env, result: *mut sys::napi_value) -> sys::napi_status;
    fn create_string_utf8(
        &self,
        env: sys::napi_env,
        value: *const c_char,
        length: isize,
        result: *mut sys::napi_value,
    ) -> sys::napi_status;
    fn get_boolean(
        &self,
        env: sys::napi_env,
        value: bool,
        result: *mut sys::napi_value,
    ) -> sys::napi_status;
    fn create_arraybuffer(
        &self,
        env: sys::napi_env,
        length: usize,
        data: *mut *mut c_void,
        result: *mut sys::napi_value,
    ) -> sys::napi_status;
    fn create_external_arraybuffer(
        &self,
        env: sys::napi_env,
        data: *mut c_void,
        length: usize,
        result: *mut sys::napi_value,
    ) -> sys::napi_status;
    fn add_finalizer(
        &self,
        env: sys::napi_env,
        object: sys::napi_value,
        data: *mut c_void,
        callback: sys::napi_finalize,
    ) -> sys::napi_status;
    fn create_uint8_array(
        &self,
        env: sys::napi_env,
        length: usize,
        arraybuffer: sys::napi_value,
        result: *mut sys::napi_value,
    ) -> sys::napi_status;
    fn define_properties(
        &self,
        env: sys::napi_env,
        object: sys::napi_value,
        properties: &[sys::napi_property_descriptor],
    ) -> sys::napi_status;
    fn create_reference(
        &self,
        env: sys::napi_env,
        value: sys::napi_value,
        result: *mut sys::napi_ref,
    ) -> sys::napi_status;
    fn get_reference_value(
        &self,
        env: sys::napi_env,
        reference: sys::napi_ref,
        result: *mut sys::napi_value,
    ) -> sys::napi_status;
    fn delete_reference(&self, env: sys::napi_env, reference: sys::napi_ref) -> sys::napi_status;
}

struct ProductionOps;

impl NapiOps for ProductionOps {
    fn create_object(&self, env: sys::napi_env, result: *mut sys::napi_value) -> sys::napi_status {
        // SAFETY: the active Node-API callback supplies `env`, and `result`
        // points to live output storage for this synchronous call.
        unsafe { sys::napi_create_object(env, result) }
    }

    fn create_string_utf8(
        &self,
        env: sys::napi_env,
        value: *const c_char,
        length: isize,
        result: *mut sys::napi_value,
    ) -> sys::napi_status {
        // SAFETY: `value` is the static LOADED byte sequence and `result`
        // points to live output storage.
        unsafe { sys::napi_create_string_utf8(env, value, length, result) }
    }

    fn get_boolean(
        &self,
        env: sys::napi_env,
        value: bool,
        result: *mut sys::napi_value,
    ) -> sys::napi_status {
        // SAFETY: `result` points to live output storage for this synchronous
        // call in the active Node-API environment.
        unsafe { sys::napi_get_boolean(env, value, result) }
    }

    fn create_arraybuffer(
        &self,
        env: sys::napi_env,
        length: usize,
        data: *mut *mut c_void,
        result: *mut sys::napi_value,
    ) -> sys::napi_status {
        // SAFETY: both output pointers remain live for this synchronous call.
        unsafe { sys::napi_create_arraybuffer(env, length, data, result) }
    }

    fn create_external_arraybuffer(
        &self,
        env: sys::napi_env,
        data: *mut c_void,
        length: usize,
        result: *mut sys::napi_value,
    ) -> sys::napi_status {
        // SAFETY: the reference-counted allocation remains live across this
        // call and until either the armed guard or finalizer releases it.
        unsafe {
            sys::napi_create_external_arraybuffer(env, data, length, None, ptr::null_mut(), result)
        }
    }

    fn add_finalizer(
        &self,
        env: sys::napi_env,
        object: sys::napi_value,
        data: *mut c_void,
        callback: sys::napi_finalize,
    ) -> sys::napi_status {
        // SAFETY: `object` is the just-created ArrayBuffer and `data` is the
        // unique Box pointer reserved for this finalizer registration.
        unsafe {
            sys::napi_add_finalizer(
                env,
                object,
                data,
                callback,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        }
    }

    fn create_uint8_array(
        &self,
        env: sys::napi_env,
        length: usize,
        arraybuffer: sys::napi_value,
        result: *mut sys::napi_value,
    ) -> sys::napi_status {
        // SAFETY: `arraybuffer` and `result` are live local Node-API handles.
        unsafe {
            sys::napi_create_typedarray(
                env,
                sys::TypedarrayType::uint8_array,
                length,
                arraybuffer,
                0,
                result,
            )
        }
    }

    fn define_properties(
        &self,
        env: sys::napi_env,
        object: sys::napi_value,
        properties: &[sys::napi_property_descriptor],
    ) -> sys::napi_status {
        // SAFETY: the descriptors and their static names remain live for the
        // complete synchronous definition call.
        unsafe { sys::napi_define_properties(env, object, properties.len(), properties.as_ptr()) }
    }

    fn create_reference(
        &self,
        env: sys::napi_env,
        value: sys::napi_value,
        result: *mut sys::napi_ref,
    ) -> sys::napi_status {
        // SAFETY: `value` is live in this handle scope and `result` is output
        // storage for one strong reference.
        unsafe { sys::napi_create_reference(env, value, 1, result) }
    }

    fn get_reference_value(
        &self,
        env: sys::napi_env,
        reference: sys::napi_ref,
        result: *mut sys::napi_value,
    ) -> sys::napi_status {
        // SAFETY: `reference` is owned by GuardedObjectRef and `result` is live
        // output storage.
        unsafe { sys::napi_get_reference_value(env, reference, result) }
    }

    fn delete_reference(&self, env: sys::napi_env, reference: sys::napi_ref) -> sys::napi_status {
        // SAFETY: this consumes the one reference owned by GuardedObjectRef.
        unsafe { sys::napi_delete_reference(env, reference) }
    }
}

static PRODUCTION_OPS: ProductionOps = ProductionOps;

enum GuardedReference {
    Plain(ObjectRef<false>),
    Secret {
        env: sys::napi_env,
        reference: sys::napi_ref,
    },
}

/// A callback result whose secret allocation stays armed until the last
/// fallible Node-API reference operation has completed.
pub struct GuardedObjectRef {
    reference: GuardedReference,
    secret: Option<AttachedSecret>,
    ops: &'static dyn NapiOps,
}

/// Keeps an external byte allocation armed while its guarded child object is
/// embedded into a larger callback result. The continuation must protect the
/// final outer reference or be dropped, which wipes the allocation
/// synchronously.
pub struct GuardedSecretContinuation {
    secret: AttachedSecret,
    ops: &'static dyn NapiOps,
}

impl GuardedObjectRef {
    /// Wraps a normal non-secret result so every branch of one callback can
    /// return the same type.
    pub fn plain(object: ObjectRef<false>) -> Self {
        Self {
            reference: GuardedReference::Plain(object),
            secret: None,
            ops: &PRODUCTION_OPS,
        }
    }

    /// Forks the current failure guard without copying the byte allocation.
    /// The returned continuation remains armed even after this child object is
    /// successfully marshalled into JavaScript.
    pub fn secret_continuation(&self) -> Option<GuardedSecretContinuation> {
        self.secret
            .as_ref()
            .map(|secret| GuardedSecretContinuation {
                secret: secret.fork(),
                ops: self.ops,
            })
    }
}

impl GuardedSecretContinuation {
    fn protect_reference(self, reference: GuardedReference) -> GuardedObjectRef {
        GuardedObjectRef {
            reference,
            secret: Some(self.secret),
            ops: self.ops,
        }
    }

    /// Transfers this guard to the final outer callback result.
    pub fn protect(self, object: ObjectRef<false>) -> GuardedObjectRef {
        self.protect_reference(GuardedReference::Plain(object))
    }
}

impl ToNapiValue for GuardedObjectRef {
    unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> Result<sys::napi_value> {
        let Self {
            reference,
            secret,
            ops,
        } = value;
        let raw = match reference {
            GuardedReference::Plain(reference) => {
                let env = Env::from_raw(env);
                let object = reference.get_value(&env)?;
                let raw = object.raw();
                if raw.is_null() {
                    let _ = reference.unref(&env);
                    return Err(boundary_error());
                }
                reference.unref(&env)?;
                raw
            }
            GuardedReference::Secret {
                env: owner_env,
                reference,
            } => {
                if owner_env != env {
                    return Err(boundary_error());
                }
                let mut raw = ptr::null_mut();
                require_ok(ops.get_reference_value(env, reference, &mut raw))?;
                if raw.is_null() {
                    let _ = ops.delete_reference(env, reference);
                    return Err(boundary_error());
                }
                require_ok(ops.delete_reference(env, reference))?;
                raw
            }
        };
        if let Some(secret) = secret {
            secret.disarm();
        }
        Ok(raw)
    }
}

fn raw_property(name: &'static [u8], value: sys::napi_value) -> sys::napi_property_descriptor {
    sys::napi_property_descriptor {
        utf8name: name.as_ptr().cast(),
        name: ptr::null_mut(),
        method: None,
        getter: None,
        setter: None,
        value,
        attributes: sys::PropertyAttributes::writable
            | sys::PropertyAttributes::enumerable
            | sys::PropertyAttributes::configurable,
        data: ptr::null_mut(),
    }
}

fn create_secret_uint8_array(
    env: sys::napi_env,
    pending: &PendingSecret,
    ops: &'static dyn NapiOps,
) -> Result<sys::napi_value> {
    let (data, length, _) = pending.backing.allocation();
    let mut arraybuffer = ptr::null_mut();
    if length == 0 {
        let mut empty_data = ptr::null_mut();
        require_ok(ops.create_arraybuffer(env, 0, &mut empty_data, &mut arraybuffer))?;
    } else {
        // Allocate finalizer ownership before exposing the pointer, leaving no
        // allocation or panic point between external-buffer creation and
        // finalizer registration.
        let finalizer_owner = Box::new(Rc::clone(&pending.backing));
        require_ok(ops.create_external_arraybuffer(env, data.cast(), length, &mut arraybuffer))?;
        if arraybuffer.is_null() {
            return Err(boundary_error());
        }

        let finalizer_data = Box::into_raw(finalizer_owner).cast();
        let finalizer_status =
            ops.add_finalizer(env, arraybuffer, finalizer_data, Some(finalize_secret));
        if finalizer_status != sys::Status::napi_ok {
            // The successful external ArrayBuffer must never outlive its
            // allocation. Keep this owner deliberately leaked if Node-API
            // cannot prove finalizer registration; the armed guard zeros it.
            return Err(boundary_error());
        }
    }
    if arraybuffer.is_null() {
        return Err(boundary_error());
    }

    let mut typed_array = ptr::null_mut();
    require_ok(ops.create_uint8_array(env, length, arraybuffer, &mut typed_array))?;
    if typed_array.is_null() {
        Err(boundary_error())
    } else {
        Ok(typed_array)
    }
}

fn finish_guarded_object(
    env: sys::napi_env,
    object: sys::napi_value,
    pending: PendingSecret,
    ops: &'static dyn NapiOps,
) -> Result<GuardedObjectRef> {
    let attached = pending.attached();
    let mut reference = ptr::null_mut();
    require_ok(ops.create_reference(env, object, &mut reference))?;
    if reference.is_null() {
        return Err(boundary_error());
    }

    Ok(GuardedObjectRef {
        reference: GuardedReference::Secret { env, reference },
        secret: Some(attached),
        ops,
    })
}

fn create_guarded_loaded_result_with(
    env: sys::napi_env,
    pending: PendingSecret,
    ops: &'static dyn NapiOps,
) -> Result<GuardedObjectRef> {
    let mut object = ptr::null_mut();
    require_ok(ops.create_object(env, &mut object))?;
    if object.is_null() {
        return Err(boundary_error());
    }

    let mut status = ptr::null_mut();
    require_ok(ops.create_string_utf8(
        env,
        LOADED.as_ptr().cast(),
        LOADED.len() as isize,
        &mut status,
    ))?;
    if status.is_null() {
        return Err(boundary_error());
    }

    let typed_array = create_secret_uint8_array(env, &pending, ops)?;
    let properties = [
        raw_property(STATUS_PROPERTY, status),
        raw_property(BYTES_PROPERTY, typed_array),
    ];
    require_ok(ops.define_properties(env, object, &properties))?;
    finish_guarded_object(env, object, pending, ops)
}

/// Creates `{ status: "loaded", bytes: Uint8Array }` without copying the
/// supplied Vec. The byte allocation is synchronously zeroized on every
/// construction/property/reference failure, by JavaScript's normal typed-array
/// wipe on success, and again by an infallible finalizer before deallocation.
pub fn create_guarded_loaded_result(env: &Env, bytes: Vec<u8>) -> Result<GuardedObjectRef> {
    let pending = PendingSecret::new(bytes);
    create_guarded_loaded_result_with(env.raw(), pending, &PRODUCTION_OPS)
}

fn create_guarded_bounded_read_result_with(
    env: sys::napi_env,
    pending: PendingSecret,
    end_of_file: bool,
    ops: &'static dyn NapiOps,
) -> Result<GuardedObjectRef> {
    let mut object = ptr::null_mut();
    require_ok(ops.create_object(env, &mut object))?;
    if object.is_null() {
        return Err(boundary_error());
    }

    let mut end_of_file_value = ptr::null_mut();
    require_ok(ops.get_boolean(env, end_of_file, &mut end_of_file_value))?;
    if end_of_file_value.is_null() {
        return Err(boundary_error());
    }

    let typed_array = create_secret_uint8_array(env, &pending, ops)?;
    let properties = [
        raw_property(BYTES_PROPERTY, typed_array),
        raw_property(END_OF_FILE_PROPERTY, end_of_file_value),
    ];
    require_ok(ops.define_properties(env, object, &properties))?;
    finish_guarded_object(env, object, pending, ops)
}

/// Creates `{ bytes: Uint8Array, endOfFile: boolean }` with the same
/// zero-copy, failure-guarded ownership used by loaded legacy results.
pub fn create_guarded_bounded_read_result(
    env: &Env,
    bytes: Vec<u8>,
    end_of_file: bool,
) -> Result<GuardedObjectRef> {
    let pending = PendingSecret::new(bytes);
    create_guarded_bounded_read_result_with(env.raw(), pending, end_of_file, &PRODUCTION_OPS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CStr;
    use std::sync::Mutex;

    const FAKE_ENV: sys::napi_env = 0x10usize as sys::napi_env;
    const FAKE_OBJECT: sys::napi_value = 0x20usize as sys::napi_value;
    const FAKE_STATUS: sys::napi_value = 0x30usize as sys::napi_value;
    const FAKE_BOOLEAN: sys::napi_value = 0x35usize as sys::napi_value;
    const FAKE_ARRAYBUFFER: sys::napi_value = 0x40usize as sys::napi_value;
    const FAKE_TYPED_ARRAY: sys::napi_value = 0x50usize as sys::napi_value;
    const FAKE_REFERENCE: sys::napi_ref = 0x60usize as sys::napi_ref;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum Boundary {
        None,
        CreateObject,
        CreateString,
        CreateBoolean,
        CreateArraybuffer,
        CreateExternalArraybuffer,
        ExternalBuffersDisallowed,
        AddFinalizer,
        CreateTypedArray,
        DefineProperties,
        CreateReference,
        GetReferenceValue,
        DeleteReference,
    }

    #[derive(Default)]
    struct FakeState {
        external_data: usize,
        external_length: usize,
        finalizer_data: usize,
        finalizer: sys::napi_finalize,
        boolean_requested: Option<bool>,
    }

    struct FakeOps {
        failing: Boundary,
        state: Mutex<FakeState>,
    }

    impl FakeOps {
        fn new(failing: Boundary) -> Self {
            Self {
                failing,
                state: Mutex::new(FakeState::default()),
            }
        }

        fn status(&self, boundary: Boundary) -> sys::napi_status {
            if self.failing == boundary {
                sys::Status::napi_generic_failure
            } else if self.failing == Boundary::ExternalBuffersDisallowed
                && boundary == Boundary::CreateExternalArraybuffer
            {
                sys::Status::napi_no_external_buffers_allowed
            } else {
                sys::Status::napi_ok
            }
        }

        fn finalize_if_registered_or_ambiguous(&self) {
            let (data, callback) = {
                let mut state = self.state.lock().expect("fake state lock");
                let pair = (state.finalizer_data, state.finalizer);
                state.finalizer_data = 0;
                state.finalizer = None;
                pair
            };
            if data != 0 {
                let callback = callback.expect("finalizer callback");
                // SAFETY: the fake retained the exact Box pointer supplied by
                // the helper, and invokes its callback at most once.
                unsafe { callback(FAKE_ENV, data as *mut c_void, ptr::null_mut()) };
            }
        }

        fn exposed_bytes(&self) -> (*mut u8, usize) {
            let state = self.state.lock().expect("fake state lock");
            (state.external_data as *mut u8, state.external_length)
        }

        fn boolean_requested(&self) -> Option<bool> {
            self.state
                .lock()
                .expect("fake state lock")
                .boolean_requested
        }
    }

    impl NapiOps for FakeOps {
        fn create_object(
            &self,
            _env: sys::napi_env,
            result: *mut sys::napi_value,
        ) -> sys::napi_status {
            let status = self.status(Boundary::CreateObject);
            if status == sys::Status::napi_ok {
                // SAFETY: the state machine supplies live output storage.
                unsafe { *result = FAKE_OBJECT };
            }
            status
        }

        fn create_string_utf8(
            &self,
            _env: sys::napi_env,
            _value: *const c_char,
            _length: isize,
            result: *mut sys::napi_value,
        ) -> sys::napi_status {
            let status = self.status(Boundary::CreateString);
            if status == sys::Status::napi_ok {
                // SAFETY: the state machine supplies live output storage.
                unsafe { *result = FAKE_STATUS };
            }
            status
        }

        fn get_boolean(
            &self,
            _env: sys::napi_env,
            value: bool,
            result: *mut sys::napi_value,
        ) -> sys::napi_status {
            self.state
                .lock()
                .expect("fake state lock")
                .boolean_requested = Some(value);
            let status = self.status(Boundary::CreateBoolean);
            if status == sys::Status::napi_ok {
                // SAFETY: the state machine supplies live output storage.
                unsafe { *result = FAKE_BOOLEAN };
            }
            status
        }

        fn create_arraybuffer(
            &self,
            _env: sys::napi_env,
            _length: usize,
            data: *mut *mut c_void,
            result: *mut sys::napi_value,
        ) -> sys::napi_status {
            let status = self.status(Boundary::CreateArraybuffer);
            if status == sys::Status::napi_ok {
                // SAFETY: the state machine supplies live output storage.
                unsafe {
                    *data = ptr::null_mut();
                    *result = FAKE_ARRAYBUFFER;
                }
            }
            status
        }

        fn create_external_arraybuffer(
            &self,
            _env: sys::napi_env,
            data: *mut c_void,
            length: usize,
            result: *mut sys::napi_value,
        ) -> sys::napi_status {
            {
                let mut state = self.state.lock().expect("fake state lock");
                state.external_data = data as usize;
                state.external_length = length;
            }
            let status = self.status(Boundary::CreateExternalArraybuffer);
            if status == sys::Status::napi_ok {
                // SAFETY: the state machine supplies live output storage.
                unsafe { *result = FAKE_ARRAYBUFFER };
            }
            status
        }

        fn add_finalizer(
            &self,
            _env: sys::napi_env,
            _object: sys::napi_value,
            data: *mut c_void,
            callback: sys::napi_finalize,
        ) -> sys::napi_status {
            let mut state = self.state.lock().expect("fake state lock");
            state.finalizer_data = data as usize;
            state.finalizer = callback;
            self.status(Boundary::AddFinalizer)
        }

        fn create_uint8_array(
            &self,
            _env: sys::napi_env,
            _length: usize,
            _arraybuffer: sys::napi_value,
            result: *mut sys::napi_value,
        ) -> sys::napi_status {
            let status = self.status(Boundary::CreateTypedArray);
            if status == sys::Status::napi_ok {
                // SAFETY: the state machine supplies live output storage.
                unsafe { *result = FAKE_TYPED_ARRAY };
            }
            status
        }

        fn define_properties(
            &self,
            _env: sys::napi_env,
            _object: sys::napi_value,
            properties: &[sys::napi_property_descriptor],
        ) -> sys::napi_status {
            assert_eq!(properties.len(), 2);
            if property_name(&properties[0]) == STATUS_PROPERTY {
                assert_eq!(properties[0].value, FAKE_STATUS);
                assert_eq!(property_name(&properties[1]), BYTES_PROPERTY);
                assert_eq!(properties[1].value, FAKE_TYPED_ARRAY);
            } else {
                assert_eq!(property_name(&properties[0]), BYTES_PROPERTY);
                assert_eq!(properties[0].value, FAKE_TYPED_ARRAY);
                assert_eq!(property_name(&properties[1]), END_OF_FILE_PROPERTY);
                assert_eq!(properties[1].value, FAKE_BOOLEAN);
            }
            assert_eq!(
                properties[0].attributes,
                sys::PropertyAttributes::writable
                    | sys::PropertyAttributes::enumerable
                    | sys::PropertyAttributes::configurable
            );
            assert_eq!(properties[1].attributes, properties[0].attributes);
            assert!(properties.iter().all(|property| {
                property.method.is_none() && property.getter.is_none() && property.setter.is_none()
            }));
            self.status(Boundary::DefineProperties)
        }

        fn create_reference(
            &self,
            _env: sys::napi_env,
            _value: sys::napi_value,
            result: *mut sys::napi_ref,
        ) -> sys::napi_status {
            let status = self.status(Boundary::CreateReference);
            if status == sys::Status::napi_ok {
                // SAFETY: the state machine supplies live output storage.
                unsafe { *result = FAKE_REFERENCE };
            }
            status
        }

        fn get_reference_value(
            &self,
            _env: sys::napi_env,
            _reference: sys::napi_ref,
            result: *mut sys::napi_value,
        ) -> sys::napi_status {
            let status = self.status(Boundary::GetReferenceValue);
            if status == sys::Status::napi_ok {
                // SAFETY: the marshaller supplies live output storage.
                unsafe { *result = FAKE_OBJECT };
            }
            status
        }

        fn delete_reference(
            &self,
            _env: sys::napi_env,
            _reference: sys::napi_ref,
        ) -> sys::napi_status {
            self.status(Boundary::DeleteReference)
        }
    }

    fn leaked_fake(failing: Boundary) -> &'static FakeOps {
        Box::leak(Box::new(FakeOps::new(failing)))
    }

    fn property_name(property: &sys::napi_property_descriptor) -> &[u8] {
        assert!(!property.utf8name.is_null());
        // SAFETY: this fake receives only descriptors built by `raw_property`
        // from the module's NUL-terminated, static-lifetime property names.
        unsafe { CStr::from_ptr(property.utf8name) }.to_bytes_with_nul()
    }

    fn assert_wiped(probe: &WipeProbe) {
        assert!(
            probe.calls.load(Ordering::SeqCst) > 0,
            "zeroization must run before the failure returns"
        );
        assert!(
            probe.all_zero.load(Ordering::SeqCst),
            "every initialized allocation byte must be zero"
        );
    }

    #[test]
    fn public_zeroize_bytes_overwrites_every_initialized_byte() {
        let mut bytes = (0_u8..=u8::MAX).collect::<Vec<_>>();
        zeroize_bytes(bytes.as_mut_slice());
        assert_eq!(bytes.len(), usize::from(u8::MAX) + 1);
        assert!(bytes.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn public_zeroize_bytes_supports_fixed_and_empty_slices() {
        let mut fixed = *b"credential-secret";
        zeroize_bytes(&mut fixed);
        assert!(fixed.iter().all(|byte| *byte == 0));

        let mut empty = [];
        zeroize_bytes(&mut empty);
        assert!(empty.is_empty());
    }

    #[test]
    fn every_loaded_result_construction_boundary_wipes_before_error() {
        for boundary in [
            Boundary::CreateObject,
            Boundary::CreateString,
            Boundary::CreateExternalArraybuffer,
            Boundary::ExternalBuffersDisallowed,
            Boundary::AddFinalizer,
            Boundary::CreateTypedArray,
            Boundary::DefineProperties,
            Boundary::CreateReference,
        ] {
            let ops = leaked_fake(boundary);
            let probe = Arc::new(WipeProbe::new());
            let pending = PendingSecret::with_probe(b"secret-value".to_vec(), Arc::clone(&probe));
            assert!(
                create_guarded_loaded_result_with(FAKE_ENV, pending, ops).is_err(),
                "{boundary:?} must fail closed"
            );
            assert_wiped(&probe);
            ops.finalize_if_registered_or_ambiguous();
        }
    }

    #[test]
    fn every_bounded_read_construction_boundary_wipes_before_error() {
        for boundary in [
            Boundary::CreateObject,
            Boundary::CreateBoolean,
            Boundary::CreateExternalArraybuffer,
            Boundary::ExternalBuffersDisallowed,
            Boundary::AddFinalizer,
            Boundary::CreateTypedArray,
            Boundary::DefineProperties,
            Boundary::CreateReference,
        ] {
            let ops = leaked_fake(boundary);
            let probe = Arc::new(WipeProbe::new());
            let pending = PendingSecret::with_probe(b"secret-value".to_vec(), Arc::clone(&probe));
            assert!(
                create_guarded_bounded_read_result_with(FAKE_ENV, pending, true, ops,).is_err(),
                "{boundary:?} must fail closed"
            );
            assert_wiped(&probe);
            ops.finalize_if_registered_or_ambiguous();
        }
    }

    #[test]
    fn bounded_read_continuation_guards_outer_construction_after_child_marshalling() {
        let ops = leaked_fake(Boundary::None);
        let probe = Arc::new(WipeProbe::new());
        let pending = PendingSecret::with_probe(b"nested-secret".to_vec(), Arc::clone(&probe));
        let guarded = create_guarded_bounded_read_result_with(FAKE_ENV, pending, true, ops)
            .expect("bounded child construction");
        let continuation = guarded
            .secret_continuation()
            .expect("bounded child must expose one continuation");

        // SAFETY: FAKE_ENV owns the fake reference and every scripted child
        // marshalling operation succeeds.
        assert_eq!(
            unsafe { GuardedObjectRef::to_napi_value(FAKE_ENV, guarded) }
                .expect("bounded child marshalling"),
            FAKE_OBJECT
        );
        assert_eq!(
            probe.calls.load(Ordering::SeqCst),
            0,
            "the successful child conversion must not disarm its outer guard"
        );

        // This models any failure while defining the outer property or
        // creating the outer reference.
        drop(continuation);
        assert_wiped(&probe);
        ops.finalize_if_registered_or_ambiguous();
    }

    #[test]
    fn bounded_read_continuation_guards_final_outer_marshalling() {
        for boundary in [Boundary::GetReferenceValue, Boundary::DeleteReference] {
            let ops = leaked_fake(boundary);
            let probe = Arc::new(WipeProbe::new());
            let backing = Rc::new(SecretBacking::with_probe(
                b"outer-secret".to_vec(),
                Arc::clone(&probe),
            ));
            let continuation = GuardedSecretContinuation {
                secret: AttachedSecret {
                    backing,
                    armed: true,
                },
                ops,
            };
            let guarded = continuation.protect_reference(GuardedReference::Secret {
                env: FAKE_ENV,
                reference: FAKE_REFERENCE,
            });

            // SAFETY: the fake owns the scripted reference and intentionally
            // fails at the selected final marshalling boundary.
            assert!(
                unsafe { GuardedObjectRef::to_napi_value(FAKE_ENV, guarded) }.is_err(),
                "{boundary:?} must fail closed"
            );
            assert_wiped(&probe);
        }
    }

    #[test]
    fn bounded_read_continuation_disarms_only_after_outer_success() {
        let ops = leaked_fake(Boundary::None);
        let probe = Arc::new(WipeProbe::new());
        let secret = b"nested-success".to_vec();
        let pending = PendingSecret::with_probe(secret.clone(), Arc::clone(&probe));
        let guarded = create_guarded_bounded_read_result_with(FAKE_ENV, pending, true, ops)
            .expect("bounded child construction");
        let continuation = guarded
            .secret_continuation()
            .expect("bounded child must expose one continuation");

        // SAFETY: the fake owns the scripted child reference and every
        // operation succeeds.
        unsafe { GuardedObjectRef::to_napi_value(FAKE_ENV, guarded) }
            .expect("bounded child marshalling");
        let outer = continuation.protect_reference(GuardedReference::Secret {
            env: FAKE_ENV,
            reference: FAKE_REFERENCE,
        });
        // SAFETY: the fake owns the scripted outer reference and every
        // operation succeeds.
        unsafe { GuardedObjectRef::to_napi_value(FAKE_ENV, outer) }.expect("outer marshalling");
        assert_eq!(
            probe.calls.load(Ordering::SeqCst),
            0,
            "successful outer marshalling must leave JavaScript's copy intact"
        );

        let (data, length) = ops.exposed_bytes();
        assert_eq!(length, secret.len());
        // SAFETY: the fake still retains the registered external allocation.
        let exposed = unsafe { std::slice::from_raw_parts_mut(data, length) };
        assert_eq!(exposed, secret);
        exposed.fill(0);
        ops.finalize_if_registered_or_ambiguous();
        assert_wiped(&probe);
    }

    #[test]
    fn empty_arraybuffer_failure_is_guarded_without_external_memory() {
        let ops = leaked_fake(Boundary::CreateArraybuffer);
        let probe = Arc::new(WipeProbe::new());
        let pending = PendingSecret::with_probe(Vec::new(), Arc::clone(&probe));
        assert!(create_guarded_loaded_result_with(FAKE_ENV, pending, ops).is_err());
        assert_wiped(&probe);
    }

    #[test]
    fn every_loaded_result_marshalling_boundary_wipes_before_error() {
        for boundary in [Boundary::GetReferenceValue, Boundary::DeleteReference] {
            let ops = leaked_fake(boundary);
            let probe = Arc::new(WipeProbe::new());
            let pending = PendingSecret::with_probe(b"secret-value".to_vec(), Arc::clone(&probe));
            let guarded = create_guarded_loaded_result_with(FAKE_ENV, pending, ops)
                .expect("construction before marshalling");
            // SAFETY: FAKE_ENV is the exact owner environment recorded by the
            // fake reference, and the fake implements the complete conversion.
            assert!(unsafe { GuardedObjectRef::to_napi_value(FAKE_ENV, guarded) }.is_err());
            assert_wiped(&probe);
            ops.finalize_if_registered_or_ambiguous();
        }
    }

    #[test]
    fn normal_js_wipe_targets_the_owned_allocation_and_finalizer_rewipes() {
        let ops = leaked_fake(Boundary::None);
        let probe = Arc::new(WipeProbe::new());
        let secret = b"secret-value".to_vec();
        let pending = PendingSecret::with_probe(secret.clone(), Arc::clone(&probe));
        let guarded =
            create_guarded_loaded_result_with(FAKE_ENV, pending, ops).expect("guarded result");
        let (data, length) = ops.exposed_bytes();
        assert_eq!(length, secret.len());
        // SAFETY: the fake retained the live external allocation and no
        // finalizer or guard has released it yet.
        let exposed = unsafe { std::slice::from_raw_parts_mut(data, length) };
        assert_eq!(exposed, secret);
        exposed.fill(0);

        // SAFETY: FAKE_ENV owns the fake reference and every scripted call
        // succeeds, matching the callback trampoline contract.
        assert_eq!(
            unsafe { GuardedObjectRef::to_napi_value(FAKE_ENV, guarded) }.expect("marshal"),
            FAKE_OBJECT
        );
        assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
        ops.finalize_if_registered_or_ambiguous();
        assert_wiped(&probe);
    }

    #[test]
    fn bounded_read_uses_the_requested_boolean_and_exact_secret_property() {
        let ops = leaked_fake(Boundary::None);
        let probe = Arc::new(WipeProbe::new());
        let pending = PendingSecret::with_probe(b"bounded".to_vec(), Arc::clone(&probe));
        let guarded = create_guarded_bounded_read_result_with(FAKE_ENV, pending, false, ops)
            .expect("guarded bounded read");
        assert_eq!(ops.boolean_requested(), Some(false));
        drop(guarded);
        assert_wiped(&probe);
        ops.finalize_if_registered_or_ambiguous();
    }

    #[test]
    fn dropping_an_unmarshalled_result_wipes_even_if_reference_is_retained() {
        let ops = leaked_fake(Boundary::None);
        let probe = Arc::new(WipeProbe::new());
        let pending = PendingSecret::with_probe(b"secret-value".to_vec(), Arc::clone(&probe));
        let guarded =
            create_guarded_loaded_result_with(FAKE_ENV, pending, ops).expect("guarded result");
        drop(guarded);
        assert_wiped(&probe);
        ops.finalize_if_registered_or_ambiguous();
    }
}
