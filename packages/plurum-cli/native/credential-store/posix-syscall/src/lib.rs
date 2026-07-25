#![cfg(any(target_os = "macos", target_os = "linux"))]
#![deny(unsafe_op_in_unsafe_fn)]

use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, BorrowedFd};

mod process;

#[cfg(feature = "test-support")]
pub use process::ignore_termination_for_test;
pub use process::{
    spawn_direct, ChildStreamRead, DirectChild, DirectSpawnRequest, ProcessError, ProcessErrorKind,
    RootExitStatus,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdentityError {
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FilesystemError {
    Unavailable,
}

/// Reports whether a retained descriptor is backed by a supported local
/// filesystem rather than a network or userspace-controlled mount.
pub fn local_filesystem_is_supported(descriptor: BorrowedFd<'_>) -> Result<bool, FilesystemError> {
    let mut facts = MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `facts` is aligned output storage and the descriptor remains live.
    if unsafe { libc::fstatfs(descriptor.as_raw_fd(), facts.as_mut_ptr()) } != 0 {
        return Err(FilesystemError::Unavailable);
    }
    // SAFETY: successful fstatfs initialized the complete structure.
    let facts = unsafe { facts.assume_init() };

    #[cfg(target_os = "macos")]
    {
        let filesystem_name_end = facts
            .f_fstypename
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(facts.f_fstypename.len());
        let filesystem_name_is = |expected: &[u8]| {
            filesystem_name_end == expected.len()
                && facts.f_fstypename[..filesystem_name_end]
                    .iter()
                    .zip(expected)
                    .all(|(actual, expected)| *actual as u8 == *expected)
        };
        Ok(facts.f_flags & libc::MNT_LOCAL as u32 != 0
            && (filesystem_name_is(b"apfs") || filesystem_name_is(b"hfs")))
    }
    #[cfg(target_os = "linux")]
    {
        let filesystem_type = facts.f_type as u64 & 0xffff_ffff;
        Ok(matches!(
            filesystem_type,
            0x0000_ef53 // ext2/3/4
                | 0x0102_1994 // tmpfs
                | 0x2fc1_2fc1 // ZFS
                | 0x5846_5342 // XFS
                | 0x7371_7368 // SquashFS
                | 0x794c_7630 // overlayfs
                | 0x9123_683e // Btrfs
                | 0xf2f5_2010 // F2FS
        ))
    }
}

#[cfg(target_os = "linux")]
fn all_ids_match_expected(
    expected_uid: u32,
    expected_gid: u32,
    user_ids: [u32; 3],
    group_ids: [u32; 3],
) -> bool {
    expected_uid != 0
        && expected_gid != 0
        && user_ids.into_iter().all(|id| id == expected_uid)
        && group_ids.into_iter().all(|id| id == expected_gid)
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
        [real_uid, effective_uid, saved_uid],
        [real_gid, effective_gid, saved_gid],
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
            501,
            20,
            [501, 501, 501],
            [20, 20, 20],
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
                ids.0,
                ids.1,
                [ids.2, ids.3, ids.4],
                [ids.5, ids.6, ids.7],
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
