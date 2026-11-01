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
// `cargo build` — answers with Cargo's own version and the commit its checkout
// stands on (ISS-866), marked `-dirty` where the tree held uncommitted changes,
// so a hand-built box still says which code it runs; with neither git nor the
// stamp it says `unknown commit` by name.
mod stamp {
    include!("src/stamp.rs");
}

fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    println!("cargo:rustc-env=FORGE_RUNNER_TARGET={target}");

    println!("cargo:rerun-if-env-changed=FORGE_RUNNER_VERSION");
    let version = stamped("FORGE_RUNNER_VERSION")
        .unwrap_or_else(|| std::env::var("CARGO_PKG_VERSION").unwrap_or_default());
    println!("cargo:rustc-env=FORGE_RUNNER_VERSION={version}");

    println!("cargo:rerun-if-env-changed=FORGE_RUNNER_COMMIT");
    let (head, dirty) = checkout_head();
    let env = stamped("FORGE_RUNNER_COMMIT");
    let commit = stamp::chosen_commit(head.as_deref(), dirty, env.as_deref());
    println!("cargo:rustc-env=FORGE_RUNNER_COMMIT={commit}");
}

/// The checkout's `HEAD` and whether its tree holds uncommitted changes, or `None` where git
/// cannot be asked here. Rebuilt when `HEAD` moves, the index changes, or a runner source does.
fn checkout_head() -> (Option<String>, bool) {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let Some(head) = git(&["rev-parse", "HEAD"]).filter(|s| !s.is_empty()) else {
        return (None, false);
    };
    if let Some(dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        for watched in ["HEAD", "index", "packed-refs"] {
            println!("cargo:rerun-if-changed={dir}/{watched}");
        }
        if let Some(reference) = git(&["symbolic-ref", "-q", "HEAD"]) {
            println!("cargo:rerun-if-changed={dir}/{reference}");
        }
    }
    println!("cargo:rerun-if-changed=..");
    let dirty = git(&["status", "--porcelain"]).is_some_and(|s| !s.is_empty());
    (Some(head), dirty)
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
