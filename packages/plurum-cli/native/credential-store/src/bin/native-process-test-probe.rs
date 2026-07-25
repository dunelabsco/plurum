use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

const EXIT_INVALID_INVOCATION: u8 = 64;
const EXIT_LAUNCH_FAILED: u8 = 71;
const EXIT_IO_FAILED: u8 = 74;
const EXIT_NONZERO_TEST: u8 = 23;
const OUTPUT_BOUNDARY_BYTES: usize = 8 * 1024;
const PRESSURE_STREAM_BYTES: usize = 128 * 1024;
const SYNTHETIC_REDACTION_VALUE: &[u8] = b"plurum-probe-sensitive-61c8d0f2";
const SYNTHETIC_REDACTION_SPLIT: usize = 18;
const SLEEP_BOUND: Duration = Duration::from_secs(30);
const SPLIT_WRITE_PAUSE: Duration = Duration::from_millis(20);
const TREE_READY_BOUND: Duration = Duration::from_secs(2);
const TREE_READY_POLL: Duration = Duration::from_millis(5);
const TREE_READY_MARKER: &[u8] = b"plurum-tree-grandchild-lock-held-v1\n";
const TREE_GRANDCHILD_MODE: &str = "__tree-grandchild";

const CAPTURE_ARGUMENTS: &[&str] = &[
    "plain",
    "two words",
    "quote\"inside",
    "trailing-backslash\\",
    "unicode-\u{03bb}",
];

fn main() -> ExitCode {
    let mut arguments = env::args_os();
    let _program = arguments.next();
    let Some(mode) = arguments.next() else {
        return ExitCode::from(EXIT_INVALID_INVOCATION);
    };
    let remaining = arguments.collect::<Vec<_>>();

    match mode.to_str() {
        Some("capture") => capture(&remaining),
        Some("capture-hostile") => capture_hostile(&remaining),
        Some("stdin-eof") if remaining.is_empty() => stdin_eof(),
        Some("stdout-stderr") if remaining.is_empty() => stdout_stderr(),
        Some("stream-pressure") if remaining.is_empty() => stream_pressure(),
        Some("split-redaction") if remaining.is_empty() => split_redaction(),
        Some("invalid-utf8") if remaining.is_empty() => invalid_utf8(),
        Some("output-exact") if remaining.is_empty() => fixed_output(OUTPUT_BOUNDARY_BYTES),
        Some("output-overflow") if remaining.is_empty() => fixed_output(OUTPUT_BOUNDARY_BYTES + 1),
        Some("nonzero") if remaining.is_empty() => ExitCode::from(EXIT_NONZERO_TEST),
        Some("sleep") if remaining.is_empty() => bounded_sleep(),
        Some("process-tree") => process_tree(&remaining),
        Some(TREE_GRANDCHILD_MODE) => tree_grandchild(&remaining),
        _ => ExitCode::from(EXIT_INVALID_INVOCATION),
    }
}

fn capture(arguments: &[OsString]) -> ExitCode {
    let environment = env::vars_os().collect::<Vec<_>>();
    if arguments.len() != CAPTURE_ARGUMENTS.len()
        || arguments
            .iter()
            .zip(CAPTURE_ARGUMENTS.iter().copied())
            .any(|(actual, expected)| actual.as_os_str() != OsStr::new(expected))
        || env::var_os("NO_COLOR").as_deref() != Some(OsStr::new("1"))
        || env::var_os("CLAUDE_CODE_PLUGIN_PREFER_HTTPS").as_deref() != Some(OsStr::new("1"))
        || environment.len() != 2
        || !environment.iter().all(|(name, value)| {
            (name == "NO_COLOR" && value == "1")
                || (name == "CLAUDE_CODE_PLUGIN_PREFER_HTTPS" && value == "1")
        })
    {
        return ExitCode::from(EXIT_INVALID_INVOCATION);
    }

    let Ok(working_directory) = env::current_dir() else {
        return ExitCode::from(EXIT_IO_FAILED);
    };
    let mut stdout = io::stdout().lock();
    let result = writeln!(stdout, "mode=capture")
        .and_then(|()| {
            for (index, value) in CAPTURE_ARGUMENTS.iter().enumerate() {
                writeln!(stdout, "arg{index}={value}")?;
            }
            Ok(())
        })
        .and_then(|()| writeln!(stdout, "cwd={}", working_directory.display()))
        .and_then(|()| writeln!(stdout, "env.NO_COLOR=1"))
        .and_then(|()| writeln!(stdout, "env.CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1"))
        .and_then(|()| stdout.flush());
    exit_for_io(result)
}

