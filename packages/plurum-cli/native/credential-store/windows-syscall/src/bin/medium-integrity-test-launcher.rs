#![cfg(target_os = "windows")]

use std::env;
use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
const ISOLATION_MARKER: &str = "plurum-native-isolation-v1\n";
const ISOLATION_ROOT_NAME: &str = "plurum-native-isolation";
const RUN_ROOT_MARKER: &str = ".plurum-native-abi-root";
const RUN_ROOT_PREFIX: &str = "plurum-native-abi-";

fn required_environment(name: &str) -> Result<String, &'static str> {
    let value = env::var(name).map_err(|_| "required environment is missing")?;
    if value.is_empty() || value.contains('\r') || value.contains('\n') {
        return Err("required environment is invalid");
    }
    Ok(value)
}

fn exact_environment(name: &str, expected: &str) -> Result<(), &'static str> {
    if required_environment(name)? == expected {
        Ok(())
    } else {
        Err("required environment has an unexpected value")
    }
}

fn metadata_without_reparse(path: &Path) -> Result<fs::Metadata, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "path metadata is unavailable")?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("reparse points are forbidden");
    }
    Ok(metadata)
}

fn canonical_directory(path: &Path) -> Result<PathBuf, &'static str> {
    let metadata = metadata_without_reparse(path)?;
    if !metadata.is_dir() {
        return Err("expected a directory");
    }
    fs::canonicalize(path).map_err(|_| "directory canonicalization failed")
}

fn canonical_file(path: &Path) -> Result<PathBuf, &'static str> {
    let metadata = metadata_without_reparse(path)?;
    if !metadata.is_file() {
        return Err("expected a regular file");
    }
    fs::canonicalize(path).map_err(|_| "file canonicalization failed")
}

fn node_main_script_path(path: &Path) -> Result<PathBuf, &'static str> {
    let rendered = path.to_str().ok_or("ABI script path is invalid")?;
    let compatible = if let Some(rest) = rendered.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = rendered.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    };
    if compatible.is_absolute() {
        Ok(compatible)
    } else {
        Err("ABI script path is invalid")
    }
}

fn direct_child(parent: &Path, child: &Path) -> bool {
    child.parent() == Some(parent)
}

fn valid_uuid_v4(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    value.bytes().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-',
        14 => byte == b'4',
        19 => matches!(byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
        _ => byte.is_ascii_hexdigit(),
    })
}

struct LaunchContext {
    isolation_root: PathBuf,
    temporary_root: PathBuf,
    run_root: PathBuf,
    node: PathBuf,
    script: PathBuf,
}

fn validate_context() -> Result<LaunchContext, &'static str> {
    exact_environment("CI", "true")?;
    exact_environment("GITHUB_ACTIONS", "true")?;

    let runner_temporary = canonical_directory(Path::new(&required_environment("RUNNER_TEMP")?))?;
    let isolation_root = canonical_directory(Path::new(&required_environment(
        "PLURUM_NATIVE_ISOLATION_ROOT",
    )?))?;
    let isolation_marker = canonical_file(&isolation_root.join(".plurum-native-isolation"))?;
    if isolation_root.file_name().and_then(|name| name.to_str()) != Some(ISOLATION_ROOT_NAME)
        || !direct_child(&runner_temporary, &isolation_root)
        || !direct_child(&isolation_root, &isolation_marker)
        || fs::read_to_string(&isolation_marker).map_err(|_| "isolation marker is unreadable")?
            != ISOLATION_MARKER
    {
        return Err("native isolation root is invalid");
    }

    let temporary_root = canonical_directory(&isolation_root.join("tmp"))?;
    if !direct_child(&isolation_root, &temporary_root) {
        return Err("native temporary root is invalid");
    }

    let run_root = canonical_directory(Path::new(&required_environment(
        "PLURUM_NATIVE_ABI_RUN_ROOT",
    )?))?;
    if !direct_child(&temporary_root, &run_root)
        || !run_root
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(RUN_ROOT_PREFIX))
    {
        return Err("ABI run root is invalid");
    }

    let run_id = required_environment("PLURUM_NATIVE_TEST_RUN_ID")?;
    let run_marker = canonical_file(&run_root.join(RUN_ROOT_MARKER))?;
    if !valid_uuid_v4(&run_id)
        || !direct_child(&run_root, &run_marker)
        || fs::read_to_string(&run_marker).map_err(|_| "ABI run marker is unreadable")? != run_id
    {
        return Err("ABI run marker is invalid");
    }

    let staged = canonical_file(Path::new(&required_environment(
        "PLURUM_NATIVE_STAGED_PATH",
    )?))?;
    if staged != canonical_file(&run_root.join("credential-store.node"))? {
        return Err("staged native module is invalid");
    }

    let node = canonical_file(Path::new(&required_environment("PLURUM_NATIVE_ABI_NODE")?))?;
    if !node
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("node.exe"))
    {
        return Err("Node executable is invalid");
    }

    let script = canonical_file(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("launcher manifest directory is invalid")?
            .join("tests")
            .join("abi-conformance.mjs"),
    )?;
    // Node 24.0.0 cannot load a main script through the Win32 verbatim path
    // returned by canonicalize. Remove only that namespace prefix while
    // preserving the validated canonical target.
    let script = node_main_script_path(&script)?;

    Ok(LaunchContext {
        isolation_root,
        temporary_root,
        run_root,
        node,
        script,
    })
}

fn run() -> Result<i32, &'static str> {
    let context = validate_context()?;

    for directory in [
        &context.isolation_root,
        &context.temporary_root,
        &context.run_root,
    ] {
        plurum_windows_syscall::prepare_medium_integrity_test_directory(directory)
            .map_err(|_| "test directory integrity preparation failed")?;
    }
    plurum_windows_syscall::lower_process_integrity_to_medium_for_tests()
        .map_err(|_| "test process integrity preparation failed")?;

    if fs::read_to_string(context.run_root.join(RUN_ROOT_MARKER))
        .map_err(|_| "ABI run marker is unreadable after integrity preparation")?
        != required_environment("PLURUM_NATIVE_TEST_RUN_ID")?
    {
        return Err("ABI run marker changed during integrity preparation");
    }

    let status = Command::new(&context.node)
        .arg(&context.script)
        .arg("--child")
        .current_dir(&context.run_root)
        .env_remove("PLURUM_NATIVE_ABI_NODE")
        .env_remove("PLURUM_NATIVE_ABI_RUN_ROOT")
        .env_remove("RUNNER_TEMP")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|_| "medium-integrity Node child failed to start")?;
    Ok(status.code().unwrap_or(1))
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("native ABI launcher refused to run: {message}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_main_script_paths_remove_only_verbatim_namespaces() {
        assert_eq!(
            node_main_script_path(Path::new(r"\\?\D:\repo\abi-conformance.mjs"))
                .expect("verbatim DOS path must convert"),
            PathBuf::from(r"D:\repo\abi-conformance.mjs")
        );
        assert_eq!(
            node_main_script_path(Path::new(r"\\?\UNC\server\share\abi-conformance.mjs"))
                .expect("verbatim UNC path must convert"),
            PathBuf::from(r"\\server\share\abi-conformance.mjs")
        );
        assert_eq!(
            node_main_script_path(Path::new(r"D:\repo\abi-conformance.mjs"))
                .expect("ordinary DOS path must remain valid"),
            PathBuf::from(r"D:\repo\abi-conformance.mjs")
        );
        assert!(node_main_script_path(Path::new(r"\\?\GLOBALROOT\Device\file")).is_err());
    }
}
