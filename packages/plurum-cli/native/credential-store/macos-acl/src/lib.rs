#![cfg(target_os = "macos")]
#![deny(unsafe_op_in_unsafe_fn)]

use std::ffi::{c_int, c_void};
use std::io;
use std::os::fd::{AsRawFd, BorrowedFd};
use std::ptr::{self, NonNull};

const ACL_FIRST_ENTRY: c_int = 0;
const ACL_TYPE_EXTENDED: c_int = 0x0000_0100;
const INVALID_ARGUMENT: c_int = 22;
const NO_SUCH_FILE: c_int = 2;

type Acl = *mut c_void;
type AclEntry = *mut c_void;

extern "C" {
    fn acl_free(object: *mut c_void) -> c_int;
    fn acl_get_entry(acl: Acl, entry_id: c_int, entry: *mut AclEntry) -> c_int;
    fn acl_get_fd_np(fd: c_int, acl_type: c_int) -> Acl;
    fn acl_init(count: c_int) -> Acl;
    fn acl_set_fd_np(fd: c_int, acl: Acl, acl_type: c_int) -> c_int;
    fn acl_valid(acl: Acl) -> c_int;
}

struct OwnedAcl(NonNull<c_void>);

impl OwnedAcl {
    fn from_fd(fd: BorrowedFd<'_>) -> io::Result<Self> {
        // SAFETY: `fd` remains borrowed for the call, and the returned allocation
        // is either null or owned by the caller according to acl_get_fd_np(3).
        let acl = unsafe { acl_get_fd_np(fd.as_raw_fd(), ACL_TYPE_EXTENDED) };
        NonNull::new(acl)
            .map(Self)
            .ok_or_else(io::Error::last_os_error)
    }

    fn empty() -> io::Result<Self> {
        // SAFETY: acl_init(3) accepts a positive capacity and returns a caller-
        // owned allocation or null.
        let acl = unsafe { acl_init(1) };
        NonNull::new(acl)
            .map(Self)
            .ok_or_else(io::Error::last_os_error)
    }

    fn as_ptr(&self) -> Acl {
        self.0.as_ptr()
    }

