#![cfg(any(target_os = "macos", target_os = "linux"))]
#![deny(unsafe_op_in_unsafe_fn)]

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdentityError {
    Unavailable,
}

#[cfg(target_os = "linux")]
fn all_ids_match_expected(
    expected_uid: u32,
    expected_gid: u32,
    real_uid: u32,
    effective_uid: u32,
    saved_uid: u32,
    real_gid: u32,
    effective_gid: u32,
    saved_gid: u32,
) -> bool {
    expected_uid != 0
        && expected_gid != 0
        && real_uid == expected_uid
        && effective_uid == expected_uid
        && saved_uid == expected_uid
        && real_gid == expected_gid
        && effective_gid == expected_gid
        && saved_gid == expected_gid
}

#[cfg(target_os = "linux")]
pub fn saved_identity_is_unprivileged(
    expected_uid: u32,
    expected_gid: u32,
) -> Result<bool, IdentityError> {
    let mut real_uid = 0;
    let mut effective_uid = 0;
    let mut saved_uid = 0;
    let mut real_gid = 0;
    let mut effective_gid = 0;
    let mut saved_gid = 0;

    // SAFETY: all pointers refer to live, aligned scalar outputs for the
    // duration of these read-only process-identity syscalls.
    let uid_status = unsafe { libc::getresuid(&mut real_uid, &mut effective_uid, &mut saved_uid) };
    // SAFETY: same argument guarantees as the getresuid call immediately above.
    let gid_status = unsafe { libc::getresgid(&mut real_gid, &mut effective_gid, &mut saved_gid) };
    if uid_status != 0 || gid_status != 0 {
        return Err(IdentityError::Unavailable);
    }

    Ok(all_ids_match_expected(
        expected_uid,
        expected_gid,
        real_uid,
        effective_uid,
        saved_uid,
        real_gid,
        effective_gid,
        saved_gid,
    ))
}

#[cfg(target_os = "macos")]
pub fn saved_identity_is_unprivileged(
    expected_uid: u32,
    expected_gid: u32,
) -> Result<bool, IdentityError> {
    // SAFETY: these identity accessors have no arguments or memory preconditions.
    let real_uid = unsafe { libc::getuid() };
    // SAFETY: these identity accessors have no arguments or memory preconditions.
    let effective_uid = unsafe { libc::geteuid() };
    // SAFETY: these identity accessors have no arguments or memory preconditions.
    let real_gid = unsafe { libc::getgid() };
    // SAFETY: these identity accessors have no arguments or memory preconditions.
    let effective_gid = unsafe { libc::getegid() };
    if expected_uid == 0
        || expected_gid == 0
        || real_uid != expected_uid
        || effective_uid != expected_uid
        || real_gid != expected_gid
        || effective_gid != expected_gid
    {
        return Ok(false);
    }
    // SAFETY: issetugid has no arguments or memory preconditions and reads the
    // kernel's sticky set-user/group-identity process flag.
    Ok(unsafe { libc::issetugid() } == 0)
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    #[test]
    fn saved_identity_policy_requires_every_id_to_match_the_nonroot_user() {
        assert!(super::all_ids_match_expected(
            501, 20, 501, 501, 501, 20, 20, 20,
        ));
        for ids in [
            (0, 20, 0, 0, 0, 20, 20, 20),
            (501, 0, 501, 501, 501, 0, 0, 0),
            (501, 20, 502, 501, 501, 20, 20, 20),
            (501, 20, 501, 502, 501, 20, 20, 20),
            (501, 20, 501, 501, 0, 20, 20, 20),
            (501, 20, 501, 501, 501, 21, 20, 20),
            (501, 20, 501, 501, 501, 20, 21, 20),
            (501, 20, 501, 501, 501, 20, 20, 0),
        ] {
            assert!(!super::all_ids_match_expected(
                ids.0, ids.1, ids.2, ids.3, ids.4, ids.5, ids.6, ids.7,
            ));
        }
    }

    #[test]
    fn ambient_test_process_has_unprivileged_saved_identity() {
        let uid = ambient_identity::uid();
        let gid = ambient_identity::gid();
        assert_eq!(super::saved_identity_is_unprivileged(uid, gid), Ok(true),);
        let wrong_uid = if uid == 1 { 2 } else { 1 };
        let wrong_gid = if gid == 1 { 2 } else { 1 };
        assert_eq!(
            super::saved_identity_is_unprivileged(wrong_uid, gid),
            Ok(false),
        );
        assert_eq!(
            super::saved_identity_is_unprivileged(uid, wrong_gid),
            Ok(false),
        );
    }

    mod ambient_identity {
        pub(super) fn uid() -> u32 {
            // SAFETY: getuid has no arguments or memory preconditions.
            unsafe { libc::getuid() }
        }

        pub(super) fn gid() -> u32 {
            // SAFETY: getgid has no arguments or memory preconditions.
            unsafe { libc::getgid() }
        }
    }
}
