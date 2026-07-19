#[path = "src/target_map.rs"]
mod target_map;

fn main() {
    let rust_target = std::env::var("TARGET").expect("Cargo must provide TARGET");
    let plurum_target = target_map::credential_target_id(&rust_target).unwrap_or_else(|| {
        panic!("unsupported Plurum native credential-store target: {rust_target}")
    });

    println!("cargo:rerun-if-changed=src/target_map.rs");
    println!("cargo:rustc-env=PLURUM_NATIVE_TARGET={plurum_target}");
    napi_build::setup();
}
