use std::cmp::Ordering;
use std::ffi::{c_void, OsString};
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path};
use std::ptr::{null, null_mut};
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, SetHandleInformation, ERROR_BROKEN_PIPE,
    ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_PARAMETER, ERROR_NO_DATA, GENERIC_READ, HANDLE,
    HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Globalization::{
    CompareStringOrdinal, CSTR_EQUAL, CSTR_GREATER_THAN, CSTR_LESS_THAN,
};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{
    AclSizeInformation, GetAce, GetAclInformation, GetLengthSid, IsValidAcl, IsValidSid,
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
    INHERIT_ONLY_ACE, OWNER_SECURITY_INFORMATION, PSID, SECURITY_ATTRIBUTES, SID,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_WRITE_DATA, OPEN_EXISTING,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_LIMIT_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::{CreatePipe, PeekNamedPipe};
use windows_sys::Win32::System::SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
};

use super::{
    file_identity, file_standard, trusted_namespace_sid, ErrorKind, FileIdentity, ProcessIdentity,
    Result, StandardUserProcessIdentity, WinError,
};

const MAX_ARGUMENTS: usize = 4_096;
const MAX_ENVIRONMENT_ENTRIES: usize = 256;
const MAX_COMMAND_LINE_UNITS: usize = 32_767;
const MAX_ENVIRONMENT_UNITS: usize = 32_767;
const MAX_PATH_UNITS: usize = 32_767;
const DROP_WAIT_MILLISECONDS: u32 = 5_000;
const DROP_EXIT_CODE: u32 = 0x504c_554d;
const FILE_WRITE_EA_ACCESS: u32 = 0x0000_0010;
const FILE_WRITE_ATTRIBUTES_ACCESS: u32 = 0x0000_0100;
const DELETE_ACCESS: u32 = 0x0001_0000;
const WRITE_DACL_ACCESS: u32 = 0x0004_0000;
const WRITE_OWNER_ACCESS: u32 = 0x0008_0000;
const GENERIC_ALL_ACCESS: u32 = 0x1000_0000;
const GENERIC_WRITE_ACCESS: u32 = 0x4000_0000;
const FILE_CONTROL_ACCESS: u32 = FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_WRITE_EA_ACCESS
    | FILE_WRITE_ATTRIBUTES_ACCESS
    | DELETE_ACCESS
    | WRITE_DACL_ACCESS
    | WRITE_OWNER_ACCESS
    | GENERIC_ALL_ACCESS
    | GENERIC_WRITE_ACCESS;

pub const MAX_PIPE_READ_BYTES: usize = 64 * 1_024;

#[derive(Clone, Copy)]
pub struct RetainedPathEvidence<'a> {
    pub handle: BorrowedHandle<'a>,
    pub identity: FileIdentity,
}

