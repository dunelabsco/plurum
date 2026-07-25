#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::posix::{PosixStoreError, StandardUserProcessIdentity};
#[cfg(target_os = "windows")]
use crate::windows::StandardUserProcessIdentity;
#[cfg(target_os = "windows")]
use plurum_windows_syscall::{ErrorKind as WindowsErrorKind, WinError};

mod executable;
mod redaction;
mod supervisor;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeRuntimeAuthorityError {
    Unsafe,
    Lost,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeRuntimeAuthority {
    process: StandardUserProcessIdentity,
    target: &'static str,
}

impl NativeRuntimeAuthority {
    pub(crate) fn capture() -> Result<Self, NativeRuntimeAuthorityError> {
        let process = StandardUserProcessIdentity::capture().map_err(map_capture_error)?;
        Ok(Self {
            process,
            target: crate::TARGET_VALUE,
        })
    }

    pub(crate) fn verify(&self) -> Result<(), NativeRuntimeAuthorityError> {
        if self.target != crate::TARGET_VALUE {
            return Err(NativeRuntimeAuthorityError::Lost);
        }
        self.process.verify().map_err(map_verify_error)
    }

    pub(crate) fn target(&self) -> &'static str {
        self.target
    }

    #[cfg(target_os = "windows")]
    fn windows_process_identity(&self) -> &StandardUserProcessIdentity {
        &self.process
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn map_capture_error(error: PosixStoreError) -> NativeRuntimeAuthorityError {
    match error {
        PosixStoreError::Unsafe => NativeRuntimeAuthorityError::Unsafe,
        _ => NativeRuntimeAuthorityError::Unavailable,
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn map_verify_error(error: PosixStoreError) -> NativeRuntimeAuthorityError {
    match error {
        PosixStoreError::Unsafe => NativeRuntimeAuthorityError::Unsafe,
        PosixStoreError::Lost => NativeRuntimeAuthorityError::Lost,
        _ => NativeRuntimeAuthorityError::Unavailable,
    }
}

#[cfg(target_os = "windows")]
fn map_capture_error(error: WinError) -> NativeRuntimeAuthorityError {
    if error.kind == WindowsErrorKind::Unsafe {
        NativeRuntimeAuthorityError::Unsafe
    } else {
        NativeRuntimeAuthorityError::Unavailable
    }
}

#[cfg(target_os = "windows")]
fn map_verify_error(error: WinError) -> NativeRuntimeAuthorityError {
    match error.kind {
        WindowsErrorKind::Unsafe => NativeRuntimeAuthorityError::Unsafe,
        WindowsErrorKind::Conflict => NativeRuntimeAuthorityError::Lost,
        _ => NativeRuntimeAuthorityError::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn compiled_runtime_target_is_one_exact_supported_target() {
        assert!(matches!(
            crate::TARGET_VALUE,
            "darwin-arm64"
                | "darwin-x64"
                | "linux-arm64-gnu"
                | "linux-arm64-musl"
                | "linux-x64-gnu"
                | "linux-x64-musl"
                | "win32-arm64-msvc"
                | "win32-x64-msvc"
        ));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn standard_user_runtime_authority_binds_target_and_process_identity() {
        let authority =
            super::NativeRuntimeAuthority::capture().expect("test process must be a standard user");
        assert_eq!(authority.target(), crate::TARGET_VALUE);
        assert_eq!(authority.verify(), Ok(()));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_runtime_authority_surface_compiles_without_reading_the_ambient_token() {
        let capture: fn() -> Result<
            super::NativeRuntimeAuthority,
            super::NativeRuntimeAuthorityError,
        > = super::NativeRuntimeAuthority::capture;
        let verify: fn(
            &super::NativeRuntimeAuthority,
        ) -> Result<(), super::NativeRuntimeAuthorityError> = super::NativeRuntimeAuthority::verify;
        let target: fn(&super::NativeRuntimeAuthority) -> &'static str =
            super::NativeRuntimeAuthority::target;

        let _ = (capture, verify, target);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_runtime_authority_maps_token_conflict_to_lost() {
        use plurum_windows_syscall::{ErrorKind, WinError};

        assert_eq!(
            super::map_verify_error(WinError {
                kind: ErrorKind::Conflict,
                code: 5,
            }),
            super::NativeRuntimeAuthorityError::Lost,
        );
        assert_eq!(
            super::map_verify_error(WinError {
                kind: ErrorKind::Unsafe,
                code: 5,
            }),
            super::NativeRuntimeAuthorityError::Unsafe,
        );
        assert_eq!(
            super::map_verify_error(WinError {
                kind: ErrorKind::Other,
                code: 5,
            }),
            super::NativeRuntimeAuthorityError::Unavailable,
        );
    }
}
