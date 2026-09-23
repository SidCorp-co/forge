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

const SETTINGS: &str = ".claude/settings.local.json";

const MANAGED_MARKERS: [&str; 2] = [" hook --event ", " gate --event "];

pub const POSIX_SHELL: bool = cfg!(unix);

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
    let Some(exe_text) = exe.to_str() else {
        return Err(Error::Other(format!(
            "the runner's own path is not valid UTF-8 ({}), so a hook command naming it would name a different file",
            exe.display()
        )));
    };
    if !crate::exe::is_runnable(exe) {
        return Err(Error::Other(format!(
            "no runnable file stands at {exe_text}, so every hook naming it would die at every call — installing none"
        )));
    }
    let exe = exe_text;
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

/// The program a managed hook command invokes, unquoted.
fn program_of(command: &str) -> Option<String> {
    let cut = MANAGED_MARKERS
        .iter()
        .filter_map(|m| command.find(m))
        .min()?;
    Some(unquoted(command[..cut].trim()))
}

/// The inverse of `shell_quoted`, for both shells it writes.
fn unquoted(head: &str) -> String {
    if let Some(inner) = head.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
        return inner.replace(r"'\''", "'");
    }
    if let Some(inner) = head.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        return inner.to_string();
    }
    head.to_string()
}

/// The programs this daemon's own hook commands in `text` name that nothing can
/// run. An operator's own hooks are not read: they are theirs to keep working.
pub fn unrunnable_in(text: &str) -> Result<Vec<String>> {
    let doc: Value = serde_json::from_str(text)
        .map_err(|e| Error::Other(format!("{SETTINGS} is not readable JSON: {e}")))?;
    let Some(hooks) = doc.get("hooks").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let mut found: Vec<String> = hooks
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .filter(|e| is_managed(e))
        .filter_map(|e| e.get("hooks").and_then(Value::as_array))
        .flatten()
        .filter_map(|h| h.get("command").and_then(Value::as_str))
        .filter_map(program_of)
        .filter(|p| !crate::exe::is_runnable(Path::new(p)))
        .collect();
    found.sort();
    found.dedup();
    Ok(found)
}