pub struct DirectProcessRequest<'a> {
    pub process: &'a StandardUserProcessIdentity,
    pub executable: &'a Path,
    pub executable_evidence: RetainedPathEvidence<'a>,
    pub working_directory: &'a Path,
    pub working_directory_evidence: RetainedPathEvidence<'a>,
    /// Arguments after argv[0]. The executable path is always supplied as argv[0].
    pub arguments: &'a [OsString],
    /// The complete child environment. Nothing is inherited from the parent.
    pub environment: &'a [(OsString, OsString)],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PipeRead {
    Pending,
    Data(Vec<u8>),
    Eof,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessWait {
    Running,
    Exited(u32),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JobTreeState {
    pub total_processes: u32,
    pub active_processes: u32,
    pub terminated_processes: u32,
}

impl JobTreeState {
    pub fn is_empty(self) -> bool {
        self.active_processes == 0
    }
}

pub struct DirectChild {
    job: OwnedHandle,
    process: OwnedHandle,
    _primary_thread: OwnedHandle,
    stdout_read: OwnedHandle,
    stderr_read: OwnedHandle,
    _executable_guard: OwnedHandle,
    _working_directory_guard: OwnedHandle,
    process_id: u32,
}

impl DirectChild {
    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    pub fn read_stdout(&mut self, maximum_bytes: usize) -> Result<PipeRead> {
        read_pipe(&self.stdout_read, maximum_bytes)
    }

    pub fn read_stderr(&mut self, maximum_bytes: usize) -> Result<PipeRead> {
        read_pipe(&self.stderr_read, maximum_bytes)
    }

    pub fn try_wait(&self) -> Result<ProcessWait> {
        wait_for_process(&self.process, 0)
    }

    pub fn wait_for(&self, timeout: Duration) -> Result<ProcessWait> {
        wait_for_process(&self.process, duration_milliseconds(timeout)?)
    }

    pub fn job_tree_state(&self) -> Result<JobTreeState> {
        query_job_tree(&self.job)
    }

    pub fn terminate_tree(&self, exit_code: u32) -> Result<()> {
        // SAFETY: job is a live private Job Object handle owned by this child.
        if unsafe { TerminateJobObject(raw(&self.job), exit_code) } == 0 {
            Err(WinError::last(ErrorKind::Other))
        } else {
            Ok(())
        }
    }
}

impl Drop for DirectChild {
    fn drop(&mut self) {
        // SAFETY: all handles remain owned and live for the duration of Drop. Failures are
        // deliberately ignored because Drop must remain fail-safe and non-panicking.
        unsafe {
            TerminateJobObject(raw(&self.job), DROP_EXIT_CODE);
            WaitForSingleObject(raw(&self.process), DROP_WAIT_MILLISECONDS);
        }
    }
}

pub fn spawn_direct(request: DirectProcessRequest<'_>) -> Result<DirectChild> {
    request.process.verify()?;
    if request
        .executable
        .extension()
        .is_none_or(|extension| extension.is_empty())
    {
        // CreateProcessW can append ".exe" to a module name without an extension. Requiring an
        // explicit extension keeps lpApplicationName bound to the attested path byte-for-byte.
        return Err(invalid_parameter());
    }
    let executable = absolute_path(request.executable)?;
    let working_directory = absolute_path(request.working_directory)?;
    let mut command_line = build_command_line(&executable, request.arguments)?;
    let environment = build_environment_block(request.environment)?;

    let executable_guard = open_and_bind_path(
        &executable,
        request.executable_evidence,
        RetainedObjectKind::Executable,
    )?;
    let working_directory_guard = open_and_bind_path(
        &working_directory,
        request.working_directory_evidence,
        RetainedObjectKind::Directory,
    )?;

    let stdout = anonymous_output_pipe()?;
    let stderr = anonymous_output_pipe()?;
    let stdin = inherited_null_input()?;
    let inherited_handles = [raw(&stdin), raw(&stdout.write), raw(&stderr.write)];
    let attributes = AttributeList::for_handle_list(&inherited_handles)?;

    let job = private_kill_job()?;
    let startup = STARTUPINFOEXW {
        StartupInfo: STARTUPINFOW {
            cb: u32::try_from(size_of::<STARTUPINFOEXW>()).map_err(|_| invalid_parameter())?,
            dwFlags: STARTF_USESTDHANDLES,
            hStdInput: raw(&stdin),
            hStdOutput: raw(&stdout.write),
            hStdError: raw(&stderr.write),
            ..STARTUPINFOW::default()
        },
        lpAttributeList: attributes.pointer,
    };

    let mut process_information = PROCESS_INFORMATION::default();
    // SAFETY: every pointer is non-null where required and remains live and correctly sized for
    // the call. The command line is mutable, both paths are absolute and NUL-terminated, the
    // environment is an explicit double-NUL-terminated Unicode block, and the inherited handle
    // list contains exactly the three valid inheritable standard handles above.
    if unsafe {
        CreateProcessW(
            executable.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            working_directory.as_ptr(),
            (&startup as *const STARTUPINFOEXW).cast(),
            &mut process_information,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }

    if !valid_handle(process_information.hProcess)
        || !valid_handle(process_information.hThread)
        || process_information.dwProcessId == 0
    {
        cleanup_invalid_process_information(&process_information);
        return Err(invalid_parameter());
    }
    let process = owned_handle(process_information.hProcess)?;
    let primary_thread = owned_handle(process_information.hThread)?;
    let mut spawned = SuspendedProcess {
        job: Some(job),
        process: Some(process),
        primary_thread: Some(primary_thread),
        assigned: false,
        armed: true,
    };

    // SAFETY: both handles are live. The process is still suspended and cannot create a
    // descendant before assignment to the private non-breakaway Job Object.
    if unsafe { AssignProcessToJobObject(spawned.job_raw()?, spawned.process_raw()?) } == 0 {
        return Err(WinError::last(ErrorKind::Other));
    }
    spawned.assigned = true;

    // SAFETY: the primary thread belongs to the still-suspended child and is resumed once.
    if unsafe { ResumeThread(spawned.primary_thread_raw()?) } == u32::MAX {
        return Err(WinError::last(ErrorKind::Other));
    }

    spawned.finish(
        stdout.read,
        stderr.read,
        executable_guard,
        working_directory_guard,
        process_information.dwProcessId,
    )
}

pub fn attest_no_untrusted_file_control(
    handle: BorrowedHandle<'_>,
    process: &ProcessIdentity,
) -> Result<bool> {
    process.verify()?;
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: all output pointers are valid; Descriptor owns the returned allocation.
    let status = unsafe {
        GetSecurityInfo(
            super::raw(handle),
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
    let descriptor = Descriptor(descriptor);
    if descriptor.0.is_null()
        || owner.is_null()
        // SAFETY: owner belongs to the live returned security descriptor.
        || unsafe { IsValidSid(owner) } == 0
        || !trusted_namespace_sid(owner, process)
        || dacl.is_null()
        // SAFETY: dacl belongs to the same live security descriptor.
        || unsafe { IsValidAcl(dacl) } == 0
    {
        return Ok(false);
    }

    let mut information = ACL_SIZE_INFORMATION::default();
    // SAFETY: dacl is valid and information has the exact documented output layout.
    if unsafe {
        GetAclInformation(
            dacl,
            (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }

    for index in 0..information.AceCount {
        let mut ace: *mut c_void = null_mut();
        // SAFETY: index is bounded by the count from the validated ACL.
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
            return Err(WinError::last(ErrorKind::Other));
        }
        // SAFETY: IsValidAcl plus GetAce proves a readable ACE header.
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
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
        let ace_length = usize::from(header.AceSize);
        if ace_length < sid_offset + sid_header_length {
            return Ok(false);
        }
        // SAFETY: the validated type and size make the fixed allowed-ACE fields readable.
        let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        if allowed.Mask & FILE_CONTROL_ACCESS == 0 {
            continue;
        }
        let sid: PSID = (&allowed.SidStart as *const u32).cast_mut().cast();
        // SAFETY: the bytes from SidStart to AceSize belong to this validated ACE.
        let sid_bytes =
            unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), ace_length - sid_offset) };
        let sid_length = 8_usize
            .checked_add(usize::from(sid_bytes[1]).saturating_mul(size_of::<u32>()))
            .ok_or_else(invalid_parameter)?;
        if sid_length > sid_bytes.len()
            // SAFETY: the complete SID was range-checked within the ACE.
            || unsafe { IsValidSid(sid) } == 0
            // SAFETY: IsValidSid succeeded for the complete in-range SID.
            || unsafe { GetLengthSid(sid) } as usize != sid_length
            || !trusted_namespace_sid(sid, process)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

#[derive(Clone, Copy)]
enum RetainedObjectKind {
    Executable,
    Directory,
}

struct OutputPipe {
    read: OwnedHandle,
    write: OwnedHandle,
}

struct AttributeList {
    _storage: Vec<usize>,
    pointer: windows_sys::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl AttributeList {
    fn for_handle_list(handles: &[HANDLE]) -> Result<Self> {
        if handles.is_empty() {
            return Err(invalid_parameter());
        }
        let mut required = 0_usize;
        // SAFETY: the documented sizing call uses a null list and writable size pointer.
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut required);
        }
        // SAFETY: GetLastError is read immediately after the expected failing sizing call.
        let sizing_error = unsafe { GetLastError() };
        if required == 0 || sizing_error != ERROR_INSUFFICIENT_BUFFER {
            return Err(WinError::code(ErrorKind::Other, sizing_error));
        }
        let words = required.div_ceil(size_of::<usize>());
        let mut storage = vec![0_usize; words];
        let pointer = storage.as_mut_ptr().cast();
        // SAFETY: storage is aligned and at least the exact size reported by the sizing call.
        if unsafe { InitializeProcThreadAttributeList(pointer, 1, 0, &mut required) } == 0 {
            return Err(WinError::last(ErrorKind::Other));
        }

        let byte_length = handles
            .len()
            .checked_mul(size_of::<HANDLE>())
            .ok_or_else(invalid_parameter)?;
        // SAFETY: pointer is an initialized one-entry list and the handle slice remains live
        // until CreateProcessW returns.
        if unsafe {
            UpdateProcThreadAttribute(
                pointer,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                byte_length,
                null_mut(),
                null(),
            )
        } == 0
        {
            let error = WinError::last(ErrorKind::Other);
            // SAFETY: pointer was initialized successfully immediately above.
            unsafe {
                DeleteProcThreadAttributeList(pointer);
            }
            return Err(error);
        }
        Ok(Self {
            _storage: storage,
            pointer,
        })
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            // SAFETY: pointer is initialized and storage remains live through this Drop.
            unsafe {
                DeleteProcThreadAttributeList(self.pointer);
            }
            self.pointer = null_mut();
        }
    }
}

struct SuspendedProcess {
    job: Option<OwnedHandle>,
    process: Option<OwnedHandle>,
    primary_thread: Option<OwnedHandle>,
    assigned: bool,
    armed: bool,
}

impl SuspendedProcess {
    fn job_raw(&self) -> Result<HANDLE> {
        self.job.as_ref().map(raw).ok_or_else(invalid_parameter)
    }

    fn process_raw(&self) -> Result<HANDLE> {
        self.process.as_ref().map(raw).ok_or_else(invalid_parameter)
    }

    fn primary_thread_raw(&self) -> Result<HANDLE> {
        self.primary_thread
            .as_ref()
            .map(raw)
            .ok_or_else(invalid_parameter)
    }

    fn finish(
        mut self,
        stdout_read: OwnedHandle,
        stderr_read: OwnedHandle,
        executable_guard: OwnedHandle,
        working_directory_guard: OwnedHandle,
        process_id: u32,
    ) -> Result<DirectChild> {
        let job = self.job.take().ok_or_else(invalid_parameter)?;
        let process = self.process.take().ok_or_else(invalid_parameter)?;
        let primary_thread = self.primary_thread.take().ok_or_else(invalid_parameter)?;
        self.armed = false;
        Ok(DirectChild {
            job,
            process,
            _primary_thread: primary_thread,
            stdout_read,
            stderr_read,
            _executable_guard: executable_guard,
            _working_directory_guard: working_directory_guard,
            process_id,
        })
    }
}

impl Drop for SuspendedProcess {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let Some(process) = self.process.as_ref() else {
            return;
        };
        // SAFETY: the process is still suspended on every failure path. Once assigned, the
        // private Job is the authoritative tree boundary; otherwise terminate the root directly.
        unsafe {
            if self.assigned {
                if let Some(job) = self.job.as_ref() {
                    TerminateJobObject(raw(job), DROP_EXIT_CODE);
                } else {
                    TerminateProcess(raw(process), DROP_EXIT_CODE);
                }
            } else {
                TerminateProcess(raw(process), DROP_EXIT_CODE);
            }
            WaitForSingleObject(raw(process), DROP_WAIT_MILLISECONDS);
        }
    }
}

struct Descriptor(windows_sys::Win32::Security::PSECURITY_DESCRIPTOR);

impl Drop for Descriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: GetSecurityInfo allocates this descriptor with LocalAlloc.
            unsafe {
                LocalFree(self.0.cast());
            }
        }
    }
}

