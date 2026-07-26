use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use plurum_native_secret_memory::zeroize_bytes;

use super::executable::{
    DirectDirectoryLease, DirectExecutableAttestation, DirectExecutableLease,
    DirectExecutableResolver, ExecutableAuthorityError, ExecutableRevision,
    RetainedHandleFootprint, MAX_RETAINED_HANDLES,
};
use super::redaction::{AggregateByteBudget, RedactionError, StreamingRedactor};

#[path = "supervisor/platform.rs"]
mod platform;

const COMMAND_QUEUE_CAPACITY: usize = 1;
const MAX_ARGUMENTS: usize = 64;
const MAX_ARGUMENT_UNITS: usize = 32_767;
const MAX_ARGUMENT_UNITS_TOTAL: usize = 131_072;
const MAX_ENVIRONMENT_ENTRIES: usize = 32;
const MAX_ENVIRONMENT_NAME_BYTES: usize = 64;
const MAX_ENVIRONMENT_VALUE_UNITS: usize = 32_767;
const MAX_ENVIRONMENT_UNITS_TOTAL: usize = 131_072;
const MIN_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_OUTPUT_BYTES: usize = 1_024 * 1_024;
const POLL_INTERVAL: Duration = Duration::from_millis(2);
const TERMINATION_GRACE: Duration = Duration::from_millis(250);
const CLEANUP_DEADLINE: Duration = Duration::from_secs(2);
const STREAM_CHUNK_BYTES: usize = 8 * 1_024;

const ALLOWED_ENVIRONMENT_KEYS: &[&str] = &[
    "APPDATA",
    "CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS",
    "CLAUDE_CODE_PLUGIN_PREFER_HTTPS",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "HOME",
    "LOCALAPPDATA",
    "NO_COLOR",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
];

