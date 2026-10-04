// What the binary answers for itself, fixed at build time.
//
// The target triple lets the updater pick the matching release asset at runtime.
//
// The version and the commit are what core compares a box against. They are
// STAMPED by `.github/workflows/runner-release.yml` rather than read from
// Cargo.toml, because the released patch is the tag's: `main` carries a required
// status check, so no CI push of a version-bump commit can reach it, and the
// number in Cargo.toml is the major.minor line the release counts patches from
// (`scripts/next-runner-version.mjs`). A build with no stamp — anybody's
// `cargo build` — answers with Cargo's own version and an unknown commit, which is
// the truth about it: it is not a published build and core will not call it
// current.
fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    println!("cargo:rustc-env=FORGE_RUNNER_TARGET={target}");

    println!("cargo:rerun-if-env-changed=FORGE_RUNNER_VERSION");
    let version = stamped("FORGE_RUNNER_VERSION")
        .unwrap_or_else(|| std::env::var("CARGO_PKG_VERSION").unwrap_or_default());
    println!("cargo:rustc-env=FORGE_RUNNER_VERSION={version}");

    println!("cargo:rerun-if-env-changed=FORGE_RUNNER_COMMIT");
    let commit = stamped("FORGE_RUNNER_COMMIT").unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=FORGE_RUNNER_COMMIT={commit}");
}

fn stamped(key: &str) -> Option<String> {
    std::env::var(key).ok().and_then(|v| {
        let v = v.trim().to_string();
        if v.is_empty() {
            None
        } else {
            Some(v)
        }
    })
}
