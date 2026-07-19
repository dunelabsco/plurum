#![deny(unsafe_code)]

use napi_derive::napi;

#[cfg(test)]
mod target_map;

const TARGET_VALUE: &str = env!("PLURUM_NATIVE_TARGET");

// napi-rs exports constants under their Rust identifiers; these names are the
// fixed JavaScript ABI and intentionally do not follow Rust constant casing.
#[allow(non_upper_case_globals)]
#[napi]
pub const magic: &str = "plurum-native-credential-store";

#[allow(non_upper_case_globals)]
#[napi]
pub const abiVersion: u32 = 1;

#[allow(non_upper_case_globals)]
#[napi]
pub const nodeApiVersion: u32 = 8;

#[allow(non_upper_case_globals)]
#[napi]
pub const packageVersion: &str = env!("CARGO_PKG_VERSION");

#[allow(non_upper_case_globals)]
#[napi]
pub const target: &str = TARGET_VALUE;

/// This foundation crate must remain unusable until platform safety is proven.
#[napi(js_name = "createAdapters")]
pub fn create_adapters() {}

#[cfg(test)]
mod tests {
    use super::{
        abiVersion, create_adapters, magic, nodeApiVersion, packageVersion, target, target_map,
        TARGET_VALUE,
    };

    #[test]
    fn descriptor_values_are_stable() {
        assert_eq!(magic, "plurum-native-credential-store");
        assert_eq!(abiVersion, 1);
        assert_eq!(nodeApiVersion, 8);
        assert_eq!(packageVersion, "0.0.0-development");
        assert_eq!(target, TARGET_VALUE);
    }

    #[test]
    fn adapter_factory_has_no_value() {
        create_adapters();
    }

    #[test]
    fn target_mapping_accepts_only_exact_supported_triples() {
        let supported = [
            ("aarch64-apple-darwin", "darwin-arm64"),
            ("x86_64-apple-darwin", "darwin-x64"),
            ("aarch64-unknown-linux-gnu", "linux-arm64-gnu"),
            ("aarch64-unknown-linux-musl", "linux-arm64-musl"),
            ("x86_64-unknown-linux-gnu", "linux-x64-gnu"),
            ("x86_64-unknown-linux-musl", "linux-x64-musl"),
            ("aarch64-pc-windows-msvc", "win32-arm64-msvc"),
            ("x86_64-pc-windows-msvc", "win32-x64-msvc"),
        ];
        for (rust_target, plurum_target) in supported {
            assert_eq!(
                target_map::credential_target_id(rust_target),
                Some(plurum_target)
            );
        }

        for rust_target in [
            "x86_64-unknown-linux-gnux32",
            "aarch64-unknown-linux-gnu_ilp32",
            "x86_64-uwp-windows-msvc",
            "x86_64-win7-windows-msvc",
            "x86_64-pc-windows-gnu",
            "wasm32-unknown-unknown",
        ] {
            assert_eq!(target_map::credential_target_id(rust_target), None);
        }
    }
}