    fn is_empty(&self) -> io::Result<bool> {
        // SAFETY: `self` owns a live ACL allocation.
        if unsafe { acl_valid(self.as_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }

        let mut entry = ptr::null_mut();
        // SAFETY: `entry` is valid output storage and `self` remains live.
        let result = unsafe { acl_get_entry(self.as_ptr(), ACL_FIRST_ENTRY, &mut entry) };
        if result == 0 {
            return Ok(false);
        }

        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(INVALID_ARGUMENT) {
            Ok(true)
        } else {
            Err(error)
        }
    }
}

impl Drop for OwnedAcl {
    fn drop(&mut self) {
        // SAFETY: this is the unique live allocation returned by an ACL API.
        let _ = unsafe { acl_free(self.as_ptr()) };
    }
}

/// Reports whether a retained macOS descriptor has no extended ACL entries.
pub fn extended_acl_is_empty(fd: BorrowedFd<'_>) -> io::Result<bool> {
    match OwnedAcl::from_fd(fd) {
        Ok(acl) => acl.is_empty(),
        Err(error) if error.raw_os_error() == Some(NO_SUCH_FILE) => Ok(true),
        Err(error) => Err(error),
    }
}

/// Removes inherited extended ACL entries and verifies the retained descriptor.
pub fn clear_extended_acl(fd: BorrowedFd<'_>) -> io::Result<()> {
    let empty = OwnedAcl::empty()?;
    // SAFETY: `fd` stays borrowed and `empty` owns a valid ACL allocation.
    if unsafe { acl_set_fd_np(fd.as_raw_fd(), empty.as_ptr(), ACL_TYPE_EXTENDED) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if extended_acl_is_empty(fd)? {
        Ok(())
    } else {
        Err(io::Error::other(
            "macOS extended ACL remained nonempty after clearing",
        ))
    }
}

#[cfg(feature = "test-support")]
mod test_support {
    use super::*;

    const ACL_EXTENDED_ALLOW: c_int = 1;
    const ACL_ENTRY_DIRECTORY_INHERIT: c_int = 1 << 6;
    const ACL_ENTRY_FILE_INHERIT: c_int = 1 << 5;
    const ACL_READ_DATA: c_int = 1 << 1;

    type AclFlagset = *mut c_void;
    type AclPermset = *mut c_void;

    extern "C" {
        fn acl_add_flag_np(flagset: AclFlagset, flag: c_int) -> c_int;
        fn acl_add_perm(permset: AclPermset, permission: c_int) -> c_int;
        fn acl_clear_flags_np(flagset: AclFlagset) -> c_int;
        fn acl_clear_perms(permset: AclPermset) -> c_int;
        fn acl_create_entry(acl: *mut Acl, entry: *mut AclEntry) -> c_int;
        fn acl_get_flagset_np(object: *mut c_void, flagset: *mut AclFlagset) -> c_int;
        fn acl_get_permset(entry: AclEntry, permset: *mut AclPermset) -> c_int;
        fn acl_set_qualifier(entry: AclEntry, qualifier: *const c_void) -> c_int;
        fn acl_set_tag_type(entry: AclEntry, tag: c_int) -> c_int;
        fn mbr_uid_to_uuid(uid: u32, uuid: *mut u8) -> c_int;
    }

    fn syscall_result(result: c_int) -> io::Result<()> {
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn install_current_user_read_acl_with_flags(
        fd: BorrowedFd<'_>,
        uid: u32,
        inherit: bool,
    ) -> io::Result<()> {
        let mut uuid = [0_u8; 16];
        // SAFETY: `uuid` has the exact writable size required by membership.h.
        syscall_result(unsafe { mbr_uid_to_uuid(uid, uuid.as_mut_ptr()) })?;

        let mut acl = OwnedAcl::empty()?;
        let mut acl_pointer = acl.as_ptr();
        let mut entry = ptr::null_mut();
        // SAFETY: both output pointers are valid; acl_create_entry may replace
        // the allocation stored in `acl_pointer`.
        syscall_result(unsafe { acl_create_entry(&mut acl_pointer, &mut entry) })?;
        acl.0 = NonNull::new(acl_pointer)
            .ok_or_else(|| io::Error::other("acl_create_entry returned a null ACL"))?;

        // SAFETY: `entry` belongs to `acl`, and the UUID remains live for the call.
        syscall_result(unsafe { acl_set_tag_type(entry, ACL_EXTENDED_ALLOW) })?;
        // SAFETY: `uuid` is the 16-byte qualifier required for a Darwin ACE.
        syscall_result(unsafe { acl_set_qualifier(entry, uuid.as_ptr().cast()) })?;

        let mut permissions = ptr::null_mut();
        // SAFETY: `permissions` is valid output storage for this live entry.
        syscall_result(unsafe { acl_get_permset(entry, &mut permissions) })?;
        // SAFETY: `permissions` belongs to the live entry.
        syscall_result(unsafe { acl_clear_perms(permissions) })?;
        // SAFETY: `ACL_READ_DATA` is a Darwin ACL permission constant.
        syscall_result(unsafe { acl_add_perm(permissions, ACL_READ_DATA) })?;

        let mut flags = ptr::null_mut();
        // SAFETY: `flags` is valid output storage for this live entry.
        syscall_result(unsafe { acl_get_flagset_np(entry, &mut flags) })?;
        // SAFETY: `flags` belongs to the live entry.
        syscall_result(unsafe { acl_clear_flags_np(flags) })?;
        if inherit {
            // SAFETY: both values are Darwin ACL inheritance constants.
            syscall_result(unsafe { acl_add_flag_np(flags, ACL_ENTRY_FILE_INHERIT) })?;
            // SAFETY: both values are Darwin ACL inheritance constants.
            syscall_result(unsafe { acl_add_flag_np(flags, ACL_ENTRY_DIRECTORY_INHERIT) })?;
        }

        // SAFETY: `acl` owns the complete test ACE assembled above.
        syscall_result(unsafe { acl_valid(acl.as_ptr()) })?;
        // SAFETY: the descriptor remains borrowed and `acl` is valid and live.
        syscall_result(unsafe { acl_set_fd_np(fd.as_raw_fd(), acl.as_ptr(), ACL_TYPE_EXTENDED) })?;
        if extended_acl_is_empty(fd)? {
            Err(io::Error::other("test ACL unexpectedly remained empty"))
        } else {
            Ok(())
        }
    }

    /// Installs one current-user read ACE for descriptor-only rejection tests.
    #[doc(hidden)]
    pub fn install_current_user_read_acl(fd: BorrowedFd<'_>, uid: u32) -> io::Result<()> {
        install_current_user_read_acl_with_flags(fd, uid, false)
    }

    /// Installs one inheritable current-user ACE for fresh-object tests.
    #[doc(hidden)]
    pub fn install_current_user_inheritable_read_acl(
        fd: BorrowedFd<'_>,
        uid: u32,
    ) -> io::Result<()> {
        install_current_user_read_acl_with_flags(fd, uid, true)
    }
}

#[cfg(feature = "test-support")]
pub use test_support::{install_current_user_inheritable_read_acl, install_current_user_read_acl};

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use std::env;
    use std::fs::{self, OpenOptions};
    use std::os::fd::AsFd;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::PathBuf;

    use super::*;

    const ISOLATION_MARKER: &str = "plurum-native-isolation-v1\n";

    struct TestFile {
        path: PathBuf,
    }

    impl TestFile {
        fn create() -> (Self, std::fs::File) {
            let configured = PathBuf::from(
                env::var_os("PLURUM_NATIVE_ISOLATION_ROOT")
                    .expect("PLURUM_NATIVE_ISOLATION_ROOT must be set"),
            );
            let root = configured
                .canonicalize()
                .expect("isolation root must canonicalize");
            assert_eq!(
                fs::read_to_string(root.join(".plurum-native-isolation"))
                    .expect("isolation marker must be readable"),
                ISOLATION_MARKER
            );
            let temporary = root
                .join("tmp")
                .canonicalize()
                .expect("isolated temporary directory must canonicalize");
            assert!(temporary.starts_with(&root));
            let path = temporary.join(format!("macos-acl-{}", std::process::id()));
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
                .expect("isolated ACL fixture must be created");
            (Self { path }, file)
        }
    }

    impl Drop for TestFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    #[test]
    fn descriptor_extended_acl_round_trip_distinguishes_empty_and_nonempty() {
        let (_fixture, file) = TestFile::create();
        assert!(
            OwnedAcl::empty()
                .expect("empty ACL must allocate")
                .is_empty()
                .expect("allocated empty ACL must be inspectable"),
            "acl_get_entry must report that acl_init produced no first entry"
        );
        assert!(
            extended_acl_is_empty(file.as_fd()).expect("fresh extended ACL must be inspectable")
        );

        let uid = libc_getuid();
        install_current_user_read_acl(file.as_fd(), uid)
            .expect("test extended ACE must be valid and installable");
        assert!(!extended_acl_is_empty(file.as_fd()).expect("installed ACL must be inspectable"));

        clear_extended_acl(file.as_fd()).expect("extended ACL must clear through the descriptor");
        assert!(
            extended_acl_is_empty(file.as_fd()).expect("cleared extended ACL must be inspectable")
        );
    }

    extern "C" {
        fn getuid() -> u32;
    }

    fn libc_getuid() -> u32 {
        // SAFETY: getuid(2) has no arguments and no failure mode.
        unsafe { getuid() }
    }
}
