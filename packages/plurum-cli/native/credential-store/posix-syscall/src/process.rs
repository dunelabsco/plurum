use std::collections::BTreeSet;
use std::ffi::{c_char, CString, OsString};
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path};
use std::ptr;
use std::time::{Duration, Instant};

const MAX_ARGUMENT_COUNT: usize = 256;
const MAX_ENVIRONMENT_COUNT: usize = 128;
const MAX_STRING_BYTES: usize = 32_767;
const MAX_VECTOR_BYTES: usize = 128 * 1024;
const REAP_TIMEOUT: Duration = Duration::from_secs(2);
const REAP_POLL_INTERVAL: Duration = Duration::from_millis(2);
const GROUP_MEMBERSHIP_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(target_os = "linux")]
const MAX_PATH_BYTES: usize = 4_096;
#[cfg(target_os = "linux")]
const LINUX_SIGNAL_LIMIT_EXCLUSIVE: i32 = 65;
#[cfg(target_os = "linux")]
const LINUX_PROCFS_MAGIC: u64 = 0x0000_9fa0;
#[cfg(target_os = "linux")]
const LINUX_PROC_GROUP_SCAN_ENTRY_LIMIT: usize = 32_768;
#[cfg(target_os = "macos")]
const MAX_PATH_BYTES: usize = 1_024;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessErrorKind {
    InvalidInput,
    Launch,
    Timeout,
    Io,
    Conflict,
    Limit,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcessError {
    pub kind: ProcessErrorKind,
    pub code: i32,
}

impl ProcessError {
    const fn new(kind: ProcessErrorKind, code: i32) -> Self {
        Self { kind, code }
    }

    fn last(kind: ProcessErrorKind) -> Self {
        Self::new(kind, last_errno())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChildStreamRead {
    Data(usize),
    WouldBlock,
    Eof,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RootExitStatus {
    Exited(i32),
    Signaled(i32),
}

pub struct DirectSpawnRequest<'a> {
    pub executable: BorrowedFd<'a>,
    pub cwd: BorrowedFd<'a>,
    pub executable_path: &'a Path,
    pub argv: &'a [OsString],
    pub environment: &'a [OsString],
    #[cfg(target_os = "macos")]
    pub mapped_file_offset: u64,
    #[cfg(target_os = "linux")]
    pub deadline: Instant,
}

pub struct DirectChild {
    pid: libc::pid_t,
    process_group: libc::pid_t,
    group_authority: ProcessGroupAuthority,
    #[cfg(target_os = "macos")]
    macos_identity: MacosProcessIdentity,
    stdout: Option<OwnedFd>,
    stderr: Option<OwnedFd>,
    root_status: Option<RootExitStatus>,
    terminal_group_signal_sent: bool,
    next_group_membership_check: Option<Instant>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessGroupAuthority {
    /// The unreaped root child still pins its PID and therefore its PGID.
    Pinned,
    /// Group quiescence was established while pinned and the root was reaped.
    Disarmed,
    /// Another reaper or an invariant failure made numeric signalling unsafe.
    Lost,
}

impl ProcessGroupAuthority {
    fn permits_signal(self) -> bool {
        self == Self::Pinned
    }
}

impl DirectChild {
    pub fn pid(&self) -> libc::pid_t {
        self.pid
    }

    pub fn process_group(&self) -> libc::pid_t {
        self.process_group
    }

    pub fn read_stdout(&mut self, destination: &mut [u8]) -> Result<ChildStreamRead, ProcessError> {
        read_stream(&mut self.stdout, destination)
    }

    pub fn read_stderr(&mut self, destination: &mut [u8]) -> Result<ChildStreamRead, ProcessError> {
        read_stream(&mut self.stderr, destination)
    }

    pub fn try_wait_root(&mut self) -> Result<Option<RootExitStatus>, ProcessError> {
        if let Some(status) = self.root_status {
            return Ok(Some(status));
        }
        if self.group_authority == ProcessGroupAuthority::Lost {
            return Err(ProcessError::new(ProcessErrorKind::Conflict, 0));
        }

        loop {
            let mut information = MaybeUninit::<libc::siginfo_t>::zeroed();
            // SAFETY: `information` is exact writable siginfo storage. P_PID
            // restricts observation to our exact child, WNOWAIT leaves the
            // exited leader unreaped so its PID continues to pin the PGID.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.pid as libc::id_t,
                    information.as_mut_ptr(),
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result != 0 {
                let code = last_errno();
                if code == libc::EINTR {
                    continue;
                }
                if code == libc::ECHILD {
                    self.group_authority = ProcessGroupAuthority::Lost;
                    return Err(ProcessError::new(ProcessErrorKind::Conflict, code));
                }
                return Err(ProcessError::new(ProcessErrorKind::Io, code));
            }
            // SAFETY: successful waitid initialized the complete structure.
            let information = unsafe { information.assume_init() };
            // SAFETY: waitid initialized the siginfo union for a child event or
            // left the zeroed si_pid in place when WNOHANG observed no event.
            let observed_pid = unsafe { information.si_pid() };
            if observed_pid == 0 {
                return Ok(None);
            }
            if observed_pid != self.pid {
                self.group_authority = ProcessGroupAuthority::Lost;
                return Err(ProcessError::new(ProcessErrorKind::Conflict, 0));
            }

            // The observed root remains an unreaped zombie until every member
            // still covered by this trusted-binary process-group contract has
            // accepted the terminal signal and left the group.
            if !self.terminal_group_signal_sent {
                match signal_group(self.process_group, libc::SIGKILL) {
                    Ok(()) => {
                        self.terminal_group_signal_sent = true;
                    }
                    #[cfg(target_os = "macos")]
                    Err(error)
                        if error.code == libc::EPERM
                            && macos_only_attested_zombie_root_remains(
                                self.process_group,
                                &self.macos_identity,
                            )? =>
                    {
                        self.terminal_group_signal_sent = true;
                    }
                    Err(error) => return Err(error),
                }
            }
            if self
                .next_group_membership_check
                .is_some_and(|next| Instant::now() < next)
            {
                return Ok(None);
            }
            if !self.only_attested_zombie_root_remains()? {
                self.next_group_membership_check =
                    Instant::now().checked_add(GROUP_MEMBERSHIP_POLL_INTERVAL);
                return Ok(None);
            }

            let mut raw_status = 0;
            loop {
                // SAFETY: waitid above observed this exact waitable child
                // without reaping it, and `raw_status` is live output storage.
                let waited = unsafe { libc::waitpid(self.pid, &mut raw_status, 0) };
                if waited == self.pid {
                    // Never issue another numeric PID/PGID signal after this
                    // reap; either number may be reused immediately.
                    self.group_authority = ProcessGroupAuthority::Disarmed;
                    self.next_group_membership_check = None;
                    let status = decode_wait_status(raw_status)?;
                    self.root_status = Some(status);
                    return Ok(Some(status));
                }
                let code = last_errno();
                if code == libc::EINTR {
                    continue;
                }
                if code == libc::ECHILD {
                    self.group_authority = ProcessGroupAuthority::Lost;
                    return Err(ProcessError::new(ProcessErrorKind::Conflict, code));
                }
                return Err(ProcessError::new(ProcessErrorKind::Io, code));
            }
        }
    }

    pub fn process_group_alive(&self) -> Result<bool, ProcessError> {
        match self.group_authority {
            ProcessGroupAuthority::Disarmed => return Ok(false),
            ProcessGroupAuthority::Lost => {
                return Err(ProcessError::new(ProcessErrorKind::Conflict, 0));
            }
            ProcessGroupAuthority::Pinned => {}
        }
        // SAFETY: a negative PID addresses exactly this child's process group;
        // the unreaped root still pins that numeric PGID, and signal zero
        // performs only the existence/permission check.
        let result = unsafe { libc::kill(-self.process_group, 0) };
        if result == 0 {
            return Ok(true);
        }
        match last_errno() {
            libc::ESRCH => Ok(false),
            libc::EPERM => Ok(true),
            _ => Err(ProcessError::last(ProcessErrorKind::Io)),
        }
    }

    pub fn terminate_group(&self) -> Result<(), ProcessError> {
        self.signal_group_if_pinned(libc::SIGTERM)
    }

    pub fn kill_group(&self) -> Result<(), ProcessError> {
        self.signal_group_if_pinned(libc::SIGKILL)
    }

    fn signal_group_if_pinned(&self, signal: libc::c_int) -> Result<(), ProcessError> {
        match self.group_authority {
            ProcessGroupAuthority::Pinned => signal_group(self.process_group, signal),
            ProcessGroupAuthority::Disarmed => Ok(()),
            ProcessGroupAuthority::Lost => Err(ProcessError::new(ProcessErrorKind::Conflict, 0)),
        }
    }

    fn only_attested_zombie_root_remains(&self) -> Result<bool, ProcessError> {
        // Descendants of the fixed trusted binary are required to remain in
        // this process group. A descendant that deliberately creates another
        // group or session is outside this process-group authority contract.
        #[cfg(target_os = "linux")]
        {
            linux_only_attested_zombie_root_remains(self.process_group, self.pid)
        }
        #[cfg(target_os = "macos")]
        {
            macos_only_attested_zombie_root_remains(self.process_group, &self.macos_identity)
        }
    }

    fn force_kill_and_reap_pinned(&mut self) {
        if signal_group(self.process_group, libc::SIGKILL).is_ok() {
            self.terminal_group_signal_sent = true;
            self.next_group_membership_check = None;
        }
        // SAFETY: the unreaped exact child PID is still pinned against reuse.
        let _ = unsafe { libc::kill(self.pid, libc::SIGKILL) };
        let Some(deadline) = Instant::now().checked_add(REAP_TIMEOUT) else {
            return;
        };
        loop {
            match self.try_wait_root() {
                Ok(Some(_)) => return,
                Ok(None) => {}
                Err(_) => return,
            }
            if Instant::now() >= deadline {
                // Retaining the zombie is safer than releasing and permitting
                // numeric PGID reuse before group quiescence was proved.
                return;
            }
            std::thread::sleep(REAP_POLL_INTERVAL);
        }
    }
}

impl Drop for DirectChild {
    fn drop(&mut self) {
        // Only an unreaped child pins the numeric PID/PGID against reuse.
        // Disarmed or lost authority must never target those numbers again.
        if self.group_authority.permits_signal() {
            self.force_kill_and_reap_pinned();
        }
    }
}

struct PreparedSpawn {
    _executable_path: CString,
    _argv_storage: Vec<CString>,
    argv: Vec<*mut c_char>,
    _environment_storage: Vec<CString>,
    environment: Vec<*mut c_char>,
}

struct SignalState {
    empty_mask: libc::sigset_t,
    #[cfg(target_os = "macos")]
    default_set: libc::sigset_t,
    #[cfg(target_os = "linux")]
    default_action: libc::sigaction,
}

struct Pipe {
    read: OwnedFd,
    write: OwnedFd,
}

pub fn spawn_direct(request: DirectSpawnRequest<'_>) -> Result<DirectChild, ProcessError> {
    validate_descriptors(request.executable, request.cwd)?;
    let prepared = prepare_spawn(request.executable_path, request.argv, request.environment)?;
    let signals = prepare_signal_state()?;
    let stdin = create_eof_input()?;
    let stdout = create_output_pipe()?;
    let stderr = create_output_pipe()?;

    #[cfg(target_os = "linux")]
    {
        spawn_linux(request, prepared, signals, stdin, stdout, stderr)
    }
    #[cfg(target_os = "macos")]
    {
        spawn_macos(request, prepared, signals, stdin, stdout, stderr)
    }
}

#[cfg(feature = "test-support")]
pub fn ignore_termination_for_test() -> Result<(), ProcessError> {
    // SAFETY: SIGTERM and SIG_IGN are fixed valid process-signal values. This
    // test-only helper changes only the calling fake probe's signal disposition.
    let previous = unsafe { libc::signal(libc::SIGTERM, libc::SIG_IGN) };
    if previous == libc::SIG_ERR {
        Err(ProcessError::last(ProcessErrorKind::Io))
    } else {
        Ok(())
    }
}

fn prepare_spawn(
    executable_path: &Path,
    argv: &[OsString],
    environment: &[OsString],
) -> Result<PreparedSpawn, ProcessError> {
    validate_absolute_path(executable_path)?;
    if argv.is_empty()
        || argv.len() > MAX_ARGUMENT_COUNT
        || environment.len() > MAX_ENVIRONMENT_COUNT
        || argv[0].as_bytes() != executable_path.as_os_str().as_bytes()
    {
        return Err(ProcessError::new(ProcessErrorKind::InvalidInput, 0));
    }

    let mut total_bytes = 0_usize;
    let mut argv_storage = Vec::with_capacity(argv.len());
    for value in argv {
        argv_storage.push(prepare_string(value, &mut total_bytes)?);
    }

    let mut names = BTreeSet::new();
    let mut environment_storage = Vec::with_capacity(environment.len());
    for value in environment {
        let bytes = value.as_bytes();
        let separator = bytes
            .iter()
            .position(|byte| *byte == b'=')
            .ok_or(ProcessError::new(ProcessErrorKind::InvalidInput, 0))?;
        if separator == 0 || !names.insert(bytes[..separator].to_vec()) {
            return Err(ProcessError::new(ProcessErrorKind::InvalidInput, 0));
        }
        environment_storage.push(prepare_string(value, &mut total_bytes)?);
    }
    let executable_path = CString::new(executable_path.as_os_str().as_bytes())
        .map_err(|_| ProcessError::new(ProcessErrorKind::InvalidInput, 0))?;
    let mut argv_pointers = argv_storage
        .iter()
        .map(|value| value.as_ptr().cast_mut())
        .collect::<Vec<_>>();
    argv_pointers.push(ptr::null_mut());
    let mut environment_pointers = environment_storage
        .iter()
        .map(|value| value.as_ptr().cast_mut())
        .collect::<Vec<_>>();
    environment_pointers.push(ptr::null_mut());

    Ok(PreparedSpawn {
        _executable_path: executable_path,
        _argv_storage: argv_storage,
        argv: argv_pointers,
        _environment_storage: environment_storage,
        environment: environment_pointers,
    })
}

fn prepare_string(value: &OsString, total_bytes: &mut usize) -> Result<CString, ProcessError> {
    let bytes = value.as_bytes();
    if bytes.len() > MAX_STRING_BYTES {
        return Err(ProcessError::new(ProcessErrorKind::Limit, 0));
    }
    let next_total = (*total_bytes)
        .checked_add(bytes.len() + 1)
        .ok_or(ProcessError::new(ProcessErrorKind::Limit, 0))?;
    if next_total > MAX_VECTOR_BYTES {
        return Err(ProcessError::new(ProcessErrorKind::Limit, 0));
    }
    *total_bytes = next_total;
    CString::new(bytes).map_err(|_| ProcessError::new(ProcessErrorKind::InvalidInput, 0))
}

fn validate_absolute_path(path: &Path) -> Result<(), ProcessError> {
    let bytes = path.as_os_str().as_bytes();
    if bytes.len() < 2
        || bytes.len() >= MAX_PATH_BYTES
        || bytes.first() != Some(&b'/')
        || bytes.starts_with(b"//")
        || bytes.ends_with(b"/")
        || bytes.windows(2).any(|pair| pair == b"//")
        || bytes[1..]
            .split(|byte| *byte == b'/')
            .any(|component| component == b"." || component == b"..")
    {
        return Err(ProcessError::new(ProcessErrorKind::InvalidInput, 0));
    }
    let mut components = path.components();
    if components.next() != Some(Component::RootDir)
        || components.any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ProcessError::new(ProcessErrorKind::InvalidInput, 0));
    }
    Ok(())
}

fn validate_descriptors(
    executable: BorrowedFd<'_>,
    cwd: BorrowedFd<'_>,
) -> Result<(), ProcessError> {
    if executable.as_raw_fd() <= libc::STDERR_FILENO
        || cwd.as_raw_fd() <= libc::STDERR_FILENO
        || executable.as_raw_fd() == cwd.as_raw_fd()
    {
        return Err(ProcessError::new(ProcessErrorKind::InvalidInput, 0));
    }
    let executable_mode = descriptor_mode(executable)?;
    let cwd_mode = descriptor_mode(cwd)?;
    if executable_mode & libc::S_IFMT != libc::S_IFREG || cwd_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(ProcessError::new(ProcessErrorKind::InvalidInput, 0));
    }
    Ok(())
}

fn descriptor_mode(fd: BorrowedFd<'_>) -> Result<libc::mode_t, ProcessError> {
    let mut facts = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `facts` is correctly aligned output storage and `fd` remains live.
    if unsafe { libc::fstat(fd.as_raw_fd(), facts.as_mut_ptr()) } != 0 {
        return Err(ProcessError::last(ProcessErrorKind::Io));
    }
    // SAFETY: successful fstat initialized the complete stat structure.
    Ok(unsafe { facts.assume_init() }.st_mode)
}

fn prepare_signal_state() -> Result<SignalState, ProcessError> {
    // SAFETY: these C signal structures are plain initialized storage and are
    // completed by sigemptyset before being used.
    let mut empty_mask = unsafe { MaybeUninit::<libc::sigset_t>::zeroed().assume_init() };
    // SAFETY: `empty_mask` is live output storage.
    if unsafe { libc::sigemptyset(&mut empty_mask) } != 0 {
        return Err(ProcessError::last(ProcessErrorKind::Io));
    }
    #[cfg(target_os = "macos")]
    let default_set = {
        // SAFETY: `signals` is plain writable signal-set storage.
        let mut signals = unsafe { MaybeUninit::<libc::sigset_t>::zeroed().assume_init() };
        // SAFETY: all catchable signals start in the reset set.
        if unsafe { libc::sigfillset(&mut signals) } != 0
            // SAFETY: SIGKILL cannot be caught or reset.
            || unsafe { libc::sigdelset(&mut signals, libc::SIGKILL) } != 0
            // SAFETY: SIGSTOP cannot be caught or reset.
            || unsafe { libc::sigdelset(&mut signals, libc::SIGSTOP) } != 0
        {
            return Err(ProcessError::last(ProcessErrorKind::Io));
        }
        signals
    };
    #[cfg(target_os = "linux")]
    let default_action = {
        // SAFETY: zero is the documented base initialization for sigaction.
        let mut action = unsafe { MaybeUninit::<libc::sigaction>::zeroed().assume_init() };
        action.sa_sigaction = libc::SIG_DFL;
        // SAFETY: `sa_mask` is live output storage.
        if unsafe { libc::sigemptyset(&mut action.sa_mask) } != 0 {
            return Err(ProcessError::last(ProcessErrorKind::Io));
        }
        action.sa_flags = 0;
        action
    };
    Ok(SignalState {
        empty_mask,
        #[cfg(target_os = "macos")]
        default_set,
        #[cfg(target_os = "linux")]
        default_action,
    })
}

fn create_output_pipe() -> Result<Pipe, ProcessError> {
    let pipe = create_cloexec_pipe()?;
    set_nonblocking(&pipe.read)?;
    Ok(pipe)
}

fn create_eof_input() -> Result<OwnedFd, ProcessError> {
    let pipe = create_cloexec_pipe()?;
    drop(pipe.write);
    Ok(pipe.read)
}

fn create_cloexec_pipe() -> Result<Pipe, ProcessError> {
    let mut descriptors = [-1; 2];
    #[cfg(target_os = "linux")]
    {
        // SAFETY: `descriptors` is exact two-element output storage.
        if unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return Err(ProcessError::last(ProcessErrorKind::Io));
        }
    }
    #[cfg(target_os = "macos")]
    {
        // SAFETY: `descriptors` is exact two-element output storage.
        if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
            return Err(ProcessError::last(ProcessErrorKind::Io));
        }
    }
    // SAFETY: a successful pipe/pipe2 returned two uniquely owned descriptors.
    let read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    // SAFETY: ownership of the distinct write descriptor is also unique.
    let write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    #[cfg(target_os = "macos")]
    {
        set_cloexec(&read)?;
        set_cloexec(&write)?;
    }
    Ok(Pipe { read, write })
}

