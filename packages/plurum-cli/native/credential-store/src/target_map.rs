pub fn credential_target_id(rust_target: &str) -> Option<&'static str> {
    match rust_target {
        "aarch64-apple-darwin" => Some("darwin-arm64"),
        "x86_64-apple-darwin" => Some("darwin-x64"),
        "aarch64-unknown-linux-gnu" => Some("linux-arm64-gnu"),
        "aarch64-unknown-linux-musl" => Some("linux-arm64-musl"),
        "x86_64-unknown-linux-gnu" => Some("linux-x64-gnu"),
        "x86_64-unknown-linux-musl" => Some("linux-x64-musl"),
        "aarch64-pc-windows-msvc" => Some("win32-arm64-msvc"),
        "x86_64-pc-windows-msvc" => Some("win32-x64-msvc"),
        _ => None,
    }
}