fn absolute_path(path: &Path) -> Result<Vec<u16>> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err(invalid_parameter());
    }
    let mut value: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .take(MAX_PATH_UNITS + 1)
        .collect();
    if value.is_empty()
        || value.len() >= MAX_PATH_UNITS
        || value.contains(&0)
        || value.contains(&(b'"' as u16))
        || value.contains(&(b'/' as u16))
        || has_dot_path_component(&value)
    {
        return Err(invalid_parameter());
    }
    value.push(0);
    Ok(value)
}

fn has_dot_path_component(path: &[u16]) -> bool {
    path.split(|unit| *unit == b'\\' as u16)
        .any(|part| part == [b'.' as u16] || part == [b'.' as u16, b'.' as u16])
}

fn build_command_line(executable: &[u16], arguments: &[OsString]) -> Result<Vec<u16>> {
    if arguments.len().saturating_add(1) > MAX_ARGUMENTS {
        return Err(invalid_parameter());
    }
    let executable = executable
        .strip_suffix(&[0])
        .ok_or_else(invalid_parameter)?;
    let mut command_line = quote_argument(executable)?;
    for argument in arguments {
        let argument: Vec<u16> = argument
            .encode_wide()
            .take(MAX_COMMAND_LINE_UNITS + 1)
            .collect();
        validate_wide_string(&argument)?;
        command_line.push(b' ' as u16);
        command_line.extend(quote_argument(&argument)?);
        if command_line.len() >= MAX_COMMAND_LINE_UNITS {
            return Err(invalid_parameter());
        }
    }
    command_line.push(0);
    if command_line.len() > MAX_COMMAND_LINE_UNITS {
        return Err(invalid_parameter());
    }
    Ok(command_line)
}

