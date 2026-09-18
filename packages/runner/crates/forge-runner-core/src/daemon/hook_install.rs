//! Registering this daemon's hooks where a pane about to start will read them.
//!
//! `agent_activity` can only hear what something reports, and nothing reports
//! unless the session's own settings name a command to run. That file is the
//! whole installation: Claude Code reads it at startup, so this must land
//! BEFORE the pane is spawned or the session runs its entire life unhooked.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::daemon::agent_activity::Event;
use crate::error::{Error, Result};

/// The settings file this writes, relative to the pane's working directory.
// cm:guard `.local` is load-bearing: `.claude/settings.json` is a file repositories COMMIT, and writing generated content there would put this daemon's exe path into somebody's diff on every box. The local twin is gitignored wholesale, which is also why nothing here needs to be pretty.
const SETTINGS: &str = ".claude/settings.local.json";

/// How a managed command is recognised on a later pass.
// cm:guard identity is the VERB, never the exe path: the path changes under an update and a marker keyed on it would leave the old entry behind, so every restart would add one more copy of every hook and a pane would report each boundary as many times as this daemon had ever been installed.
// cm:guard BOTH of this daemon's verbs are listed, and the flag alone is never the marker. Keyed on `hook --event` a stale `gate` entry survives every pane spawn and the hooks multiply; keyed on `--event` alone, an operator's own `audit-hook --event PreToolUse` is classified as ours and silently deleted on the next spawn — a pane spawn that removes somebody's automation, which is the failure the merge exists to prevent (ISS-1094, review F6).
// cm:guard each marker carries its LEADING SPACE, which is the boundary between the exe path and
// the verb. Without it `audit-hook --event PreToolUse` — an operator's own command — contains
// `hook --event` and is deleted as ours on the next pane spawn. Measured by the test below, which
// went red against the first version of this fix.
const MANAGED_MARKERS: [&str; 2] = [" hook --event ", " gate --event "];

/// Whether the shell reading these commands quotes the POSIX way.
// cm:guard a VALUE and not a `#[cfg]` arm inside `shell_quoted`, which is the lesson ISS-1096 already paid for once: every test on this box runs where `cfg(unix)` is true, so an arm behind `cfg(windows)` fires nowhere anybody can run it and its green is worth nothing. As a parameter both arms are reachable from a linux test, and both are asserted below.
// cm:guard this is NOT `HOOKS_CAN_REPORT`, and the two must not be folded together however alike they read. That one says whether a frame can reach this daemon and gates the pool lane; this one says how a shell reads a string, and the MASTER lane installs hooks on every platform — `master.rs:install_hooks_logged` has no platform gate at all, so a windows master would get POSIX quoting if this were keyed on the other fact.
pub const POSIX_SHELL: bool = cfg!(unix);

/// One argument of a shell command line, carrying any character a path may hold.
// cm:guard the command is a SHELL string, so an unquoted `/opt/Forge Runner/forge-runner` invokes `/opt/Forge`. `install` never runs what it writes and still answers Ok, so `pool_jobs::open_channel` reads a channel that can never report and fails the job at the window (ISS-1096 F1).
// cm:guard POSIX: single quotes, every inner `'` closed, escaped and reopened. Double quotes would expand `$`, `` ` `` and `\` inside a path holding them.
// cm:guard cmd.exe: double quotes, nothing escaped inside — `"` is not legal in a windows path, so an escaping branch here is one no test could reach.
// cm:guard what the windows arm's tests assert is the STRING and never its execution: nothing on this fleet runs a hook through cmd.exe, so `%VAR%` in a path — legal on NTFS — is still expanded and unproven here. Unchanged by this fix rather than introduced by it; the unquoted form had it too. A declared hole, not a covered one.
fn shell_quoted(path: &str, posix: bool) -> String {
    if posix {
        format!("'{}'", path.replace('\'', r"'\''"))
    } else {
        format!("\"{path}\"")
    }
}

fn command_for(exe: &str, event: Event, posix: bool) -> String {
    format!("{} hook --event {}", shell_quoted(exe, posix), event.wire())
}

