use std::fs::File;
#[cfg(target_os = "macos")]
use std::io;

use rustix::fs as rustix_fs;
#[cfg(target_os = "macos")]
use rustix::io::Errno;

use super::PosixStoreError;

#[cfg(target_os = "macos")]
fn classify_acl_error(error: &io::Error) -> PosixStoreError {
    let raw = error.raw_os_error();
    if error.kind() == io::ErrorKind::Unsupported
        || error.kind() == io::ErrorKind::InvalidInput
        || raw == Some(Errno::NOTSUP.raw_os_error())
        || raw == Some(Errno::NOSYS.raw_os_error())
    {
        PosixStoreError::Unsupported
    } else {
        PosixStoreError::Io
    }
}

#[cfg(target_os = "macos")]
fn classify_full_sync_error(error: Errno) -> PosixStoreError {
    if matches!(error, Errno::INVAL | Errno::NOTSUP | Errno::NOSYS) {
        PosixStoreError::Unsupported
    } else {
        PosixStoreError::Io
    }
}

pub(super) fn access_is_private(file: &File) -> Result<bool, PosixStoreError> {
    #[cfg(target_os = "macos")]
    {
        plurum_native_macos_acl::extended_acl_is_empty(std::os::fd::AsFd::as_fd(file))
            .map_err(|error| classify_acl_error(&error))
    }
    #[cfg(target_os = "linux")]
    {
        let _ = file;
        Ok(true)
    }
}

pub(super) fn initialize_created_access(file: &File) -> Result<(), PosixStoreError> {
    #[cfg(target_os = "macos")]
    {
        plurum_native_macos_acl::clear_extended_acl(std::os::fd::AsFd::as_fd(file))
            .map_err(|error| classify_acl_error(&error))
    }
    #[cfg(target_os = "linux")]
    {
        let _ = file;
        Ok(())
    }
}

pub(super) fn sync_file(file: &File) -> Result<(), PosixStoreError> {
    #[cfg(target_os = "macos")]
    {
        rustix_fs::fcntl_fullfsync(file).map_err(classify_full_sync_error)
    }
    #[cfg(target_os = "linux")]
    {
        rustix_fs::fsync(file).map_err(|_| PosixStoreError::Io)
    }
}

pub(super) fn sync_directory(directory: &File) -> Result<(), PosixStoreError> {
    rustix_fs::fsync(directory).map_err(|_| PosixStoreError::Io)
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn unsupported_platform_errors_fail_closed() {
        assert_eq!(
            classify_acl_error(&io::Error::from_raw_os_error(45)),
            PosixStoreError::Unsupported
        );
        assert_eq!(
            classify_acl_error(&io::Error::from_raw_os_error(22)),
            PosixStoreError::Unsupported
        );
        assert_eq!(
            classify_acl_error(&io::Error::from_raw_os_error(5)),
            PosixStoreError::Io
        );
        assert_eq!(
            classify_full_sync_error(Errno::INVAL),
            PosixStoreError::Unsupported
        );
        assert_eq!(
            classify_full_sync_error(Errno::NOTSUP),
            PosixStoreError::Unsupported
        );
        assert_eq!(
            classify_full_sync_error(Errno::NOSYS),
            PosixStoreError::Unsupported
        );
        assert_eq!(classify_full_sync_error(Errno::IO), PosixStoreError::Io);
    }
}