fn quote_argument(argument: &[u16]) -> Result<Vec<u16>> {
    validate_wide_string(argument)?;
    let quoted = argument.is_empty()
        || argument
            .iter()
            .any(|unit| matches!(*unit, 0x09 | 0x20 | 0x22));
    if !quoted {
        return Ok(argument.to_vec());
    }

    let mut output = Vec::with_capacity(argument.len().saturating_add(2));
    output.push(b'"' as u16);
    let mut backslashes = 0_usize;
    for unit in argument {
        if *unit == b'\\' as u16 {
            backslashes = backslashes.checked_add(1).ok_or_else(invalid_parameter)?;
            continue;
        }
        if *unit == b'"' as u16 {
            extend_repeated(
                &mut output,
                b'\\' as u16,
                backslashes
                    .checked_mul(2)
                    .and_then(|value| value.checked_add(1))
                    .ok_or_else(invalid_parameter)?,
            )?;
            output.push(*unit);
        } else {
            extend_repeated(&mut output, b'\\' as u16, backslashes)?;
            output.push(*unit);
        }
        backslashes = 0;
    }
    extend_repeated(
        &mut output,
        b'\\' as u16,
        backslashes.checked_mul(2).ok_or_else(invalid_parameter)?,
    )?;
    output.push(b'"' as u16);
    Ok(output)
}