#[cfg(target_os = "macos")]
fn set_cloexec(fd: &OwnedFd) -> Result<(), ProcessError> {
    // SAFETY: F_GETFD reads flags for this live descriptor.
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };
    if flags < 0 {
        return Err(ProcessError::last(ProcessErrorKind::Io));
    }
    // SAFETY: F_SETFD changes only descriptor flags on this live descriptor.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC) } != 0 {
        return Err(ProcessError::last(ProcessErrorKind::Io));
    }
    Ok(())
}

fn set_nonblocking(fd: &OwnedFd) -> Result<(), ProcessError> {
    // SAFETY: F_GETFL reads status flags for this live descriptor.
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
    if flags < 0 {
        return Err(ProcessError::last(ProcessErrorKind::Io));
    }
    // SAFETY: F_SETFL updates only status flags on this live descriptor.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } != 0 {
        return Err(ProcessError::last(ProcessErrorKind::Io));
    }
    Ok(())
}

fn read_stream(
    stream: &mut Option<OwnedFd>,
    destination: &mut [u8],
) -> Result<ChildStreamRead, ProcessError> {
    if destination.is_empty() {
        return Err(ProcessError::new(ProcessErrorKind::InvalidInput, 0));
    }
    let Some(fd) = stream.as_ref() else {
        return Ok(ChildStreamRead::Eof);
    };
    loop {
        // SAFETY: `destination` is live writable storage and `fd` is retained.
        let result = unsafe {
            libc::read(
                fd.as_raw_fd(),
                destination.as_mut_ptr().cast(),
                destination.len(),
            )
        };
        if result > 0 {
            return Ok(ChildStreamRead::Data(result as usize));
        }
        if result == 0 {
            stream.take();
            return Ok(ChildStreamRead::Eof);
        }
        match last_errno() {
            libc::EINTR => continue,
            libc::EAGAIN => return Ok(ChildStreamRead::WouldBlock),
            _ => return Err(ProcessError::last(ProcessErrorKind::Io)),
        }
    }
}

