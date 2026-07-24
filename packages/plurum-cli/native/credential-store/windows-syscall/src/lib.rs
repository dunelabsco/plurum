#![cfg(target_os = "windows")]
#![deny(unsafe_op_in_unsafe_fn)]

use std::ffi::c_void;
use std::fs::File;
use std::io;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle};
use std::path::Path;
use std::ptr::null_mut;

use windows_sys::Wdk::Storage::FileSystem::{
    FileRenameInformationEx, NtSetInformationFile, FILE_RENAME_INFORMATION,
    FILE_RENAME_INFORMATION_0, FILE_RENAME_POSIX_SEMANTICS, FILE_RENAME_REPLACE_IF_EXISTS,
};
#[cfg(feature = "test-support")]
use windows_sys::Win32::Foundation::GENERIC_WRITE;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, RtlNtStatusToDosError, ERROR_ALREADY_EXISTS,
    ERROR_FILE_EXISTS, ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER, ERROR_LOCK_VIOLATION,
    ERROR_NOT_SUPPORTED, ERROR_NO_TOKEN, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
#[cfg(feature = "test-support")]
use windows_sys::Win32::Security::Authorization::{SetSecurityInfo, SE_KERNEL_OBJECT};
use windows_sys::Win32::Security::{
    AclSizeInformation, AddAccessAllowedAceEx, EqualSid, GetAce, GetAclInformation, GetLengthSid,
    GetSecurityDescriptorControl, GetSecurityDescriptorLength, GetTokenInformation, InitializeAcl,
    InitializeSecurityDescriptor, IsValidAcl, IsValidSid, IsWellKnownSid,
    SetSecurityDescriptorControl, SetSecurityDescriptorDacl, SetSecurityDescriptorOwner,
    TokenIntegrityLevel, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid,
    WinMediumLabelSid, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION, ACL_SIZE_INFORMATION,
    CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, INHERITED_ACE, INHERIT_ONLY_ACE,
    LABEL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION, PSID,
    SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, SE_DACL_PROTECTED, SID, SYSTEM_MANDATORY_LABEL_ACE,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_USER,
};
#[cfg(feature = "test-support")]
use windows_sys::Win32::Security::{
    AddMandatoryAce, CreateWellKnownSid, SetTokenInformation, WinWorldSid,
    PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES,
    TOKEN_ADJUST_DEFAULT, UNPROTECTED_DACL_SECURITY_INFORMATION,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, FileDispositionInfoEx, FileIdInfo, FileStandardInfo,
    FlushFileBuffers, GetDriveTypeW, GetFileInformationByHandleEx, GetVolumeInformationByHandleW,
    LockFileEx, QueryDosDeviceW, SetFileInformationByHandle, UnlockFileEx, CREATE_NEW,
    FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL, FILE_DISPOSITION_FLAG_DELETE,
    FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_ID_INFO, FILE_STANDARD_INFO, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
};
#[cfg(feature = "test-support")]
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING, READ_CONTROL, WRITE_DAC, WRITE_OWNER,
};
#[cfg(feature = "test-support")]
use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
#[cfg(feature = "test-support")]
use windows_sys::Win32::System::SystemServices::IO_REPARSE_TAG_MOUNT_POINT;
use windows_sys::Win32::System::SystemServices::{
    ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE, FILE_PERSISTENT_ACLS, SE_GROUP_INTEGRITY,
    SE_GROUP_INTEGRITY_ENABLED, SYSTEM_MANDATORY_LABEL_ACE_TYPE,
    SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken,
};
#[cfg(feature = "test-support")]
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Win32::System::IO::{IO_STATUS_BLOCK, OVERLAPPED};

const DRIVE_FIXED: u32 = 3;
const SECURITY_DESCRIPTOR_REVISION: u32 = 1;
const DELETE_ACCESS: u32 = 0x0001_0000;
const WRITE_DACL_ACCESS: u32 = 0x0004_0000;
const WRITE_OWNER_ACCESS: u32 = 0x0008_0000;
const GENERIC_ALL_ACCESS: u32 = 0x1000_0000;
const FILE_DELETE_CHILD_ACCESS: u32 = 0x0000_0040;
const NAMESPACE_CONTROL_ACCESS: u32 = DELETE_ACCESS
    | WRITE_DACL_ACCESS
    | WRITE_OWNER_ACCESS
    | GENERIC_ALL_ACCESS
    | FILE_DELETE_CHILD_ACCESS;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorKind {
    Busy,
    Conflict,
    Unsafe,
    Unsupported,
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WinError {
    pub kind: ErrorKind,
    pub code: u32,
}

impl WinError {
    fn last(kind: ErrorKind) -> Self {
        // SAFETY: GetLastError has no preconditions and is read immediately after failure.
        let code = unsafe { GetLastError() };
        Self { kind, code }
    }

    fn code(kind: ErrorKind, code: u32) -> Self {
        Self { kind, code }
    }
}

impl std::fmt::Display for WinError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Windows error {}", self.code)
    }
}

impl std::error::Error for WinError {}

impl From<WinError> for io::Error {
    fn from(value: WinError) -> Self {
        io::Error::from_raw_os_error(value.code as i32)
    }
}

pub type Result<T> = std::result::Result<T, WinError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecurityKind {
    Directory,
    File,
}