fn capture_hostile(arguments: &[OsString]) -> ExitCode {
    let [expected_executable, expected_working_directory] = arguments else {
        return ExitCode::from(EXIT_INVALID_INVOCATION);
    };
    let expected_executable = PathBuf::from(expected_executable);
    let expected_working_directory = PathBuf::from(expected_working_directory);
    let Ok(actual_executable) = env::current_exe() else {
        return ExitCode::from(EXIT_IO_FAILED);
    };
    let Ok(actual_working_directory) = env::current_dir() else {
        return ExitCode::from(EXIT_IO_FAILED);
    };
    let environment = env::vars_os().collect::<Vec<_>>();
    if actual_executable != expected_executable
        || actual_working_directory != expected_working_directory
        || env::var_os("HOME").as_deref() != Some(expected_working_directory.as_os_str())
        || env::var_os("NO_COLOR").as_deref() != Some(OsStr::new("1"))
        || environment.len() != 2
        || !environment.iter().all(|(name, value)| {
            (name == "NO_COLOR" && value == "1")
                || (name == "HOME" && value == expected_working_directory.as_os_str())
        })
    {
        return ExitCode::from(EXIT_INVALID_INVOCATION);
    }
    let mut stdout = io::stdout().lock();
    exit_for_io(
        stdout
            .write_all(b"hostile-paths-ok\n")
            .and_then(|()| stdout.flush()),
    )
}

fn stdin_eof() -> ExitCode {
    let mut byte = [0_u8; 1];
    let mut stdin = io::stdin().lock();
    match stdin.read(&mut byte) {
        Ok(0) => {
            let mut stdout = io::stdout().lock();
            exit_for_io(
                stdout
                    .write_all(b"stdin-eof\n")
                    .and_then(|()| stdout.flush()),
            )
        }
        Ok(_) => ExitCode::from(EXIT_INVALID_INVOCATION),
        Err(_) => ExitCode::from(EXIT_IO_FAILED),
    }
}

fn stdout_stderr() -> ExitCode {
    let stdout_result = {
        let mut stdout = io::stdout().lock();
        stdout
            .write_all(b"probe-stdout\n")
            .and_then(|()| stdout.flush())
    };
    if stdout_result.is_err() {
        return ExitCode::from(EXIT_IO_FAILED);
    }
    let stderr_result = {
        let mut stderr = io::stderr().lock();
        stderr
            .write_all(b"probe-stderr\n")
            .and_then(|()| stderr.flush())
    };
    exit_for_io(stderr_result)
}

fn stream_pressure() -> ExitCode {
    let stdout = thread::spawn(|| write_pressure_stream(io::stdout(), b'o'));
    let stderr = thread::spawn(|| write_pressure_stream(io::stderr(), b'e'));
    if matches!(stdout.join(), Ok(Ok(()))) && matches!(stderr.join(), Ok(Ok(()))) {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(EXIT_IO_FAILED)
    }
}

fn write_pressure_stream(mut output: impl Write, byte: u8) -> io::Result<()> {
    let block = [byte; 4 * 1024];
    let mut remaining = PRESSURE_STREAM_BYTES;
    while remaining != 0 {
        let amount = remaining.min(block.len());
        output.write_all(&block[..amount])?;
        remaining -= amount;
    }
    output.flush()
}

fn split_redaction() -> ExitCode {
    let stdout = thread::spawn(|| {
        write_split_redaction(
            io::stdout(),
            b"stdout-split-before:",
            b":stdout-split-after\n",
        )
    });
    let stderr = thread::spawn(|| {
        write_split_redaction(
            io::stderr(),
            b"stderr-split-before:",
            b":stderr-split-after\n",
        )
    });
    if matches!(stdout.join(), Ok(Ok(()))) && matches!(stderr.join(), Ok(Ok(()))) {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(EXIT_IO_FAILED)
    }
}

fn write_split_redaction(mut output: impl Write, prefix: &[u8], suffix: &[u8]) -> io::Result<()> {
    output.write_all(prefix)?;
    output.write_all(&SYNTHETIC_REDACTION_VALUE[..SYNTHETIC_REDACTION_SPLIT])?;
    output.flush()?;
    thread::sleep(SPLIT_WRITE_PAUSE);
    output.write_all(&SYNTHETIC_REDACTION_VALUE[SYNTHETIC_REDACTION_SPLIT..])?;
    output.write_all(suffix)?;
    output.flush()
}

fn invalid_utf8() -> ExitCode {
    let mut stdout = io::stdout().lock();
    exit_for_io(
        stdout
            .write_all(b"valid-prefix:\xff:valid-suffix\n")
            .and_then(|()| stdout.flush()),
    )
}

fn fixed_output(byte_count: usize) -> ExitCode {
    let mut stdout = io::stdout().lock();
    let block = [b'x'; 1024];
    let mut remaining = byte_count;
    while remaining != 0 {
        let amount = remaining.min(block.len());
        if stdout.write_all(&block[..amount]).is_err() {
            return ExitCode::from(EXIT_IO_FAILED);
        }
        remaining -= amount;
    }
    exit_for_io(stdout.flush())
}