fn build_environment_block(environment: &[(OsString, OsString)]) -> Result<Vec<u16>> {
    if environment.len() > MAX_ENVIRONMENT_ENTRIES {
        return Err(invalid_parameter());
    }
    let mut entries = Vec::with_capacity(environment.len());
    let mut required_units = 1_usize;
    for (name, value) in environment {
        let name: Vec<u16> = name.encode_wide().take(MAX_ENVIRONMENT_UNITS + 1).collect();
        let value: Vec<u16> = value
            .encode_wide()
            .take(MAX_ENVIRONMENT_UNITS + 1)
            .collect();
        if name.is_empty()
            || name.contains(&(b'=' as u16))
            || name.contains(&0)
            || value.contains(&0)
        {
            return Err(invalid_parameter());
        }
        required_units = required_units
            .checked_add(name.len())
            .and_then(|total| total.checked_add(value.len()))
            .and_then(|total| total.checked_add(2))
            .ok_or_else(invalid_parameter)?;
        if required_units > MAX_ENVIRONMENT_UNITS {
            return Err(invalid_parameter());
        }
        entries.push((name, value));
    }

    for index in 1..entries.len() {
        let mut cursor = index;
        while cursor > 0 {
            match compare_environment_names(&entries[cursor - 1].0, &entries[cursor].0)? {
                Ordering::Less => break,
                Ordering::Equal => return Err(invalid_parameter()),
                Ordering::Greater => entries.swap(cursor - 1, cursor),
            }
            cursor -= 1;
        }
    }

    let mut block = Vec::new();
    if entries.is_empty() {
        block.push(0);
    } else {
        for (name, value) in entries {
            block.extend(name);
            block.push(b'=' as u16);
            block.extend(value);
            block.push(0);
        }
    }
    block.push(0);
    if block.len() > MAX_ENVIRONMENT_UNITS {
        return Err(invalid_parameter());
    }
    Ok(block)
}

fn compare_environment_names(left: &[u16], right: &[u16]) -> Result<Ordering> {
    let left_length = i32::try_from(left.len()).map_err(|_| invalid_parameter())?;
    let right_length = i32::try_from(right.len()).map_err(|_| invalid_parameter())?;
    // SAFETY: both slices are readable for their explicit lengths and need not be terminated.
    match unsafe {
        CompareStringOrdinal(left.as_ptr(), left_length, right.as_ptr(), right_length, 1)
    } {
        CSTR_LESS_THAN => Ok(Ordering::Less),
        CSTR_EQUAL => Ok(Ordering::Equal),
        CSTR_GREATER_THAN => Ok(Ordering::Greater),
        _ => Err(WinError::last(ErrorKind::Other)),
    }
}

fn validate_wide_string(value: &[u16]) -> Result<()> {
    if value.len() >= MAX_COMMAND_LINE_UNITS || value.contains(&0) {
        Err(invalid_parameter())
    } else {
        Ok(())
    }
}

