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

    drop_entries_this_build_cannot_serve(&mut hooks);

    root.insert("hooks".into(), Value::Object(hooks));
    serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| Error::Other(format!("cannot serialize {SETTINGS}: {e}")))
}

/// Remove this daemon's own hook entries under every OTHER event key.
///
/// The marker is what makes an entry ours, and `unrunnable_in` reads it over
/// every event present in the file. Rewriting only `Event::ALL` and the gate
/// made the rewrite answer a narrower question than the scan, so an entry for
/// any other event was counted as dead, triggered the repair, and was then
/// left exactly as it was — the sweep naming a project repaired at every boot
/// and after every update while the file kept commands nothing could run
/// (ISS-1200).
///
/// Removed rather than repointed onto the build that stands. `cmd::hook` has
/// one rule above every other — a hook may never break the agent that runs it
/// — so a build handed an event it does not know exits 0, prints `{}` and
/// drops the report. Repointing such an entry would leave a command that runs,
/// says nothing and reports nothing, which is a worse lie than the dead one it
/// replaced: the sweep would settle on it and call the project repaired. What
/// this build cannot serve, it does not leave standing in its own name. The
/// removal is named in the journal by `install`, never made quietly, and a
/// daemon that can serve the event writes it back the next time it prepares a
/// pane there.
///
/// Only this daemon's own entries go: the program comes off the front of the
/// command exactly as `program_of` takes it, so what this removes and what
/// `unrunnable_in` counts are one reading of the file and not two, and an
/// operator's own hook under the same event is untouched.
fn drop_entries_this_build_cannot_serve(hooks: &mut Map<String, Value>) {
    let mut emptied: Vec<String> = Vec::new();
    for (event, entries) in hooks.iter_mut() {
        if installs(event) {
            continue;
        }
        let Some(entries) = entries.as_array_mut() else {
            continue;
        };
        entries.retain(|entry| !is_ours(entry));
        if entries.is_empty() {
            emptied.push(event.clone());
        }
    }
    for event in emptied {
        hooks.remove(&event);
    }
}

/// Whether this build registers hooks for `event` itself.
fn installs(event: &str) -> bool {
    event == GATE_EVENT || Event::ALL.iter().any(|e| e.wire() == event)
}

/// Whether one entry holds a command this daemon wrote, by the same reading
/// `unrunnable_in` counts one by.
fn is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hs| {
            hs.iter()
                .filter_map(|h| h.get("command").and_then(Value::as_str))
                .any(|c| program_of(c).is_some())
        })
}

/// The events outside this build's own set whose entries a rewrite will take
/// out, so the journal can name them rather than let them go quietly.
pub fn served_by_no_event_this_build_installs(text: &str) -> Vec<String> {
    let Ok(doc) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let Some(hooks) = doc.get("hooks").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut found: Vec<String> = hooks
        .iter()
        .filter(|(event, _)| !installs(event))
        .filter(|(_, entries)| entries.as_array().is_some_and(|es| es.iter().any(is_ours)))
        .map(|(event, _)| event.clone())
        .collect();
    found.sort();
    found
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
    if let Some(text) = existing.as_deref() {
        let gone = served_by_no_event_this_build_installs(text);
        if !gone.is_empty() {
            tracing::warn!(
                "[hooks] {} holds hooks of this runner's own under {}, which this build does not report on — removing them rather than leaving commands that run, say nothing and lose every report; a build that serves those events writes them back",
                path.display(),
                gone.join(", ")
            );
        }
    }
    let next = merged(existing.as_deref(), exe)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| Error::Other(format!("cannot create {}: {e}", dir.display())))?;
    }
    write_atomically(&path, &next)?;
    Ok(path)
}

/// Write beside the file and rename over it, the way `Config::save` writes.
///
/// A bare `std::fs::write` truncates in place, so a failure partway through
/// leaves a checkout with no hooks AND a file every later sweep refuses as
/// unreadable JSON — the one state this daemon cannot repair itself out of.
/// ISS-1200's sweep made this write run over every binding at boot and again
/// after every update, so how often that window is open went up a great deal.
/// A rename is the replace the reader either sees or does not.
fn write_atomically(path: &Path, body: &str) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)
        .map_err(|e| Error::Other(format!("cannot write {}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        Error::Other(format!(
            "cannot move {} over {}: {e}",
            tmp.display(),
            path.display()
        ))
    })
}