fn decode_wait_status(raw: libc::c_int) -> Result<RootExitStatus, ProcessError> {
    if libc::WIFEXITED(raw) {
        Ok(RootExitStatus::Exited(libc::WEXITSTATUS(raw)))
    } else if libc::WIFSIGNALED(raw) {
        Ok(RootExitStatus::Signaled(libc::WTERMSIG(raw)))
    } else {
        Err(ProcessError::new(ProcessErrorKind::Conflict, 0))
    }
}

#[cfg(target_os = "linux")]
fn linux_only_attested_zombie_root_remains(
    process_group: libc::pid_t,
    root_pid: libc::pid_t,
) -> Result<bool, ProcessError> {
    if process_group <= 0 || root_pid <= 0 || process_group != root_pid {
        return Err(ProcessError::new(ProcessErrorKind::Conflict, 0));
    }

    let procfs = std::fs::File::open("/proc")
        .map_err(|error| ProcessError::new(ProcessErrorKind::Io, raw_io_error(&error)))?;
    let mut facts = MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `facts` is exact writable statfs storage and `procfs` remains
    // open for the call.
    if unsafe { libc::fstatfs(procfs.as_raw_fd(), facts.as_mut_ptr()) } != 0 {
        return Err(ProcessError::last(ProcessErrorKind::Io));
    }
    // SAFETY: successful fstatfs initialized the complete structure.
    let facts = unsafe { facts.assume_init() };
    if facts.f_type as u64 & 0xffff_ffff != LINUX_PROCFS_MAGIC {
        return Err(ProcessError::new(ProcessErrorKind::Unsupported, 0));
    }

    let entries = std::fs::read_dir("/proc")
        .map_err(|error| ProcessError::new(ProcessErrorKind::Io, raw_io_error(&error)))?;
    for (index, entry) in entries.enumerate() {
        if index >= LINUX_PROC_GROUP_SCAN_ENTRY_LIMIT {
            return Err(ProcessError::new(ProcessErrorKind::Limit, 0));
        }
        let entry =
            entry.map_err(|error| ProcessError::new(ProcessErrorKind::Io, raw_io_error(&error)))?;
        let Some(pid) = linux_decimal_pid(entry.file_name().as_bytes()) else {
            continue;
        };
        if pid == root_pid {
            continue;
        }
        loop {
            // SAFETY: `pid` is one positive numeric /proc entry. The unreaped
            // root continues to pin `process_group` against reuse throughout
            // this bounded scan.
            let observed_group = unsafe { libc::getpgid(pid) };
            if observed_group == process_group {
                return Ok(false);
            }
            if observed_group >= 0 {
                break;
            }
            match last_errno() {
                libc::EINTR => continue,
                libc::ESRCH => break,
                code => return Err(ProcessError::new(ProcessErrorKind::Io, code)),
            }
        }
    }
    Ok(true)
}

