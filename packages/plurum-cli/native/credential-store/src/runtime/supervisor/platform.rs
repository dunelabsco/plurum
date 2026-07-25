use std::ffi::OsString;
use std::time::Instant;

use super::{
    DirectDirectoryLease, DirectExecutableLease, DirectExecutableResolver, NativeProcessError,
    NativeProcessTermination,
};

#[derive(Clone, Copy)]
pub(super) enum Stream {
    Stdout,
    Stderr,
}

pub(super) enum ReadState {
    Pending,
    Data(Vec<u8>),
    Eof,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) type PlatformChild = plurum_native_posix_syscall::DirectChild;
#[cfg(target_os = "windows")]
pub(super) type PlatformChild = plurum_windows_syscall::process::DirectChild;

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) const RETAINED_CHILD_PATH_GUARDS: usize = 0;
#[cfg(target_os = "windows")]
pub(super) const RETAINED_CHILD_PATH_GUARDS: usize = 2;

pub(super) fn spawn(
    resolver: &DirectExecutableResolver,
    executable: &DirectExecutableLease,
    working_directory: &DirectDirectoryLease,
    arguments: &[String],
    environment: &[(String, String)],
    deadline: Instant,
) -> Result<PlatformChild, NativeProcessError> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::os::fd::AsFd;

        let _ = resolver;
        let mut argv = Vec::with_capacity(arguments.len() + 1);
        argv.push(
            executable
                .attestation()
                .source_path
                .as_os_str()
                .to_os_string(),
        );
        argv.extend(arguments.iter().map(OsString::from));
        let environment = environment
            .iter()
            .map(|(name, value)| OsString::from(format!("{name}={value}")))
            .collect::<Vec<_>>();
        #[cfg(target_os = "macos")]
        let _ = deadline;
        // Linux carries the absolute request deadline into its exec handshake.
        // macOS posix_spawn and launch attestation remain synchronous; the
        // supervisor observes their timeout/cancellation at the next boundary.
        plurum_native_posix_syscall::spawn_direct(plurum_native_posix_syscall::DirectSpawnRequest {
            executable: executable.executable_file().as_fd(),
            cwd: working_directory.directory_file().as_fd(),
            executable_path: &executable.attestation().source_path,
            argv: &argv,
            environment: &environment,
            #[cfg(target_os = "macos")]
            mapped_file_offset: executable.mapped_file_offset(),
            #[cfg(target_os = "linux")]
            deadline,
        })
        .map_err(map_posix_error)
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::io::AsHandle;

        // CreateProcessW and its pre-resume containment checks remain
        // synchronous; the supervisor observes timeout/cancellation at the
        // boundary immediately after this call returns.
        let _ = deadline;
        let executable_identity =
            plurum_windows_syscall::file_identity(executable.executable_file().as_handle())
                .map_err(|_| NativeProcessError::AuthorityLost)?;
        let working_directory_identity =
            plurum_windows_syscall::file_identity(working_directory.directory_file().as_handle())
                .map_err(|_| NativeProcessError::AuthorityLost)?;
        let arguments = arguments.iter().map(OsString::from).collect::<Vec<_>>();
        let environment = environment
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect::<Vec<_>>();
        plurum_windows_syscall::process::spawn_direct(
            plurum_windows_syscall::process::DirectProcessRequest {
                process: resolver.windows_process_identity(),
                executable: &executable.attestation().source_path,
                executable_evidence: plurum_windows_syscall::process::RetainedPathEvidence {
                    handle: executable.executable_file().as_handle(),
                    identity: executable_identity,
                },
                working_directory: working_directory.path(),
                working_directory_evidence: plurum_windows_syscall::process::RetainedPathEvidence {
                    handle: working_directory.directory_file().as_handle(),
                    identity: working_directory_identity,
                },
                arguments: &arguments,
                environment: &environment,
            },
        )
        .map_err(map_windows_error)
    }
}