/// Rewrite a settings file this daemon already wrote whose own hook commands
/// name a program nothing can run, and leave one whose commands all run exactly
/// as it stands.
///
/// Fixing where the path comes from does not unpoison a file written yesterday.
/// A pane is prepared per project, so a project nobody dispatches to keeps a
/// dead gate until somebody opens a session in it by hand. Returns the programs
/// that could not be run, empty when nothing was owed.
pub fn repair(cwd: &Path, exe: &Path) -> Result<Vec<String>> {
    let path = settings_path(cwd);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    let unrunnable = unrunnable_in(&text)?;
    if unrunnable.is_empty() {
        return Ok(Vec::new());
    }
    install(cwd, exe)?;
    Ok(unrunnable)
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

    #[test]
    fn the_gate_is_registered_for_the_event_that_runs_before_the_dispatch() {
        assert_eq!(
            gate_command_for("/bin/fr", true),
            "'/bin/fr' gate --event PreToolUse"
        );
        assert_ne!(GATE_EVENT, Event::SubagentStarted.wire());
    }

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

    #[test]
    fn the_shell_is_what_decides_the_quoting_and_nothing_else_differs() {
        let exe = "/opt/Forge Runner/forge-runner";
        assert_ne!(
            command_for(exe, Event::PromptSubmitted, true),
            command_for(exe, Event::PromptSubmitted, false),
            "same exe, same event — only the shell differs"
        );
    }

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

    #[test]
    fn installing_twice_does_not_leave_two_copies() {
        let once = merged_for(None, "/bin/fr", true).unwrap();
        let twice = merged_for(Some(&once), "/bin/fr", true).unwrap();
        let hooks = hooks_of(&twice);
        assert_eq!(hooks["Stop"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn an_entry_from_a_previous_exe_path_is_replaced_not_joined() {
        let old = merged_for(None, "/old/path/forge-runner", true).unwrap();
        let new = merged_for(Some(&old), "/new/path/forge-runner", true).unwrap();
        let entries = hooks_of(&new)["Stop"].as_array().unwrap().clone();
        assert_eq!(entries.len(), 1);
        let cmd = entries[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.starts_with("'/new/path/"), "{cmd}");
    }

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
        let dir = scratch_dir("write-reread");
        let (_home, exe) = scratch_runner("real-binary");
        let path = install(&dir, &exe).unwrap();
        assert!(path.ends_with(SETTINGS));
        let back = std::fs::read_to_string(&path).unwrap();
        assert!(hooks_of(&back).contains_key("Stop"));
        // A second install over the file it just wrote stays at one entry.
        install(&dir, &exe).unwrap();
        let back = std::fs::read_to_string(&path).unwrap();
        assert_eq!(hooks_of(&back)["Stop"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_path_no_file_stands_at_is_refused_by_name_and_installs_nothing() {
        let dir = scratch_dir("absent");
        let err = install(&dir, &dir.join("forge-runner"))
            .expect_err("a hook naming a file that is not there dies at every call");

        let said = err.to_string();
        assert!(
            said.contains("no runnable file"),
            "the refusal must name the CLASS, or it reads as a permissions fault: {said:?}"
        );
        assert!(
            !settings_path(&dir).exists(),
            "nothing may be written for a path that cannot be invoked"
        );
    }

    /// The refusal is a refusal to WRITE, which is only visible where something
    /// was already there to be overwritten.
    #[cfg(unix)]
    #[test]
    fn a_settings_file_already_standing_survives_that_refusal_byte_for_byte() {
        let dir = scratch_dir("absent-over-existing");
        let (_home, good) = scratch_runner("still-here");
        let path = install(&dir, &good).expect("the file a working daemon writes");
        let before = std::fs::read_to_string(&path).unwrap();

        install(&dir, &dir.join("forge-runner")).expect_err("must install nothing");

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            before,
            "the refusal rewrote a settings file that was already correct"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_program_a_managed_command_names_is_read_back_out_of_its_quoting() {
        for exe in [
            "/opt/forge/forge-runner",
            "/opt/Forge Runner/forge-runner",
            "/opt/o'brien/forge-runner",
        ] {
            for posix in [true, false] {
                let command = command_for(exe, Event::PromptSubmitted, posix);
                assert_eq!(
                    program_of(&command).as_deref(),
                    Some(exe),
                    "posix={posix}, command was {command:?}"
                );
            }
            assert_eq!(
                program_of(&gate_command_for(exe, true)).as_deref(),
                Some(exe)
            );
        }
        assert_eq!(
            program_of("audit-hook --event PreToolUse"),
            None,
            "somebody else's command names no program of ours"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_file_poisoned_by_an_earlier_daemon_is_rewritten_by_the_repair() {
        let dir = scratch_dir("repair");
        let (_home, good) = scratch_runner("the-build-on-disk");
        let gone = dir.join(format!("forge-runner{}", crate::exe::DELETED_SUFFIX));
        std::fs::create_dir_all(settings_path(&dir).parent().unwrap()).unwrap();
        std::fs::write(
            settings_path(&dir),
            merged(None, gone.to_str().unwrap()).unwrap(),
        )
        .unwrap();

        let rewritten = repair(&dir, &good).expect("repair");
        assert_eq!(
            rewritten,
            vec![gone.to_str().unwrap().to_string()],
            "the repair must name what could not be run, or the journal says only that it did something"
        );

        let back = std::fs::read_to_string(settings_path(&dir)).unwrap();
        assert!(
            !back.contains(crate::exe::DELETED_SUFFIX),
            "the dead path is still in the file: {back}"
        );
        assert!(back.contains(good.to_str().unwrap()), "{back}");
    }

    #[cfg(unix)]
    #[test]
    fn a_file_whose_commands_all_run_is_left_exactly_as_it_stands() {
        let dir = scratch_dir("repair-healthy");
        let (_home, good) = scratch_runner("healthy");
        let path = install(&dir, &good).unwrap();
        let before = std::fs::read_to_string(&path).unwrap();

        assert!(
            repair(&dir, &good).expect("repair").is_empty(),
            "nothing was owed, so nothing may be reported"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            before,
            "a sweep rewrote a file it had no business touching"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_repair_keeps_hooks_the_operator_wrote_themselves() {
        let dir = scratch_dir("repair-theirs");
        let (_home, good) = scratch_runner("ours");
        let gone = dir.join(format!("forge-runner{}", crate::exe::DELETED_SUFFIX));
        let poisoned = merged(None, gone.to_str().unwrap()).unwrap();
        let mut doc: Value = serde_json::from_str(&poisoned).unwrap();
        doc["hooks"]["Stop"].as_array_mut().unwrap().push(json!({
            "hooks": [{ "type": "command", "command": "say done" }]
        }));
        doc["permissions"] = json!({ "allow": ["Bash"] });
        std::fs::create_dir_all(settings_path(&dir).parent().unwrap()).unwrap();
        std::fs::write(settings_path(&dir), doc.to_string()).unwrap();

        assert!(!repair(&dir, &good).expect("repair").is_empty());

        let back: Value =
            serde_json::from_str(&std::fs::read_to_string(settings_path(&dir)).unwrap()).unwrap();
        let stop = back["hooks"]["Stop"].as_array().unwrap();
        assert!(
            stop.iter().any(|e| e["hooks"][0]["command"] == "say done"),
            "the repair took an operator's own hook with it: {stop:?}"
        );
        assert_eq!(back["permissions"]["allow"][0], "Bash");
    }

    #[cfg(unix)]
    #[test]
    fn the_repair_reads_a_file_it_cannot_parse_as_a_refusal_rather_than_a_rewrite() {
        let dir = scratch_dir("repair-unparseable");
        let (_home, good) = scratch_runner("ours");
        std::fs::create_dir_all(settings_path(&dir).parent().unwrap()).unwrap();
        std::fs::write(settings_path(&dir), "{ not json").unwrap();

        let err =
            repair(&dir, &good).expect_err("a file this cannot read is not a file to rewrite");
        assert!(err.to_string().contains("not readable JSON"), "{err}");
        assert_eq!(
            std::fs::read_to_string(settings_path(&dir)).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn a_project_with_no_settings_file_is_not_one_the_repair_creates_one_for() {
        let dir = scratch_dir("repair-absent");
        assert!(repair(&dir, Path::new("/bin/fr"))
            .expect("repair")
            .is_empty());
        assert!(
            !settings_path(&dir).exists(),
            "the repair wrote hooks into a project no pane has ever been prepared for"
        );
    }
}