#[cfg(target_os = "linux")]
fn linux_decimal_pid(value: &[u8]) -> Option<libc::pid_t> {
    if value.is_empty() || value.len() > 10 {
        return None;
    }
    let mut result = 0_i32;
    for byte in value {
        if !byte.is_ascii_digit() {
            return None;
        }
        result = result
            .checked_mul(10)?
            .checked_add(i32::from(*byte - b'0'))?;
    }
    (result > 0).then_some(result)
}

#[cfg(target_os = "linux")]
fn raw_io_error(error: &io::Error) -> i32 {
    error.raw_os_error().unwrap_or(0)
}

fn signal_group(process_group: libc::pid_t, signal: libc::c_int) -> Result<(), ProcessError> {
    // SAFETY: the negative PID addresses this exact process group and callers
    // expose only SIGTERM and SIGKILL.
    if unsafe { libc::kill(-process_group, signal) } == 0 {
        return Ok(());
    }
    if last_errno() == libc::ESRCH {
        Ok(())
    } else {
        Err(ProcessError::last(ProcessErrorKind::Io))
    }
}

fn last_errno() -> i32 {
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn force_kill_and_reap(pid: libc::pid_t) {
    if pid <= 0 {
        return;
    }
    // SAFETY: both calls target only the known child/group and cleanup ignores
    // already-dead errors.
    let _ = unsafe { libc::kill(-pid, libc::SIGKILL) };
    // SAFETY: direct PID cleanup covers failure before process-group creation.
    let _ = unsafe { libc::kill(pid, libc::SIGKILL) };
    let mut status = 0;
    let Some(deadline) = Instant::now().checked_add(REAP_TIMEOUT) else {
        return;
    };
    loop {
        // SAFETY: `status` is live output storage for the exact child.
        let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if result == pid || (result < 0 && last_errno() == libc::ECHILD) {
            break;
        }
        if result < 0 && last_errno() == libc::EINTR {
            continue;
        }
        if result < 0 || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(REAP_POLL_INTERVAL);
    }
}

#[cfg(target_os = "linux")]
const LINUX_CLOSE_RANGE_CLOEXEC: libc::c_uint = 1 << 2;
#[cfg(target_os = "linux")]
const LINUX_AT_EMPTY_PATH: libc::c_int = 0x1000;
#[cfg(target_os = "linux")]
const LINUX_ERROR_RECORD_BYTES: usize = 5;
#[cfg(target_os = "linux")]
const LINUX_LAUNCH_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(target_os = "linux")]
struct LinuxChildContext<'a> {
    executable: RawFd,
    cwd: RawFd,
    stdin: RawFd,
    stdout: RawFd,
    stderr: RawFd,
    error: RawFd,
    argv: *const *mut c_char,
    environment: *const *mut c_char,
    signals: &'a SignalState,
}

#[cfg(target_os = "linux")]
fn spawn_linux(
    request: DirectSpawnRequest<'_>,
    prepared: PreparedSpawn,
    signals: SignalState,
    stdin: OwnedFd,
    stdout: Pipe,
    stderr: Pipe,
) -> Result<DirectChild, ProcessError> {
    let error_pipe = create_cloexec_pipe()?;
    set_nonblocking(&error_pipe.read)?;
    let child = LinuxChildContext {
        executable: request.executable.as_raw_fd(),
        cwd: request.cwd.as_raw_fd(),
        stdin: stdin.as_raw_fd(),
        stdout: stdout.write.as_raw_fd(),
        stderr: stderr.write.as_raw_fd(),
        error: error_pipe.write.as_raw_fd(),
        argv: prepared.argv.as_ptr(),
        environment: prepared.environment.as_ptr(),
        signals: &signals,
    };

    // SAFETY: every allocation and pointer needed by the child was prepared
    // above. The child branch performs only audited async-signal-safe syscalls.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(ProcessError::last(ProcessErrorKind::Launch));
    }
    if pid == 0 {
        // SAFETY: `child` and all referenced storage are inherited unchanged
        // and remain live until execveat or _exit.
        unsafe { linux_child_main(&child) };
    }

    drop(stdin);
    drop(stdout.write);
    drop(stderr.write);
    drop(error_pipe.write);

    // Close the parent/child setpgid race. EACCES means the child already
    // crossed exec; ESRCH means the error pipe will classify an early exit.
    // SAFETY: both values identify the exact positive child PID.
    if unsafe { libc::setpgid(pid, pid) } != 0
        && !matches!(last_errno(), libc::EACCES | libc::ESRCH)
    {
        force_kill_and_reap(pid);
        return Err(ProcessError::last(ProcessErrorKind::Launch));
    }

    if let Err(error) = confirm_linux_exec(&error_pipe.read, request.deadline) {
        force_kill_and_reap(pid);
        return Err(error);
    }
    Ok(DirectChild {
        pid,
        process_group: pid,
        group_authority: ProcessGroupAuthority::Pinned,
        stdout: Some(stdout.read),
        stderr: Some(stderr.read),
        root_status: None,
        terminal_group_signal_sent: false,
        next_group_membership_check: None,
    })
}

#[cfg(target_os = "linux")]
unsafe fn linux_child_main(context: &LinuxChildContext<'_>) -> ! {
    // SAFETY: all calls below operate only on inherited scalar descriptors,
    // preinitialized signal structures, and prebuilt pointer arrays.
    if unsafe { libc::setpgid(0, 0) } != 0 {
        unsafe { linux_child_fail(context.error, 1, linux_child_errno()) };
    }
    if unsafe {
        libc::sigprocmask(
            libc::SIG_SETMASK,
            &context.signals.empty_mask,
            ptr::null_mut(),
        )
    } != 0
    {
        unsafe { linux_child_fail(context.error, 2, linux_child_errno()) };
    }
    // Linux's userspace signal-number ABI is 1 through 64 on both supported
    // GNU targets. Avoid libc's runtime SIGRTMAX helper in the post-fork child.
    for signal in 1..LINUX_SIGNAL_LIMIT_EXCLUSIVE {
        if signal == libc::SIGKILL || signal == libc::SIGSTOP {
            continue;
        }
        if unsafe { libc::sigaction(signal, &context.signals.default_action, ptr::null_mut()) } != 0
        {
            let error = unsafe { linux_child_errno() };
            if error != libc::EINVAL {
                unsafe { linux_child_fail(context.error, 3, error) };
            }
        }
    }
    if unsafe { child_dup2(context.stdin, libc::STDIN_FILENO) } != 0
        || unsafe { child_dup2(context.stdout, libc::STDOUT_FILENO) } != 0
        || unsafe { child_dup2(context.stderr, libc::STDERR_FILENO) } != 0
    {
        unsafe { linux_child_fail(context.error, 4, linux_child_errno()) };
    }
    if unsafe { libc::fchdir(context.cwd) } != 0 {
        unsafe { linux_child_fail(context.error, 5, linux_child_errno()) };
    }
    if unsafe {
        libc::syscall(
            libc::SYS_close_range,
            3_u32,
            libc::c_uint::MAX,
            LINUX_CLOSE_RANGE_CLOEXEC,
        )
    } != 0
    {
        unsafe { linux_child_fail(context.error, 6, linux_child_errno()) };
    }

    let empty_path = b"\0";
    // SAFETY: all strings and both null-terminated pointer arrays were built
    // before fork and remain live; AT_EMPTY_PATH binds execution to the
    // retained executable descriptor without PATH lookup.
    let _ = unsafe {
        libc::syscall(
            libc::SYS_execveat,
            context.executable,
            empty_path.as_ptr().cast::<c_char>(),
            context.argv,
            context.environment,
            LINUX_AT_EMPTY_PATH,
        )
    };
    unsafe { linux_child_fail(context.error, 7, linux_child_errno()) }
}