const DIRECTORY_ENVIRONMENT_KEYS: &[&str] = &[
    "APPDATA",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "HOME",
    "LOCALAPPDATA",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeProcessError {
    InvalidRequest,
    Unsafe,
    AuthorityLost,
    Unavailable,
    Unsupported,
    LaunchFailed,
    OutputTooLarge,
    OutputInvalid,
    Timeout,
    Cancelled,
    CleanupFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeProcessTermination {
    Exited(u32),
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    Signaled(i32),
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct NativeProcessOutput {
    pub(crate) termination: NativeProcessTermination,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

pub(crate) struct NativeProcessRequest {
    pub(crate) executable_revision: ExecutableRevision,
    pub(crate) arguments: Vec<String>,
    pub(crate) working_directory: PathBuf,
    pub(crate) environment: Vec<(String, String)>,
    pub(crate) timeout: Duration,
    pub(crate) max_output_bytes: usize,
    pub(crate) sensitive_values: Vec<Vec<u8>>,
    pub(crate) cancellation: NativeProcessCancellation,
    #[cfg(feature = "test-support")]
    pub(crate) before_spawn_barrier: Option<NativeProcessBeforeSpawnBarrier>,
}

impl Drop for NativeProcessRequest {
    fn drop(&mut self) {
        wipe_sensitive_values(&mut self.sensitive_values);
    }
}

#[cfg(feature = "test-support")]
pub(crate) struct NativeProcessBeforeSpawnBarrier {
    pub(crate) ready: mpsc::Sender<()>,
    pub(crate) proceed: Receiver<()>,
}

#[cfg(feature = "test-support")]
impl NativeProcessBeforeSpawnBarrier {
    fn wait(&self, deadline: Instant) -> Result<(), NativeProcessError> {
        self.ready
            .send(())
            .map_err(|_| NativeProcessError::Unavailable)?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(NativeProcessError::Timeout)?;
        match self.proceed.recv_timeout(remaining) {
            Ok(()) => Ok(()),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(NativeProcessError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(NativeProcessError::Unavailable),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct NativeProcessCancellation {
    cancelled: Arc<AtomicBool>,
}

impl NativeProcessCancellation {
    pub(crate) fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

struct WeightedEntry<K, V> {
    key: K,
    weight: usize,
    value: V,
}

struct WeightedFifo<K, V> {
    entries: VecDeque<WeightedEntry<K, V>>,
    retained: usize,
    capacity: usize,
}

impl<K: Copy + Eq, V> WeightedFifo<K, V> {
    fn new(capacity: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            retained: 0,
            capacity,
        }
    }

    fn retained(&self) -> usize {
        debug_assert!(self.accounting_is_valid());
        self.retained
    }

    fn accounting_is_valid(&self) -> bool {
        self.entries
            .iter()
            .try_fold(0_usize, |total, entry| {
                if entry.weight == 0 {
                    None
                } else {
                    total.checked_add(entry.weight)
                }
            })
            .is_some_and(|total| total == self.retained && total <= self.capacity)
    }

    fn get(&self, key: K) -> Option<&V> {
        self.entries
            .iter()
            .find(|entry| entry.key == key)
            .map(|entry| &entry.value)
    }

    fn reserve(
        &mut self,
        additional_peak: usize,
        protected: Option<K>,
    ) -> Result<(), ExecutableAuthorityError> {
        if additional_peak == 0 || additional_peak > self.capacity {
            return Err(ExecutableAuthorityError::Limit);
        }
        while self
            .retained
            .checked_add(additional_peak)
            .is_none_or(|total| total > self.capacity)
        {
            let index = self
                .entries
                .iter()
                .position(|entry| Some(entry.key) != protected)
                .ok_or(ExecutableAuthorityError::Limit)?;
            let removed = self
                .entries
                .remove(index)
                .ok_or(ExecutableAuthorityError::Unavailable)?;
            self.retained = self
                .retained
                .checked_sub(removed.weight)
                .ok_or(ExecutableAuthorityError::Unavailable)?;
            debug_assert!(self.accounting_is_valid());
        }
        debug_assert!(self.accounting_is_valid());
        Ok(())
    }

    fn insert(&mut self, key: K, weight: usize, value: V) -> Result<(), ExecutableAuthorityError> {
        if weight == 0
            || self.entries.iter().any(|entry| entry.key == key)
            || self
                .retained
                .checked_add(weight)
                .is_none_or(|total| total > self.capacity)
        {
            return Err(ExecutableAuthorityError::Limit);
        }
        self.retained += weight;
        self.entries.push_back(WeightedEntry { key, weight, value });
        debug_assert!(self.accounting_is_valid());
        Ok(())
    }
}

type ExecutableLeaseCache = WeightedFifo<ExecutableRevision, DirectExecutableLease>;

enum SupervisorCommand {
    Resolve {
        candidate: PathBuf,
        excluded_project_directory: PathBuf,
        reply: SyncSender<Result<DirectExecutableAttestation, NativeProcessError>>,
    },
    Run {
        request: NativeProcessRequest,
        reply: SyncSender<Result<NativeProcessOutput, NativeProcessError>>,
    },
    Shutdown,
}

pub(crate) struct NativeProcessSupervisor {
    commands: SyncSender<SupervisorCommand>,
    worker: Option<JoinHandle<()>>,
}

impl NativeProcessSupervisor {
    pub(crate) fn start() -> Result<Self, NativeProcessError> {
        let (commands, receiver) = mpsc::sync_channel(COMMAND_QUEUE_CAPACITY);
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("plurum-native-process-supervisor".to_owned())
            .spawn(move || worker_main(receiver, ready_sender))
            .map_err(|_| NativeProcessError::Unavailable)?;
        match ready_receiver.recv() {
            Ok(Ok(())) => Ok(Self {
                commands,
                worker: Some(worker),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(_) => {
                let _ = worker.join();
                Err(NativeProcessError::Unavailable)
            }
        }
    }

    pub(crate) fn inspect_direct_candidate(
        &mut self,
        candidate: PathBuf,
        excluded_project_directory: PathBuf,
    ) -> Result<DirectExecutableAttestation, NativeProcessError> {
        let (reply, result) = mpsc::sync_channel(1);
        self.commands
            .send(SupervisorCommand::Resolve {
                candidate,
                excluded_project_directory,
                reply,
            })
            .map_err(|_| NativeProcessError::Unavailable)?;
        result.recv().map_err(|_| NativeProcessError::Unavailable)?
    }

    pub(crate) fn run(
        &mut self,
        request: NativeProcessRequest,
    ) -> Result<NativeProcessOutput, NativeProcessError> {
        let (reply, result) = mpsc::sync_channel(1);
        self.commands
            .send(SupervisorCommand::Run { request, reply })
            .map_err(|_| NativeProcessError::Unavailable)?;
        result.recv().map_err(|_| NativeProcessError::Unavailable)?
    }
}

impl Drop for NativeProcessSupervisor {
    fn drop(&mut self) {
        let _ = self.commands.send(SupervisorCommand::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn worker_main(
    receiver: Receiver<SupervisorCommand>,
    ready: SyncSender<Result<(), NativeProcessError>>,
) {
    let mut resolver = match DirectExecutableResolver::capture() {
        Ok(resolver) => {
            let _ = ready.send(Ok(()));
            resolver
        }
        Err(error) => {
            let _ = ready.send(Err(map_executable_error(error)));
            return;
        }
    };
    let mut leases = ExecutableLeaseCache::new(MAX_RETAINED_HANDLES);
    while let Ok(command) = receiver.recv() {
        match command {
            SupervisorCommand::Resolve {
                candidate,
                excluded_project_directory,
                reply,
            } => {
                let result = (|| {
                    let footprint =
                        resolver.resolve_footprint(&candidate, &excluded_project_directory)?;
                    leases.reserve(footprint.capture_peak, None)?;
                    let lease = resolver.resolve(
                        &candidate,
                        &excluded_project_directory,
                        leases.retained(),
                    )?;
                    let attestation = lease.attestation().clone();
                    leases.insert(attestation.revision, lease.retained_handles(), lease)?;
                    Ok(attestation)
                })()
                .map_err(map_executable_error);
                let _ = reply.send(result);
            }
            SupervisorCommand::Run { request, reply } => {
                let result = run_request(&resolver, &mut leases, request);
                let _ = reply.send(result);
            }
            SupervisorCommand::Shutdown => break,
        }
    }
}

fn run_request(
    resolver: &DirectExecutableResolver,
    leases: &mut ExecutableLeaseCache,
    request: NativeProcessRequest,
) -> Result<NativeProcessOutput, NativeProcessError> {
    run_request_inner(resolver, leases, &request)
}

fn run_request_inner(
    resolver: &DirectExecutableResolver,
    leases: &mut ExecutableLeaseCache,
    request: &NativeProcessRequest,
) -> Result<NativeProcessOutput, NativeProcessError> {
    validate_request_shape(request)?;
    let deadline = Instant::now()
        .checked_add(request.timeout)
        .ok_or(NativeProcessError::InvalidRequest)?;
    check_request_boundary(request, deadline)?;

    let environment_directory_paths = validate_environment(request)?;
    let directory_paths =
        dedupe_directory_paths(&request.working_directory, &environment_directory_paths);
    check_request_boundary(request, deadline)?;

    let expected = leases
        .get(request.executable_revision)
        .ok_or(NativeProcessError::AuthorityLost)?;
    let executable_footprint = resolver
        .reattest_footprint(expected)
        .map_err(map_executable_error)?;
    let directory_footprints = directory_paths
        .iter()
        .map(|path| resolver.directory_footprint(path, expected))
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_executable_error)?;
    let reservation = attestation_reservation(executable_footprint, &directory_footprints)
        .map_err(map_executable_error)?;
    leases
        .reserve(reservation, Some(request.executable_revision))
        .map_err(map_executable_error)?;
    check_request_boundary(request, deadline)?;

    let expected = leases
        .get(request.executable_revision)
        .ok_or(NativeProcessError::AuthorityLost)?;
    let executable = resolver
        .reattest(expected, leases.retained())
        .map_err(map_executable_error)?;
    check_request_boundary(request, deadline)?;

    let mut active_retained = leases
        .retained()
        .checked_add(executable.retained_handles())
        .ok_or(NativeProcessError::InvalidRequest)?;
    let mut directories = Vec::with_capacity(directory_paths.len());
    for path in &directory_paths {
        let directory = resolver
            .resolve_directory(path, &executable, active_retained)
            .map_err(map_executable_error)?;
        active_retained = active_retained
            .checked_add(directory.retained_handles())
            .ok_or(NativeProcessError::InvalidRequest)?;
        directories.push(directory);
        check_request_boundary(request, deadline)?;
    }
    let working_directory = directories
        .first()
        .ok_or(NativeProcessError::InvalidRequest)?;

    let mut stdout_redactor =
        StreamingRedactor::new(request.sensitive_values.to_vec()).map_err(map_redaction_error)?;
    let mut stderr_redactor =
        StreamingRedactor::new(request.sensitive_values.to_vec()).map_err(map_redaction_error)?;
    let mut budget = AggregateByteBudget::new(request.max_output_bytes, request.max_output_bytes);
    let mut stdout = StrictUtf8Output::new(request.max_output_bytes);
    let mut stderr = StrictUtf8Output::new(request.max_output_bytes);

    #[cfg(feature = "test-support")]
    if let Some(barrier) = &request.before_spawn_barrier {
        barrier.wait(deadline)?;
        check_request_boundary(request, deadline)?;
    }
    let mut child = platform::spawn(
        resolver,
        &executable,
        working_directory,
        &request.arguments,
        &request.environment,
        deadline,
    )?;
    if let Err(error) = check_request_boundary(request, deadline) {
        return Err(fail_child(&mut child, error));
    }
    let mut stdout_eof = false;
    let mut stderr_eof = false;
    let mut root_status = None;

    loop {
        if request.cancellation.is_cancelled() {
            return Err(fail_child(&mut child, NativeProcessError::Cancelled));
        }
        let mut progressed = false;
        progressed |= drain_stream(
            &mut child,
            platform::Stream::Stdout,
            &mut stdout_eof,
            &mut stdout_redactor,
            &mut stdout,
            &mut budget,
        )
        .map_err(|error| fail_child(&mut child, error))?;
        progressed |= drain_stream(
            &mut child,
            platform::Stream::Stderr,
            &mut stderr_eof,
            &mut stderr_redactor,
            &mut stderr,
            &mut budget,
        )
        .map_err(|error| fail_child(&mut child, error))?;

        if root_status.is_none() {
            root_status = platform::try_wait(&mut child)
                .map_err(|_| fail_child(&mut child, NativeProcessError::Unavailable))?;
            progressed |= root_status.is_some();
        }
        let tree_alive = platform::tree_alive(&child)
            .map_err(|_| fail_child(&mut child, NativeProcessError::Unavailable))?;
        if root_status.is_some() && !tree_alive && stdout_eof && stderr_eof {
            break;
        }
        if Instant::now() >= deadline {
            return Err(fail_child(&mut child, NativeProcessError::Timeout));
        }
        if !progressed {
            thread::sleep(POLL_INTERVAL);
        }
    }

    let stdout_tail = stdout_redactor
        .finish(&mut budget)
        .map_err(|error| fail_child(&mut child, map_redaction_error(error)))?;
    stdout
        .push(stdout_tail)
        .map_err(|error| fail_child(&mut child, error))?;
    let stderr_tail = stderr_redactor
        .finish(&mut budget)
        .map_err(|error| fail_child(&mut child, map_redaction_error(error)))?;
    stderr
        .push(stderr_tail)
        .map_err(|error| fail_child(&mut child, error))?;

    let termination = root_status.ok_or(NativeProcessError::CleanupFailed)?;
    let stdout = stdout.finish()?;
    let stderr = stderr.finish()?;

    check_request_boundary(request, deadline)?;
    let post_attestation_base = active_retained
        .checked_add(platform::RETAINED_CHILD_PATH_GUARDS)
        .ok_or(NativeProcessError::InvalidRequest)?;
    let refreshed_executable = resolver
        .reattest(&executable, post_attestation_base)
        .map_err(map_executable_error)?;
    drop(refreshed_executable);
    check_request_boundary(request, deadline)?;
    for directory in &directories {
        let refreshed_directory = resolver
            .reattest_directory(directory, post_attestation_base)
            .map_err(map_executable_error)?;
        drop(refreshed_directory);
        check_request_boundary(request, deadline)?;
    }

    Ok(NativeProcessOutput {
        termination,
        stdout,
        stderr,
    })
}

fn validate_request_shape(request: &NativeProcessRequest) -> Result<(), NativeProcessError> {
    if request.timeout < MIN_TIMEOUT
        || request.timeout > MAX_TIMEOUT
        || request.max_output_bytes == 0
        || request.max_output_bytes > MAX_OUTPUT_BYTES
        || request.arguments.len() > MAX_ARGUMENTS
        || request.environment.len() > MAX_ENVIRONMENT_ENTRIES
    {
        return Err(NativeProcessError::InvalidRequest);
    }

    let mut argument_units = 0_usize;
    for argument in &request.arguments {
        let units = platform_string_units(argument);
        argument_units = argument_units
            .checked_add(units)
            .ok_or(NativeProcessError::InvalidRequest)?;
        if units > MAX_ARGUMENT_UNITS
            || argument_units > MAX_ARGUMENT_UNITS_TOTAL
            || contains_control(argument)
            || contains_sensitive_marker(argument.as_bytes())
            || contains_explicit_sensitive(argument.as_bytes(), &request.sensitive_values)
        {
            return Err(NativeProcessError::InvalidRequest);
        }
    }
    Ok(())
}

fn validate_environment(
    request: &NativeProcessRequest,
) -> Result<Vec<PathBuf>, NativeProcessError> {
    let mut seen = HashSet::with_capacity(request.environment.len());
    let mut total_units = 0_usize;
    let mut directories = Vec::new();
    let mut system_root: Option<&str> = None;
    let mut windows_directory: Option<&str> = None;

    for (name, value) in &request.environment {
        if name.is_empty()
            || name.len() > MAX_ENVIRONMENT_NAME_BYTES
            || !name.is_ascii()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            || !ALLOWED_ENVIRONMENT_KEYS.contains(&name.as_str())
            || !seen.insert(platform_environment_key(name))
            || (value.is_empty() && name != "NO_COLOR")
            || contains_control(value)
            || contains_sensitive_marker(value.as_bytes())
            || contains_explicit_sensitive(value.as_bytes(), &request.sensitive_values)
        {
            return Err(NativeProcessError::InvalidRequest);
        }
        let units = platform_string_units(value);
        total_units = total_units
            .checked_add(name.len())
            .and_then(|total| total.checked_add(units))
            .ok_or(NativeProcessError::InvalidRequest)?;
        if units > MAX_ENVIRONMENT_VALUE_UNITS || total_units > MAX_ENVIRONMENT_UNITS_TOTAL {
            return Err(NativeProcessError::InvalidRequest);
        }

        if DIRECTORY_ENVIRONMENT_KEYS.contains(&name.as_str()) {
            directories.push(PathBuf::from(value));
            if name == "SystemRoot" {
                system_root = Some(value);
            } else if name == "WINDIR" {
                windows_directory = Some(value);
            }
        } else {
            validate_literal_environment(name, value)?;
        }
    }

    if let (Some(system_root), Some(windows_directory)) = (system_root, windows_directory) {
        if !platform_path_eq(Path::new(system_root), Path::new(windows_directory)) {
            return Err(NativeProcessError::InvalidRequest);
        }
    }
    Ok(directories)
}

fn dedupe_directory_paths(
    working_directory: &Path,
    environment_directories: &[PathBuf],
) -> Vec<PathBuf> {
    let mut unique = Vec::with_capacity(environment_directories.len() + 1);
    unique.push(working_directory.to_path_buf());
    for path in environment_directories {
        if !unique
            .iter()
            .any(|retained| platform_path_eq(retained, path))
        {
            unique.push(path.clone());
        }
    }
    unique
}

fn attestation_reservation(
    executable: RetainedHandleFootprint,
    directories: &[RetainedHandleFootprint],
) -> Result<usize, ExecutableAuthorityError> {
    let mut pre_spawn_peak = executable.capture_peak;
    let mut active = executable.retained;
    let mut largest_post_capture = executable.capture_peak;
    for directory in directories {
        pre_spawn_peak = pre_spawn_peak.max(
            active
                .checked_add(directory.capture_peak)
                .ok_or(ExecutableAuthorityError::Limit)?,
        );
        active = active
            .checked_add(directory.retained)
            .ok_or(ExecutableAuthorityError::Limit)?;
        largest_post_capture = largest_post_capture.max(directory.capture_peak);
    }
    pre_spawn_peak = pre_spawn_peak.max(active);
    let post_spawn_active = active
        .checked_add(platform::RETAINED_CHILD_PATH_GUARDS)
        .ok_or(ExecutableAuthorityError::Limit)?;
    pre_spawn_peak = pre_spawn_peak.max(post_spawn_active);
    let post_spawn_peak = post_spawn_active
        .checked_add(largest_post_capture)
        .ok_or(ExecutableAuthorityError::Limit)?;
    Ok(pre_spawn_peak.max(post_spawn_peak))
}

fn check_request_boundary(
    request: &NativeProcessRequest,
    deadline: Instant,
) -> Result<(), NativeProcessError> {
    // Filesystem and most kernel calls are synchronous. Cancellation and
    // timeout are observed at these boundaries; Linux's exec handshake also
    // receives the absolute deadline and bounds its poll internally.
    if request.cancellation.is_cancelled() {
        Err(NativeProcessError::Cancelled)
    } else if Instant::now() >= deadline {
        Err(NativeProcessError::Timeout)
    } else {
        Ok(())
    }
}

fn validate_literal_environment(name: &str, value: &str) -> Result<(), NativeProcessError> {
    match name {
        "NO_COLOR" if value.is_empty() || value == "1" => Ok(()),
        "CLAUDE_CODE_PLUGIN_PREFER_HTTPS" if value == "1" => Ok(()),
        "CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS" => {
            let timeout = value
                .parse::<u32>()
                .map_err(|_| NativeProcessError::InvalidRequest)?;
            if (1_000..=120_000).contains(&timeout) && !value.starts_with('0') {
                Ok(())
            } else {
                Err(NativeProcessError::InvalidRequest)
            }
        }
        _ => Err(NativeProcessError::InvalidRequest),
    }
}

fn drain_stream(
    child: &mut platform::PlatformChild,
    stream: platform::Stream,
    eof: &mut bool,
    redactor: &mut StreamingRedactor,
    output: &mut StrictUtf8Output,
    budget: &mut AggregateByteBudget,
) -> Result<bool, NativeProcessError> {
    if *eof {
        return Ok(false);
    }
    let mut progressed = false;
    for _ in 0..64 {
        match platform::read_stream(child, stream, STREAM_CHUNK_BYTES)
            .map_err(|_| NativeProcessError::Unavailable)?
        {
            platform::ReadState::Pending => break,
            platform::ReadState::Eof => {
                *eof = true;
                progressed = true;
                break;
            }
            platform::ReadState::Data(mut bytes) => {
                progressed = true;
                let redacted = redactor.push(&bytes, budget).map_err(map_redaction_error);
                zeroize_bytes(&mut bytes);
                output.push(redacted?)?;
            }
        }
    }
    Ok(progressed)
}

fn fail_child(
    child: &mut platform::PlatformChild,
    error: NativeProcessError,
) -> NativeProcessError {
    if terminate_and_reap(child).is_ok() {
        error
    } else {
        NativeProcessError::CleanupFailed
    }
}

fn terminate_and_reap(child: &mut platform::PlatformChild) -> Result<(), NativeProcessError> {
    let _ = platform::terminate(child);
    let grace_end = Instant::now()
        .checked_add(TERMINATION_GRACE)
        .ok_or(NativeProcessError::CleanupFailed)?;
    let mut root_done = false;
    while Instant::now() < grace_end {
        discard_available_output(child);
        root_done |= platform::try_wait(child)
            .map_err(|_| NativeProcessError::CleanupFailed)?
            .is_some();
        if root_done
            && !platform::tree_alive(child).map_err(|_| NativeProcessError::CleanupFailed)?
        {
            return Ok(());
        }
        thread::sleep(POLL_INTERVAL);
    }

    let _ = platform::kill(child);
    let cleanup_end = Instant::now()
        .checked_add(CLEANUP_DEADLINE)
        .ok_or(NativeProcessError::CleanupFailed)?;
    while Instant::now() < cleanup_end {
        discard_available_output(child);
        root_done |= platform::try_wait(child)
            .map_err(|_| NativeProcessError::CleanupFailed)?
            .is_some();
        if root_done
            && !platform::tree_alive(child).map_err(|_| NativeProcessError::CleanupFailed)?
        {
            return Ok(());
        }
        thread::sleep(POLL_INTERVAL);
    }
    Err(NativeProcessError::CleanupFailed)
}

fn discard_available_output(child: &mut platform::PlatformChild) {
    for stream in [platform::Stream::Stdout, platform::Stream::Stderr] {
        for _ in 0..64 {
            match platform::read_stream(child, stream, STREAM_CHUNK_BYTES) {
                Ok(platform::ReadState::Data(mut bytes)) => zeroize_bytes(&mut bytes),
                Ok(platform::ReadState::Pending | platform::ReadState::Eof) | Err(_) => break,
            }
        }
    }
}

struct StrictUtf8Output {
    bytes: Vec<u8>,
    validated: usize,
    limit: usize,
    failed: bool,
}

impl StrictUtf8Output {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            validated: 0,
            limit,
            failed: false,
        }
    }

    fn push(&mut self, mut chunk: Vec<u8>) -> Result<(), NativeProcessError> {
        if self.failed
            || self
                .bytes
                .len()
                .checked_add(chunk.len())
                .is_none_or(|length| length > self.limit)
        {
            zeroize_bytes(&mut chunk);
            self.fail();
            return Err(NativeProcessError::OutputTooLarge);
        }
        self.bytes.append(&mut chunk);
        match std::str::from_utf8(&self.bytes[self.validated..]) {
            Ok(_) => {
                self.validated = self.bytes.len();
                Ok(())
            }
            Err(error) if error.error_len().is_none() => {
                self.validated += error.valid_up_to();
                if self.bytes.len() - self.validated <= 3 {
                    Ok(())
                } else {
                    self.fail();
                    Err(NativeProcessError::OutputInvalid)
                }
            }
            Err(_) => {
                self.fail();
                Err(NativeProcessError::OutputInvalid)
            }
        }
    }

    fn finish(mut self) -> Result<String, NativeProcessError> {
        if self.failed || self.validated != self.bytes.len() {
            self.fail();
            return Err(NativeProcessError::OutputInvalid);
        }
        String::from_utf8(std::mem::take(&mut self.bytes)).map_err(|error| {
            let mut bytes = error.into_bytes();
            zeroize_bytes(&mut bytes);
            NativeProcessError::OutputInvalid
        })
    }

    fn fail(&mut self) {
        self.failed = true;
        zeroize_bytes(&mut self.bytes);
        self.bytes.clear();
        self.validated = 0;
    }
}

impl Drop for StrictUtf8Output {
    fn drop(&mut self) {
        zeroize_bytes(&mut self.bytes);
    }
}

fn contains_control(value: &str) -> bool {
    value
        .chars()
        .any(|character| character <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&character))
}

fn contains_explicit_sensitive(value: &[u8], patterns: &[Vec<u8>]) -> bool {
    patterns
        .iter()
        .any(|pattern| !pattern.is_empty() && contains_bytes(value, pattern))
}

fn contains_sensitive_marker(value: &[u8]) -> bool {
    [
        b"plrm_live_".as_slice(),
        b"plrm_test_".as_slice(),
        b"plurum_api_key".as_slice(),
        b"authorization".as_slice(),
        b"bearer ".as_slice(),
        b"api_key".as_slice(),
        b"api-key".as_slice(),
        b"api key".as_slice(),
        b"access_token".as_slice(),
        b"access-token".as_slice(),
        b"access token".as_slice(),
        b"secret".as_slice(),
        b"password".as_slice(),
        b"private key".as_slice(),
    ]
    .iter()
    .any(|needle| contains_ascii_case_insensitive(value, needle))
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    needle.len() <= haystack.len()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    needle.len() <= haystack.len()
        && haystack.windows(needle.len()).any(|window| {
            window
                .iter()
                .zip(needle)
                .all(|(left, right)| left.eq_ignore_ascii_case(right))
        })
}

fn platform_string_units(value: &str) -> usize {
    #[cfg(target_os = "windows")]
    {
        value.encode_utf16().count()
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        value.len()
    }
}

fn platform_environment_key(name: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        name.to_ascii_uppercase()
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        name.to_owned()
    }
}

fn platform_path_eq(left: &Path, right: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        left.to_str()
            .zip(right.to_str())
            .is_some_and(|(left, right)| left.eq_ignore_ascii_case(right))
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        left == right
    }
}

fn map_executable_error(error: ExecutableAuthorityError) -> NativeProcessError {
    match error {
        ExecutableAuthorityError::InvalidInput | ExecutableAuthorityError::Limit => {
            NativeProcessError::InvalidRequest
        }
        ExecutableAuthorityError::Missing | ExecutableAuthorityError::Unavailable => {
            NativeProcessError::Unavailable
        }
        ExecutableAuthorityError::Unsafe => NativeProcessError::Unsafe,
        ExecutableAuthorityError::Conflict => NativeProcessError::AuthorityLost,
        ExecutableAuthorityError::Unsupported => NativeProcessError::Unsupported,
    }
}

fn map_redaction_error(error: RedactionError) -> NativeProcessError {
    match error {
        RedactionError::RawBudgetExceeded | RedactionError::EmittedBudgetExceeded => {
            NativeProcessError::OutputTooLarge
        }
        RedactionError::InvalidPatternCount
        | RedactionError::InvalidPatternLength
        | RedactionError::DuplicatePattern => NativeProcessError::InvalidRequest,
        RedactionError::AllocationFailed => NativeProcessError::Unavailable,
        RedactionError::AlreadyFinished | RedactionError::Failed => {
            NativeProcessError::OutputInvalid
        }
    }
}

fn wipe_sensitive_values(values: &mut Vec<Vec<u8>>) {
    for value in values.iter_mut() {
        zeroize_bytes(value);
        value.clear();
    }
    values.clear();
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    #[cfg(feature = "test-support")]
    use std::env;
    #[cfg(feature = "test-support")]
    use std::ffi::OsStr;
    #[cfg(feature = "test-support")]
    use std::fs;
    #[cfg(feature = "test-support")]
    use std::fs::OpenOptions;
    #[cfg(all(feature = "test-support", target_os = "macos"))]
    use std::os::fd::AsFd;
    #[cfg(all(
        feature = "test-support",
        any(target_os = "macos", target_os = "linux")
    ))]
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[cfg(all(feature = "test-support", target_os = "windows"))]
    use std::os::windows::fs::OpenOptionsExt;
    #[cfg(feature = "test-support")]
    use std::path::Path;
    #[cfg(feature = "test-support")]
    use std::sync::mpsc;
    #[cfg(feature = "test-support")]
    use std::thread;
    #[cfg(feature = "test-support")]
    use std::time::{Duration, Instant};

    #[cfg(all(
        feature = "test-support",
        any(target_os = "macos", target_os = "linux")
    ))]
    use crate::posix::ProcessEvidenceRoot;
    #[cfg(all(feature = "test-support", target_os = "windows"))]
    use crate::windows::ProcessEvidenceRoot;
    #[cfg(all(feature = "test-support", target_os = "windows"))]
    use plurum_windows_syscall::SecurityKind;

    use super::{
        attestation_reservation, contains_ascii_case_insensitive, contains_control,
        contains_sensitive_marker, dedupe_directory_paths, NativeProcessError, StrictUtf8Output,
        WeightedFifo,
    };
    #[cfg(feature = "test-support")]
    use super::{
        NativeProcessBeforeSpawnBarrier, NativeProcessCancellation, NativeProcessOutput,
        NativeProcessRequest, NativeProcessSupervisor, NativeProcessTermination,
    };
    #[cfg(all(
        feature = "test-support",
        any(target_os = "macos", target_os = "linux")
    ))]
    use crate::runtime::executable::ExecutableAuthorityError;
    #[cfg(target_os = "windows")]
    use crate::runtime::executable::MAX_RETAINED_HANDLES;
    #[cfg(all(feature = "test-support", target_os = "macos"))]
    use crate::runtime::executable::{diagnose_direct_candidate, DirectCandidateDiagnostic};
    #[cfg(feature = "test-support")]
    use crate::runtime::executable::{
        DirectExecutableResolver, ExecutableOwner, ExecutableRevision,
    };
    use crate::runtime::executable::{
        ExecutableAuthorityError as HandleAuthorityError, RetainedHandleFootprint,
    };

    #[cfg(feature = "test-support")]
    const EVIDENCE_SENTINEL: &str = "plurum-native-process-evidence-run-v1";
    #[cfg(feature = "test-support")]
    const SYNTHETIC_REDACTION_VALUE: &[u8] = b"plurum-probe-sensitive-61c8d0f2";
    #[cfg(feature = "test-support")]
    const PRESSURE_STREAM_BYTES: usize = 128 * 1024;
    #[cfg(feature = "test-support")]
    const TREE_READY_MARKER: &[u8] = b"plurum-tree-grandchild-lock-held-v1\n";
    #[cfg(feature = "test-support")]
    const CAPTURE_ARGUMENTS: &[&str] = &[
        "plain",
        "two words",
        "quote\"inside",
        "trailing-backslash\\",
        "unicode-\u{03bb}",
    ];

    #[test]
    fn sensitive_marker_scan_is_case_insensitive_without_rendering_values() {
        for value in [
            b"PLRM_LIVE_example".as_slice(),
            b"Authorization: value".as_slice(),
            b"Bearer value".as_slice(),
            b"password=value".as_slice(),
            b"private key".as_slice(),
        ] {
            assert!(contains_sensitive_marker(value));
        }
        assert!(!contains_sensitive_marker(b"ordinary-literal"));
        assert!(contains_ascii_case_insensitive(
            b"before-SeCrEt-after",
            b"secret"
        ));
    }

    #[test]
    fn control_scan_rejects_c0_c1_and_del_but_allows_metacharacters() {
        assert!(contains_control("line\nbreak"));
        assert!(contains_control("\u{7f}"));
        assert!(contains_control("\u{85}"));
        assert!(!contains_control("literal ; $() & | <> ' \""));
    }

    #[test]
    fn strict_utf8_accepts_every_codepoint_split_and_rejects_invalid_sequences() {
        let expected = "a🙂éz";
        for split in 0..=expected.len() {
            if !expected.is_char_boundary(split) {
                let mut output = StrictUtf8Output::new(64);
                output
                    .push(expected.as_bytes()[..split].to_vec())
                    .expect("incomplete prefix must remain pending");
                output
                    .push(expected.as_bytes()[split..].to_vec())
                    .expect("suffix must complete the code point");
                assert_eq!(output.finish().expect("UTF-8 must finish"), expected);
            }
        }

        let mut invalid = StrictUtf8Output::new(64);
        assert_eq!(
            invalid
                .push(vec![0xf0, 0x28, 0x8c, 0xbc])
                .expect_err("invalid UTF-8 must fail"),
            NativeProcessError::OutputInvalid
        );

        let mut truncated = StrictUtf8Output::new(64);
        truncated
            .push(vec![0xf0, 0x9f])
            .expect("truncated prefix remains pending");
        assert_eq!(
            truncated
                .finish()
                .expect_err("truncated final code point must fail"),
            NativeProcessError::OutputInvalid
        );
    }

    #[test]
    fn strict_utf8_enforces_aggregate_output_storage_bound() {
        let mut output = StrictUtf8Output::new(3);
        output.push(b"abc".to_vec()).expect("exact limit must fit");
        assert_eq!(
            output
                .push(b"d".to_vec())
                .expect_err("one byte beyond the limit must fail"),
            NativeProcessError::OutputTooLarge
        );
    }

    #[test]
    fn weighted_fifo_evicts_oldest_unrelated_entries_and_protects_requested_key() {
        let mut cache = WeightedFifo::new(10);
        cache.insert(1_u8, 2, "protected").expect("first insert");
        assert!(cache.accounting_is_valid());
        cache.insert(2, 3, "oldest").expect("second insert");
        assert!(cache.accounting_is_valid());
        cache.insert(3, 3, "newest").expect("third insert");
        assert!(cache.accounting_is_valid());
        cache
            .reserve(6, Some(1))
            .expect("unrelated entries must make room");
        assert!(cache.accounting_is_valid());
        assert_eq!(cache.retained(), 2);
        assert_eq!(cache.get(1), Some(&"protected"));
        assert_eq!(cache.get(2), None);
        assert_eq!(cache.get(3), None);

        assert_eq!(
            cache.reserve(9, Some(1)),
            Err(HandleAuthorityError::Limit),
            "the protected entry cannot be evicted to satisfy a peak"
        );
        assert!(cache.accounting_is_valid());
        assert_eq!(cache.get(1), Some(&"protected"));
    }

    #[test]
    fn directory_path_dedup_includes_cwd_and_uses_platform_exactness() {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let (cwd, case_variant, other) = (
            PathBuf::from("/safe/Work"),
            PathBuf::from("/safe/work"),
            PathBuf::from("/safe/other"),
        );
        #[cfg(target_os = "windows")]
        let (cwd, case_variant, other) = (
            PathBuf::from(r"C:\safe\Work"),
            PathBuf::from(r"c:\SAFE\work"),
            PathBuf::from(r"C:\safe\other"),
        );
        let unique = dedupe_directory_paths(
            &cwd,
            &[
                cwd.clone(),
                case_variant.clone(),
                other.clone(),
                other.clone(),
            ],
        );
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert_eq!(unique, vec![cwd, case_variant, other]);
        #[cfg(target_os = "windows")]
        assert_eq!(unique, vec![cwd, other]);
    }

    #[test]
    fn reservation_covers_pre_and_post_reattestation_peaks() {
        let executable = RetainedHandleFootprint {
            retained: 3,
            capture_peak: 6,
        };
        let directories = [
            RetainedHandleFootprint {
                retained: 4,
                capture_peak: 8,
            },
            RetainedHandleFootprint {
                retained: 5,
                capture_peak: 10,
            },
        ];
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert_eq!(attestation_reservation(executable, &directories), Ok(22));
        #[cfg(target_os = "windows")]
        assert_eq!(attestation_reservation(executable, &directories), Ok(24));
        assert_eq!(
            attestation_reservation(
                RetainedHandleFootprint {
                    retained: usize::MAX,
                    capture_peak: 1,
                },
                &directories,
            ),
            Err(HandleAuthorityError::Limit)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reservation_enforces_windows_path_guards_at_the_exact_handle_boundary() {
        let exact = attestation_reservation(
            RetainedHandleFootprint {
                retained: 42,
                capture_peak: 84,
            },
            &[],
        )
        .expect("the exact Windows handle boundary must be representable");
        let above = attestation_reservation(
            RetainedHandleFootprint {
                retained: 43,
                capture_peak: 86,
            },
            &[],
        )
        .expect("the next executable footprint must be representable");

        assert_eq!(exact, MAX_RETAINED_HANDLES);
        assert_eq!(above, 131);
        let mut leases = WeightedFifo::<u8, ()>::new(MAX_RETAINED_HANDLES);
        assert_eq!(leases.reserve(exact, None), Ok(()));
        assert_eq!(
            leases.reserve(above, None),
            Err(HandleAuthorityError::Limit)
        );
    }

    #[cfg(feature = "test-support")]
    #[test]
    #[ignore = "requires the exact disposable native-process evidence harness"]
    fn native_process_evidence() {
        assert_eq!(
            env::var("PLURUM_NATIVE_PROCESS_EVIDENCE_SENTINEL").as_deref(),
            Ok(EVIDENCE_SENTINEL),
            "native process evidence requires the exact disposable sentinel"
        );
        let probe = PathBuf::from(
            env::var_os("PLURUM_NATIVE_PROCESS_TEST_PROBE")
                .expect("the evidence harness must provide the direct fake probe"),
        );
        assert!(probe.is_absolute(), "the fake probe path must be absolute");
        #[cfg(target_os = "windows")]
        assert!(
            probe.file_name().and_then(OsStr::to_str).is_some_and(
                |name| name.eq_ignore_ascii_case("plurum-native-process-test-probe.exe")
            ),
            "the Windows evidence target must be the fixed fake probe"
        );
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert_eq!(
            probe.file_name(),
            Some(OsStr::new("plurum-native-process-test-probe")),
            "the POSIX evidence target must be the fixed fake probe"
        );

        let root = ProcessEvidenceRoot::new();
        let excluded = root.create_private_child("excluded");
        let working_directory = root.create_private_child("work");
        let hostile_directory = root.create_private_child("hostile");
        let hostile_working_directory = root.create_hostile_private_child();
        assert_eq!(excluded.parent(), Some(root.root()));
        assert_eq!(working_directory.parent(), Some(root.root()));
        assert_eq!(hostile_directory.parent(), Some(root.root()));
        assert_eq!(hostile_working_directory.parent(), Some(root.root()));

        #[cfg(target_os = "macos")]
        {
            let diagnostic = diagnose_direct_candidate(&probe, &excluded);
            eprintln!(
                "plurum-native-process-evidence-preflight={}",
                diagnostic.category()
            );
            assert_eq!(
                diagnostic,
                DirectCandidateDiagnostic::Ready,
                "the staged probe failed its bounded preflight category"
            );
        }

        let mut supervisor =
            NativeProcessSupervisor::start().expect("native process supervisor must start");
        let attestation = supervisor
            .inspect_direct_candidate(probe.clone(), excluded.clone())
            .expect("the fixed fake probe must attest as one direct executable");
        assert_eq!(attestation.source_path, probe);
        assert_eq!(attestation.resolved_path, probe);
        assert_eq!(attestation.chain[0].path, probe);
        assert!(matches!(
            attestation.chain[0].owner,
            ExecutableOwner::CurrentUser | ExecutableOwner::TrustedSystem
        ));
        assert_ne!(attestation.chain[0].revision, [0; 32]);
        let opaque_revision = attestation.revision.opaque();
        assert!(opaque_revision.starts_with("native-direct-v1:"));
        assert_eq!(opaque_revision.matches(':').count(), 2);
        assert!(
            !opaque_revision.contains(
                probe
                    .file_name()
                    .and_then(OsStr::to_str)
                    .expect("the fixed probe name must be Unicode")
            ),
            "opaque revisions must not reveal executable paths"
        );

        assert_eq!(
            run_mode(
                &mut supervisor,
                attestation.revision,
                "stdout-stderr",
                &[],
                &excluded,
                no_color_environment(),
                Duration::from_secs(5),
                16 * 1024,
                NativeProcessCancellation::new(),
            )
            .expect_err("the excluded project cannot become the child cwd"),
            NativeProcessError::Unsafe
        );
        assert_eq!(
            run_mode(
                &mut supervisor,
                attestation.revision,
                "stdout-stderr",
                &[],
                &working_directory,
                vec![
                    ("NO_COLOR".to_owned(), "1".to_owned()),
                    (
                        "HOME".to_owned(),
                        excluded
                            .to_str()
                            .expect("the evidence root must be Unicode")
                            .to_owned(),
                    ),
                ],
                Duration::from_secs(5),
                16 * 1024,
                NativeProcessCancellation::new(),
            )
            .expect_err("the excluded project cannot enter a directory environment value"),
            NativeProcessError::Unsafe
        );

        let sandwich_excluded = root.create_private_child("sandwich-excluded");
        let mut sandwich_resolver =
            DirectExecutableResolver::capture().expect("the sandwich resolver must capture");
        let sandwich_executable = sandwich_resolver
            .resolve(&probe, &sandwich_excluded, 0)
            .expect("the sandwich executable lease must retain the excluded identity");
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let displaced_excluded = root.root().join("sandwich-displaced");
            fs::rename(&sandwich_excluded, &displaced_excluded)
                .expect("POSIX must permit the deliberate excluded-directory displacement");
            let replacement_excluded = root.create_private_child("sandwich-excluded");
            assert_eq!(
                sandwich_resolver
                    .resolve_directory(
                        &displaced_excluded,
                        &sandwich_executable,
                        sandwich_executable.retained_handles(),
                    )
                    .err(),
                Some(ExecutableAuthorityError::Conflict),
                "a path replacement around trusted-directory resolution must lose authority"
            );
            assert_eq!(
                sandwich_resolver
                    .resolve_directory(
                        &working_directory,
                        &sandwich_executable,
                        sandwich_executable.retained_handles(),
                    )
                    .err(),
                Some(ExecutableAuthorityError::Conflict),
                "a replacement excluded name cannot authorize an unrelated cwd or environment"
            );
            fs::remove_dir(&replacement_excluded)
                .expect("the disposable excluded replacement must be removable");
            fs::rename(&displaced_excluded, &sandwich_excluded)
                .expect("the retained excluded identity must be restorable at its exact name");
            let restored_directory = sandwich_resolver
                .resolve_directory(
                    &working_directory,
                    &sandwich_executable,
                    sandwich_executable.retained_handles(),
                )
                .expect("restoring the exact retained identity must restore directory authority");
            let restored_handles = sandwich_executable
                .retained_handles()
                .checked_add(restored_directory.retained_handles())
                .expect("the evidence handle footprint must remain bounded");
            sandwich_resolver
                .reattest_directory(&restored_directory, restored_handles)
                .expect("the restored directory lease must retain the same exclusion binding");
        }
        #[cfg(target_os = "windows")]
        {
            let displaced_excluded = root.root().join("sandwich-displaced");
            assert!(
                fs::rename(&sandwich_excluded, &displaced_excluded).is_err(),
                "the retained Windows excluded-directory handle must block displacement"
            );
            assert!(
                sandwich_excluded.is_dir() && !displaced_excluded.exists(),
                "Windows must not expose a replacement window at the excluded name"
            );
            let retained_directory = sandwich_resolver
                .resolve_directory(
                    &working_directory,
                    &sandwich_executable,
                    sandwich_executable.retained_handles(),
                )
                .expect("the unchanged retained Windows exclusion must authorize a trusted cwd");
            let retained_handles = sandwich_executable
                .retained_handles()
                .checked_add(retained_directory.retained_handles())
                .expect("the evidence handle footprint must remain bounded");
            sandwich_resolver
                .reattest_directory(&retained_directory, retained_handles)
                .expect("the Windows cwd lease must retain the same exclusion binding");
        }

        let excluded_probe = copy_fake_probe(&probe, &excluded, "excluded-probe");
        assert_eq!(
            supervisor
                .inspect_direct_candidate(excluded_probe.clone(), excluded.clone())
                .expect_err("an executable inside the excluded project must fail closed"),
            NativeProcessError::Unsafe
        );
        fs::remove_file(&excluded_probe).expect("the excluded fake probe must be removable");

        let script_candidate =
            hostile_directory.join(evidence_executable_name("script-text-probe"));
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        fs::write(&script_candidate, b"#!/bin/sh\nexit 0\n")
            .expect("the disposable script fixture must be written");
        #[cfg(target_os = "windows")]
        fs::write(&script_candidate, b"@echo off\r\nexit /b 0\r\n")
            .expect("the disposable command-text fixture must be written");
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        fs::set_permissions(&script_candidate, fs::Permissions::from_mode(0o700))
            .expect("the disposable script fixture must have a secure executable mode");
        assert_eq!(
            supervisor
                .inspect_direct_candidate(script_candidate.clone(), excluded.clone())
                .expect_err("text with an executable-looking name must fail image attestation"),
            NativeProcessError::Unsafe
        );
        fs::remove_file(&script_candidate)
            .expect("the rejected command-text fixture must be removable");

        #[cfg(target_os = "windows")]
        {
            let command_candidate = hostile_directory.join("script-text-probe.cmd");
            fs::write(&command_candidate, b"@echo off\r\nexit /b 0\r\n")
                .expect("the disposable .cmd fixture must be written");
            assert_eq!(
                supervisor
                    .inspect_direct_candidate(command_candidate.clone(), excluded.clone())
                    .expect_err(".cmd must remain outside the direct compiled-image boundary"),
                NativeProcessError::Unsafe
            );
            fs::remove_file(&command_candidate)
                .expect("the rejected .cmd fixture must be removable");
        }

        let hard_link_source = copy_fake_probe(&probe, &hostile_directory, "hard-link-source");
        let hard_link_candidate = hostile_directory.join(evidence_executable_name("hard-link"));
        fs::hard_link(&hard_link_source, &hard_link_candidate)
            .expect("the disposable local filesystem must support a fake hard link");
        assert_eq!(
            supervisor
                .inspect_direct_candidate(hard_link_candidate.clone(), excluded.clone())
                .expect_err("a hard-linked executable must fail closed"),
            NativeProcessError::Unsafe
        );
        fs::remove_file(&hard_link_candidate).expect("the fake hard link must be removable");
        fs::remove_file(&hard_link_source).expect("the hard-link source must be removable");

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let symlink_candidate = hostile_directory.join("linked-probe");
            symlink(&probe, &symlink_candidate)
                .expect("the disposable POSIX root must permit a fake symlink");
            assert_eq!(
                supervisor
                    .inspect_direct_candidate(symlink_candidate.clone(), excluded.clone())
                    .expect_err("a linked executable must fail closed"),
                NativeProcessError::Unsafe
            );
            fs::remove_file(&symlink_candidate).expect("the fake symlink must be removable");

            let writable_candidate =
                copy_fake_probe(&probe, &hostile_directory, "broadly-writable-probe");
            fs::set_permissions(&writable_candidate, fs::Permissions::from_mode(0o777))
                .expect("the fake executable mode must be made intentionally unsafe");
            assert_eq!(
                supervisor
                    .inspect_direct_candidate(writable_candidate.clone(), excluded.clone())
                    .expect_err("a broadly writable executable must fail closed"),
                NativeProcessError::Unsafe
            );
            fs::remove_file(&writable_candidate)
                .expect("the broadly writable fake probe must be removable");

            #[cfg(target_os = "linux")]
            {
                let set_id_candidate = copy_fake_probe(&probe, &hostile_directory, "set-id-probe");
                fs::set_permissions(&set_id_candidate, fs::Permissions::from_mode(0o4700))
                    .expect("the fake executable mode must carry the set-user-ID bit");
                assert_ne!(
                    fs::metadata(&set_id_candidate)
                        .expect("the set-ID candidate metadata must load")
                        .permissions()
                        .mode()
                        & 0o6000,
                    0,
                    "the Linux evidence filesystem must preserve the set-ID fixture"
                );
                assert_eq!(
                    supervisor
                        .inspect_direct_candidate(set_id_candidate.clone(), excluded.clone())
                        .expect_err("a set-ID executable must fail closed"),
                    NativeProcessError::Unsafe
                );
                fs::remove_file(&set_id_candidate)
                    .expect("the set-ID fake probe must be removable");
            }

            let unsafe_ancestor = root.create_private_child("unsafe-ancestor");
            let unsafe_ancestor_candidate =
                copy_fake_probe(&probe, &unsafe_ancestor, "ancestor-probe");
            fs::set_permissions(&unsafe_ancestor, fs::Permissions::from_mode(0o777))
                .expect("the fake ancestor must be made intentionally unsafe");
            assert_eq!(
                supervisor
                    .inspect_direct_candidate(unsafe_ancestor_candidate.clone(), excluded.clone(),)
                    .expect_err("a broadly writable executable ancestor must fail closed"),
                NativeProcessError::Unsafe
            );
            fs::set_permissions(&unsafe_ancestor, fs::Permissions::from_mode(0o700))
                .expect("the disposable ancestor permissions must be restored");
            fs::remove_file(&unsafe_ancestor_candidate)
                .expect("the unsafe-ancestor fake probe must be removable");

            #[cfg(target_os = "macos")]
            {
                let acl_candidate =
                    copy_fake_probe(&probe, &hostile_directory, "extended-acl-probe");
                let acl_file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&acl_candidate)
                    .expect("the fake ACL candidate must open");
                plurum_native_macos_acl::install_current_user_read_acl(
                    acl_file.as_fd(),
                    rustix::process::getuid().as_raw(),
                )
                .expect("the disposable macOS file must accept an extended ACL");
                drop(acl_file);
                assert_eq!(
                    supervisor
                        .inspect_direct_candidate(acl_candidate.clone(), excluded.clone())
                        .expect_err("a macOS executable with an extended ACL must fail closed"),
                    NativeProcessError::Unsafe
                );
                fs::remove_file(&acl_candidate)
                    .expect("the extended-ACL fake probe must be removable");
            }
        }

        #[cfg(target_os = "windows")]
        {
            let weak_acl_candidate = copy_fake_probe(&probe, &hostile_directory, "weak-acl-probe");
            plurum_windows_syscall::set_broad_dacl_for_tests(
                &weak_acl_candidate,
                SecurityKind::File,
            )
            .expect("the disposable Windows executable must accept a broad test DACL");
            assert_eq!(
                supervisor
                    .inspect_direct_candidate(weak_acl_candidate.clone(), excluded.clone())
                    .expect_err("a broadly writable Windows executable must fail closed"),
                NativeProcessError::Unsafe
            );
            plurum_windows_syscall::set_private_current_user_dacl_for_tests(
                &weak_acl_candidate,
                SecurityKind::File,
            )
            .expect("the disposable Windows executable DACL must be restorable");
            fs::remove_file(&weak_acl_candidate)
                .expect("the weak-DACL fake probe must be removable");

            let reparse_target = root.create_private_child("reparse-target");
            let reparse_target_probe = copy_fake_probe(&probe, &reparse_target, "target-probe");
            let reparse_ancestor = root.root().join("reparse-ancestor");
            assert!(
                plurum_windows_syscall::try_create_junction_for_tests(
                    &reparse_ancestor,
                    &reparse_target,
                )
                .expect("the Windows reparse fixture attempt must remain bounded"),
                "the hosted Windows evidence filesystem must support a disposable junction"
            );
            let reparse_candidate = reparse_ancestor.join(evidence_executable_name("target-probe"));
            assert_eq!(
                supervisor
                    .inspect_direct_candidate(reparse_candidate, excluded.clone())
                    .expect_err("a Windows reparse ancestor must fail without following it"),
                NativeProcessError::Unsafe
            );
            fs::remove_dir(&reparse_ancestor)
                .expect("the disposable Windows junction must be removable without traversal");
            fs::remove_file(&reparse_target_probe)
                .expect("the Windows reparse target probe must remain independently removable");
        }

        let replaceable_probe = copy_fake_probe(&probe, &hostile_directory, "replaceable-probe");
        let replaceable_attestation = supervisor
            .inspect_direct_candidate(replaceable_probe.clone(), excluded.clone())
            .expect("the disposable replacement target must initially attest");
        let displaced_probe =
            hostile_directory.join(evidence_executable_name("displaced-race-probe"));
        let (ready_sender, ready_receiver) = mpsc::channel();
        let (proceed_sender, proceed_receiver) = mpsc::channel();
        let race_candidate = replaceable_probe.clone();
        let race_displaced = displaced_probe.clone();
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let race_source = probe.clone();
        let racer = thread::spawn(move || {
            ready_receiver
                .recv()
                .expect("the supervisor must expose the exact pre-spawn evidence boundary");
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            let replacement_blocked = {
                fs::rename(&race_candidate, &race_displaced)
                    .expect("POSIX must permit replacement at the exact launch boundary");
                copy_fake_probe_to(&race_source, &race_candidate);
                false
            };
            #[cfg(target_os = "windows")]
            let replacement_blocked = fs::rename(&race_candidate, &race_displaced).is_err();
            proceed_sender
                .send(())
                .expect("the race fixture must release the supervisor");
            replacement_blocked
        });
        let mut raced_request = request_for_mode(
            replaceable_attestation.revision,
            "stdout-stderr",
            &[],
            &working_directory,
            no_color_environment(),
            Duration::from_secs(5),
            16 * 1024,
            NativeProcessCancellation::new(),
        );
        raced_request.before_spawn_barrier = Some(NativeProcessBeforeSpawnBarrier {
            ready: ready_sender,
            proceed: proceed_receiver,
        });
        let raced_result = supervisor.run(raced_request);
        let replacement_blocked = racer
            .join()
            .expect("the deterministic launch-race fixture must join");
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            assert!(!replacement_blocked);
            assert_eq!(
                raced_result.expect_err(
                    "a POSIX name replacement at the exact launch boundary must lose authority"
                ),
                NativeProcessError::AuthorityLost
            );
            fs::remove_file(&replaceable_probe)
                .expect("the replacement fake probe must be removable");
            fs::remove_file(&displaced_probe).expect("the displaced fake probe must be removable");
        }
        #[cfg(target_os = "windows")]
        {
            assert!(
                replacement_blocked,
                "the retained Windows handle must block the exact launch-boundary replacement"
            );
            let retained =
                raced_result.expect("the unchanged retained Windows executable must launch");
            assert_success(&retained);
            assert!(!displaced_probe.exists());
            fs::remove_file(&replaceable_probe)
                .expect("the retained Windows race fixture must be removable");
        }

        let capture = run_mode(
            &mut supervisor,
            attestation.revision,
            "capture",
            CAPTURE_ARGUMENTS,
            &working_directory,
            vec![
                ("NO_COLOR".to_owned(), "1".to_owned()),
                ("CLAUDE_CODE_PLUGIN_PREFER_HTTPS".to_owned(), "1".to_owned()),
            ],
            Duration::from_secs(5),
            16 * 1024,
            NativeProcessCancellation::new(),
        )
        .expect("literal argv, environment, and cwd must survive direct launch");
        assert_success(&capture);
        let expected_capture = format!(
            "mode=capture\n\
             arg0=plain\n\
             arg1=two words\n\
             arg2=quote\"inside\n\
             arg3=trailing-backslash\\\n\
             arg4=unicode-\u{03bb}\n\
             cwd={}\n\
             env.NO_COLOR=1\n\
             env.CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1\n",
            working_directory.display()
        );
        assert_eq!(capture.stdout, expected_capture);
        assert!(capture.stderr.is_empty());

        let hostile_executable = copy_fake_probe(
            &probe,
            &hostile_directory,
            "probe ; dollar$ parens() amp& quote' space",
        );
        let hostile_attestation = supervisor
            .inspect_direct_candidate(hostile_executable.clone(), excluded.clone())
            .expect("the metacharacter executable path must attest without shell parsing");
        let hostile_executable_text = hostile_executable
            .to_str()
            .expect("the fixed hostile executable path must be Unicode");
        let hostile_working_directory_text = hostile_working_directory
            .to_str()
            .expect("the fixed hostile working-directory path must be Unicode");
        let hostile_paths = run_mode(
            &mut supervisor,
            hostile_attestation.revision,
            "capture-hostile",
            &[hostile_executable_text, hostile_working_directory_text],
            &hostile_working_directory,
            vec![
                ("NO_COLOR".to_owned(), "1".to_owned()),
                ("HOME".to_owned(), hostile_working_directory_text.to_owned()),
            ],
            Duration::from_secs(5),
            16 * 1024,
            NativeProcessCancellation::new(),
        )
        .expect("metacharacters in executable, argv, cwd, and HOME must remain literal");
        assert_success(&hostile_paths);
        assert_eq!(hostile_paths.stdout, "hostile-paths-ok\n");
        assert!(hostile_paths.stderr.is_empty());
        fs::remove_file(&hostile_executable)
            .expect("the hostile-path fake probe must be removable");

        let stdin_eof = run_mode(
            &mut supervisor,
            attestation.revision,
            "stdin-eof",
            &[],
            &working_directory,
            no_color_environment(),
            Duration::from_secs(5),
            16 * 1024,
            NativeProcessCancellation::new(),
        )
        .expect("the child must observe immediate EOF on its private stdin");
        assert_success(&stdin_eof);
        assert_eq!(stdin_eof.stdout, "stdin-eof\n");
        assert!(stdin_eof.stderr.is_empty());

        let both_streams = run_mode(
            &mut supervisor,
            attestation.revision,
            "stdout-stderr",
            &[],
            &working_directory,
            no_color_environment(),
            Duration::from_secs(5),
            16 * 1024,
            NativeProcessCancellation::new(),
        )
        .expect("stdout and stderr must drain concurrently");
        assert_success(&both_streams);
        assert_eq!(both_streams.stdout, "probe-stdout\n");
        assert_eq!(both_streams.stderr, "probe-stderr\n");

        let pressure_output_bytes = PRESSURE_STREAM_BYTES
            .checked_mul(2)
            .expect("the fixed pressure-stream aggregate must fit");
        let pressure = run_mode(
            &mut supervisor,
            attestation.revision,
            "stream-pressure",
            &[],
            &working_directory,
            no_color_environment(),
            Duration::from_secs(5),
            pressure_output_bytes,
            NativeProcessCancellation::new(),
        )
        .expect("both streams must drain concurrently beyond pipe capacity");
        assert_success(&pressure);
        assert_eq!(pressure.stdout, "o".repeat(PRESSURE_STREAM_BYTES));
        assert_eq!(pressure.stderr, "e".repeat(PRESSURE_STREAM_BYTES));
        assert_eq!(
            run_mode(
                &mut supervisor,
                attestation.revision,
                "stream-pressure",
                &[],
                &working_directory,
                no_color_environment(),
                Duration::from_secs(5),
                pressure_output_bytes - 1,
                NativeProcessCancellation::new(),
            )
            .expect_err("the two streams must share one exact aggregate byte limit"),
            NativeProcessError::OutputTooLarge
        );

        let redacted = run_mode(
            &mut supervisor,
            attestation.revision,
            "split-redaction",
            &[],
            &working_directory,
            no_color_environment(),
            Duration::from_secs(5),
            16 * 1024,
            NativeProcessCancellation::new(),
        )
        .expect("a sensitive value split across reads on both streams must be redacted");
        assert_success(&redacted);
        assert_eq!(
            redacted.stdout,
            "stdout-split-before:[REDACTED]:stdout-split-after\n"
        );
        assert_eq!(
            redacted.stderr,
            "stderr-split-before:[REDACTED]:stderr-split-after\n"
        );
        for output in [&redacted.stdout, &redacted.stderr] {
            assert!(!output
                .as_bytes()
                .windows(SYNTHETIC_REDACTION_VALUE.len())
                .any(|window| window == SYNTHETIC_REDACTION_VALUE));
        }

        assert_eq!(
            run_mode(
                &mut supervisor,
                attestation.revision,
                "invalid-utf8",
                &[],
                &working_directory,
                no_color_environment(),
                Duration::from_secs(5),
                16 * 1024,
                NativeProcessCancellation::new(),
            )
            .expect_err("invalid UTF-8 must fail closed"),
            NativeProcessError::OutputInvalid
        );

        let exact_output = run_mode(
            &mut supervisor,
            attestation.revision,
            "output-exact",
            &[],
            &working_directory,
            no_color_environment(),
            Duration::from_secs(5),
            8 * 1024,
            NativeProcessCancellation::new(),
        )
        .expect("the exact aggregate output limit must succeed");
        assert_success(&exact_output);
        assert_eq!(exact_output.stdout, "x".repeat(8 * 1024));
        assert!(exact_output.stderr.is_empty());

        assert_eq!(
            run_mode(
                &mut supervisor,
                attestation.revision,
                "output-overflow",
                &[],
                &working_directory,
                no_color_environment(),
                Duration::from_secs(5),
                8 * 1024,
                NativeProcessCancellation::new(),
            )
            .expect_err("one byte beyond the aggregate limit must fail closed"),
            NativeProcessError::OutputTooLarge
        );

        let nonzero = run_mode(
            &mut supervisor,
            attestation.revision,
            "nonzero",
            &[],
            &working_directory,
            no_color_environment(),
            Duration::from_secs(5),
            16 * 1024,
            NativeProcessCancellation::new(),
        )
        .expect("a nonzero exit remains an attested process result");
        assert_eq!(nonzero.termination, NativeProcessTermination::Exited(23));
        assert!(nonzero.stdout.is_empty());
        assert!(nonzero.stderr.is_empty());

        assert_bounded_failure(
            &mut supervisor,
            request_for_mode(
                attestation.revision,
                "sleep",
                &[],
                &working_directory,
                no_color_environment(),
                Duration::from_millis(150),
                16 * 1024,
                NativeProcessCancellation::new(),
            ),
            NativeProcessError::Timeout,
        );

        let cancellation = NativeProcessCancellation::new();
        let cancellation_trigger = cancellation.clone();
        let trigger = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            cancellation_trigger.cancel();
        });
        assert_bounded_failure(
            &mut supervisor,
            request_for_mode(
                attestation.revision,
                "sleep",
                &[],
                &working_directory,
                no_color_environment(),
                Duration::from_secs(5),
                16 * 1024,
                cancellation,
            ),
            NativeProcessError::Cancelled,
        );
        trigger
            .join()
            .expect("the bounded cancellation trigger must join");

        let tree_lock = working_directory.join("tree-authority.lock");
        let tree_ready = working_directory.join("tree-grandchild.ready");
        fs::write(&tree_lock, b"plurum-tree-authority-v1\n")
            .expect("the disposable process-tree lock must be created");
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        fs::set_permissions(&tree_lock, fs::Permissions::from_mode(0o600))
            .expect("the disposable process-tree lock must remain private");
        let tree_lock_text = tree_lock
            .to_str()
            .expect("the fixed process-tree lock path must be Unicode");
        let tree_ready_text = tree_ready
            .to_str()
            .expect("the fixed process-tree readiness path must be Unicode");
        let tree_cancellation = NativeProcessCancellation::new();
        let tree_trigger_cancellation = tree_cancellation.clone();
        let tree_trigger_ready = tree_ready.clone();
        let tree_trigger = thread::spawn(move || {
            let readiness_deadline = Instant::now()
                .checked_add(Duration::from_secs(3))
                .expect("the fixed readiness bound must fit");
            loop {
                match fs::read(&tree_trigger_ready) {
                    Ok(observed) if observed == TREE_READY_MARKER => {
                        tree_trigger_cancellation.cancel();
                        return observed;
                    }
                    Ok(observed) => {
                        if !TREE_READY_MARKER.starts_with(&observed) {
                            tree_trigger_cancellation.cancel();
                            panic!("the process-tree readiness marker is invalid");
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        tree_trigger_cancellation.cancel();
                        panic!("the process-tree readiness marker cannot be read: {error}");
                    }
                }
                if Instant::now() >= readiness_deadline {
                    tree_trigger_cancellation.cancel();
                    panic!("the grandchild did not publish readiness within its bound");
                }
                thread::sleep(Duration::from_millis(5));
            }
        });
        assert_bounded_failure(
            &mut supervisor,
            request_for_mode(
                attestation.revision,
                "process-tree",
                &[tree_lock_text, tree_ready_text],
                &working_directory,
                no_color_environment(),
                Duration::from_secs(5),
                16 * 1024,
                tree_cancellation,
            ),
            NativeProcessError::Cancelled,
        );
        let trigger_marker = tree_trigger
            .join()
            .expect("the readiness-driven cancellation trigger must join");
        assert_eq!(
            trigger_marker, TREE_READY_MARKER,
            "cleanup must begin only after the exact grandchild marker is observed"
        );
        assert_eq!(
            fs::read(&tree_ready).expect("the grandchild must publish readiness after locking"),
            TREE_READY_MARKER,
            "readiness must prove that the signal-resistant grandchild held the authority"
        );
        assert_tree_lock_released(&tree_lock);
        fs::remove_file(&tree_ready).expect("the process-tree readiness file must be removable");
        fs::remove_file(&tree_lock).expect("the released process-tree lock must be removable");

        let final_result = run_mode(
            &mut supervisor,
            attestation.revision,
            "stdout-stderr",
            &[],
            &working_directory,
            no_color_environment(),
            Duration::from_secs(5),
            16 * 1024,
            NativeProcessCancellation::new(),
        )
        .expect("the supervisor must remain usable after every cleanup path");
        assert_success(&final_result);
        assert_eq!(final_result.stdout, "probe-stdout\n");
        assert_eq!(final_result.stderr, "probe-stderr\n");
    }

    #[cfg(feature = "test-support")]
    #[allow(clippy::too_many_arguments)]
    fn run_mode(
        supervisor: &mut NativeProcessSupervisor,
        revision: ExecutableRevision,
        mode: &str,
        arguments: &[&str],
        working_directory: &Path,
        environment: Vec<(String, String)>,
        timeout: Duration,
        max_output_bytes: usize,
        cancellation: NativeProcessCancellation,
    ) -> Result<NativeProcessOutput, NativeProcessError> {
        supervisor.run(request_for_mode(
            revision,
            mode,
            arguments,
            working_directory,
            environment,
            timeout,
            max_output_bytes,
            cancellation,
        ))
    }

    #[cfg(feature = "test-support")]
    #[allow(clippy::too_many_arguments)]
    fn request_for_mode(
        revision: ExecutableRevision,
        mode: &str,
        arguments: &[&str],
        working_directory: &Path,
        environment: Vec<(String, String)>,
        timeout: Duration,
        max_output_bytes: usize,
        cancellation: NativeProcessCancellation,
    ) -> NativeProcessRequest {
        let mut process_arguments = Vec::with_capacity(arguments.len() + 1);
        process_arguments.push(mode.to_owned());
        process_arguments.extend(arguments.iter().map(|argument| (*argument).to_owned()));
        NativeProcessRequest {
            executable_revision: revision,
            arguments: process_arguments,
            working_directory: working_directory.to_path_buf(),
            environment,
            timeout,
            max_output_bytes,
            sensitive_values: vec![SYNTHETIC_REDACTION_VALUE.to_vec()],
            cancellation,
            before_spawn_barrier: None,
        }
    }

    #[cfg(feature = "test-support")]
    fn assert_bounded_failure(
        supervisor: &mut NativeProcessSupervisor,
        request: NativeProcessRequest,
        expected: NativeProcessError,
    ) {
        let started = Instant::now();
        assert_eq!(
            supervisor
                .run(request)
                .expect_err("the bounded failure mode must fail"),
            expected
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the child and its retained process-tree authority must clean up within the bound"
        );
    }

    #[cfg(feature = "test-support")]
    fn no_color_environment() -> Vec<(String, String)> {
        vec![("NO_COLOR".to_owned(), "1".to_owned())]
    }

    #[cfg(feature = "test-support")]
    fn assert_success(output: &NativeProcessOutput) {
        assert_eq!(
            output.termination,
            NativeProcessTermination::Exited(0),
            "the fake probe must exit successfully"
        );
    }

    #[cfg(all(
        feature = "test-support",
        any(target_os = "macos", target_os = "linux")
    ))]
    fn assert_tree_lock_released(path: &Path) {
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .expect("the process-tree authority file must reopen");
        rustix::fs::flock(&lock, rustix::fs::FlockOperation::NonBlockingLockExclusive)
            .expect("no POSIX descendant may retain the process-tree authority");
    }

    #[cfg(all(feature = "test-support", target_os = "windows"))]
    fn assert_tree_lock_released(path: &Path) {
        let _lock = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(path)
            .expect("no Windows Job descendant may retain the process-tree authority");
    }

    #[cfg(feature = "test-support")]
    fn evidence_executable_name(stem: &str) -> String {
        #[cfg(target_os = "windows")]
        {
            format!("{stem}.exe")
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            stem.to_owned()
        }
    }

    #[cfg(feature = "test-support")]
    fn copy_fake_probe(source: &Path, directory: &Path, stem: &str) -> PathBuf {
        let destination = directory.join(evidence_executable_name(stem));
        copy_fake_probe_to(source, &destination);
        destination
    }

    #[cfg(feature = "test-support")]
    fn copy_fake_probe_to(source: &Path, destination: &Path) {
        assert_eq!(
            fs::copy(source, destination).expect("the fixed fake probe must copy"),
            fs::metadata(source)
                .expect("the fixed fake probe metadata must load")
                .len(),
            "the fake probe copy must preserve its exact byte length"
        );
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        fs::set_permissions(destination, fs::Permissions::from_mode(0o700))
            .expect("the fake probe copy must be executable only by its owner");
    }
}