/// The program a managed hook command invokes, unquoted, and `None` for a
/// command that is not one of ours.
///
/// The program comes off the FRONT rather than out of a search for the marker:
/// a runner installed at `/opt/runner hook --event tools/forge-runner` carries
/// the marker inside its own quoted name, and a search would cut the path in
/// half and call a healthy hook dead.
fn program_of(command: &str) -> Option<String> {
    let (program, rest) = split_program(command)?;
    MANAGED_MARKERS
        .iter()
        .any(|m| rest.starts_with(m))
        .then_some(program)
}

/// The program and what follows it, with the quoting taken off the way the
/// shell `shell_quoted` wrote for would take it off.
fn split_program(command: &str) -> Option<(String, &str)> {
    let command = command.trim_start();
    if let Some(after) = command.strip_prefix('\'') {
        return posix_quoted(after);
    }
    if let Some(after) = command.strip_prefix('"') {
        let end = after.find('"')?;
        return Some((after[..end].to_string(), &after[end + 1..]));
    }
    let end = command.find(' ').unwrap_or(command.len());
    Some((command[..end].to_string(), &command[end..]))
}

/// Inside a single-quoted word: a literal quote is written `'\''`, which closes,
/// escapes and reopens, so the real close is the first `'` not followed by `\''`.
fn posix_quoted(after_open: &str) -> Option<(String, &str)> {
    let mut program = String::new();
    let mut rest = after_open;
    loop {
        let close = rest.find('\'')?;
        program.push_str(&rest[..close]);
        rest = &rest[close + 1..];
        match rest.strip_prefix(r"\''") {
            Some(reopened) => {
                program.push('\'');
                rest = reopened;
            }
            None => return Some((program, rest)),
        }
    }
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
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        // Absent is the answer for a project no pane was ever prepared for.
        // Anything else — unreadable bytes, a permission this daemon lost — is
        // not knowing, and reporting it as nothing to do is the silence this
        // whole issue is about.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(Error::Other(format!(
            "cannot read {} ({e}), so whether the hooks in it can run is unknown rather than fine",
            path.display()
        )))
        }
    };
    if unrunnable_in(&text)?.is_empty() {
        return Ok(Vec::new());
    }
    let path = install(cwd, exe)?;
    let after = std::fs::read_to_string(&path).map_err(|e| {
        Error::Other(format!(
            "cannot read {} back after rewriting it ({e}), so whether its hooks can run now is unknown rather than fixed",
            path.display()
        ))
    })?;
    repaired(&text, &after)
}