#[cfg(target_os = "linux")]
unsafe fn child_dup2(source: RawFd, destination: RawFd) -> libc::c_int {
    if source == destination {
        // SAFETY: clearing CLOEXEC on a standard descriptor changes only its
        // descriptor flags.
        unsafe { libc::fcntl(destination, libc::F_SETFD, 0) }
    } else {
        // SAFETY: both values are inherited live descriptor numbers.
        unsafe { libc::dup2(source, destination) }
    }
}

#[cfg(target_os = "linux")]
unsafe fn linux_child_errno() -> i32 {
    // SAFETY: libc exposes thread-local errno storage for the calling child.
    unsafe { *libc::__errno_location() }
}

#[cfg(target_os = "linux")]
unsafe fn linux_child_fail(error_fd: RawFd, stage: u8, code: i32) -> ! {
    let mut record = [0_u8; LINUX_ERROR_RECORD_BYTES];
    let code = code.to_ne_bytes();
    record[0] = stage;
    record[1] = code[0];
    record[2] = code[1];
    record[3] = code[2];
    record[4] = code[3];
    let mut written = 0_usize;
    while written < record.len() {
        // SAFETY: the remaining record bytes are live and `error_fd` is the
        // inherited dedicated error-pipe writer.
        let result = unsafe {
            libc::write(
                error_fd,
                record.as_ptr().add(written).cast(),
                record.len() - written,
            )
        };
        if result > 0 {
            written += result as usize;
        } else if result < 0 && unsafe { linux_child_errno() } == libc::EINTR {
            continue;
        } else {
            break;
        }
    }
    // SAFETY: _exit terminates without running non-async-signal-safe cleanup.
    unsafe { libc::_exit(127) }
}

#[cfg(target_os = "linux")]
fn confirm_linux_exec(error_read: &OwnedFd, request_deadline: Instant) -> Result<(), ProcessError> {
    let mut record = [0_u8; LINUX_ERROR_RECORD_BYTES];
    let mut received = 0_usize;
    // Keep a defense-in-depth launch ceiling while never extending the
    // supervisor's earlier absolute request deadline.
    let internal_deadline = Instant::now()
        .checked_add(LINUX_LAUNCH_TIMEOUT)
        .ok_or(ProcessError::new(ProcessErrorKind::Limit, 0))?;
    let deadline = request_deadline.min(internal_deadline);
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Err(ProcessError::new(
                ProcessErrorKind::Timeout,
                libc::ETIMEDOUT,
            ));
        };
        // poll(2) accepts only whole milliseconds. Rounding down guarantees
        // this individual wait cannot extend beyond the request deadline.
        let timeout_millis = remaining.as_millis();
        let timeout_millis = i32::try_from(timeout_millis).unwrap_or(i32::MAX);
        let mut poll_descriptor = libc::pollfd {
            fd: error_read.as_raw_fd(),
            events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
            revents: 0,
        };
        // SAFETY: the single pollfd is initialized writable storage and the
        // deadline-derived timeout is finite.
        let poll_result = unsafe { libc::poll(&mut poll_descriptor, 1, timeout_millis) };
        if poll_result == 0 {
            if Instant::now() >= deadline {
                return Err(ProcessError::new(
                    ProcessErrorKind::Timeout,
                    libc::ETIMEDOUT,
                ));
            }
            continue;
        }
        if poll_result < 0 {
            if last_errno() == libc::EINTR {
                continue;
            }
            return Err(ProcessError::last(ProcessErrorKind::Io));
        }
        if poll_descriptor.revents & libc::POLLNVAL != 0 {
            return Err(ProcessError::new(ProcessErrorKind::Io, libc::EBADF));
        }
        // SAFETY: the unused record suffix is writable and the descriptor is
        // the retained nonblocking error-pipe reader.
        let result = unsafe {
            libc::read(
                error_read.as_raw_fd(),
                record[received..].as_mut_ptr().cast(),
                record.len() - received,
            )
        };
        if result == 0 {
            return if received == 0 {
                Ok(())
            } else {
                Err(ProcessError::new(ProcessErrorKind::Conflict, 0))
            };
        }
        if result > 0 {
            received += result as usize;
            if received == record.len() {
                let stage = record[0];
                let code = i32::from_ne_bytes([record[1], record[2], record[3], record[4]]);
                if !(1..=7).contains(&stage) || code <= 0 {
                    return Err(ProcessError::new(ProcessErrorKind::Conflict, 0));
                }
                let kind = if stage == 6 && matches!(code, libc::ENOSYS | libc::EINVAL) {
                    ProcessErrorKind::Unsupported
                } else {
                    ProcessErrorKind::Launch
                };
                return Err(ProcessError::new(kind, code));
            }
            continue;
        }
        match last_errno() {
            libc::EINTR | libc::EAGAIN => continue,
            _ => return Err(ProcessError::last(ProcessErrorKind::Io)),
        }
    }
}

