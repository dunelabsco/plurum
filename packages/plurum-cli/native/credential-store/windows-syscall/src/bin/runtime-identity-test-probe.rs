#![cfg(target_os = "windows")]
#![deny(unsafe_code)]

use std::env;

use plurum_windows_syscall::{
    current_process_token_classification_for_tests, impersonate_self_for_tests,
    lower_process_integrity_to_medium_for_tests, ErrorKind, StandardUserProcessIdentity,
    TestElevationType,
};

fn expect_unsafe_capture() -> Result<(), &'static str> {
    match StandardUserProcessIdentity::capture() {
        Err(error) if error.kind == ErrorKind::Unsafe => Ok(()),
        _ => Err("standard-user capture did not fail unsafe"),
    }
}

fn ambient_elevated_rejected() -> Result<(), &'static str> {
    let classification = current_process_token_classification_for_tests()
        .map_err(|_| "ambient token classification failed")?;
    if !classification.elevated {
        return Err("ambient token is not elevated");
    }
    expect_unsafe_capture()
}

fn lowered_elevated_rejected() -> Result<(), &'static str> {
    let before = current_process_token_classification_for_tests()
        .map_err(|_| "ambient token classification failed")?;
    if !before.elevated || before.exact_medium_integrity {
        return Err("ambient token cannot prove integrity lowering");
    }
    lower_process_integrity_to_medium_for_tests()
        .map_err(|_| "medium-integrity lowering failed")?;
    let after = current_process_token_classification_for_tests()
        .map_err(|_| "lowered token classification failed")?;
    if !after.exact_medium_integrity
        || !after.elevated
        || after.elevation_type != before.elevation_type
    {
        return Err("integrity lowering changed elevation evidence");
    }
    expect_unsafe_capture()
}

fn self_impersonation_rejected() -> Result<(), &'static str> {
    let baseline =
        StandardUserProcessIdentity::capture().map_err(|_| "standard-user baseline failed")?;
    baseline
        .verify()
        .map_err(|_| "standard-user baseline verification failed")?;
    let guard = impersonate_self_for_tests().map_err(|_| "self impersonation failed")?;
    let capture = expect_unsafe_capture();
    guard
        .finish()
        .map_err(|_| "self impersonation restoration failed")?;
    capture?;
    baseline
        .verify()
        .map_err(|_| "standard-user identity changed after impersonation")
}

fn standard_default_stable() -> Result<(), &'static str> {
    let classification = current_process_token_classification_for_tests()
        .map_err(|_| "standard token classification failed")?;
    if !classification.exact_medium_integrity
        || classification.elevated
        || classification.elevation_type != TestElevationType::Default
    {
        return Err("token is not a genuine standard-user default token");
    }
    let identity =
        StandardUserProcessIdentity::capture().map_err(|_| "standard-user capture failed")?;
    identity
        .verify()
        .map_err(|_| "standard-user verification failed")
}

fn standard_token_change_conflict() -> Result<(), &'static str> {
    let identity =
        StandardUserProcessIdentity::capture().map_err(|_| "standard-user capture failed")?;
    let changed = identity.with_changed_token_generation_for_tests();
    match changed.verify() {
        Err(error) if error.kind == ErrorKind::Conflict => Ok(()),
        _ => Err("changed token generation did not produce a conflict"),
    }
}

fn run() -> Result<(), &'static str> {
    let mut arguments = env::args_os();
    let _program = arguments.next();
    let mode = arguments
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or("one fixed probe mode is required")?;
    if arguments.next().is_some() {
        return Err("one fixed probe mode is required");
    }
    match mode.as_str() {
        "ambient-elevated-rejected" => ambient_elevated_rejected(),
        "lowered-elevated-rejected" => lowered_elevated_rejected(),
        "self-impersonation-rejected" => self_impersonation_rejected(),
        "standard-default-stable" => standard_default_stable(),
        "standard-token-change-conflict" => standard_token_change_conflict(),
        _ => Err("unknown probe mode"),
    }
}

fn main() {
    if let Err(message) = run() {
        eprintln!("Windows runtime identity evidence failed: {message}");
        std::process::exit(1);
    }
}
