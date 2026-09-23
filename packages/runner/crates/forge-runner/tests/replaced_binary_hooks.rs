//! The defect as the kernel produces it: a live process whose binary is
//! replaced underneath it, and the hook command a pane preparation builds from
//! the path that process then answers with.
//!
//! Every other test about this can be green while the fleet still poisons every
//! settings file it writes, because they all decide for themselves what the
//! annotated path looks like. `" (deleted)"` here is not a literal — it is read
//! off `/proc/<pid>/exe` for a process this file started and whose binary it
//! then replaced the way `update::apply` replaces it, so the string the
//! resolver is proved against is the one Linux actually writes.
//!
//! # The one platform this file can speak for
//!
//! The annotation is `/proc`'s, so this file runs on Linux and nowhere else.
//! What the resolver does with such a path is covered on every platform by
//! `exe`'s own unit tests; what is Linux-only is the evidence that Linux
//! produces that path at all.

#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use forge_runner_core::daemon::hook_install;
use forge_runner_core::exe;

/// A live process with no file left at the path it started from.
struct Replaced {
    child: Child,
    /// What `/proc/<pid>/exe` answers now — the kernel's own annotation.
    raw: PathBuf,
    /// The build standing at that path instead, as an updater leaves it.
    installed: PathBuf,
    dir: PathBuf,
}