#[cfg(target_os = "macos")]
const MACOS_POSIX_SPAWN_SETPGROUP: libc::c_short = 0x0002;
#[cfg(target_os = "macos")]
const MACOS_POSIX_SPAWN_SETSIGDEF: libc::c_short = 0x0004;
#[cfg(target_os = "macos")]
const MACOS_POSIX_SPAWN_SETSIGMASK: libc::c_short = 0x0008;
#[cfg(target_os = "macos")]
const MACOS_POSIX_SPAWN_START_SUSPENDED: libc::c_short = 0x0080;
#[cfg(target_os = "macos")]
const MACOS_POSIX_SPAWN_CLOEXEC_DEFAULT: libc::c_short = 0x4000;
#[cfg(target_os = "macos")]
const MACOS_PROC_PIDREGIONPATHINFO: libc::c_int = 8;
#[cfg(target_os = "macos")]
const MACOS_PROC_PIDTBSDINFO: libc::c_int = 3;
#[cfg(target_os = "macos")]
const MACOS_VM_PROT_EXECUTE: u32 = 0x04;
#[cfg(target_os = "macos")]
const MACOS_MAX_REGIONS: usize = 16_384;
#[cfg(target_os = "macos")]
const MACOS_MAX_PATH: usize = 1_024;
#[cfg(target_os = "macos")]
const MACOS_MAX_COMMAND_NAME: usize = 16;
#[cfg(target_os = "macos")]
const MACOS_ZOMBIE_STATUS: u32 = 5;
#[cfg(target_os = "macos")]
const MACOS_PROCESS_GROUP_QUERY_CAPACITY: usize = 4_096;

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct MacosProcBsdInfo {
    flags: u32,
    status: u32,
    exit_status: u32,
    pid: u32,
    parent_pid: u32,
    uid: u32,
    gid: u32,
    real_uid: u32,
    real_gid: u32,
    saved_uid: u32,
    saved_gid: u32,
    reserved: u32,
    command: [libc::c_char; MACOS_MAX_COMMAND_NAME],
    name: [libc::c_char; MACOS_MAX_COMMAND_NAME * 2],
    file_count: u32,
    process_group: u32,
    job_control_count: u32,
    controlling_terminal: u32,
    terminal_process_group: u32,
    nice: i32,
    start_seconds: u64,
    start_microseconds: u64,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MacosProcessIdentity {
    pid: u32,
    parent_pid: u32,
    process_group: u32,
    uid: u32,
    gid: u32,
    start_seconds: u64,
    start_microseconds: u64,
}

#[cfg(target_os = "macos")]
impl MacosProcessIdentity {
    fn capture_unprivileged_child(
        pid: libc::pid_t,
        process_group: libc::pid_t,
    ) -> Result<Self, ProcessError> {
        let information = macos_process_information(pid)?;
        // SAFETY: these identity accessors have no arguments or memory
        // preconditions and the child remains suspended during this check.
        let uid = unsafe { libc::getuid() };
        // SAFETY: see the getuid call immediately above.
        let effective_uid = unsafe { libc::geteuid() };
        // SAFETY: see the getuid call immediately above.
        let gid = unsafe { libc::getgid() };
        // SAFETY: see the getuid call immediately above.
        let effective_gid = unsafe { libc::getegid() };
        // SAFETY: getpid has no arguments or memory preconditions.
        let parent_pid = unsafe { libc::getpid() };
        let expected_pid =
            u32::try_from(pid).map_err(|_| ProcessError::new(ProcessErrorKind::Conflict, 0))?;
        let expected_group = u32::try_from(process_group)
            .map_err(|_| ProcessError::new(ProcessErrorKind::Conflict, 0))?;
        let expected_parent = u32::try_from(parent_pid)
            .map_err(|_| ProcessError::new(ProcessErrorKind::Conflict, 0))?;
        // SAFETY: issetugid has no arguments or memory preconditions and
        // exposes the sticky privilege-transition state of this supervisor.
        let supervisor_is_setugid = unsafe { libc::issetugid() } != 0;
        if !macos_suspended_child_is_unprivileged(
            &information,
            expected_pid,
            expected_parent,
            expected_group,
            uid,
            effective_uid,
            gid,
            effective_gid,
            supervisor_is_setugid,
        ) {
            return Err(ProcessError::new(ProcessErrorKind::Conflict, 0));
        }
        Ok(Self {
            pid: expected_pid,
            parent_pid: expected_parent,
            process_group: expected_group,
            uid,
            gid,
            start_seconds: information.start_seconds,
            start_microseconds: information.start_microseconds,
        })
    }
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn macos_suspended_child_is_unprivileged(
    information: &MacosProcBsdInfo,
    expected_pid: u32,
    expected_parent: u32,
    expected_group: u32,
    uid: u32,
    effective_uid: u32,
    gid: u32,
    effective_gid: u32,
    supervisor_is_setugid: bool,
) -> bool {
    uid != 0
        && gid != 0
        && uid == effective_uid
        && gid == effective_gid
        && !supervisor_is_setugid
        && information.status != MACOS_ZOMBIE_STATUS
        && information.pid == expected_pid
        && information.parent_pid == expected_parent
        && information.process_group == expected_group
        && [information.uid, information.real_uid, information.saved_uid]
            .into_iter()
            .all(|candidate| candidate == uid)
        && [information.gid, information.real_gid, information.saved_gid]
            .into_iter()
            .all(|candidate| candidate == gid)
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[allow(dead_code)]
struct MacosProcRegionInfo {
    protection: u32,
    max_protection: u32,
    inheritance: u32,
    flags: u32,
    offset: u64,
    behavior: u32,
    user_wired_count: u32,
    user_tag: u32,
    pages_resident: u32,
    pages_shared_now_private: u32,
    pages_swapped_out: u32,
    pages_dirtied: u32,
    reference_count: u32,
    shadow_depth: u32,
    share_mode: u32,
    private_pages_resident: u32,
    shared_pages_resident: u32,
    object_id: u32,
    depth: u32,
    address: u64,
    size: u64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[allow(dead_code)]
struct MacosVinfoStat {
    device: u32,
    mode: u16,
    link_count: u16,
    inode: u64,
    uid: u32,
    gid: u32,
    accessed_seconds: i64,
    accessed_nanoseconds: i64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
    born_seconds: i64,
    born_nanoseconds: i64,
    size: i64,
    blocks: i64,
    block_size: i32,
    flags: u32,
    generation: u32,
    raw_device: u32,
    spare: [i64; 2],
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[allow(dead_code)]
struct MacosVnodeInfo {
    stat: MacosVinfoStat,
    vnode_type: libc::c_int,
    padding: libc::c_int,
    filesystem_id: libc::fsid_t,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[allow(dead_code)]
struct MacosVnodeInfoPath {
    vnode: MacosVnodeInfo,
    path: [libc::c_char; MACOS_MAX_PATH],
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct MacosRegionWithPathInfo {
    region: MacosProcRegionInfo,
    vnode: MacosVnodeInfoPath,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MacosImageIdentity {
    device: u32,
    inode: u64,
    generation: u32,
    size: i64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
    mapped_file_offset: u64,
}

#[cfg(target_os = "macos")]
impl MacosImageIdentity {
    fn from_descriptor(fd: BorrowedFd<'_>, mapped_file_offset: u64) -> Result<Self, ProcessError> {
        let mut facts = MaybeUninit::<libc::stat>::uninit();
        // SAFETY: `facts` is aligned output and `fd` remains retained.
        if unsafe { libc::fstat(fd.as_raw_fd(), facts.as_mut_ptr()) } != 0 {
            return Err(ProcessError::last(ProcessErrorKind::Io));
        }
        // SAFETY: successful fstat initialized the complete structure.
        let facts = unsafe { facts.assume_init() };
        Ok(Self {
            device: facts.st_dev as u32,
            inode: facts.st_ino,
            generation: facts.st_gen,
            size: facts.st_size,
            modified_seconds: facts.st_mtime,
            modified_nanoseconds: facts.st_mtime_nsec,
            changed_seconds: facts.st_ctime,
            changed_nanoseconds: facts.st_ctime_nsec,
            mapped_file_offset,
        })
    }

    fn matches_region(&self, region: &MacosRegionWithPathInfo) -> bool {
        let facts = &region.vnode.vnode.stat;
        region.region.offset == self.mapped_file_offset
            && region.region.protection & MACOS_VM_PROT_EXECUTE != 0
            && facts.device == self.device
            && facts.inode == self.inode
            && facts.generation == self.generation
            && facts.size == self.size
            && facts.modified_seconds == self.modified_seconds
            && facts.modified_nanoseconds == self.modified_nanoseconds
            && facts.changed_seconds == self.changed_seconds
            && facts.changed_nanoseconds == self.changed_nanoseconds
    }
}

#[cfg(target_os = "macos")]
#[link(name = "proc")]
extern "C" {
    fn proc_pidinfo(
        pid: libc::c_int,
        flavor: libc::c_int,
        argument: u64,
        buffer: *mut libc::c_void,
        buffer_size: libc::c_int,
    ) -> libc::c_int;

    fn proc_listpgrppids(
        process_group: libc::pid_t,
        buffer: *mut libc::c_void,
        buffer_size: libc::c_int,
    ) -> libc::c_int;
}

#[cfg(target_os = "macos")]
extern "C" {
    fn posix_spawn_file_actions_addfchdir_np(
        actions: *mut libc::posix_spawn_file_actions_t,
        descriptor: libc::c_int,
    ) -> libc::c_int;
}

#[cfg(target_os = "macos")]
fn macos_process_information(pid: libc::pid_t) -> Result<MacosProcBsdInfo, ProcessError> {
    let expected_size = std::mem::size_of::<MacosProcBsdInfo>();
    let expected_size_i32 = i32::try_from(expected_size)
        .map_err(|_| ProcessError::new(ProcessErrorKind::Unsupported, 0))?;
    let mut information = MaybeUninit::<MacosProcBsdInfo>::zeroed();
    // SAFETY: `information` is exact writable PROC_PIDTBSDINFO storage.
    let result = unsafe {
        proc_pidinfo(
            pid,
            MACOS_PROC_PIDTBSDINFO,
            0,
            information.as_mut_ptr().cast(),
            expected_size_i32,
        )
    };
    if result == 0 {
        return Err(ProcessError::last(ProcessErrorKind::Io));
    }
    if result != expected_size_i32 {
        return Err(ProcessError::new(ProcessErrorKind::Conflict, result));
    }
    // SAFETY: an exact-size successful result initialized the structure.
    Ok(unsafe { information.assume_init() })
}

#[cfg(target_os = "macos")]
fn macos_only_attested_zombie_root_remains(
    process_group: libc::pid_t,
    expected: &MacosProcessIdentity,
) -> Result<bool, ProcessError> {
    // SAFETY: these identity accessors have no arguments or memory
    // preconditions. The supervisor identity is immutable for this launch.
    let current_pid = unsafe { libc::getpid() };
    // SAFETY: see the getpid call immediately above.
    let current_uid = unsafe { libc::getuid() };
    // SAFETY: see the getpid call immediately above.
    let current_effective_uid = unsafe { libc::geteuid() };
    // SAFETY: see the getpid call immediately above.
    let current_gid = unsafe { libc::getgid() };
    // SAFETY: see the getpid call immediately above.
    let current_effective_gid = unsafe { libc::getegid() };
    if expected.process_group
        != u32::try_from(process_group)
            .map_err(|_| ProcessError::new(ProcessErrorKind::Conflict, 0))?
        || expected.parent_pid
            != u32::try_from(current_pid)
                .map_err(|_| ProcessError::new(ProcessErrorKind::Conflict, 0))?
        || expected.uid != current_uid
        || expected.uid != current_effective_uid
        || expected.gid != current_gid
        || expected.gid != current_effective_gid
        || (expected.start_seconds == 0 && expected.start_microseconds == 0)
    {
        return Err(ProcessError::new(ProcessErrorKind::Conflict, 0));
    }

    let mut members = vec![0 as libc::pid_t; MACOS_PROCESS_GROUP_QUERY_CAPACITY];
    let buffer_bytes = members
        .len()
        .checked_mul(std::mem::size_of::<libc::pid_t>())
        .and_then(|bytes| libc::c_int::try_from(bytes).ok())
        .ok_or(ProcessError::new(ProcessErrorKind::Limit, 0))?;
    // SAFETY: `members` is writable for exactly `buffer_bytes`; the retained
    // unreaped root still pins this exact numeric process-group identity.
    let result =
        unsafe { proc_listpgrppids(process_group, members.as_mut_ptr().cast(), buffer_bytes) };
    if result < 0 {
        return Err(ProcessError::last(ProcessErrorKind::Io));
    }
    let count =
        usize::try_from(result).map_err(|_| ProcessError::new(ProcessErrorKind::Conflict, 0))?;
    if count >= members.len() {
        return Err(ProcessError::new(ProcessErrorKind::Limit, 0));
    }
    members.truncate(count);
    members.retain(|pid| *pid > 0);
    if members.as_slice() != [expected.pid as libc::pid_t] {
        return Ok(false);
    }
    // `waitid(..., WNOWAIT)` already proved this exact child exited while
    // retaining its PID. The pre-resume identity above binds its start time
    // and unprivileged credentials, and this group query proves no descendant
    // remains. Darwin alone reports EPERM for a group containing that zombie.
    Ok(true)
}

#[cfg(target_os = "macos")]
struct MacosSpawnActions {
    value: libc::posix_spawn_file_actions_t,
}

#[cfg(target_os = "macos")]
impl MacosSpawnActions {
    fn new() -> Result<Self, ProcessError> {
        let mut value = MaybeUninit::<libc::posix_spawn_file_actions_t>::uninit();
        // SAFETY: `value` is correctly aligned output storage.
        let result = unsafe { libc::posix_spawn_file_actions_init(value.as_mut_ptr()) };
        if result != 0 {
            return Err(ProcessError::new(ProcessErrorKind::Launch, result));
        }
        // SAFETY: successful initialization completed the opaque value.
        Ok(Self {
            value: unsafe { value.assume_init() },
        })
    }

    fn add_dup2(&mut self, source: RawFd, destination: RawFd) -> Result<(), ProcessError> {
        // SAFETY: the action object is initialized and both descriptors are
        // valid at the later posix_spawn call.
        let result =
            unsafe { libc::posix_spawn_file_actions_adddup2(&mut self.value, source, destination) };
        spawn_configuration_result(result)
    }

    fn add_fchdir(&mut self, directory: RawFd) -> Result<(), ProcessError> {
        // SAFETY: the action object is initialized and the directory remains
        // retained through the later posix_spawn call.
        let result = unsafe { posix_spawn_file_actions_addfchdir_np(&mut self.value, directory) };
        spawn_configuration_result(result)
    }
}

#[cfg(target_os = "macos")]
impl Drop for MacosSpawnActions {
    fn drop(&mut self) {
        // SAFETY: this value was successfully initialized and is uniquely owned.
        let _ = unsafe { libc::posix_spawn_file_actions_destroy(&mut self.value) };
    }
}

#[cfg(target_os = "macos")]
struct MacosSpawnAttributes {
    value: libc::posix_spawnattr_t,
}

#[cfg(target_os = "macos")]
impl MacosSpawnAttributes {
    fn new(signals: &SignalState) -> Result<Self, ProcessError> {
        let mut value = MaybeUninit::<libc::posix_spawnattr_t>::uninit();
        // SAFETY: `value` is correctly aligned output storage.
        let result = unsafe { libc::posix_spawnattr_init(value.as_mut_ptr()) };
        if result != 0 {
            return Err(ProcessError::new(ProcessErrorKind::Launch, result));
        }
        // SAFETY: successful initialization completed the opaque value.
        let mut attributes = Self {
            value: unsafe { value.assume_init() },
        };
        let flags = MACOS_POSIX_SPAWN_SETPGROUP
            | MACOS_POSIX_SPAWN_SETSIGDEF
            | MACOS_POSIX_SPAWN_SETSIGMASK
            | MACOS_POSIX_SPAWN_START_SUSPENDED
            | MACOS_POSIX_SPAWN_CLOEXEC_DEFAULT;
        // SAFETY: the attribute object is initialized.
        spawn_configuration_result(unsafe {
            libc::posix_spawnattr_setflags(&mut attributes.value, flags)
        })?;
        // SAFETY: group zero with SETPGROUP creates a group whose ID is the
        // child's PID.
        spawn_configuration_result(unsafe {
            libc::posix_spawnattr_setpgroup(&mut attributes.value, 0)
        })?;
        // SAFETY: both signal sets were initialized before this call.
        spawn_configuration_result(unsafe {
            libc::posix_spawnattr_setsigmask(&mut attributes.value, &signals.empty_mask)
        })?;
        // SAFETY: the default-signal set remains live for this call.
        spawn_configuration_result(unsafe {
            libc::posix_spawnattr_setsigdefault(&mut attributes.value, &signals.default_set)
        })?;
        Ok(attributes)
    }
}

#[cfg(target_os = "macos")]
impl Drop for MacosSpawnAttributes {
    fn drop(&mut self) {
        // SAFETY: this value was successfully initialized and is uniquely owned.
        let _ = unsafe { libc::posix_spawnattr_destroy(&mut self.value) };
    }
}

#[cfg(target_os = "macos")]
fn spawn_configuration_result(result: libc::c_int) -> Result<(), ProcessError> {
    if result == 0 {
        Ok(())
    } else {
        Err(ProcessError::new(ProcessErrorKind::Launch, result))
    }
}

#[cfg(target_os = "macos")]
fn spawn_macos(
    request: DirectSpawnRequest<'_>,
    prepared: PreparedSpawn,
    signals: SignalState,
    stdin: OwnedFd,
    stdout: Pipe,
    stderr: Pipe,
) -> Result<DirectChild, ProcessError> {
    let expected =
        MacosImageIdentity::from_descriptor(request.executable, request.mapped_file_offset)?;
    let mut actions = MacosSpawnActions::new()?;
    actions.add_dup2(stdin.as_raw_fd(), libc::STDIN_FILENO)?;
    actions.add_dup2(stdout.write.as_raw_fd(), libc::STDOUT_FILENO)?;
    actions.add_dup2(stderr.write.as_raw_fd(), libc::STDERR_FILENO)?;
    actions.add_fchdir(request.cwd.as_raw_fd())?;
    let attributes = MacosSpawnAttributes::new(&signals)?;
    let mut pid = 0;
    // SAFETY: path, argv, and environment are terminated retained allocations;
    // actions/attributes remain initialized for the entire call.
    let result = unsafe {
        libc::posix_spawn(
            &mut pid,
            prepared._executable_path.as_ptr(),
            &actions.value,
            &attributes.value,
            prepared.argv.as_ptr(),
            prepared.environment.as_ptr(),
        )
    };
    if result != 0 {
        return Err(ProcessError::new(ProcessErrorKind::Launch, result));
    }
    drop(stdout.write);
    drop(stderr.write);

    // SETPGROUP with a zero group must establish a fresh group identified by
    // this exact still-suspended child before any identity validation/resume.
    // SAFETY: `pid` is the exact positive child returned by posix_spawn.
    let process_group = unsafe { libc::getpgid(pid) };
    if process_group != pid {
        let error = if process_group < 0 {
            ProcessError::last(ProcessErrorKind::Launch)
        } else {
            ProcessError::new(ProcessErrorKind::Conflict, 0)
        };
        force_kill_and_reap(pid);
        return Err(error);
    }

    let current =
        match MacosImageIdentity::from_descriptor(request.executable, request.mapped_file_offset) {
            Ok(identity) => identity,
            Err(error) => {
                force_kill_and_reap(pid);
                return Err(error);
            }
        };
    if current != expected {
        force_kill_and_reap(pid);
        return Err(ProcessError::new(ProcessErrorKind::Conflict, 0));
    }
    match macos_spawned_image_matches(pid, &expected) {
        Ok(true) => {}
        Ok(false) => {
            force_kill_and_reap(pid);
            return Err(ProcessError::new(ProcessErrorKind::Conflict, 0));
        }
        Err(error) => {
            force_kill_and_reap(pid);
            return Err(error);
        }
    }
    let macos_identity = match MacosProcessIdentity::capture_unprivileged_child(pid, process_group)
    {
        Ok(identity) => identity,
        Err(error) => {
            force_kill_and_reap(pid);
            return Err(error);
        }
    };

    // POSIX_SPAWN_START_SUSPENDED guarantees no user-space child instruction
    // ran before the retained-vnode and unprivileged-credential comparisons.
    // SAFETY: `pid` is the still-suspended exact child.
    if unsafe { libc::kill(pid, libc::SIGCONT) } != 0 {
        let error = ProcessError::last(ProcessErrorKind::Launch);
        force_kill_and_reap(pid);
        return Err(error);
    }
    Ok(DirectChild {
        pid,
        process_group: pid,
        group_authority: ProcessGroupAuthority::Pinned,
        macos_identity,
        stdout: Some(stdout.read),
        stderr: Some(stderr.read),
        root_status: None,
        terminal_group_signal_sent: false,
        next_group_membership_check: None,
    })
}

#[cfg(target_os = "macos")]
fn macos_spawned_image_matches(
    pid: libc::pid_t,
    expected: &MacosImageIdentity,
) -> Result<bool, ProcessError> {
    let expected_size = std::mem::size_of::<MacosRegionWithPathInfo>();
    let expected_size_i32 = i32::try_from(expected_size)
        .map_err(|_| ProcessError::new(ProcessErrorKind::Unsupported, 0))?;
    let mut address = 0_u64;
    let mut matches = 0_usize;
    for _ in 0..MACOS_MAX_REGIONS {
        let mut information = MaybeUninit::<MacosRegionWithPathInfo>::zeroed();
        // SAFETY: `information` is exact flavor-sized output storage for our
        // own still-suspended child.
        let result = unsafe {
            proc_pidinfo(
                pid,
                MACOS_PROC_PIDREGIONPATHINFO,
                address,
                information.as_mut_ptr().cast(),
                expected_size_i32,
            )
        };
        if result == 0 {
            return Ok(matches == 1);
        }
        if result < 0 {
            return Err(ProcessError::last(ProcessErrorKind::Io));
        }
        if result != expected_size_i32 {
            return Err(ProcessError::new(ProcessErrorKind::Conflict, result));
        }
        // SAFETY: an exact-size successful result initialized the structure.
        let information = unsafe { information.assume_init() };
        if expected.matches_region(&information) {
            matches = matches
                .checked_add(1)
                .ok_or(ProcessError::new(ProcessErrorKind::Limit, 0))?;
            if matches > 1 {
                return Ok(false);
            }
        }
        if information.region.size == 0 || information.region.address < address {
            return Err(ProcessError::new(ProcessErrorKind::Conflict, 0));
        }
        address = information
            .region
            .address
            .checked_add(information.region.size)
            .ok_or(ProcessError::new(ProcessErrorKind::Limit, 0))?;
    }
    Err(ProcessError::new(ProcessErrorKind::Limit, 0))
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use std::mem::MaybeUninit;
    use std::os::fd::AsRawFd;

    use super::{create_eof_input, ProcessGroupAuthority};
    #[cfg(target_os = "macos")]
    use super::{MacosImageIdentity, MacosRegionWithPathInfo, MACOS_VM_PROT_EXECUTE};

    #[test]
    fn only_a_pinned_process_group_permits_numeric_signalling() {
        assert!(ProcessGroupAuthority::Pinned.permits_signal());
        assert!(!ProcessGroupAuthority::Disarmed.permits_signal());
        assert!(!ProcessGroupAuthority::Lost.permits_signal());
    }

    #[test]
    fn closed_writer_pipe_provides_immediate_stdin_eof() {
        let stdin = create_eof_input().expect("EOF input pipe must be created");
        let mut byte = 0_u8;
        // SAFETY: `stdin` is a live read descriptor and `byte` is writable.
        let result = unsafe {
            libc::read(
                stdin.as_raw_fd(),
                (&mut byte as *mut u8).cast(),
                std::mem::size_of_val(&byte),
            )
        };
        assert_eq!(result, 0, "the closed-writer input pipe must be at EOF");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_proc_group_scan_accepts_only_positive_decimal_pids() {
        use super::linux_decimal_pid;

        assert_eq!(linux_decimal_pid(b"1"), Some(1));
        assert_eq!(linux_decimal_pid(b"2147483647"), Some(i32::MAX));
        for value in [
            b"".as_slice(),
            b"0",
            b"-1",
            b"+1",
            b"01x",
            b"2147483648",
            b"99999999999",
        ] {
            assert_eq!(linux_decimal_pid(value), None, "{value:?}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_exec_confirmation_honors_an_expired_request_deadline() {
        use std::time::{Duration, Instant};

        use super::{confirm_linux_exec, create_cloexec_pipe, set_nonblocking, ProcessErrorKind};

        let error_pipe = create_cloexec_pipe().expect("the launch error pipe must be created");
        set_nonblocking(&error_pipe.read).expect("the launch error pipe must become nonblocking");
        let expired = Instant::now()
            .checked_sub(Duration::from_millis(1))
            .expect("the monotonic clock must represent the immediate past");
        let error = confirm_linux_exec(&error_pipe.read, expired)
            .expect_err("an expired request must not wait in the Linux exec handshake");
        assert_eq!(error.kind, ProcessErrorKind::Timeout);
        assert_eq!(error.code, libc::ETIMEDOUT);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn darwin_zombie_exception_requires_exact_unprivileged_child_identity() {
        use super::{macos_suspended_child_is_unprivileged, MacosProcBsdInfo, MACOS_ZOMBIE_STATUS};

        let mut information = MacosProcBsdInfo {
            status: 3,
            pid: 41,
            parent_pid: 17,
            uid: 501,
            gid: 20,
            real_uid: 501,
            real_gid: 20,
            saved_uid: 501,
            saved_gid: 20,
            process_group: 41,
            ..MacosProcBsdInfo::default()
        };
        let accepted = |information: &MacosProcBsdInfo| {
            macos_suspended_child_is_unprivileged(information, 41, 17, 41, 501, 501, 20, 20, false)
        };
        assert!(accepted(&information));

        information.saved_uid = 0;
        assert!(!accepted(&information));
        information.saved_uid = 501;
        information.status = MACOS_ZOMBIE_STATUS;
        assert!(!accepted(&information));
        information.status = 3;
        information.process_group = 42;
        assert!(!accepted(&information));
        information.process_group = 41;
        assert!(!macos_suspended_child_is_unprivileged(
            &information,
            41,
            17,
            41,
            501,
            501,
            20,
            20,
            true,
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mapped_image_identity_requires_the_exact_attested_slice_offset() {
        let expected = MacosImageIdentity {
            device: 9,
            inode: 10,
            generation: 11,
            size: 12,
            modified_seconds: 13,
            modified_nanoseconds: 14,
            changed_seconds: 15,
            changed_nanoseconds: 16,
            mapped_file_offset: 4_096,
        };
        // SAFETY: this repr(C) process-information fixture contains only integer,
        // fixed-array, and C filesystem-identity fields for which all-zero is a
        // valid test representation. Every field read by `matches_region` is
        // initialized explicitly below.
        let mut region = unsafe { MaybeUninit::<MacosRegionWithPathInfo>::zeroed().assume_init() };
        region.region.protection = MACOS_VM_PROT_EXECUTE;
        region.region.offset = expected.mapped_file_offset;
        region.vnode.vnode.stat.device = expected.device;
        region.vnode.vnode.stat.inode = expected.inode;
        region.vnode.vnode.stat.generation = expected.generation;
        region.vnode.vnode.stat.size = expected.size;
        region.vnode.vnode.stat.modified_seconds = expected.modified_seconds;
        region.vnode.vnode.stat.modified_nanoseconds = expected.modified_nanoseconds;
        region.vnode.vnode.stat.changed_seconds = expected.changed_seconds;
        region.vnode.vnode.stat.changed_nanoseconds = expected.changed_nanoseconds;

        assert!(expected.matches_region(&region));
        region.region.offset = 0;
        assert!(!expected.matches_region(&region));
    }
}