/// The `PreToolUse` entry: the one hook on a pane that ANSWERS rather than reports.
// cm:guard this is the door the declaration is enforced at, and registering it here rather than anywhere else is the whole of why it holds: `install` is called before every pane this daemon spawns, so a master gets the gate without anybody configuring a box. A gate wired up somewhere a person has to opt into is the advice this issue is replacing, wearing a config key.
// cm:edge lockstep -> packages/runner/crates/forge-runner/src/cmd/gate.rs — the verb this names and the event it is registered for are one decision; the end-to-end test runs THIS string as a process and feeds it a real payload, so a wrong verb or a wrong event here fails there rather than in silence.
pub const GATE_EVENT: &str = "PreToolUse";

fn gate_command_for(exe: &str, posix: bool) -> String {
    format!("{} gate --event {GATE_EVENT}", shell_quoted(exe, posix))
}

/// Whether one entry in an event's hook array is ours.
fn is_managed(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| MANAGED_MARKERS.iter().any(|m| c.contains(m)))
            })
        })
}

/// The settings text a pane should start with, given whatever is there now.
// cm:guard MERGES and never replaces: a user's own hooks in this file are theirs, and an install that wrote a fresh document would delete them silently on every pane spawn. Only entries this daemon recognises as its own are removed, and only to be replaced.
// cm:guard unparseable existing content is REFUSED by name rather than overwritten. A corrupt or hand-edited file is somebody's work in an unknown state; the honest outcome is a pane that starts unhooked and says so, not a file this daemon quietly truncated.
pub fn merged(existing: Option<&str>, exe: &str) -> Result<String> {
    merged_for(existing, exe, POSIX_SHELL)
}

/// The same, with the shell named rather than read off this machine.
pub fn merged_for(existing: Option<&str>, exe: &str, posix: bool) -> Result<String> {
    let mut root: Map<String, Value> = match existing.map(str::trim) {
        None | Some("") => Map::new(),
        Some(text) => serde_json::from_str::<Value>(text)
            .map_err(|e| Error::Other(format!("{SETTINGS} is not readable JSON: {e}")))?
            .as_object()
            .cloned()
            .ok_or_else(|| Error::Other(format!("{SETTINGS} is not a JSON object")))?,
    };

    let mut hooks: Map<String, Value> = root
        .get("hooks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    for event in Event::ALL {
        let mut entries: Vec<Value> = hooks
            .get(event.wire())
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|e| !is_managed(e))
            .collect();
        entries.push(json!({
            "hooks": [{ "type": "command", "command": command_for(exe, event, posix) }]
        }));
        hooks.insert(event.wire().to_string(), Value::Array(entries));
    }

    let mut gate: Vec<Value> = hooks
        .get(GATE_EVENT)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|e| !is_managed(e))
        .collect();
    // cm:guard the matcher is `*` and not the dispatch tool's name. Measured on claude 2.1.276 that tool is `Agent`; it has been called other things, and a matcher naming it would turn the gate off on the version that renames it, silently. The verb itself answers in microseconds for every tool call that is not a dispatch.
    gate.push(json!({
        "matcher": "*",
        "hooks": [{ "type": "command", "command": gate_command_for(exe, posix) }]
    }));
    hooks.insert(GATE_EVENT.to_string(), Value::Array(gate));

    root.insert("hooks".into(), Value::Object(hooks));
    serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| Error::Other(format!("cannot serialize {SETTINGS}: {e}")))
}

pub fn settings_path(cwd: &Path) -> PathBuf {
    cwd.join(SETTINGS)
}