impl Drop for Replaced {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "forge-replaced-{label}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

/// A real ELF this file may copy under a name of its own.
///
/// Not one of coreutils': `/bin/cat` and its siblings are one multi-call binary
/// that dispatches on `argv[0]`, so a copy named `forge-runner` exits at once
/// with `unknown program` and leaves no `/proc/<pid>/exe` to read. A shell
/// takes its name from nowhere and blocks on a pipe with no writer, which is
/// exactly the shape this file needs.
fn long_lived_program() -> PathBuf {
    ["/bin/sh", "/usr/bin/sh", "/bin/dash", "/bin/bash"]
        .into_iter()
        .map(PathBuf::from)
        .filter_map(|p| std::fs::canonicalize(p).ok())
        .find(|p| p.is_file())
        .expect(
            "no shell on this box: this file needs a real executable to replace under a process",
        )
}

/// Start a process from `<dir>/forge-runner`, then replace that file the way
/// `update::apply` does — write beside it and rename over it, which unlinks the
/// inode the process is running and leaves a different build at the path.
fn replaced_under_a_live_process(label: &str) -> Replaced {
    use std::os::unix::fs::PermissionsExt;

    let dir = scratch(label);
    let installed = dir.join("forge-runner");
    std::fs::copy(long_lived_program(), &installed).expect("install the first build");
    std::fs::set_permissions(&installed, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let child = spawn_blocking(&installed);

    let next = dir.join("forge-runner.new");
    std::fs::copy(long_lived_program(), &next).expect("download the next build");
    std::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    std::fs::rename(&next, &installed).expect("replace the running binary");

    let raw = std::fs::read_link(format!("/proc/{}/exe", child.id())).unwrap_or_else(|e| {
        panic!(
            "/proc/{}/exe could not be read ({e}) — the child is gone, so nothing was measured and no assertion below means anything",
            child.id()
        )
    });
    Replaced {
        child,
        raw,
        installed,
        dir,
    }
}

/// Start the copy so that it blocks: `read` waits on a pipe whose write end
/// this process holds open, so the child outlives every assertion and `Drop` is
/// what ends it.
///
/// Retried on `ETXTBSY`. A sibling test thread forking for its own spawn
/// inherits the write descriptor this one just used to copy the file, and until
/// that fork's `exec` closes it the kernel refuses to run the file. It is a race
/// between test threads and not a property of the subject, so a case that met it
/// measured nothing rather than failing.
fn spawn_blocking(program: &Path) -> Child {
    for _ in 0..50 {
        match Command::new(program)
            .arg("-c")
            .arg("read line")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => return child,
            Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(e) => panic!("start the daemon under test: {e}"),
        }
    }
    panic!(
        "{} stayed busy for a second: nothing was measured",
        program.display()
    )
}

fn commands_in(settings: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(settings).expect("the settings file");
    let doc: serde_json::Value = serde_json::from_str(&text).expect("settings json");
    doc["hooks"]
        .as_object()
        .expect("hooks")
        .values()
        .filter_map(serde_json::Value::as_array)
        .flatten()
        .filter_map(|e| e["hooks"].as_array())
        .flatten()
        .filter_map(|h| h["command"].as_str())
        .map(str::to_string)
        .collect()
}

fn repo_under(live: &Replaced) -> PathBuf {
    let repo = live.dir.join("repo");
    std::fs::create_dir_all(&repo).expect("repo");
    repo
}

#[test]
fn the_kernel_annotates_the_path_of_a_process_whose_binary_was_replaced() {
    let live = replaced_under_a_live_process("annotation");
    let raw = live.raw.to_str().expect("utf-8");
    assert!(
        raw.ends_with(exe::DELETED_SUFFIX),
        "this whole issue rests on Linux writing {:?} here, and it wrote {raw:?} instead — every other assertion in this file is then about a string that does not occur",
        exe::DELETED_SUFFIX
    );
    assert!(
        live.installed.is_file(),
        "the replacement did not land, so nothing was replaced and this file proves nothing"
    );
}

#[test]
fn a_pane_prepared_by_a_replaced_daemon_gets_hooks_that_run() {
    let live = replaced_under_a_live_process("prepare");
    let repo = repo_under(&live);

    let resolved = exe::resolve(&live.raw).expect("a build stands at that path, annotation aside");
    assert_eq!(resolved.path, live.installed);
    assert_eq!(
        resolved.replaced_from.as_deref(),
        Some(live.raw.as_path()),
        "the fallback must be reportable, or it is the silent substitution it replaced"
    );

    let settings = hook_install::install(&repo, &resolved.path).expect("install");
    let commands = commands_in(&settings);
    assert!(!commands.is_empty(), "no hook was written at all");
    for command in &commands {
        assert!(
            !command.contains(exe::DELETED_SUFFIX),
            "the pane was given a command nothing can execute: {command}"
        );
        assert!(
            command.contains(live.installed.to_str().expect("utf-8")),
            "the pane was given a command naming something other than the build on disk: {command}"
        );
    }
}

#[test]
fn the_annotated_path_itself_installs_no_hook_and_writes_nothing() {
    let live = replaced_under_a_live_process("refuse");
    let repo = repo_under(&live);

    match hook_install::install(&repo, &live.raw) {
        Ok(settings) => panic!(
            "a pane was prepared with commands nothing can execute: {:?}",
            commands_in(&settings)
        ),
        Err(e) => {
            let said = e.to_string();
            assert!(
                said.contains("no runnable file"),
                "the refusal must name the class, or a reader takes it for a permissions fault: {said}"
            );
        }
    }
    assert!(
        !hook_install::settings_path(&repo).exists(),
        "a hook command that cannot run was written anyway"
    );
}

#[test]
fn a_settings_file_already_standing_is_left_byte_for_byte_on_that_refusal() {
    let live = replaced_under_a_live_process("preserve");
    let repo = repo_under(&live);
    let settings = hook_install::settings_path(&repo);
    std::fs::create_dir_all(settings.parent().expect("parent")).expect("dot claude");

    let before = hook_install::merged(None, live.installed.to_str().expect("utf-8"))
        .expect("a file a working daemon would have written");
    std::fs::write(&settings, &before).expect("write");

    hook_install::install(&repo, &live.raw).expect_err("the annotated path must install nothing");

    let after = std::fs::read_to_string(&settings).expect("read back");
    assert_eq!(
        after, before,
        "the refusal rewrote a settings file that was already correct"
    );
}