pub(super) fn read_stream(
    child: &mut PlatformChild,
    stream: Stream,
    maximum_bytes: usize,
) -> Result<ReadState, ()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use plurum_native_posix_syscall::ChildStreamRead;

        let mut bytes = vec![0_u8; maximum_bytes];
        let result = match stream {
            Stream::Stdout => child.read_stdout(&mut bytes),
            Stream::Stderr => child.read_stderr(&mut bytes),
        }
        .map_err(|_| ())?;
        match result {
            ChildStreamRead::Data(length) => {
                bytes.truncate(length);
                Ok(ReadState::Data(bytes))
            }
            ChildStreamRead::WouldBlock => Ok(ReadState::Pending),
            ChildStreamRead::Eof => Ok(ReadState::Eof),
        }
    }
    #[cfg(target_os = "windows")]
    {
        use plurum_windows_syscall::process::PipeRead;

        let result = match stream {
            Stream::Stdout => child.read_stdout(maximum_bytes),
            Stream::Stderr => child.read_stderr(maximum_bytes),
        }
        .map_err(|_| ())?;
        match result {
            PipeRead::Pending => Ok(ReadState::Pending),
            PipeRead::Data(bytes) => Ok(ReadState::Data(bytes)),
            PipeRead::Eof => Ok(ReadState::Eof),
        }
    }
}

pub(super) fn try_wait(child: &mut PlatformChild) -> Result<Option<NativeProcessTermination>, ()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        child
            .try_wait_root()
            .map(|status| {
                status.map(|status| match status {
                    plurum_native_posix_syscall::RootExitStatus::Exited(code) => {
                        NativeProcessTermination::Exited(code as u32)
                    }
                    plurum_native_posix_syscall::RootExitStatus::Signaled(signal) => {
                        NativeProcessTermination::Signaled(signal)
                    }
                })
            })
            .map_err(|_| ())
    }
    #[cfg(target_os = "windows")]
    {
        child
            .try_wait()
            .map(|status| match status {
                plurum_windows_syscall::process::ProcessWait::Running => None,
                plurum_windows_syscall::process::ProcessWait::Exited(code) => {
                    Some(NativeProcessTermination::Exited(code))
                }
            })
            .map_err(|_| ())
    }
}

pub(super) fn tree_alive(child: &PlatformChild) -> Result<bool, ()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        child.process_group_alive().map_err(|_| ())
    }
    #[cfg(target_os = "windows")]
    {
        child
            .job_tree_state()
            .map(|state| !state.is_empty())
            .map_err(|_| ())
    }
}

pub(super) fn terminate(child: &PlatformChild) -> Result<(), ()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        child.terminate_group().map_err(|_| ())
    }
    #[cfg(target_os = "windows")]
    {
        child.terminate_tree(0x504c_0001).map_err(|_| ())
    }
}

pub(super) fn kill(child: &PlatformChild) -> Result<(), ()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        child.kill_group().map_err(|_| ())
    }
    #[cfg(target_os = "windows")]
    {
        child.terminate_tree(0x504c_0002).map_err(|_| ())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn map_posix_error(error: plurum_native_posix_syscall::ProcessError) -> NativeProcessError {
    use plurum_native_posix_syscall::ProcessErrorKind;

    match error.kind {
        ProcessErrorKind::InvalidInput | ProcessErrorKind::Limit => {
            NativeProcessError::InvalidRequest
        }
        ProcessErrorKind::Conflict => NativeProcessError::AuthorityLost,
        ProcessErrorKind::Unsupported => NativeProcessError::Unsupported,
        ProcessErrorKind::Launch => NativeProcessError::LaunchFailed,
        ProcessErrorKind::Timeout => NativeProcessError::Timeout,
        ProcessErrorKind::Io => NativeProcessError::Unavailable,
    }
}

#[cfg(target_os = "windows")]
fn map_windows_error(error: plurum_windows_syscall::WinError) -> NativeProcessError {
    use plurum_windows_syscall::ErrorKind;

    match error.kind {
        ErrorKind::Conflict | ErrorKind::Busy => NativeProcessError::AuthorityLost,
        ErrorKind::Unsafe => NativeProcessError::Unsafe,
        ErrorKind::Unsupported => NativeProcessError::Unsupported,
        ErrorKind::Other => NativeProcessError::LaunchFailed,
    }
}
