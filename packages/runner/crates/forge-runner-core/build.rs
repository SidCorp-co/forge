// Capture the build target triple so the updater can pick the matching release
// asset at runtime (e.g. "x86_64-unknown-linux-gnu").
fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    println!("cargo:rustc-env=FORGE_RUNNER_TARGET={target}");
}
