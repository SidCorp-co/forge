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
// cm:guard `--event` alone, so it recognises BOTH this daemon's verbs — `hook` and `gate`. Keyed on `hook --event` it would leave a stale `gate` entry behind on every pane spawn, which is the multiplying-hooks failure this marker exists to prevent, arriving through the newer verb.
const MANAGED_MARKER: &str = "--event";

fn command_for(exe: &str, event: Event) -> String {
    format!("{exe} hook --event {}", event.wire())
}

/// The `PreToolUse` entry: the one hook on a pane that ANSWERS rather than reports.
// cm:guard this is the door the declaration is enforced at, and registering it here rather than anywhere else is the whole of why it holds: `install` is called before every pane this daemon spawns, so a master gets the gate without anybody configuring a box. A gate wired up somewhere a person has to opt into is the advice this issue is replacing, wearing a config key.
// cm:edge lockstep -> packages/runner/crates/forge-runner/src/cmd/gate.rs — the verb this names and the event it is registered for are one decision; the end-to-end test runs THIS string as a process and feeds it a real payload, so a wrong verb or a wrong event here fails there rather than in silence.
pub const GATE_EVENT: &str = "PreToolUse";

fn gate_command_for(exe: &str) -> String {
    format!("{exe} gate --event {GATE_EVENT}")
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
                    .is_some_and(|c| c.contains(MANAGED_MARKER))
            })
        })
}

/// The settings text a pane should start with, given whatever is there now.
// cm:guard MERGES and never replaces: a user's own hooks in this file are theirs, and an install that wrote a fresh document would delete them silently on every pane spawn. Only entries this daemon recognises as its own are removed, and only to be replaced.
// cm:guard unparseable existing content is REFUSED by name rather than overwritten. A corrupt or hand-edited file is somebody's work in an unknown state; the honest outcome is a pane that starts unhooked and says so, not a file this daemon quietly truncated.
pub fn merged(existing: Option<&str>, exe: &str) -> Result<String> {
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
            "hooks": [{ "type": "command", "command": command_for(exe, event) }]
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
        "hooks": [{ "type": "command", "command": gate_command_for(exe) }]
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
    let path = settings_path(cwd);
    let existing = std::fs::read_to_string(&path).ok();
    let next = merged(existing.as_deref(), &exe.to_string_lossy())?;
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
        let out = merged(None, "/bin/fr").unwrap();
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
        let hooks = hooks_of(&merged(None, "/bin/fr").unwrap());
        let entries = hooks
            .get(GATE_EVENT)
            .and_then(Value::as_array)
            .unwrap_or_else(|| panic!("no {GATE_EVENT} entry: a master would dispatch ungated"));
        let cmd = entries
            .iter()
            .filter_map(|e| e["hooks"][0]["command"].as_str())
            .find(|c| c.contains("gate --event"))
            .unwrap_or_else(|| panic!("no gate command among {entries:?}"));
        assert_eq!(cmd, "/bin/fr gate --event PreToolUse");
    }

    /// Criterion 23. The event argument is part of the door, not decoration.
    // cm:guard asserts the WHOLE string rather than that it contains `gate`. `gate --event SubagentStart` registers a hook that fires after the dispatch it was meant to refuse, and every structural test that only looked for the verb would still be green.
    #[test]
    fn the_gate_is_registered_for_the_event_that_runs_before_the_dispatch() {
        assert_eq!(
            gate_command_for("/bin/fr"),
            "/bin/fr gate --event PreToolUse"
        );
        assert_ne!(GATE_EVENT, Event::SubagentStarted.wire());
    }

    /// Both of this daemon's verbs are recognised as its own on a later pass.
    #[test]
    fn the_gate_is_not_duplicated_by_a_second_install() {
        let once = merged(None, "/bin/fr").unwrap();
        let twice = merged(Some(&once), "/bin/fr").unwrap();
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
        let once = merged(None, "/bin/fr").unwrap();
        let twice = merged(Some(&once), "/bin/fr").unwrap();
        let hooks = hooks_of(&twice);
        assert_eq!(hooks["Stop"].as_array().unwrap().len(), 1);
    }

    // cm:guard the same, across the case the marker exists FOR: an update moves the exe, and an entry from the old path must be replaced rather than joined.
    #[test]
    fn an_entry_from_a_previous_exe_path_is_replaced_not_joined() {
        let old = merged(None, "/old/path/forge-runner").unwrap();
        let new = merged(Some(&old), "/new/path/forge-runner").unwrap();
        let entries = hooks_of(&new)["Stop"].as_array().unwrap().clone();
        assert_eq!(entries.len(), 1);
        let cmd = entries[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.starts_with("/new/path/"), "{cmd}");
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
        let out = merged(Some(&mine), "/bin/fr").unwrap();
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
            .any(|e| e["hooks"][0]["command"] == "/bin/fr gate --event PreToolUse"));
        let root: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            root["permissions"]["allow"][0], "Bash",
            "unrelated settings must not be touched"
        );
    }

    // cm:guard refusing beats truncating: the file may be somebody's work in a state this code cannot read, and a pane that starts unhooked is recoverable where a deleted config is not.
    #[test]
    fn a_file_this_cannot_parse_is_refused_by_name_rather_than_overwritten() {
        let e = merged(Some("{ not json"), "/bin/fr").unwrap_err();
        let msg = format!("{e}");
        assert!(msg.contains("settings.local.json"), "{msg}");
        assert!(msg.contains("not readable JSON"), "{msg}");
    }

    #[test]
    fn a_json_array_is_refused_too() {
        assert!(merged(Some("[]"), "/bin/fr").is_err());
    }

    #[test]
    fn an_empty_file_reads_as_no_settings_rather_than_a_parse_error() {
        assert!(merged(Some("   "), "/bin/fr").is_ok());
    }

    #[test]
    fn the_command_names_the_event_it_reports() {
        let out = merged(None, "/bin/fr").unwrap();
        let hooks = hooks_of(&out);
        let cmd = hooks["UserPromptSubmit"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(cmd, "/bin/fr hook --event UserPromptSubmit");
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