fn bounded_sleep() -> ExitCode {
    thread::sleep(SLEEP_BOUND);
    ExitCode::SUCCESS
}

fn process_tree(arguments: &[OsString]) -> ExitCode {
    let [lock_path, ready_path] = arguments else {
        return ExitCode::from(EXIT_INVALID_INVOCATION);
    };
    let lock_path = PathBuf::from(lock_path);
    let ready_path = PathBuf::from(ready_path);
    if !lock_path.is_absolute() || !ready_path.is_absolute() || ready_path.exists() {
        return ExitCode::from(EXIT_INVALID_INVOCATION);
    }
    if !ignore_normal_termination() {
        return ExitCode::from(EXIT_LAUNCH_FAILED);
    }
    let Ok(executable) = env::current_exe() else {
        return ExitCode::from(EXIT_LAUNCH_FAILED);
    };
    if !executable.is_absolute() {
        return ExitCode::from(EXIT_LAUNCH_FAILED);
    }

    let mut grandchild = match Command::new(executable)
        .arg(TREE_GRANDCHILD_MODE)
        .arg(&lock_path)
        .arg(&ready_path)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return ExitCode::from(EXIT_LAUNCH_FAILED),
    };

    let ready_deadline = Instant::now() + TREE_READY_BOUND;
    while !ready_path.is_file() {
        if Instant::now() >= ready_deadline {
            let _ = grandchild.kill();
            let _ = grandchild.wait();
            return ExitCode::from(EXIT_LAUNCH_FAILED);
        }
        thread::sleep(TREE_READY_POLL);
    }

    {
        let mut stdout = io::stdout().lock();
        if stdout
            .write_all(b"tree-parent-ready\n")
            .and_then(|()| stdout.flush())
            .is_err()
        {
            let _ = grandchild.kill();
            let _ = grandchild.wait();
            return ExitCode::from(EXIT_IO_FAILED);
        }
    }

    thread::sleep(SLEEP_BOUND);
    match grandchild.wait() {
        Ok(status) => match status.code() {
            Some(code) if (0..=u8::MAX as i32).contains(&code) => ExitCode::from(code as u8),
            Some(_) | None => ExitCode::from(EXIT_LAUNCH_FAILED),
        },
        Err(_) => ExitCode::from(EXIT_LAUNCH_FAILED),
    }
}

fn tree_grandchild(arguments: &[OsString]) -> ExitCode {
    let [lock_path, ready_path] = arguments else {
        return ExitCode::from(EXIT_INVALID_INVOCATION);
    };
    let lock_path = Path::new(lock_path);
    let ready_path = Path::new(ready_path);
    if !lock_path.is_absolute() || !ready_path.is_absolute() || ready_path.exists() {
        return ExitCode::from(EXIT_INVALID_INVOCATION);
    }
    if !ignore_normal_termination() {
        return ExitCode::from(EXIT_LAUNCH_FAILED);
    }
    let Some(_lock) = hold_tree_lock(lock_path) else {
        return ExitCode::from(EXIT_LAUNCH_FAILED);
    };
    let ready_result = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(ready_path)
        .and_then(|mut ready| {
            ready.write_all(TREE_READY_MARKER)?;
            ready.flush()?;
            ready.sync_all()
        });
    if ready_result.is_err() {
        return ExitCode::from(EXIT_IO_FAILED);
    }
    {
        let mut stdout = io::stdout().lock();
        if stdout
            .write_all(b"tree-grandchild-ready\n")
            .and_then(|()| stdout.flush())
            .is_err()
        {
            return ExitCode::from(EXIT_IO_FAILED);
        }
    }
    thread::sleep(SLEEP_BOUND);
    ExitCode::SUCCESS
}

#[cfg(unix)]
fn hold_tree_lock(path: &Path) -> Option<File> {
    let file = OpenOptions::new().read(true).write(true).open(path).ok()?;
    rustix::fs::flock(&file, rustix::fs::FlockOperation::LockExclusive).ok()?;
    Some(file)
}

#[cfg(windows)]
fn hold_tree_lock(path: &Path) -> Option<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(path)
        .ok()
}

fn ignore_normal_termination() -> bool {
    #[cfg(unix)]
    {
        plurum_native_posix_syscall::ignore_termination_for_test().is_ok()
    }
    #[cfg(windows)]
    {
        // The Windows supervisor terminates the complete private Job directly;
        // no cooperative console signal exists in its no-window launch shape.
        true
    }
}

fn exit_for_io(result: io::Result<()>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::from(EXIT_IO_FAILED),
    }
}
