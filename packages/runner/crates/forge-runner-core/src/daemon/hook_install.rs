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

/// Take this daemon's own commands out of one event's entries, and drop an
/// entry the removal leaves holding no command at all.
///
/// The unit that is ours is the COMMAND, not the object it sits in. Until
/// ISS-1200 this removal was per entry, so an operator's own command written
/// into the same entry as one of ours went out with it — deleted from their
/// file, with nothing said, every time a pane was prepared and, once the sweep
/// landed, at every boot and after every update as well. `install` writes its
/// own commands one to an entry, so nothing of this daemon's is lost by asking
/// the narrower question.
fn take_ours_out(entries: &mut Vec<Value>) {
    for entry in entries.iter_mut() {
        if let Some(hooks) = entry.get_mut("hooks").and_then(Value::as_array_mut) {
            hooks.retain(|hook| !is_ours_command(hook));
        }
    }
    entries.retain(
        |entry| !matches!(entry.get("hooks").and_then(Value::as_array), Some(hs) if hs.is_empty()),
    );
}

/// Whether one hook in an entry carries a command this daemon wrote.
fn is_ours_command(hook: &Value) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| program_of(c).is_some())
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
            .unwrap_or_default();
        take_ours_out(&mut entries);
        entries.push(json!({
            "hooks": [{ "type": "command", "command": command_for(exe, event, posix) }]
        }));
        hooks.insert(event.wire().to_string(), Value::Array(entries));
    }

    let mut gate: Vec<Value> = hooks
        .get(GATE_EVENT)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    take_ours_out(&mut gate);
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
        take_ours_out(entries);
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
/// `unrunnable_in` counts one by. What comes OUT of such an entry is
/// `take_ours_out`'s narrower question: an entry can hold one of ours and one
/// of somebody else's.
fn is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hs| hs.iter().any(is_ours_command))
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
    ignore_settings(cwd, &path)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| Error::Other(format!("cannot create {}: {e}", dir.display())))?;
    }
    write_atomically(&path, &next)?;
    Ok(path)
}

/// Make the checkout's git ignore the settings file before it is written, so a
/// checkout that does not ignore `.claude/` gains no untracked work (owner,
/// ISS-1357, 2026-09-30). A settings file the checkout tracks is its own
/// committed file, which an ignore rule cannot change, and is written as it
/// always was.
fn ignore_settings(cwd: &Path, path: &Path) -> Result<()> {
    use crate::daemon::git_exclude::{ensure_ignored, Refused};
    match ensure_ignored(cwd, SETTINGS) {
        Ok(_) => Ok(()),
        Err(Refused::Tracked) => {
            tracing::warn!(
                "[hooks] {} is tracked by that checkout's git, so the hooks are written into a committed file",
                path.display()
            );
            Ok(())
        }
        Err(refused) => Err(Error::Other(format!(
            "{} is not written: {refused}",
            path.display()
        ))),
    }
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