fn extend_repeated(output: &mut Vec<u16>, unit: u16, count: usize) -> Result<()> {
    if output
        .len()
        .checked_add(count)
        .is_none_or(|length| length >= MAX_COMMAND_LINE_UNITS)
    {
        return Err(invalid_parameter());
    }
    output.extend(std::iter::repeat_n(unit, count));
    Ok(())
}

fn open_and_bind_path(
    path: &[u16],
    evidence: RetainedPathEvidence<'_>,
    kind: RetainedObjectKind,
) -> Result<OwnedHandle> {
    let retained_identity = file_identity(evidence.handle)?;
    let retained_standard = file_standard(evidence.handle)?;
    if retained_identity != evidence.identity
        || retained_standard.delete_pending
        || retained_standard.directory != matches!(kind, RetainedObjectKind::Directory)
        || (matches!(kind, RetainedObjectKind::Executable) && retained_standard.links != 1)
    {
        return Err(WinError::code(ErrorKind::Conflict, ERROR_INVALID_PARAMETER));
    }

    let (share_mode, flags) = match kind {
        RetainedObjectKind::Executable => (
            FILE_SHARE_READ,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
        ),
        RetainedObjectKind::Directory => (
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        ),
    };
    // SAFETY: path is a live absolute NUL-terminated string. Omitting FILE_SHARE_DELETE retains
    // the exact object name, while the reparse flag refuses silently opening a final target.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_READ_ATTRIBUTES,
            share_mode,
            null(),
            OPEN_EXISTING,
            flags,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(WinError::last(ErrorKind::Other));
    }
    let guard = owned_handle(handle)?;
    let guard_identity = file_identity(borrowed(&guard))?;
    let guard_standard = file_standard(borrowed(&guard))?;
    if guard_identity != evidence.identity
        || guard_standard.delete_pending
        || guard_standard.directory != matches!(kind, RetainedObjectKind::Directory)
        || (matches!(kind, RetainedObjectKind::Executable) && guard_standard.links != 1)
    {
        return Err(WinError::code(ErrorKind::Conflict, ERROR_INVALID_PARAMETER));
    }
    Ok(guard)
}

fn anonymous_output_pipe() -> Result<OutputPipe> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read = null_mut();
    let mut write = null_mut();
    // SAFETY: output pointers and attributes are valid; zero requests the system pipe size.
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(WinError::last(ErrorKind::Other));
    }
    let read = owned_handle(read)?;
    let write = owned_handle(write)?;
    // SAFETY: read is live; this clears inheritance while leaving the child write end inheritable.
    if unsafe { SetHandleInformation(raw(&read), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(WinError::last(ErrorKind::Other));
    }
    Ok(OutputPipe { read, write })
}

fn inherited_null_input() -> Result<OwnedHandle> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let name = [b'N' as u16, b'U' as u16, b'L' as u16, 0];
    // SAFETY: name is a literal NUL-terminated device path and attributes requests inheritance.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(WinError::last(ErrorKind::Other))
    } else {
        owned_handle(handle)
    }
}