impl SecurityKind {
    fn ace_flags(self) -> u8 {
        match self {
            Self::Directory => (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8,
            Self::File => 0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ProcessIdentity {
    sid_storage: Vec<usize>,
    sid_length: usize,
}

impl PartialEq for ProcessIdentity {
    fn eq(&self, other: &Self) -> bool {
        self.sid_bytes() == other.sid_bytes()
    }
}

impl Eq for ProcessIdentity {}

impl ProcessIdentity {
    pub fn capture() -> Result<Self> {
        Self::capture_with_integrity_requirement(true)
    }

    fn capture_with_integrity_requirement(require_exact_medium: bool) -> Result<Self> {
        ensure_no_impersonation()?;
        let token = OwnedHandle::current_process_token()?;
        if require_exact_medium && !token_integrity_is_exact_medium(token.0)? {
            return Err(WinError::code(ErrorKind::Unsafe, 5));
        }
        let (token_user, token_user_length) = token_information_storage(token.0, TokenUser)?;
        if token_user_length < size_of::<TOKEN_USER>() {
            return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
        }
        // SAFETY: token_user is the initialized output of GetTokenInformation(TokenUser),
        // and the API guarantees TOKEN_USER alignment and a SID valid for the buffer lifetime.
        let sid = unsafe { (*(token_user.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        let buffer_start = token_user.as_ptr() as usize;
        let buffer_end = buffer_start
            .checked_add(token_user_length)
            .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
        let sid_start = sid as usize;
        if sid_start < buffer_start || sid_start >= buffer_end {
            return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
        }
        // SAFETY: sid comes from a successful TokenUser result.
        if unsafe { IsValidSid(sid) } == 0 {
            return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
        }
        // SAFETY: sid was validated immediately above.
        let sid_length = unsafe { GetLengthSid(sid) } as usize;
        if sid_length == 0
            || sid_start
                .checked_add(sid_length)
                .is_none_or(|sid_end| sid_end > buffer_end)
        {
            return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
        }
        // SAFETY: GetLengthSid returned the readable SID byte count.
        let mut sid_storage = vec![0_usize; sid_length.div_ceil(size_of::<usize>())];
        // SAFETY: sid was range-checked and sid_storage is writable for sid_length bytes.
        unsafe {
            std::ptr::copy_nonoverlapping(
                sid.cast::<u8>(),
                sid_storage.as_mut_ptr().cast::<u8>(),
                sid_length,
            );
        }
        Ok(Self {
            sid_storage,
            sid_length,
        })
    }

    pub fn verify(&self) -> Result<()> {
        self.verify_with_integrity_requirement(true)
    }

    fn verify_with_integrity_requirement(&self, require_exact_medium: bool) -> Result<()> {
        let current = Self::capture_with_integrity_requirement(require_exact_medium)?;
        if current == *self {
            Ok(())
        } else {
            Err(WinError::code(ErrorKind::Other, 5))
        }
    }

    fn sid(&self) -> PSID {
        self.sid_storage.as_ptr().cast_mut().cast()
    }

    fn sid_bytes(&self) -> &[u8] {
        // SAFETY: sid_storage was sized to hold sid_length initialized SID bytes.
        unsafe {
            std::slice::from_raw_parts(self.sid_storage.as_ptr().cast::<u8>(), self.sid_length)
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SecurityAttestation {
    pub owner_current: bool,
    pub exact_protected_dacl: bool,
    pub semantic_medium_label: bool,
    pub descriptor: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VolumeAttestation {
    pub serial: u32,
    pub fixed_drive: bool,
    pub ntfs: bool,
    pub persistent_acls: bool,
    pub direct_volume_mapping: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FileIdentity {
    pub volume_serial: u64,
    pub file_id: [u8; 16],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FileStandardAttestation {
    pub links: u32,
    pub delete_pending: bool,
    pub directory: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LockAttempt {
    Acquired,
    Busy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MutationAttempt {
    Applied,
    Conflict,
    Unsupported,
}

pub enum FileCreateAttempt {
    Created(File),
    Conflict,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DirectoryCreateAttempt {
    Created,
    Conflict,
}

pub fn create_private_directory(
    path: &Path,
    process: &ProcessIdentity,
) -> Result<DirectoryCreateAttempt> {
    process.verify()?;
    let path = nul_terminated_path(path)?;
    with_private_security(process, SecurityKind::Directory, |attributes| {
        // SAFETY: path is NUL-terminated and attributes remains valid through the call.
        if unsafe { CreateDirectoryW(path.as_ptr(), attributes) } != 0 {
            return Ok(DirectoryCreateAttempt::Created);
        }
        let error = WinError::last(ErrorKind::Other);
        match error.code {
            ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS => Ok(DirectoryCreateAttempt::Conflict),
            _ => Err(error),
        }
    })
}

pub fn create_private_file(
    path: &Path,
    process: &ProcessIdentity,
    desired_access: u32,
    share_mode: u32,
) -> Result<FileCreateAttempt> {
    process.verify()?;
    let path = nul_terminated_path(path)?;
    with_private_security(process, SecurityKind::File, |attributes| {
        // SAFETY: all pointers remain valid through the call and CREATE_NEW never opens or
        // truncates an existing object.
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                desired_access,
                share_mode,
                attributes,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            // SAFETY: CreateFileW returned a new owned kernel handle.
            return Ok(FileCreateAttempt::Created(unsafe {
                File::from_raw_handle(handle as _)
            }));
        }
        let error = WinError::last(ErrorKind::Other);
        match error.code {
            ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS => Ok(FileCreateAttempt::Conflict),
            _ => Err(error),
        }
    })
}

fn with_private_security<T>(
    process: &ProcessIdentity,
    kind: SecurityKind,
    operation: impl FnOnce(*const SECURITY_ATTRIBUTES) -> Result<T>,
) -> Result<T> {
    let sid_length = process.sid_length;
    let ace_length = size_of::<ACCESS_ALLOWED_ACE>()
        .checked_sub(size_of::<u32>())
        .and_then(|base| base.checked_add(sid_length))
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let acl_length = size_of::<ACL>()
        .checked_add(ace_length)
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let acl_length_u32 = u32::try_from(acl_length)
        .map_err(|_| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let words = acl_length.div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; words];
    let acl = storage.as_mut_ptr().cast::<ACL>();

    // SAFETY: storage is aligned, writable, and at least acl_length bytes.
    if unsafe { InitializeAcl(acl, acl_length_u32, ACL_REVISION) } == 0 {
        return Err(WinError::last(ErrorKind::Other));
    }
    // SAFETY: acl is initialized and process.sid is a captured valid SID.
    if unsafe {
        AddAccessAllowedAceEx(
            acl,
            ACL_REVISION,
            kind.ace_flags() as u32,
            FILE_ALL_ACCESS,
            process.sid(),
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }

    let mut descriptor = SECURITY_DESCRIPTOR::default();
    // SAFETY: descriptor is writable and references remain live through operation.
    if unsafe {
        InitializeSecurityDescriptor(
            (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
            SECURITY_DESCRIPTOR_REVISION,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    // SAFETY: the captured process SID remains valid through operation.
    if unsafe {
        SetSecurityDescriptorOwner(
            (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
            process.sid(),
            0,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    // SAFETY: acl is initialized and remains valid through operation.
    if unsafe {
        SetSecurityDescriptorDacl(
            (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
            1,
            acl,
            0,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    // SAFETY: descriptor is initialized; this makes the explicit DACL non-inheriting.
    if unsafe {
        SetSecurityDescriptorControl(
            (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
            SE_DACL_PROTECTED,
            SE_DACL_PROTECTED,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
        bInheritHandle: 0,
    };
    operation(&attributes)
}

pub fn attest_security(
    handle: BorrowedHandle<'_>,
    process: &ProcessIdentity,
    kind: SecurityKind,
) -> Result<SecurityAttestation> {
    process.verify()?;
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut label_acl: *mut ACL = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: output pointers are valid and descriptor is released by DescriptorGuard.
    let status = unsafe {
        GetSecurityInfo(
            raw(handle),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            &mut label_acl,
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(WinError::code(ErrorKind::Other, status));
    }
    let descriptor = DescriptorGuard(descriptor);
    if descriptor.0.is_null() {
        return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
    }

    // SAFETY: pointers belong to the live security descriptor.
    let owner_current = !owner.is_null() && unsafe { EqualSid(owner, process.sid()) } != 0;
    let mut control = 0_u16;
    let mut revision = 0_u32;
    // SAFETY: descriptor is a valid self-relative security descriptor.
    let control_ok =
        unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } != 0;
    let protected = control_ok && control & SE_DACL_PROTECTED != 0;

    let mut acl_info = ACL_SIZE_INFORMATION::default();
    // SAFETY: dacl, when non-null, belongs to the live descriptor and output is sized exactly.
    let acl_ok = !dacl.is_null()
        // SAFETY: dacl belongs to the live descriptor.
        && unsafe { IsValidAcl(dacl) } != 0
        && unsafe {
            GetAclInformation(
                dacl,
                (&mut acl_info as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } != 0;
    let expected_ace_length = size_of::<ACCESS_ALLOWED_ACE>()
        .checked_sub(size_of::<u32>())
        .and_then(|base| base.checked_add(process.sid_length))
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let expected_acl_length = size_of::<ACL>()
        .checked_add(expected_ace_length)
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    // SAFETY: a successful GetAclInformation proves dacl points to a readable ACL header.
    let acl_header_exact = acl_ok
        && unsafe { (*dacl).AclRevision } as u32 == ACL_REVISION
        && unsafe { (*dacl).AclSize } as usize == expected_acl_length
        && unsafe { (*dacl).Sbz1 } == 0
        && unsafe { (*dacl).Sbz2 } == 0
        && acl_info.AclBytesInUse as usize == expected_acl_length
        && acl_info.AclBytesFree == 0;
    let mut exact_ace = false;
    if acl_header_exact && acl_info.AceCount == 1 {
        let mut ace: *mut c_void = null_mut();
        // SAFETY: the DACL reports exactly one ACE and the output pointer is valid.
        if unsafe { GetAce(dacl, 0, &mut ace) } != 0 && !ace.is_null() {
            // SAFETY: IsValidAcl plus GetAce proves a readable ACE_HEADER.
            let header = unsafe { &*(ace.cast::<ACE_HEADER>()) };
            if header.AceType == ACCESS_ALLOWED_ACE_TYPE as u8
                && header.AceFlags == kind.ace_flags()
                && header.AceSize as usize == expected_ace_length
                && header.AceFlags & INHERITED_ACE as u8 == 0
            {
                // SAFETY: the exact ACE size/type prove an ACCESS_ALLOWED_ACE with SID payload.
                let allowed = unsafe { &*(ace.cast::<ACCESS_ALLOWED_ACE>()) };
                let sid = (&allowed.SidStart as *const u32).cast_mut().cast();
                // SAFETY: ACCESS_ALLOWED_ACE stores a SID beginning at SidStart.
                exact_ace = allowed.Mask == FILE_ALL_ACCESS
                    && unsafe { IsValidSid(sid) } != 0
                    && unsafe { GetLengthSid(sid) } as usize == process.sid_length
                    && unsafe { EqualSid(sid, process.sid()) } != 0;
            }
        }
    }
    let semantic_medium_label = attest_semantic_medium_label(label_acl, kind)?;

    // SAFETY: descriptor is live and GetSecurityDescriptorLength reports its readable size.
    let descriptor_length = unsafe { GetSecurityDescriptorLength(descriptor.0) } as usize;
    if descriptor_length == 0 {
        return Err(WinError::last(ErrorKind::Other));
    }
    // SAFETY: the descriptor allocation is readable for the reported size.
    let descriptor_bytes =
        unsafe { std::slice::from_raw_parts(descriptor.0.cast::<u8>(), descriptor_length) }
            .to_vec();
    Ok(SecurityAttestation {
        owner_current,
        exact_protected_dacl: protected && exact_ace,
        semantic_medium_label,
        descriptor: descriptor_bytes,
    })
}

/// Returns whether no untrusted principal has authority to replace or retarget this directory.
///
/// Create-only sibling rights are intentionally not treated as replacement authority. Callers
/// retain no-delete handles for every traversed component, while this check rejects rights that
/// can delete a bound name or change the ACL/owner. Unknown ACE semantics fail closed.
pub fn attest_no_untrusted_namespace_control(
    handle: BorrowedHandle<'_>,
    process: &ProcessIdentity,
) -> Result<bool> {
    process.verify()?;
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: output pointers are valid and descriptor is released by DescriptorGuard.
    let status = unsafe {
        GetSecurityInfo(
            raw(handle),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(WinError::code(ErrorKind::Other, status));
    }
    let descriptor = DescriptorGuard(descriptor);
    if descriptor.0.is_null()
        || owner.is_null()
        // SAFETY: owner belongs to the live security descriptor.
        || unsafe { IsValidSid(owner) } == 0
        || !trusted_namespace_sid(owner, process)
        || dacl.is_null()
    {
        return Ok(false);
    }
    // SAFETY: dacl belongs to the live descriptor.
    if unsafe { IsValidAcl(dacl) } == 0 {
        return Ok(false);
    }
    let mut info = ACL_SIZE_INFORMATION::default();
    // SAFETY: dacl is a valid ACL and output is sized exactly.
    if unsafe {
        GetAclInformation(
            dacl,
            (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }

    for index in 0..info.AceCount {
        let mut ace: *mut c_void = null_mut();
        // SAFETY: index is bounded by the ACE count reported for the validated ACL.
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
            return Err(WinError::last(ErrorKind::Other));
        }
        // SAFETY: IsValidAcl plus GetAce proves a readable ACE_HEADER.
        let header = unsafe { &*(ace.cast::<ACE_HEADER>()) };
        if header.AceType == ACCESS_DENIED_ACE_TYPE as u8 {
            continue;
        }
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8 {
            return Ok(false);
        }
        if header.AceFlags & INHERIT_ONLY_ACE as u8 != 0 {
            continue;
        }

        let sid_offset = size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>();
        let sid_header_length = size_of::<SID>() - size_of::<u32>();
        let ace_length = header.AceSize as usize;
        if ace_length < sid_offset + sid_header_length {
            return Ok(false);
        }
        // SAFETY: the validated ACE type/size proves the fixed ACCESS_ALLOWED_ACE fields.
        let allowed = unsafe { &*(ace.cast::<ACCESS_ALLOWED_ACE>()) };
        if allowed.Mask & NAMESPACE_CONTROL_ACCESS == 0 {
            continue;
        }
        let sid: PSID = (&allowed.SidStart as *const u32).cast_mut().cast();
        // SAFETY: the range from SidStart through AceSize belongs to this validated ACE.
        let sid_bytes =
            unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), ace_length - sid_offset) };
        let sid_length = 8_usize
            .checked_add(usize::from(sid_bytes[1]).saturating_mul(size_of::<u32>()))
            .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
        if sid_length > sid_bytes.len()
            // SAFETY: the complete SID was range-checked within the ACE.
            || unsafe { IsValidSid(sid) } == 0
            // SAFETY: IsValidSid succeeded for the complete in-range SID.
            || unsafe { GetLengthSid(sid) } as usize != sid_length
        {
            return Ok(false);
        }
        if !trusted_namespace_sid(sid, process) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn trusted_namespace_sid(sid: PSID, process: &ProcessIdentity) -> bool {
    // SAFETY: callers supply a live valid SID and process.sid is captured and valid.
    (unsafe { EqualSid(sid, process.sid()) }) != 0
        // SAFETY: callers supply a live valid SID.
        || unsafe { IsWellKnownSid(sid, WinLocalSystemSid) } != 0
        // SAFETY: callers supply a live valid SID.
        || unsafe { IsWellKnownSid(sid, WinBuiltinAdministratorsSid) } != 0
}

fn attest_semantic_medium_label(label_acl: *mut ACL, kind: SecurityKind) -> Result<bool> {
    if label_acl.is_null() {
        // Windows assigns medium integrity semantics to an object with no mandatory label.
        return Ok(true);
    }
    // SAFETY: label_acl belongs to the live descriptor returned by GetSecurityInfo.
    if unsafe { IsValidAcl(label_acl) } == 0 {
        return Ok(false);
    }
    let mut info = ACL_SIZE_INFORMATION::default();
    // SAFETY: label_acl is a valid ACL and the output buffer is sized exactly.
    if unsafe {
        GetAclInformation(
            label_acl,
            (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    // SAFETY: IsValidAcl proves a readable ACL header.
    let header_exact = unsafe { (*label_acl).AclRevision } as u32 == ACL_REVISION
        && unsafe { (*label_acl).Sbz1 } == 0
        && unsafe { (*label_acl).Sbz2 } == 0
        && unsafe { (*label_acl).AclSize } as u32 == info.AclBytesInUse
        && info.AclBytesFree == 0;
    if !header_exact {
        return Ok(false);
    }
    if info.AceCount == 0 {
        return Ok(info.AclBytesInUse as usize == size_of::<ACL>());
    }
    if info.AceCount != 1 {
        return Ok(false);
    }

    let mut ace: *mut c_void = null_mut();
    // SAFETY: the validated label ACL reports exactly one ACE.
    if unsafe { GetAce(label_acl, 0, &mut ace) } == 0 || ace.is_null() {
        return Ok(false);
    }
    // SAFETY: IsValidAcl plus GetAce proves a readable ACE_HEADER.
    let header = unsafe { &*(ace.cast::<ACE_HEADER>()) };
    let permitted_flags = (INHERITED_ACE | OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8;
    let effective_flags = header.AceFlags & !(INHERITED_ACE as u8);
    if header.AceType != SYSTEM_MANDATORY_LABEL_ACE_TYPE as u8
        || header.AceFlags & !permitted_flags != 0
        || (effective_flags != 0 && effective_flags != kind.ace_flags())
    {
        return Ok(false);
    }
    let ace_length = header.AceSize as usize;
    let sid_offset = size_of::<SYSTEM_MANDATORY_LABEL_ACE>() - size_of::<u32>();
    if ace_length < sid_offset + size_of::<SID>() {
        return Ok(false);
    }
    // SAFETY: the exact ACE type and validated header make the fixed portion readable.
    let label = unsafe { &*(ace.cast::<SYSTEM_MANDATORY_LABEL_ACE>()) };
    let sid = (&label.SidStart as *const u32).cast_mut().cast();
    // SAFETY: SYSTEM_MANDATORY_LABEL_ACE stores a SID beginning at SidStart.
    if unsafe { IsValidSid(sid) } == 0 {
        return Ok(false);
    }
    // SAFETY: sid was validated immediately above.
    let sid_length = unsafe { GetLengthSid(sid) } as usize;
    let expected_ace_length = sid_offset
        .checked_add(sid_length)
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let expected_acl_length = size_of::<ACL>()
        .checked_add(expected_ace_length)
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    // SAFETY: sid was validated and is contained by the validated ACE.
    Ok(ace_length == expected_ace_length
        && info.AclBytesInUse as usize == expected_acl_length
        && label.Mask == SYSTEM_MANDATORY_LABEL_NO_WRITE_UP
        && unsafe { IsWellKnownSid(sid, WinMediumLabelSid) } != 0)
}

pub fn attest_local_ntfs(
    handle: BorrowedHandle<'_>,
    drive_root: &[u16],
) -> Result<VolumeAttestation> {
    if drive_root.last().copied() != Some(0) {
        return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
    }
    // SAFETY: drive_root is explicitly NUL-terminated.
    let drive_type = unsafe { GetDriveTypeW(drive_root.as_ptr()) };
    let mut serial = 0_u32;
    let mut flags = 0_u32;
    let mut filesystem = [0_u16; 16];
    // SAFETY: all output buffers are valid for their declared lengths.
    if unsafe {
        GetVolumeInformationByHandleW(
            raw(handle),
            null_mut(),
            0,
            &mut serial,
            null_mut(),
            &mut flags,
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    let filesystem_end = filesystem
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(filesystem.len());
    let filesystem = String::from_utf16_lossy(&filesystem[..filesystem_end]);
    let drive_name = [drive_root[0], b':' as u16, 0];
    let mut device_target = [0_u16; 1_024];
    // SAFETY: drive_name and target buffer are valid and NUL-terminated/sized respectively.
    let target_length = unsafe {
        QueryDosDeviceW(
            drive_name.as_ptr(),
            device_target.as_mut_ptr(),
            device_target.len() as u32,
        )
    };
    if target_length == 0 {
        return Err(WinError::last(ErrorKind::Other));
    }
    let first_target_end = device_target
        .iter()
        .take(target_length as usize)
        .position(|value| *value == 0)
        .unwrap_or(target_length as usize);
    let target = String::from_utf16_lossy(&device_target[..first_target_end]);
    let direct_volume_mapping =
        target
            .strip_prefix(r"\Device\HarddiskVolume")
            .is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
            });
    Ok(VolumeAttestation {
        serial,
        fixed_drive: drive_type == DRIVE_FIXED,
        ntfs: filesystem.eq_ignore_ascii_case("NTFS"),
        persistent_acls: flags & FILE_PERSISTENT_ACLS != 0,
        direct_volume_mapping,
    })
}

pub fn file_identity(handle: BorrowedHandle<'_>) -> Result<FileIdentity> {
    let mut info = FILE_ID_INFO::default();
    // SAFETY: info is exactly the documented output structure for FileIdInfo.
    if unsafe {
        GetFileInformationByHandleEx(
            raw(handle),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    Ok(FileIdentity {
        volume_serial: info.VolumeSerialNumber,
        file_id: info.FileId.Identifier,
    })
}

pub fn file_standard(handle: BorrowedHandle<'_>) -> Result<FileStandardAttestation> {
    let mut info = FILE_STANDARD_INFO::default();
    // SAFETY: info is exactly the documented output structure for FileStandardInfo.
    if unsafe {
        GetFileInformationByHandleEx(
            raw(handle),
            FileStandardInfo,
            (&mut info as *mut FILE_STANDARD_INFO).cast(),
            size_of::<FILE_STANDARD_INFO>() as u32,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    Ok(FileStandardAttestation {
        links: info.NumberOfLinks,
        delete_pending: info.DeletePending,
        directory: info.Directory,
    })
}

pub fn try_lock_exclusive(handle: BorrowedHandle<'_>) -> Result<LockAttempt> {
    let mut overlapped = OVERLAPPED::default();
    // SAFETY: handle is live, overlapped is valid for the synchronous call, and the locked
    // range is fixed for all Plurum participants.
    if unsafe {
        LockFileEx(
            raw(handle),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    } != 0
    {
        return Ok(LockAttempt::Acquired);
    }
    let error = WinError::last(ErrorKind::Other);
    if error.code == ERROR_LOCK_VIOLATION {
        Ok(LockAttempt::Busy)
    } else {
        Err(error)
    }
}

pub fn unlock(handle: BorrowedHandle<'_>) -> Result<()> {
    let mut overlapped = OVERLAPPED::default();
    // SAFETY: this uses the same handle, range, and offset as try_lock_exclusive.
    if unsafe { UnlockFileEx(raw(handle), 0, u32::MAX, u32::MAX, &mut overlapped) } != 0 {
        Ok(())
    } else {
        Err(WinError::last(ErrorKind::Other))
    }
}

pub fn flush_file(handle: BorrowedHandle<'_>) -> Result<()> {
    // SAFETY: handle is live and opened for data synchronization.
    if unsafe { FlushFileBuffers(raw(handle)) } != 0 {
        Ok(())
    } else {
        Err(WinError::last(ErrorKind::Other))
    }
}

pub fn rename_by_handle(
    source: BorrowedHandle<'_>,
    destination_directory: BorrowedHandle<'_>,
    destination_name: &[u16],
    replace: bool,
) -> Result<MutationAttempt> {
    if destination_name.is_empty()
        || destination_name.iter().any(|value| {
            *value == 0 || *value == b'\\' as u16 || *value == b'/' as u16 || *value == b':' as u16
        })
    {
        return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
    }
    let name_bytes = destination_name
        .len()
        .checked_mul(size_of::<u16>())
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let buffer_length = size_of::<FILE_RENAME_INFORMATION>()
        .checked_add(name_bytes)
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let words = buffer_length.div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; words];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    // SAFETY: storage is aligned and large enough for the variable-length structure.
    unsafe {
        (*info).Anonymous = FILE_RENAME_INFORMATION_0 {
            Flags: FILE_RENAME_POSIX_SEMANTICS
                | if replace {
                    FILE_RENAME_REPLACE_IF_EXISTS
                } else {
                    0
                },
        };
        (*info).RootDirectory = raw(destination_directory);
        (*info).FileNameLength = name_bytes as u32;
        std::ptr::copy_nonoverlapping(
            destination_name.as_ptr(),
            (*info).FileName.as_mut_ptr(),
            destination_name.len(),
        );
    }
    let mut io_status = IO_STATUS_BLOCK::default();
    // SAFETY: info is a complete variable-length FILE_RENAME_INFORMATION, RootDirectory is
    // retained and live, and source is opened synchronously.
    let status = unsafe {
        NtSetInformationFile(
            raw(source),
            &mut io_status,
            info.cast(),
            buffer_length as u32,
            FileRenameInformationEx,
        )
    };
    if status >= 0 {
        return Ok(MutationAttempt::Applied);
    }
    // SAFETY: conversion is defined for every failing NTSTATUS.
    let error = unsafe { RtlNtStatusToDosError(status) };
    classify_mutation_code(error)
}

pub fn remove_by_handle(handle: BorrowedHandle<'_>) -> Result<MutationAttempt> {
    let info = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    };
    // SAFETY: info has the exact representation and lifetime required for the call.
    if unsafe {
        SetFileInformationByHandle(
            raw(handle),
            FileDispositionInfoEx,
            (&info as *const FILE_DISPOSITION_INFO_EX).cast(),
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    } != 0
    {
        return Ok(MutationAttempt::Applied);
    }
    classify_mutation_error()
}

fn classify_mutation_error() -> Result<MutationAttempt> {
    let error = WinError::last(ErrorKind::Unsafe);
    classify_mutation_code(error.code)
}

fn classify_mutation_code(code: u32) -> Result<MutationAttempt> {
    match code {
        ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS => Ok(MutationAttempt::Conflict),
        ERROR_INVALID_FUNCTION | ERROR_INVALID_PARAMETER | ERROR_NOT_SUPPORTED => {
            Ok(MutationAttempt::Unsupported)
        }
        _ => Err(WinError::code(ErrorKind::Other, code)),
    }
}

fn raw(handle: BorrowedHandle<'_>) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

fn ensure_no_impersonation() -> Result<()> {
    let mut token = null_mut();
    // SAFETY: output pointer is valid and the pseudo-thread handle is not owned.
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) } != 0 {
        if !token.is_null() {
            // SAFETY: OpenThreadToken returned a new owned handle.
            unsafe {
                CloseHandle(token);
            }
        }
        return Err(WinError::code(ErrorKind::Unsafe, 5));
    }
    let error = WinError::last(ErrorKind::Unsafe);
    if error.code == ERROR_NO_TOKEN {
        Ok(())
    } else {
        Err(error)
    }
}

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn current_process_token() -> Result<Self> {
        Self::process_token(TOKEN_QUERY)
    }

    fn process_token(access: u32) -> Result<Self> {
        let mut handle = null_mut();
        // SAFETY: output pointer is valid and the pseudo-process handle needs no ownership.
        if unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut handle) } == 0 {
            Err(WinError::last(ErrorKind::Other))
        } else {
            Ok(Self(handle))
        }
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: self exclusively owns the real token handle.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct DescriptorGuard(windows_sys::Win32::Security::PSECURITY_DESCRIPTOR);

impl Drop for DescriptorGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: GetSecurityInfo allocates the descriptor with LocalAlloc.
            unsafe {
                LocalFree(self.0.cast());
            }
        }
    }
}

fn token_information_storage(handle: HANDLE, class: i32) -> Result<(Vec<usize>, usize)> {
    let mut required = 0_u32;
    // SAFETY: the zero-length probe intentionally supplies a null output buffer.
    unsafe {
        GetTokenInformation(handle, class, null_mut(), 0, &mut required);
    }
    if required == 0 {
        return Err(WinError::last(ErrorKind::Other));
    }
    let words = (required as usize).div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; words];
    let mut actual = required;
    // SAFETY: aligned storage is writable for at least required bytes.
    if unsafe {
        GetTokenInformation(
            handle,
            class,
            storage.as_mut_ptr().cast(),
            required,
            &mut actual,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    if actual > required {
        return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
    }
    Ok((storage, actual as usize))
}

fn token_integrity_is_exact_medium(handle: HANDLE) -> Result<bool> {
    let (storage, length) = token_information_storage(handle, TokenIntegrityLevel)?;
    if length < size_of::<TOKEN_MANDATORY_LABEL>() {
        return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
    }
    // SAFETY: storage is aligned and contains a successful TokenIntegrityLevel result.
    let label = unsafe { &*(storage.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()) };
    let sid = label.Label.Sid;
    let start = storage.as_ptr() as usize;
    let end = start
        .checked_add(length)
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let sid_start = sid as usize;
    if sid_start < start
        || sid_start
            .checked_add(size_of::<SID>())
            .is_none_or(|sid_header_end| sid_header_end > end)
    {
        return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
    }
    // SAFETY: the fixed SID header was range-checked within the token buffer.
    if unsafe { IsValidSid(sid) } == 0 {
        return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
    }
    // SAFETY: sid was validated immediately above.
    let sid_length = unsafe { GetLengthSid(sid) } as usize;
    if sid_start
        .checked_add(sid_length)
        .is_none_or(|sid_end| sid_end > end)
    {
        return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
    }
    // SAFETY: the complete validated SID lies within the token buffer.
    Ok(
        label.Label.Attributes == (SE_GROUP_INTEGRITY | SE_GROUP_INTEGRITY_ENABLED) as u32
            && unsafe { IsWellKnownSid(sid, WinMediumLabelSid) } != 0,
    )
}

#[cfg(feature = "test-support")]
pub fn lower_process_integrity_to_medium_for_tests() -> Result<()> {
    ensure_no_impersonation()?;
    let token = OwnedHandle::process_token(TOKEN_QUERY | TOKEN_ADJUST_DEFAULT)?;
    // SAFETY: GetCurrentProcess returns a non-owning pseudo-handle valid in this process.
    let process = unsafe { GetCurrentProcess() };
    set_and_attest_medium_label(process, SE_KERNEL_OBJECT, 0, SecurityKind::File)?;
    if token_integrity_is_exact_medium(token.0)? {
        return Ok(());
    }

    let mut sid_storage =
        vec![0_usize; (SECURITY_MAX_SID_SIZE as usize).div_ceil(size_of::<usize>())];
    let mut sid_length = SECURITY_MAX_SID_SIZE;
    let sid = sid_storage.as_mut_ptr().cast();
    // SAFETY: sid_storage is aligned and writable for SECURITY_MAX_SID_SIZE bytes.
    if unsafe { CreateWellKnownSid(WinMediumLabelSid, null_mut(), sid, &mut sid_length) } == 0 {
        return Err(WinError::last(ErrorKind::Other));
    }
    if sid_length == 0 || sid_length > SECURITY_MAX_SID_SIZE {
        return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
    }
    let label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: sid,
            Attributes: SE_GROUP_INTEGRITY as u32,
        },
    };
    let information_length = size_of::<TOKEN_MANDATORY_LABEL>()
        .checked_add(sid_length as usize)
        .and_then(|length| u32::try_from(length).ok())
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    // SAFETY: token has TOKEN_ADJUST_DEFAULT, label points to a live well-known SID, and
    // information_length covers both the fixed label and its SID.
    if unsafe {
        SetTokenInformation(
            token.0,
            TokenIntegrityLevel,
            (&label as *const TOKEN_MANDATORY_LABEL).cast(),
            information_length,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    if token_integrity_is_exact_medium(token.0)?
        && attest_handle_medium_label(process, SE_KERNEL_OBJECT, SecurityKind::File)?
    {
        Ok(())
    } else {
        Err(WinError::code(ErrorKind::Unsafe, 5))
    }
}

#[cfg(feature = "test-support")]
pub fn prepare_medium_integrity_test_directory(path: &Path) -> Result<()> {
    let path = nul_terminated_path(path)?;
    // SAFETY: path is NUL-terminated; no security attributes or template handle are supplied.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            READ_CONTROL | WRITE_OWNER,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(WinError::last(ErrorKind::Other));
    }
    let handle = OwnedHandle(handle);
    prepare_medium_integrity_test_directory_handle(
        // SAFETY: handle remains live for the duration of the borrowed call.
        unsafe { BorrowedHandle::borrow_raw(handle.0.cast()) },
    )
}

#[cfg(feature = "test-support")]
pub fn prepare_medium_integrity_test_directory_handle(handle: BorrowedHandle<'_>) -> Result<()> {
    prepare_current_user_test_owner_handle(handle)?;
    let process = ProcessIdentity::capture_with_integrity_requirement(false)?;
    if !attest_handle_medium_label(raw(handle), SE_FILE_OBJECT, SecurityKind::Directory)? {
        // Avoid rewriting already-valid medium semantics: SetSecurityInfo
        // propagates SACL changes to descendants and advances NTFS ChangeTime.
        set_and_attest_medium_label(
            raw(handle),
            SE_FILE_OBJECT,
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
            SecurityKind::Directory,
        )?;
    }
    process.verify_with_integrity_requirement(false)?;
    if test_handle_owner_state(handle, &process)? == TestHandleOwner::Current
        && attest_handle_medium_label(raw(handle), SE_FILE_OBJECT, SecurityKind::Directory)?
    {
        Ok(())
    } else {
        Err(WinError::code(ErrorKind::Unsafe, 5))
    }
}

#[cfg(feature = "test-support")]
pub fn prepare_current_user_test_owner_handle(handle: BorrowedHandle<'_>) -> Result<()> {
    let process = ProcessIdentity::capture_with_integrity_requirement(false)?;
    match test_handle_owner_state(handle, &process)? {
        TestHandleOwner::Current => {}
        TestHandleOwner::Trusted => {
            // SAFETY: handle has WRITE_OWNER and process.sid is the live current token user SID.
            let status = unsafe {
                SetSecurityInfo(
                    raw(handle),
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION,
                    process.sid(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                )
            };
            if status != 0 {
                return Err(WinError::code(ErrorKind::Other, status));
            }
        }
        TestHandleOwner::Untrusted => return Err(WinError::code(ErrorKind::Unsafe, 5)),
    }
    process.verify_with_integrity_requirement(false)?;
    if test_handle_owner_state(handle, &process)? == TestHandleOwner::Current {
        Ok(())
    } else {
        Err(WinError::code(ErrorKind::Unsafe, 5))
    }
}

#[cfg(feature = "test-support")]
#[derive(Clone, Copy, Eq, PartialEq)]
enum TestHandleOwner {
    Current,
    Trusted,
    Untrusted,
}

#[cfg(feature = "test-support")]
fn test_handle_owner_state(
    handle: BorrowedHandle<'_>,
    process: &ProcessIdentity,
) -> Result<TestHandleOwner> {
    let mut owner: PSID = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: output pointers are valid and descriptor is released by DescriptorGuard.
    let status = unsafe {
        GetSecurityInfo(
            raw(handle),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(WinError::code(ErrorKind::Other, status));
    }
    let descriptor = DescriptorGuard(descriptor);
    if descriptor.0.is_null() {
        return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
    }
    if owner.is_null()
        // SAFETY: a non-null owner belongs to the live descriptor.
        || unsafe { IsValidSid(owner) } == 0
    {
        return Ok(TestHandleOwner::Untrusted);
    }
    // SAFETY: owner and the captured process SID are both valid.
    if unsafe { EqualSid(owner, process.sid()) } != 0 {
        Ok(TestHandleOwner::Current)
    } else if trusted_namespace_sid(owner, process) {
        Ok(TestHandleOwner::Trusted)
    } else {
        Ok(TestHandleOwner::Untrusted)
    }
}

#[cfg(feature = "test-support")]
fn set_and_attest_medium_label(
    handle: HANDLE,
    object_type: i32,
    ace_flags: u32,
    kind: SecurityKind,
) -> Result<()> {
    let mut sid_storage =
        vec![0_usize; (SECURITY_MAX_SID_SIZE as usize).div_ceil(size_of::<usize>())];
    let mut sid_length = SECURITY_MAX_SID_SIZE;
    let sid = sid_storage.as_mut_ptr().cast();
    // SAFETY: sid_storage is aligned and writable for SECURITY_MAX_SID_SIZE bytes.
    if unsafe { CreateWellKnownSid(WinMediumLabelSid, null_mut(), sid, &mut sid_length) } == 0 {
        return Err(WinError::last(ErrorKind::Other));
    }
    let ace_length = size_of::<SYSTEM_MANDATORY_LABEL_ACE>()
        .checked_sub(size_of::<u32>())
        .and_then(|base| base.checked_add(sid_length as usize))
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let acl_length = size_of::<ACL>()
        .checked_add(ace_length)
        .and_then(|length| u32::try_from(length).ok())
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let mut acl_storage = vec![0_usize; (acl_length as usize).div_ceil(size_of::<usize>())];
    let acl = acl_storage.as_mut_ptr().cast::<ACL>();
    // SAFETY: acl_storage is aligned and writable for acl_length bytes.
    if unsafe { InitializeAcl(acl, acl_length, ACL_REVISION) } == 0 {
        return Err(WinError::last(ErrorKind::Other));
    }
    // SAFETY: acl is initialized with sufficient exact space and sid is a live well-known SID.
    if unsafe {
        AddMandatoryAce(
            acl,
            ACL_REVISION,
            ace_flags,
            SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
            sid,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    // SAFETY: handle has WRITE_OWNER; acl is a live initialized mandatory-label ACL.
    let status = unsafe {
        SetSecurityInfo(
            handle,
            object_type,
            LABEL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            acl,
        )
    };
    if status != 0 {
        return Err(WinError::code(ErrorKind::Other, status));
    }
    if attest_handle_medium_label(handle, object_type, kind)? {
        Ok(())
    } else {
        Err(WinError::code(ErrorKind::Unsafe, 5))
    }
}

#[cfg(feature = "test-support")]
fn attest_handle_medium_label(
    handle: HANDLE,
    object_type: i32,
    kind: SecurityKind,
) -> Result<bool> {
    let mut label_acl: *mut ACL = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: output pointers are valid and descriptor is released by DescriptorGuard.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            object_type,
            LABEL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut label_acl,
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(WinError::code(ErrorKind::Other, status));
    }
    let descriptor = DescriptorGuard(descriptor);
    if descriptor.0.is_null() {
        return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
    }
    attest_semantic_medium_label(label_acl, kind)
}

#[cfg(feature = "test-support")]
pub fn set_broad_dacl_for_tests(path: &Path, kind: SecurityKind) -> Result<()> {
    set_test_dacl(path, kind, true, true)
}

#[cfg(feature = "test-support")]
pub fn set_inherited_current_user_dacl_for_tests(path: &Path, kind: SecurityKind) -> Result<()> {
    set_test_dacl(path, kind, false, false)
}

#[cfg(feature = "test-support")]
pub fn set_private_current_user_dacl_for_tests(path: &Path, kind: SecurityKind) -> Result<()> {
    set_test_dacl(path, kind, false, true)
}

#[cfg(feature = "test-support")]
pub fn set_private_current_user_dacl_for_tests_handle(
    handle: BorrowedHandle<'_>,
    kind: SecurityKind,
) -> Result<()> {
    let process = ProcessIdentity::capture()?;
    set_test_dacl_handle(handle, kind, false, true, &process)
}

#[cfg(feature = "test-support")]
fn set_test_dacl(path: &Path, kind: SecurityKind, broad: bool, protected: bool) -> Result<()> {
    let process = ProcessIdentity::capture()?;
    let handle = open_test_object(path, kind, READ_CONTROL | WRITE_DAC)?;
    set_test_dacl_handle(
        // SAFETY: handle remains live for the duration of the borrowed call.
        unsafe { BorrowedHandle::borrow_raw(handle.0.cast()) },
        kind,
        broad,
        protected,
        &process,
    )
}

#[cfg(feature = "test-support")]
fn set_test_dacl_handle(
    handle: BorrowedHandle<'_>,
    kind: SecurityKind,
    broad: bool,
    protected: bool,
    process: &ProcessIdentity,
) -> Result<()> {
    let mut sid_storage =
        vec![0_usize; (SECURITY_MAX_SID_SIZE as usize).div_ceil(size_of::<usize>())];
    let sid = if broad {
        let mut sid_length = SECURITY_MAX_SID_SIZE;
        let sid = sid_storage.as_mut_ptr().cast();
        // SAFETY: sid_storage is aligned and writable for SECURITY_MAX_SID_SIZE bytes.
        if unsafe { CreateWellKnownSid(WinWorldSid, null_mut(), sid, &mut sid_length) } == 0 {
            return Err(WinError::last(ErrorKind::Other));
        }
        sid
    } else {
        process.sid()
    };
    // SAFETY: either CreateWellKnownSid succeeded or sid belongs to process for this scope.
    let sid_length = unsafe { GetLengthSid(sid) } as usize;
    let ace_length = size_of::<ACCESS_ALLOWED_ACE>()
        .checked_sub(size_of::<u32>())
        .and_then(|base| base.checked_add(sid_length))
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let acl_length = size_of::<ACL>()
        .checked_add(ace_length)
        .and_then(|length| u32::try_from(length).ok())
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let mut acl_storage = vec![0_usize; (acl_length as usize).div_ceil(size_of::<usize>())];
    let acl = acl_storage.as_mut_ptr().cast::<ACL>();
    // SAFETY: acl_storage is aligned and writable for acl_length bytes.
    if unsafe { InitializeAcl(acl, acl_length, ACL_REVISION) } == 0 {
        return Err(WinError::last(ErrorKind::Other));
    }
    let ace_flags = kind.ace_flags();
    // SAFETY: acl is initialized with exact space and sid is valid for the call.
    if unsafe {
        AddAccessAllowedAceEx(
            acl,
            ACL_REVISION,
            u32::from(ace_flags),
            FILE_ALL_ACCESS,
            sid,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    // SAFETY: handle has WRITE_DAC and acl is initialized and live for the call.
    let status = unsafe {
        SetSecurityInfo(
            raw(handle),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION
                | if protected {
                    PROTECTED_DACL_SECURITY_INFORMATION
                } else {
                    UNPROTECTED_DACL_SECURITY_INFORMATION
                },
            null_mut(),
            null_mut(),
            acl,
            null_mut(),
        )
    };
    if status != 0 {
        return Err(WinError::code(ErrorKind::Other, status));
    }
    let security = attest_security(handle, process, kind)?;
    if security.owner_current
        && security.exact_protected_dacl == (!broad && protected)
        && security.semantic_medium_label
    {
        Ok(())
    } else {
        Err(WinError::code(ErrorKind::Unsafe, 5))
    }
}

#[cfg(feature = "test-support")]
pub fn try_set_wrong_owner_for_tests(path: &Path, kind: SecurityKind) -> Result<bool> {
    let process = ProcessIdentity::capture()?;
    let handle = open_test_object(path, kind, READ_CONTROL | WRITE_OWNER)?;
    let mut sid_storage =
        vec![0_usize; (SECURITY_MAX_SID_SIZE as usize).div_ceil(size_of::<usize>())];
    let mut sid_length = SECURITY_MAX_SID_SIZE;
    let sid = sid_storage.as_mut_ptr().cast();
    // SAFETY: sid_storage is aligned and writable for SECURITY_MAX_SID_SIZE bytes.
    if unsafe {
        CreateWellKnownSid(
            WinBuiltinAdministratorsSid,
            null_mut(),
            sid,
            &mut sid_length,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    // SAFETY: handle has WRITE_OWNER and sid is a live well-known SID.
    let status = unsafe {
        SetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            sid,
            null_mut(),
            null_mut(),
            null_mut(),
        )
    };
    if matches!(status, 5 | 1_307) {
        return Ok(false);
    }
    if status != 0 {
        return Err(WinError::code(ErrorKind::Other, status));
    }
    let security = attest_security(
        // SAFETY: handle remains live and is not mutably aliased by BorrowedHandle.
        unsafe { BorrowedHandle::borrow_raw(handle.0.cast()) },
        &process,
        kind,
    )?;
    Ok(!security.owner_current)
}

#[cfg(feature = "test-support")]
fn open_test_object(path: &Path, kind: SecurityKind, access: u32) -> Result<OwnedHandle> {
    let path = nul_terminated_path(path)?;
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if kind == SecurityKind::Directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            0
        };
    // SAFETY: path is NUL-terminated; no security attributes or template handle are supplied.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null_mut(),
            OPEN_EXISTING,
            flags,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(WinError::last(ErrorKind::Other))
    } else {
        Ok(OwnedHandle(handle))
    }
}

#[cfg(feature = "test-support")]
pub fn try_create_junction_for_tests(junction: &Path, target: &Path) -> Result<bool> {
    if !target.is_absolute() {
        return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
    }
    let target_text = target
        .to_str()
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    if target_text.contains(['/', '\0']) {
        return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
    }
    let substitute: Vec<u16> = format!(r"\??\{target_text}").encode_utf16().collect();
    let print: Vec<u16> = target_text.encode_utf16().collect();
    let substitute_bytes = substitute
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let print_bytes = print
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let print_offset = substitute_bytes
        .checked_add(size_of::<u16>() as u16)
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let path_words = substitute
        .len()
        .checked_add(1)
        .and_then(|length| length.checked_add(print.len()))
        .and_then(|length| length.checked_add(1))
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let path_bytes = path_words
        .checked_mul(size_of::<u16>())
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let reparse_data_length = 8_usize
        .checked_add(path_bytes)
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let total_length = 8_usize
        .checked_add(reparse_data_length as usize)
        .ok_or_else(|| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let mut buffer = vec![0_u8; total_length];
    buffer[0..4].copy_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer[4..6].copy_from_slice(&reparse_data_length.to_le_bytes());
    buffer[8..10].copy_from_slice(&0_u16.to_le_bytes());
    buffer[10..12].copy_from_slice(&substitute_bytes.to_le_bytes());
    buffer[12..14].copy_from_slice(&print_offset.to_le_bytes());
    buffer[14..16].copy_from_slice(&print_bytes.to_le_bytes());
    for (index, word) in substitute
        .iter()
        .chain(std::iter::once(&0))
        .chain(print.iter())
        .chain(std::iter::once(&0))
        .enumerate()
    {
        let offset = 16 + index * size_of::<u16>();
        buffer[offset..offset + 2].copy_from_slice(&word.to_le_bytes());
    }

    let handle = open_test_object(junction, SecurityKind::Directory, GENERIC_WRITE)?;
    let input_length = u32::try_from(buffer.len())
        .map_err(|_| WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER))?;
    let mut returned = 0_u32;
    // SAFETY: handle is a live directory opened for write; buffer is initialized for its full
    // declared length; no output buffer or overlapped operation is requested.
    if unsafe {
        DeviceIoControl(
            handle.0,
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr().cast(),
            input_length,
            null_mut(),
            0,
            &mut returned,
            null_mut(),
        )
    } == 0
    {
        let error = WinError::last(ErrorKind::Other);
        if matches!(error.code, 5 | 50 | 1_314) {
            return Ok(false);
        }
        return Err(error);
    }
    Ok(true)
}

fn nul_terminated_path(path: &Path) -> Result<Vec<u16>> {
    let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
    if value.is_empty() || value.contains(&0) {
        return Err(WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER));
    }
    value.push(0);
    Ok(value)
}
