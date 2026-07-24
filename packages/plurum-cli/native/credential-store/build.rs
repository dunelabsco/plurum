#[path = "src/target_map.rs"]
mod target_map;

fn main() {
    let rust_target = std::env::var("TARGET").expect("Cargo must provide TARGET");
    let plurum_target = target_map::credential_target_id(&rust_target).unwrap_or_else(|| {
        panic!("unsupported Plurum native credential-store target: {rust_target}")
    });

    println!("cargo:rerun-if-changed=src/target_map.rs");
    println!("cargo:rustc-env=PLURUM_NATIVE_TARGET={plurum_target}");
    if matches!(
        rust_target.as_str(),
        "aarch64-apple-darwin" | "x86_64-apple-darwin"
    ) {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-install_name,@rpath/credential-store.node");
    }
    napi_build::setup();
}