fn private_kill_job() -> Result<OwnedHandle> {
    // SAFETY: null attributes/name creates one private, non-inheritable unnamed Job Object.
    let raw_job = unsafe { CreateJobObjectW(null(), null()) };
    if raw_job.is_null() {
        return Err(WinError::last(ErrorKind::Other));
    }
    let job = owned_handle(raw_job)?;
    let limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
            LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            ..JOBOBJECT_BASIC_LIMIT_INFORMATION::default()
        },
        ..JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default()
    };
    // No breakaway flag is set, so descendants cannot leave this Job hierarchy.
    // SAFETY: job is live and limits has the exact documented layout and byte size.
    if unsafe {
        SetInformationJobObject(
            raw(&job),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    Ok(job)
}

fn query_job_tree(job: &OwnedHandle) -> Result<JobTreeState> {
    let mut information = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    let mut returned = 0_u32;
    // SAFETY: job is live and information is an exact writable output structure.
    if unsafe {
        QueryInformationJobObject(
            raw(job),
            JobObjectBasicAccountingInformation,
            (&mut information as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
            size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            &mut returned,
        )
    } == 0
    {
        return Err(WinError::last(ErrorKind::Other));
    }
    if returned != 0 && returned as usize != size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() {
        return Err(invalid_parameter());
    }
    Ok(JobTreeState {
        total_processes: information.TotalProcesses,
        active_processes: information.ActiveProcesses,
        terminated_processes: information.TotalTerminatedProcesses,
    })
}

fn read_pipe(pipe: &OwnedHandle, maximum_bytes: usize) -> Result<PipeRead> {
    if maximum_bytes == 0 || maximum_bytes > MAX_PIPE_READ_BYTES {
        return Err(invalid_parameter());
    }
    let mut available = 0_u32;
    // SAFETY: pipe is the live read end; no output buffer is requested, only byte availability.
    if unsafe {
        PeekNamedPipe(
            raw(pipe),
            null_mut(),
            0,
            null_mut(),
            &mut available,
            null_mut(),
        )
    } == 0
    {
        return pipe_error_or_eof();
    }
    if available == 0 {
        return Ok(PipeRead::Pending);
    }

    let requested = available.min(maximum_bytes as u32);
    let mut data = vec![0_u8; requested as usize];
    let mut read = 0_u32;
    // SAFETY: data is writable for requested bytes and the peek proved that many bytes available
    // to this sole reader, so the synchronous read cannot block waiting for child output.
    if unsafe {
        ReadFile(
            raw(pipe),
            data.as_mut_ptr(),
            requested,
            &mut read,
            null_mut(),
        )
    } == 0
    {
        return pipe_error_or_eof();
    }
    data.truncate(read as usize);
    if data.is_empty() {
        Ok(PipeRead::Eof)
    } else {
        Ok(PipeRead::Data(data))
    }
}

fn pipe_error_or_eof() -> Result<PipeRead> {
    // SAFETY: GetLastError is read immediately after a failed pipe operation.
    let code = unsafe { GetLastError() };
    if matches!(code, ERROR_BROKEN_PIPE | ERROR_NO_DATA) {
        Ok(PipeRead::Eof)
    } else {
        Err(WinError::code(ErrorKind::Other, code))
    }
}

fn wait_for_process(process: &OwnedHandle, milliseconds: u32) -> Result<ProcessWait> {
    // SAFETY: process is a live process handle and milliseconds is always finite.
    match unsafe { WaitForSingleObject(raw(process), milliseconds) } {
        WAIT_TIMEOUT => Ok(ProcessWait::Running),
        WAIT_OBJECT_0 => {
            let mut exit_code = 0_u32;
            // SAFETY: process is signaled and exit_code is writable.
            if unsafe { GetExitCodeProcess(raw(process), &mut exit_code) } == 0 {
                Err(WinError::last(ErrorKind::Other))
            } else {
                Ok(ProcessWait::Exited(exit_code))
            }
        }
        WAIT_FAILED => Err(WinError::last(ErrorKind::Other)),
        _ => Err(invalid_parameter()),
    }
}

fn duration_milliseconds(duration: Duration) -> Result<u32> {
    if duration.is_zero() {
        return Ok(0);
    }
    let mut milliseconds = duration.as_millis();
    if !duration.subsec_nanos().is_multiple_of(1_000_000) {
        milliseconds = milliseconds.checked_add(1).ok_or_else(invalid_parameter)?;
    }
    if milliseconds >= u128::from(u32::MAX) {
        return Err(invalid_parameter());
    }
    u32::try_from(milliseconds).map_err(|_| invalid_parameter())
}

fn owned_handle(handle: HANDLE) -> Result<OwnedHandle> {
    if !valid_handle(handle) {
        return Err(invalid_parameter());
    }
    // SAFETY: callers transfer one newly created owned kernel handle exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as _) })
}

fn valid_handle(handle: HANDLE) -> bool {
    !handle.is_null() && handle != INVALID_HANDLE_VALUE
}

fn cleanup_invalid_process_information(information: &PROCESS_INFORMATION) {
    // SAFETY: CreateProcessW reported success. Each non-null/non-invalid returned handle is
    // therefore owned here; the process is terminated before either handle is closed.
    unsafe {
        if valid_handle(information.hProcess) {
            TerminateProcess(information.hProcess, DROP_EXIT_CODE);
            WaitForSingleObject(information.hProcess, DROP_WAIT_MILLISECONDS);
        }
        if valid_handle(information.hThread) {
            CloseHandle(information.hThread);
        }
        if valid_handle(information.hProcess) {
            CloseHandle(information.hProcess);
        }
    }
}

fn borrowed(handle: &OwnedHandle) -> BorrowedHandle<'_> {
    // SAFETY: the returned borrow cannot outlive the referenced OwnedHandle.
    unsafe { BorrowedHandle::borrow_raw(handle.as_raw_handle()) }
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

fn invalid_parameter() -> WinError {
    WinError::code(ErrorKind::Other, ERROR_INVALID_PARAMETER)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::ffi::OsStringExt;

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().collect()
    }

    fn decoded(value: &[u16]) -> String {
        String::from_utf16(value).expect("test values are valid UTF-16")
    }

    #[test]
    fn crt_quoting_preserves_empty_spaces_quotes_and_backslashes() {
        for (argument, expected) in [
            ("plain", "plain"),
            ("", "\"\""),
            ("two words", "\"two words\""),
            ("tab\tvalue", "\"tab\tvalue\""),
            ("back\\slash", "back\\slash"),
            ("quote\"value", "\"quote\\\"value\""),
            ("space and slash\\", "\"space and slash\\\\\""),
        ] {
            assert_eq!(
                decoded(&quote_argument(&wide(argument)).expect("argument quotes")),
                expected
            );
        }
    }

    #[test]
    fn crt_command_line_owns_argv_zero_and_rejects_nuls_and_oversize() {
        let executable = wide(r"C:\Program Files\Plurum Probe.exe");
        let mut terminated = executable.clone();
        terminated.push(0);
        let arguments = [
            OsString::from("alpha"),
            OsString::from("two words"),
            OsString::from_wide(&[b'x' as u16, 0, b'y' as u16]),
        ];
        assert!(build_command_line(&terminated, &arguments).is_err());

        let line = build_command_line(&terminated, &arguments[..2]).expect("command line");
        assert_eq!(
            decoded(&line[..line.len() - 1]),
            "\"C:\\Program Files\\Plurum Probe.exe\" alpha \"two words\""
        );

        let oversized = OsString::from_wide(&vec![b'x' as u16; MAX_COMMAND_LINE_UNITS]);
        assert!(build_command_line(&terminated, &[oversized]).is_err());

        let too_many = vec![OsString::new(); MAX_ARGUMENTS];
        assert!(build_command_line(&terminated, &too_many).is_err());
    }

    #[test]
    fn unicode_environment_is_sorted_unique_and_double_terminated() {
        let environment = [
            (OsString::from("zeta"), OsString::from("last")),
            (OsString::from("Ångström"), OsString::from("unicode")),
            (OsString::from("Alpha"), OsString::from("first")),
        ];
        let block = build_environment_block(&environment).expect("environment block");
        assert_eq!(block.last(), Some(&0));
        assert_eq!(block.get(block.len() - 2), Some(&0));
        let entries: Vec<String> = block[..block.len() - 1]
            .split(|unit| *unit == 0)
            .filter(|entry| !entry.is_empty())
            .map(decoded)
            .collect();
        assert_eq!(entries, ["Alpha=first", "zeta=last", "Ångström=unicode"]);

        let empty = build_environment_block(&[]).expect("empty environment");
        assert_eq!(empty, [0, 0]);
    }

    #[test]
    fn environment_rejects_case_aliases_invalid_names_nuls_and_oversize() {
        assert!(build_environment_block(&[
            (OsString::from("Path"), OsString::from("one")),
            (OsString::from("PATH"), OsString::from("two")),
        ])
        .is_err());
        assert!(build_environment_block(&[
            (OsString::from("Å"), OsString::from("one")),
            (OsString::from("å"), OsString::from("two")),
        ])
        .is_err());
        for name in ["", "=drive", "bad=name"] {
            assert!(
                build_environment_block(&[(OsString::from(name), OsString::from("value"))])
                    .is_err()
            );
        }
        assert!(build_environment_block(&[(
            OsString::from_wide(&[b'N' as u16, 0]),
            OsString::from("value"),
        )])
        .is_err());
        assert!(build_environment_block(&[(
            OsString::from("NAME"),
            OsString::from_wide(&[b'v' as u16, 0]),
        )])
        .is_err());
        assert!(build_environment_block(&[(
            OsString::from("NAME"),
            OsString::from_wide(&vec![b'v' as u16; MAX_ENVIRONMENT_UNITS]),
        )])
        .is_err());

        let too_many = vec![(OsString::new(), OsString::new()); MAX_ENVIRONMENT_ENTRIES + 1];
        assert!(build_environment_block(&too_many).is_err());
    }
}