/// What the rewrite actually repaired, or a refusal naming what it did not.
///
/// The list a caller reports is read off the file the rewrite LEFT, never off
/// the scan that ran before it. Those were two derivations of the same
/// question and they disagreed: `unrunnable_in` counted every event in the
/// file while the rewrite covered only the events this build installs, and the
/// journal printed the first one's answer as though it described the second
/// one's work — a project named as repaired at every boot, forever, holding
/// the same dead commands throughout (ISS-1200).
///
/// Keeping the check here rather than only fixing the rewrite is the point: it
/// is what a later `Event::ALL`, a later marker or a later caller has to get
/// past, and what it cannot get past quietly.
fn repaired(before: &str, after: &str) -> Result<Vec<String>> {
    let still = unrunnable_in(after)?;
    if !still.is_empty() {
        return Err(Error::Other(format!(
            "the rewrite left hook commands naming {}, which nothing can run, so this checkout is NOT repaired — reporting it as repaired is what this refusal replaces",
            still.join(", ")
        )));
    }
    unrunnable_in(before)
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

    /// Every hook command in a settings file, decoded.
    ///
    /// A path is not what the file says it is: `C:\\Users\\...` on disk is
    /// `C:\Users\...` once JSON is done with it, so a case that asks whether
    /// the raw text holds a path is asking about a different string on Windows
    /// than on unix — which is how this module's repair case failed there while
    /// being green everywhere else.
    fn commands_of(text: &str) -> Vec<String> {
        hooks_of(text)
            .values()
            .filter_map(Value::as_array)
            .flatten()
            .filter_map(|e| e["hooks"].as_array())
            .flatten()
            .filter_map(|h| h["command"].as_str())
            .map(str::to_string)
            .collect()
    }

    /// Which of this module's cases are hidden from a platform, and why.
    ///
    /// `#[cfg(unix)]` on a case whose subject has no platform in it does not
    /// make that platform's job pass — it makes it silent, and a green over a
    /// case that was never compiled is evidence of nothing. Nine of the cases
    /// below carried one until the Windows job could not compile the helper
    /// they shared and said so; that is the only reason anybody found out.
    ///
    /// So the exception set is named here rather than left to whoever reads a
    /// diff. A tenth cannot be added quietly: this fails, and the way past it
    /// is to say in this list what unix thing the new case needs.
    #[test]
    fn every_case_this_module_hides_from_a_platform_says_what_it_needs_unix_for() {
        const SOURCE: &str = include_str!("hook_install.rs");

        // name => the unix-only thing it cannot be written without.
        const EARNED: [(&str, &str); 4] = [
            (
                "a_runner_under_a_path_with_a_space_is_what_the_hook_actually_invokes",
                "runs the command through `sh`",
            ),
            (
                "a_runner_under_a_path_holding_a_quote_is_still_invoked",
                "runs the command through `sh`",
            ),
            (
                "a_runner_under_a_path_that_is_not_utf8_is_refused_by_name",
                "builds a path from bytes with OsStrExt, which only unix has",
            ),
            (
                "the_settings_file_is_replaced_rather_than_written_over_in_place",
                "reads st_ino, which is how a replace is told from a truncate in place",
            ),
        ];

        let hidden = crate::platform_scope::tests_hidden_off_unix(SOURCE);

        for name in &hidden {
            assert!(
                EARNED.iter().any(|(earned, _)| earned == name),
                "{name} is hidden from every platform that is not unix and nothing says why. If \
                 it needs a unix shell, a file mode or a non-UTF-8 path, add it to EARNED with \
                 the reason; otherwise take the cfg off — what this module decides about a path \
                 has no platform in it, and a case Windows never compiles makes that job's green \
                 empty."
            );
        }
        for (earned, why) in EARNED {
            assert!(
                hidden.iter().any(|name| name == earned),
                "{earned} is listed as needing unix ({why}) and is not hidden any more — drop it \
                 from EARNED so the list stays a list of live exceptions"
            );
        }
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

    /// A directory named `label`, holding a file `is_runnable` accepts.
    ///
    /// Cross-platform on purpose. What `install` and `repair` decide about a
    /// path is not a property of the shell — `merged_for` takes the shell as an
    /// argument precisely because this module serves both — so a helper only
    /// unix could call is what hid nine of this module's own cases from the
    /// Windows job. On unix it is a real shell script, which is what the two
    /// cases that actually invoke it need; elsewhere it is a regular file,
    /// which is the whole of what `is_runnable` asks there.
    fn scratch_runner(label: &str) -> (PathBuf, PathBuf) {
        let home = scratch_dir("run").join(label);
        std::fs::create_dir_all(&home).expect("scratch");
        let exe = home.join("forge-runner");
        std::fs::write(&exe, "#!/bin/sh\necho ran > \"$FORGE_HOOK_MARKER\"\n").expect("runner");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        (home, exe)
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
        assert_eq!(
            program_of("/bin/forge-runner hook --event Stop").as_deref(),
            Some("/bin/forge-runner"),
            "a command nothing quoted still names its program"
        );
    }

    /// A path can carry the marker inside its own name, and a parser that goes
    /// looking for the marker cuts such a path in half and calls a healthy hook
    /// dead. Raised as F2 on consult 5542c8.
    #[test]
    fn a_runner_whose_own_path_holds_the_marker_is_read_back_whole() {
        let exe = "/opt/runner hook --event tools/forge-runner";
        let command = command_for(exe, Event::PromptSubmitted, true);
        assert_eq!(
            program_of(&command).as_deref(),
            Some(exe),
            "the program was cut at the marker inside its own name: {command}"
        );

        let dir = scratch_dir("marker-in-path");
        let home = dir.join("opt/runner hook --event tools");
        std::fs::create_dir_all(&home).expect("home");
        let installed = {
            let p = home.join("forge-runner");
            std::fs::write(&p, "#!/bin/sh\nexit 0\n").expect("write");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755))
                    .expect("chmod");
            }
            p
        };
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).expect("repo");
        let path = install(&repo, &installed).expect("install");
        let before = std::fs::read_to_string(&path).expect("read");

        assert!(
            repair(&repo, &installed).expect("repair").is_empty(),
            "a healthy runner was called unrunnable because its path holds the marker"
        );
        assert_eq!(
            std::fs::read_to_string(&path).expect("read back"),
            before,
            "the sweep rewrote a file whose every command runs"
        );
    }

    /// Raised as F3 on consult 5542c8: a read that failed is not a file whose
    /// hooks are fine, and the caller has nothing to report if this says so.
    #[test]
    fn a_settings_file_that_cannot_be_read_is_refused_rather_than_called_healthy() {
        let dir = scratch_dir("unreadable");
        let (_home, good) = scratch_runner("ours");
        let path = settings_path(&dir);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bytes = b"\xff\xfe not utf-8 at all";
        std::fs::write(&path, bytes).unwrap();

        let err = repair(&dir, &good).expect_err("bytes this cannot read are not a healthy file");
        assert!(
            err.to_string().contains("unknown rather than fine"),
            "{err}"
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            bytes,
            "a file it could not read was rewritten anyway"
        );
    }

    /// What a settings file SAYS a command is, and what the command IS, are two
    /// different strings wherever a path holds a backslash.
    ///
    /// A case that asks the raw text whether it holds a path is asking about
    /// the unescaped one, which JSON never wrote. On unix nothing is escaped
    /// and the two readings agree, so such a case is green here forever and
    /// red on Windows — which is how the repair case above was found, by the
    /// Windows job, after this module had already been made to compile there.
    #[test]
    fn a_path_in_a_hook_command_is_read_back_decoded_and_not_off_the_raw_text() {
        let windows_shaped = r"C:\Program Files\forge\forge-runner";
        let text = merged(None, windows_shaped).unwrap();

        assert!(
            !text.contains(windows_shaped),
            "this case rests on JSON escaping the path, and it did not — it proves nothing here"
        );
        assert!(
            commands_of(&text)
                .iter()
                .all(|c| c.contains(windows_shaped)),
            "the decoded command lost the path the file was written with: {:?}",
            commands_of(&text)
        );
    }

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
        let commands = commands_of(&back);
        assert!(
            !commands.is_empty(),
            "the repair wrote no hook at all: {back}"
        );
        for command in &commands {
            assert!(
                !command.contains(crate::exe::DELETED_SUFFIX),
                "the dead path is still in the file: {command}"
            );
            assert!(
                command.contains(good.to_str().unwrap()),
                "a command names something other than the build on disk: {command}"
            );
        }
    }

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

    /// A settings document carrying one of this daemon's markers under an
    /// event this build does not install — what a newer daemon writes and an
    /// older one then meets.
    fn document_with_a_managed_hook_for(event: &str, exe: &str) -> String {
        serde_json::to_string_pretty(&json!({
            "hooks": {
                event: [{
                    "hooks": [{
                        "type": "command",
                        "command": format!("'{exe}' hook --event {event}"),
                    }]
                }]
            }
        }))
        .unwrap()
    }

    #[test]
    fn a_managed_hook_for_an_event_this_build_does_not_install_is_taken_out() {
        let existing = document_with_a_managed_hook_for("SessionStart", "/old/forge-runner");

        let out = merged_for(Some(&existing), "/new/forge-runner", true).unwrap();

        let commands = commands_of(&out);
        assert!(
            !commands.iter().any(|c| c.contains("SessionStart")),
            "an entry this build cannot report on was left standing in its own name: {commands:?}"
        );
        assert!(
            !hooks_of(&out).contains_key("SessionStart"),
            "the event key was left behind holding nothing: {out}"
        );
        assert!(
            !commands.is_empty(),
            "the events this build DOES install went with it: {out}"
        );
    }

    #[test]
    fn the_events_a_rewrite_will_take_out_are_named_before_it_runs() {
        let existing = document_with_a_managed_hook_for("SessionStart", "/old/forge-runner");

        assert_eq!(
            served_by_no_event_this_build_installs(&existing),
            vec!["SessionStart".to_string()],
            "the journal cannot name what nothing tells it"
        );
        assert!(
            served_by_no_event_this_build_installs(
                &merged_for(None, "/new/forge-runner", true).unwrap()
            )
            .is_empty(),
            "a file holding only what this build installs must name nothing"
        );
    }

    #[test]
    fn an_operators_own_hook_under_such_an_event_is_left_alone() {
        let existing = serde_json::to_string_pretty(&json!({
            "hooks": {
                "SessionStart": [{
                    "hooks": [{
                        "type": "command",
                        "command": "/usr/bin/env notify-send 'my own hook'",
                    }]
                }]
            }
        }))
        .unwrap();

        let out = merged_for(Some(&existing), "/new/forge-runner", true).unwrap();

        assert!(
            commands_of(&out).contains(&"/usr/bin/env notify-send 'my own hook'".to_string()),
            "the operator's own hook was taken out with this daemon's: {out}"
        );
    }

    #[test]
    fn what_the_rewrite_covers_is_what_the_scan_counts() {
        let dir = scratch_dir("repair-outside-all");
        let (_home, good) = scratch_runner("the-build-on-disk");
        let gone = dir.join(format!("forge-runner{}", crate::exe::DELETED_SUFFIX));
        std::fs::create_dir_all(settings_path(&dir).parent().unwrap()).unwrap();
        std::fs::write(
            settings_path(&dir),
            document_with_a_managed_hook_for("Notification", gone.to_str().unwrap()),
        )
        .unwrap();

        let rewritten = repair(&dir, &good).expect("repair");

        assert_eq!(rewritten, vec![gone.to_str().unwrap().to_string()]);
        let back = std::fs::read_to_string(settings_path(&dir)).unwrap();
        assert!(
            !back.contains(crate::exe::DELETED_SUFFIX),
            "the repair reported a rewrite it had not made: {back}"
        );
        assert!(
            repair(&dir, &good).expect("second pass").is_empty(),
            "the repair reports the same project forever instead of settling"
        );
    }

    /// The guard, driven at the only seam that can show it: a rewrite whose
    /// result still holds a command nothing can run. No input reaches this
    /// through `merged` any more — that is the point of the fix — so the case
    /// hands `repaired` the file such a rewrite would leave.
    #[test]
    fn a_rewrite_that_left_a_dead_command_is_refused_rather_than_reported_repaired() {
        let before = document_with_a_managed_hook_for("SessionStart", "/gone/forge-runner");

        let e = repaired(&before, &before).expect_err("a residue must refuse");

        let said = e.to_string();
        assert!(
            said.contains("/gone/forge-runner") && said.contains("NOT repaired"),
            "the refusal does not name what survived: {said}"
        );
    }

    #[test]
    fn a_rewrite_that_left_nothing_dead_reports_what_it_repaired() {
        let before = document_with_a_managed_hook_for("SessionStart", "/gone/forge-runner");
        let after = document_with_a_managed_hook_for("SessionStart", "/bin/sh");

        assert_eq!(
            repaired(&before, &after).expect("a clean rewrite"),
            vec!["/gone/forge-runner".to_string()],
            "the journal is owed the programs that could not be run"
        );
    }

    /// Installing over a settings file that already stands replaces it.
    ///
    /// `write_atomically` renames over the destination, and `std::fs::rename`
    /// replaces an existing one on every platform this crate builds for —
    /// `config::Config::save` has written that way in this crate since before
    /// this change. A review round said Windows would refuse it; this box runs
    /// only the unix leg, so rather than argue the point the case is stated
    /// here for the other two legs to answer. It carries no `cfg`, no inode
    /// and no mode: a platform where the rename does not replace fails HERE,
    /// naming the rename, instead of somewhere downstream.
    #[test]
    fn installing_over_a_settings_file_that_already_stands_replaces_it() {
        let dir = scratch_dir("replace-existing");
        let (_first_home, first) = scratch_runner("the-build-that-was");
        let (_second_home, second) = scratch_runner("the-build-that-stands");
        install(&dir, &first).expect("the first install");

        install(&dir, &second)
            .expect("the rename did not replace the settings file that already stood there");

        let back = std::fs::read_to_string(settings_path(&dir)).expect("read back");
        let commands = commands_of(&back);
        assert!(
            !commands.is_empty(),
            "the second install wrote no hook: {back}"
        );
        for command in &commands {
            assert!(
                command.contains(second.to_str().expect("utf-8")),
                "a command still names the build that was replaced: {command}"
            );
        }
    }

    /// The settings file is replaced, never truncated in place: a failure
    /// partway through a bare write leaves a checkout with no hooks and a file
    /// the next sweep refuses as unreadable JSON. The inode is how a replace
    /// is told from a truncate, and only unix has one to read.
    #[test]
    #[cfg(unix)]
    fn the_settings_file_is_replaced_rather_than_written_over_in_place() {
        use std::os::unix::fs::MetadataExt;

        let dir = scratch_dir("atomic");
        let (_home, good) = scratch_runner("the-build-on-disk");
        install(&dir, &good).expect("first install");
        let first = std::fs::metadata(settings_path(&dir)).unwrap().ino();

        install(&dir, &good).expect("second install");

        assert_ne!(
            std::fs::metadata(settings_path(&dir)).unwrap().ino(),
            first,
            "the file was written in place, so a reader can see it half-written"
        );
        assert!(
            !settings_path(&dir).with_extension("json.tmp").exists(),
            "the temporary file was left beside the settings file"
        );
    }
}