/// Install the hooks into `cwd`, returning the file written.
pub fn install(cwd: &Path, exe: &Path) -> Result<PathBuf> {
    // cm:guard REFUSE the one class quoting cannot carry, rather than install a command naming a different file. `to_string_lossy` replaces each invalid UTF-8 byte with U+FFFD and no quoting recovers it, so a runner under a non-UTF-8 path would be registered under a name nothing can exec — and `open_channel`'s reader treats a successful install as a channel that can report. The caller already has the arm for this: an `Err` here starts the pane unhooked and says so, which is the honest reading (ISS-1096, review F1).
    let Some(exe) = exe.to_str() else {
        return Err(Error::Other(format!(
            "the runner's own path is not valid UTF-8 ({}), so a hook command naming it would name a different file",
            exe.display()
        )));
    };
    let path = settings_path(cwd);
    let existing = std::fs::read_to_string(&path).ok();
    let next = merged(existing.as_deref(), exe)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| Error::Other(format!("cannot create {}: {e}", dir.display())))?;
    }
    std::fs::write(&path, next)
        .map_err(|e| Error::Other(format!("cannot write {}: {e}", path.display())))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hooks_of(text: &str) -> Map<String, Value> {
        serde_json::from_str::<Value>(text).unwrap()["hooks"]
            .as_object()
            .cloned()
            .unwrap()
    }

    #[test]
    fn every_event_the_daemon_understands_is_registered() {
        let out = merged_for(None, "/bin/fr", true).unwrap();
        let hooks = hooks_of(&out);
        for e in Event::ALL {
            assert!(
                hooks.contains_key(e.wire()),
                "{} is understood and not registered — the channel is only as wide as this file",
                e.wire()
            );
        }
        assert_eq!(
            hooks.len(),
            Event::ALL.len() + 1,
            "the eight reporting events plus the one gate, and nothing else"
        );
    }

    /// Criterion 20. The gate reaches a pane because the same installer that
    /// registers the activity hooks registers it, with nobody configuring a box.
    // cm:guard this is the DOOR, not the arm. Deleting `gate` from `merged` leaves every test of `dispatch_gate::decide` green while no dispatch on the fleet ever reaches it — which is the shape of a criterion that stayed green after the event it was about was removed from the list entirely (ISS-1075).
    #[test]
    fn the_declaration_gate_is_registered_on_every_pane_this_daemon_opens() {
        let hooks = hooks_of(&merged_for(None, "/bin/fr", true).unwrap());
        let entries = hooks
            .get(GATE_EVENT)
            .and_then(Value::as_array)
            .unwrap_or_else(|| panic!("no {GATE_EVENT} entry: a master would dispatch ungated"));
        let cmd = entries
            .iter()
            .filter_map(|e| e["hooks"][0]["command"].as_str())
            .find(|c| c.contains("gate --event"))
            .unwrap_or_else(|| panic!("no gate command among {entries:?}"));
        assert_eq!(cmd, "'/bin/fr' gate --event PreToolUse");
    }

    /// Criterion 23. The event argument is part of the door, not decoration.
    // cm:guard asserts the WHOLE string rather than that it contains `gate`. `gate --event SubagentStart` registers a hook that fires after the dispatch it was meant to refuse, and every structural test that only looked for the verb would still be green.
    #[test]
    fn the_gate_is_registered_for_the_event_that_runs_before_the_dispatch() {
        assert_eq!(
            gate_command_for("/bin/fr", true),
            "'/bin/fr' gate --event PreToolUse"
        );
        assert_ne!(GATE_EVENT, Event::SubagentStarted.wire());
    }

    /// A runner whose own path holds a space is still the thing the hook runs.
    // cm:guard this RUNS the string through a shell rather than reading it, which is the only thing that would have caught F1: every structural assertion in this file passed against the unquoted version, because the defect is not in the text, it is in what a shell does with the text. `install` writes the file and never invokes what it wrote, so nothing downstream of it can tell a command that works from one that cannot.
    // cm:guard `#[cfg(unix)]` is scoping and not an amnesty: there is no hook channel on windows to test. `control::serve` is `#[cfg(not(unix))] -> Err`, `HOOKS_CAN_REPORT` is `cfg!(unix)`, and `pool_jobs::open_channel` reads that value and starts such a pane unhooked, so no frame is ever expected there.
    #[cfg(unix)]
    #[test]
    fn a_runner_under_a_path_with_a_space_is_what_the_hook_actually_invokes() {
        let (dir, exe) = scratch_runner("forge hooks with spaces");
        let cmd = reporting_command(&exe);

        let marker = dir.join("it-ran");
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .env("FORGE_HOOK_MARKER", &marker)
            .output()
            .expect("sh");

        assert!(
            marker.exists(),
            "the shell never reached the runner. command was {cmd:?}, stderr {:?}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// The same, for a path holding the quote character the quoting is made of.
    #[cfg(unix)]
    #[test]
    fn a_runner_under_a_path_holding_a_quote_is_still_invoked() {
        let (dir, exe) = scratch_runner("forge o'brien hooks");
        let cmd = reporting_command(&exe);

        let marker = dir.join("it-ran");
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .env("FORGE_HOOK_MARKER", &marker)
            .output()
            .expect("sh");

        assert!(
            marker.exists(),
            "a path holding `'` broke its own quoting. command was {cmd:?}, stderr {:?}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Quoting must not cost this daemon the ability to recognise its own entries.
    // cm:guard a STRING contract nothing type-checks, and quoting moved the character before the
    // verb. Asserted for BOTH shells and every event: lose the match and each spawn adds a copy.
    #[test]
    fn a_quoted_command_is_still_recognised_as_this_daemons_own() {
        let exe = "/opt/Forge Runner/forge-runner";
        for posix in [true, false] {
            let once = merged_for(None, exe, posix).unwrap();
            let twice = merged_for(Some(&once), exe, posix).unwrap();
            let hooks = hooks_of(&twice);

            for event in Event::ALL {
                let entries = hooks[event.wire()].as_array().unwrap();
                assert_eq!(
                    entries.len(),
                    1,
                    "posix={posix}, {}: a second copy, so the quoted command is no longer recognised as ours: {entries:?}",
                    event.wire()
                );
            }
            let gate = hooks[GATE_EVENT].as_array().unwrap();
            assert_eq!(gate.len(), 1, "posix={posix}: the gate doubled: {gate:?}");
        }
    }

    /// And must not start claiming somebody else's.
    #[test]
    fn quoting_does_not_widen_what_counts_as_this_daemons_own() {
        let theirs = serde_json::json!({
            "hooks": {
                GATE_EVENT: [{ "hooks": [{ "type": "command", "command": "audit-hook --event PreToolUse" }] }]
            }
        })
        .to_string();
        let out = merged_for(Some(&theirs), "/opt/Forge Runner/forge-runner", true).unwrap();
        let entries = hooks_of(&out)[GATE_EVENT].as_array().unwrap().clone();

        assert!(
            entries.iter().any(|e| e["hooks"][0]["command"]
                .as_str()
                .is_some_and(|c| c == "audit-hook --event PreToolUse")),
            "a pane spawn deleted somebody else's automation: {entries:?}"
        );
    }

    /// The one class quoting cannot carry is refused by name, not installed lossily.
    // cm:guard a path is BYTES on unix and `to_string_lossy` replaces each invalid one with U+FFFD, so the command would name a file that does not exist while `install` answered Ok — the same silence F1 is, one layer down and beyond the reach of any quoting. `open_channel` already has the arm for an `Err` here; it needed no new one, and adding one there would have been a branch no plant could reach.
    #[cfg(unix)]
    #[test]
    fn a_runner_under_a_path_that_is_not_utf8_is_refused_by_name() {
        use std::os::unix::ffi::OsStrExt;

        let dir = scratch_dir("not-utf8");
        let exe = dir.join(std::ffi::OsStr::from_bytes(b"forge-\xff-runner"));
        let err = install(&dir, &exe).expect_err("a path this cannot represent must not install");

        let said = err.to_string();
        assert!(
            said.contains("not valid UTF-8"),
            "the refusal must name the CLASS, or it reads as the file system being at fault: {said:?}"
        );
        assert!(
            !settings_path(&dir).exists(),
            "nothing may be written for a runner this cannot name"
        );
    }

    /// The windows arm, asserted from linux because the value makes it reachable.
    // cm:guard cmd.exe does not read `'` as quoting, so the POSIX form everywhere would REGRESS the
    // windows master lane — `install_hooks_logged` has no platform gate and installs there too.
    #[test]
    fn a_windows_shell_gets_the_quoting_a_windows_shell_understands() {
        let cmd = command_for(
            r"C:\Program Files\forge\forge-runner.exe",
            Event::PromptSubmitted,
            false,
        );
        assert_eq!(
            cmd,
            "\"C:\\Program Files\\forge\\forge-runner.exe\" hook --event UserPromptSubmit"
        );
    }

    /// And the two arms must not agree by accident.
    // cm:guard this is what says the parameter is load bearing rather than decorative — the same
    // assertion `pool_jobs` makes about `hooks_can_report`, and for the same reason.
    #[test]
    fn the_shell_is_what_decides_the_quoting_and_nothing_else_differs() {
        let exe = "/opt/Forge Runner/forge-runner";
        assert_ne!(
            command_for(exe, Event::PromptSubmitted, true),
            command_for(exe, Event::PromptSubmitted, false),
            "same exe, same event — only the shell differs"
        );
    }

    /// The wrapper every caller uses must hand `merged_for` this platform's shell.
    // cm:guard the ONE test here that reads the ambient value; every other test NAMES its shell. They used to read it, which made four assert the POSIX string under `cfg!(unix) == false`: green on linux, red on the windows leg, and the green said nothing about the arm it seemed to cover (ISS-1096 F1, caught by #524's windows leg).
    // cm:guard what this can and cannot catch, said plainly because it derives its expectation from the same constant the code reads: it catches `merged` delegating with a literal instead of `POSIX_SHELL`, and it is NOT evidence about either arm's content. That belongs to the tests that name an arm and assert a hand-written literal, which is the only shape here that can disagree with its subject.
    #[test]
    fn the_ambient_wrapper_hands_on_this_platforms_shell() {
        let exe = "/opt/Forge Runner/forge-runner";
        assert_eq!(
            merged(None, exe).unwrap(),
            merged_for(None, exe, POSIX_SHELL).unwrap(),
            "`merged` must delegate with POSIX_SHELL and nothing else"
        );
    }

    fn scratch_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "forge-hookq-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    /// A directory named `label`, holding a runner that proves it was invoked.
    #[cfg(unix)]
    fn scratch_runner(label: &str) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch_dir("run").join(label);
        std::fs::create_dir_all(&dir).expect("scratch");
        let exe = dir.join("forge-runner");
        std::fs::write(&exe, "#!/bin/sh\necho ran > \"$FORGE_HOOK_MARKER\"\n").expect("runner");
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        (dir, exe)
    }

    /// The command this daemon would install for a reporting event.
    fn reporting_command(exe: &Path) -> String {
        let out = merged_for(None, exe.to_str().unwrap(), true).unwrap();
        hooks_of(&out)[Event::PromptSubmitted.wire()]
            .as_array()
            .unwrap()[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// Both of this daemon's verbs are recognised as its own on a later pass.
    #[test]
    fn the_gate_is_not_duplicated_by_a_second_install() {
        let once = merged_for(None, "/bin/fr", true).unwrap();
        let twice = merged_for(Some(&once), "/bin/fr", true).unwrap();
        let entries = hooks_of(&twice)[GATE_EVENT].as_array().unwrap().clone();
        let ours = entries
            .iter()
            .filter(|e| {
                e["hooks"][0]["command"]
                    .as_str()
                    .is_some_and(|c| c.contains("gate --event"))
            })
            .count();
        assert_eq!(ours, 1, "{entries:?}");
    }

    // cm:guard the failure this prevents is silent and cumulative: a marker keyed on the exe path would not match after an update, so every daemon restart would append one more copy of every hook and each boundary would be reported many times over.
    #[test]
    fn installing_twice_does_not_leave_two_copies() {
        let once = merged_for(None, "/bin/fr", true).unwrap();
        let twice = merged_for(Some(&once), "/bin/fr", true).unwrap();
        let hooks = hooks_of(&twice);
        assert_eq!(hooks["Stop"].as_array().unwrap().len(), 1);
    }

    // cm:guard the same, across the case the marker exists FOR: an update moves the exe, and an entry from the old path must be replaced rather than joined.
    #[test]
    fn an_entry_from_a_previous_exe_path_is_replaced_not_joined() {
        let old = merged_for(None, "/old/path/forge-runner", true).unwrap();
        let new = merged_for(Some(&old), "/new/path/forge-runner", true).unwrap();
        let entries = hooks_of(&new)["Stop"].as_array().unwrap().clone();
        assert_eq!(entries.len(), 1);
        let cmd = entries[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.starts_with("'/new/path/"), "{cmd}");
    }

    /// Review F6. An operator's own command that happens to take `--event`.
    // cm:guard the damage this prevents is silent and total: a pane spawn deletes somebody's automation and the only symptom is their hook stopping. The marker exists to recognise THIS daemon's entries, and a flag is not a signature.
    #[test]
    fn an_operators_own_event_taking_hook_is_not_mistaken_for_ours() {
        let theirs = serde_json::to_string(&json!({
            "hooks": {
                "PreToolUse": [
                    { "matcher": "*", "hooks": [{ "type": "command", "command": "audit-hook --event PreToolUse" }] },
                    { "matcher": "*", "hooks": [{ "type": "command", "command": "/old/fr gate --event PreToolUse" }] }
                ],
                "Stop": [{ "hooks": [{ "type": "command", "command": "/old/fr hook --event Stop" }] }]
            }
        }))
        .unwrap();
        let hooks = hooks_of(&merged_for(Some(&theirs), "/bin/fr", true).unwrap());
        let pre = hooks["PreToolUse"].as_array().unwrap();
        assert!(
            pre.iter()
                .any(|e| e["hooks"][0]["command"] == "audit-hook --event PreToolUse"),
            "an operator's own hook is theirs: {pre:?}"
        );
        assert_eq!(
            pre.iter()
                .filter(|e| e["hooks"][0]["command"]
                    .as_str()
                    .is_some_and(|c| c.contains("gate --event")))
                .count(),
            1,
            "our own stale entry is replaced, not joined: {pre:?}"
        );
        assert_eq!(hooks["Stop"].as_array().unwrap().len(), 1);
    }

    // cm:guard a user's own hooks are theirs. Without this, every pane spawn silently deletes whatever somebody configured on that checkout, and the only symptom is their hook stopping.
    #[test]
    fn a_users_own_hooks_survive_the_install() {
        let mine = serde_json::to_string(&json!({
            "hooks": {
                "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }],
                "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "lint" }] }]
            },
            "permissions": { "allow": ["Bash"] }
        }))
        .unwrap();
        let out = merged_for(Some(&mine), "/bin/fr", true).unwrap();
        let hooks = hooks_of(&out);
        let stop = hooks["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "the user's Stop hook and ours");
        assert!(stop.iter().any(|e| e["hooks"][0]["command"] == "say done"));
        // The user's own `PreToolUse` hook and the declaration gate, side by side:
        // the gate is added to that event now, and adding it may not cost somebody
        // the linter they wired up on the same one.
        let pre = hooks["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2, "the user's PreToolUse hook and ours: {pre:?}");
        assert!(pre.iter().any(|e| e["hooks"][0]["command"] == "lint"));
        assert!(pre
            .iter()
            .any(|e| e["hooks"][0]["command"] == "'/bin/fr' gate --event PreToolUse"));
        let root: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            root["permissions"]["allow"][0], "Bash",
            "unrelated settings must not be touched"
        );
    }

    // cm:guard refusing beats truncating: the file may be somebody's work in a state this code cannot read, and a pane that starts unhooked is recoverable where a deleted config is not.
    #[test]
    fn a_file_this_cannot_parse_is_refused_by_name_rather_than_overwritten() {
        let e = merged_for(Some("{ not json"), "/bin/fr", true).unwrap_err();
        let msg = format!("{e}");
        assert!(msg.contains("settings.local.json"), "{msg}");
        assert!(msg.contains("not readable JSON"), "{msg}");
    }

    #[test]
    fn a_json_array_is_refused_too() {
        assert!(merged_for(Some("[]"), "/bin/fr", true).is_err());
    }

    #[test]
    fn an_empty_file_reads_as_no_settings_rather_than_a_parse_error() {
        assert!(merged_for(Some("   "), "/bin/fr", true).is_ok());
    }

    #[test]
    fn the_command_names_the_event_it_reports() {
        let out = merged_for(None, "/bin/fr", true).unwrap();
        let hooks = hooks_of(&out);
        let cmd = hooks["UserPromptSubmit"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(cmd, "'/bin/fr' hook --event UserPromptSubmit");
    }

    #[test]
    fn it_writes_and_rereads_from_a_real_directory() {
        let dir = std::env::temp_dir().join(format!(
            "forge-hook-install-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = install(&dir, Path::new("/bin/fr")).unwrap();
        assert!(path.ends_with(SETTINGS));
        let back = std::fs::read_to_string(&path).unwrap();
        assert!(hooks_of(&back).contains_key("Stop"));
        // A second install over the file it just wrote stays at one entry.
        install(&dir, Path::new("/bin/fr")).unwrap();
        let back = std::fs::read_to_string(&path).unwrap();
        assert_eq!(hooks_of(&back)["Stop"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
