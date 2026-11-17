//! The daemon never sudoes (ISS-1276): a box's root parts are asked for once, at a terminal, by
//! `forge-runner setup` alone. Neither the daemon nor the box crate it runs names `sudo` anywhere
//! a command could be built from.
// @direct-test-of packages/runner/crates/runner-box/src

use std::path::Path;

fn sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir)
        .expect("a source directory")
        .flatten()
    {
        let p = entry.path();
        if p.is_dir() {
            sources(&p, out);
        } else if p.extension().is_some_and(|e| e == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn neither_the_daemon_nor_the_box_crate_ever_runs_sudo() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = Vec::new();
    for c in ["runner-daemon/src", "runner-box/src"] {
        sources(&crates.join(c), &mut files);
    }
    assert!(files.len() > 20, "{} files read", files.len());
    let this = file!().rsplit('/').next().unwrap_or_default().to_string();
    let named: Vec<String> = files
        .iter()
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy() != this))
        .filter(|p| {
            let text = std::fs::read_to_string(p).unwrap_or_default();
            text.contains("\"sudo\"") || text.contains("\"sudo ") || text.contains("pkexec")
        })
        .map(|p| p.display().to_string())
        .collect();
    assert!(
        named.is_empty(),
        "these name sudo where the daemon runs them: {named:?}"
    );
}
