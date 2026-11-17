//! The backstop under the permission relay (ISS-1268 B3, C2): a prompt standing on a resident
//! master's background session, read and answered within one watcher cycle, and told to Forge.
//!
//! Every [`EVERY`] the box reads `claude agents --json`. A master session that waits
//! (`waitingFor`, e.g. "permission prompt") or that Claude Code's own record calls "stuck on a
//! startup dialog" stood on something its relay hook never answered. The box attaches on a pty it
//! holds (`bg_session::prompt`), reads the dialog's exact text, and answers it: from the dialog
//! catalog where the pinned version's text is known, else with Escape, which closes a Claude Code
//! dialog without accepting it. The account's usage-limit list is core's to know first, so it is
//! reported before Escape, as it always was. A screen the box cannot read gets no key at all. Each
//! answer is a line in the box's dialog record under the session's project, and Forge is told with
//! the session, the text, what the session says it needs, and the answer: never silent.
//!
//! A prompt the relay hook holds reads `waiting` / `permission prompt` in the roster the whole time
//! the hook waits on a person (measured on 2.1.322), so the box leaves a session whose relay marks
//! it in flight (`permission_relay::inflight`) to the relay: that prompt is on Forge already.
//!
//! This replaces the keystroke refusal over the box's tmux panes (`terminal::deny`, ISS-280), which
//! served panes no master runs in any more.

mod usage_limit;
pub use usage_limit::{LimitReporter, NoCore};

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use runner_core::agent_activity::now_ms;
use runner_core::dialog_answer::{self, Asked, Via};
use runner_core::permission_relay;
use runner_transport::master::{report_session_prompt, SessionPrompt};
use runner_transport::CoreClient;
use runner_workspace::bg_session::prompt::{self, JobState, Keys};
use runner_workspace::bg_session::{launch, roster, BgSession};
use runner_workspace::composer::{self, Standing};
use runner_workspace::terminal::MASTER_PREFIX;

/// How often the roster is read: a prompt is raised within seconds of standing.
pub const EVERY: Duration = Duration::from_secs(5);

/// What the box tells core: the account's limit, and a dialog it answered.
#[expect(
    async_fn_in_trait,
    reason = "a test seam implemented only inside this workspace; no caller needs its future to be Send"
)]
pub trait Core: LimitReporter {
    async fn raised(&self, p: &SessionPrompt<'_>) -> Result<(), String>;
}

impl Core for CoreClient {
    async fn raised(&self, p: &SessionPrompt<'_>) -> Result<(), String> {
        report_session_prompt(self, p)
            .await
            .map_err(|e| e.to_string())
    }
}

/// A session's screen, as the box reads and answers it.
#[expect(
    async_fn_in_trait,
    reason = "a test seam implemented only inside this workspace; no caller needs its future to be Send"
)]
pub trait Screens {
    /// The screen of session `id` (its short id) as it stands.
    async fn read(&mut self, id: &str) -> Result<String, String>;
    /// Press `keys` on it, and answer the screen after.
    async fn press(&mut self, id: &str, keys: Keys) -> Result<String, String>;
    /// Let go of it.
    fn done(&mut self, id: &str);
}

/// The box's own pty, one attach per session read.
#[derive(Default)]
pub struct Pty {
    #[cfg(unix)]
    open: HashMap<String, prompt::Attached>,
}

/// No pseudo-terminal to attach on: every read is refused naming that, so a pass tells core it
/// could not read the prompt rather than pressing anything.
#[cfg(not(unix))]
impl Screens for Pty {
    async fn read(&mut self, id: &str) -> Result<String, String> {
        Err(format!(
            "{id}: a prompt is read on a pseudo-terminal, which this platform has no attach for"
        ))
    }

    async fn press(&mut self, id: &str, _: Keys) -> Result<String, String> {
        Err(format!("{id} is not attached"))
    }

    fn done(&mut self, _: &str) {}
}

#[cfg(unix)]
impl Screens for Pty {
    async fn read(&mut self, id: &str) -> Result<String, String> {
        let a = prompt::Attached::open(id)?;
        let a = self.open.entry(id.to_string()).or_insert(a);
        Ok(a.screen(prompt::SETTLE).await)
    }

    async fn press(&mut self, id: &str, keys: Keys) -> Result<String, String> {
        let a = self
            .open
            .get_mut(id)
            .ok_or_else(|| format!("{id} is not attached"))?;
        a.press(keys)?;
        Ok(a.screen(prompt::SETTLE).await)
    }

    fn done(&mut self, id: &str) {
        self.open.remove(id);
    }
}

/// What one pass did about one session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Answered from the catalog or with Escape; `cleared` where the dialog went.
    Answered {
        session: String,
        text: String,
        by: &'static str,
        keys: Keys,
        cleared: bool,
    },
    /// Nothing was pressed: the screen could not be read, or the limit could not be reported.
    Unread { session: String, why: String },
}

/// What the box decides to press on a screen, before it presses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Nothing readable is drawn: press nothing.
    Unread,
    /// The account's usage-limit list: tell core, then Escape.
    Limit { reset: Option<String> },
    /// A dialog: the catalog's answer, or Escape where it is unknown.
    Press {
        text: String,
        entry: Option<&'static prompt::Entry>,
    },
}

/// What to do about `screen` on Claude Code `version`.
pub fn plan(version: &str, screen: &str) -> Plan {
    let text = prompt::dialog_text(screen);
    if text.trim().is_empty() {
        return Plan::Unread;
    }
    if let Standing::UsageLimit { reset, .. } = composer::standing(screen) {
        return Plan::Limit { reset };
    }
    Plan::Press {
        entry: prompt::known(version, screen),
        text,
    }
}

/// What the box reads beside the roster: the Claude Code version, its own config dir, a
/// session's job record by its short id, and the project a session was placed for by its name.
pub struct Box_<'a> {
    pub version: &'a str,
    pub config_dir: Option<&'a Path>,
    pub job: &'a (dyn Fn(&str) -> JobState + Sync),
    pub project: &'a (dyn Fn(&str) -> Option<String> + Sync),
}

/// The watcher, holding what it last raised per session so one standing prompt is told once.
#[derive(Default)]
pub struct PromptWatch {
    raised: HashMap<String, String>,
    unread_said: Option<String>,
}

/// A resident master's session that waits on something only a person or this box answers.
fn waiting<'a>(s: &'a BgSession, job: &JobState) -> Option<&'a str> {
    let ours = s
        .name
        .as_deref()
        .is_some_and(|n| n.starts_with(&format!("{MASTER_PREFIX}-")));
    if !(ours && s.is_background() && s.is_live()) {
        return None;
    }
    s.waiting()
        .or(job.stuck_at_startup().then_some("a startup dialog"))
}

/// The project a session was placed for: its settings file's `FORGE_PROJECT_ID`.
fn project_of(name: &str) -> Option<String> {
    let path = launch::settings_path(name).ok()?;
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    v["env"]["FORGE_PROJECT_ID"]
        .as_str()
        .filter(|p| !p.is_empty())
        .map(str::to_string)
}

impl PromptWatch {
    /// One pass over the roster as it stands.
    pub async fn pass(&mut self, core: &impl Core) -> Vec<Outcome> {
        let roster = match roster::list().await {
            Ok(r) => {
                self.unread_said = None;
                r
            }
            Err(e) => {
                let why = e.to_string();
                if self.unread_said.as_deref() != Some(&why) {
                    tracing::warn!("[prompt] {why}: no prompt on a master session was looked for");
                    self.unread_said = Some(why);
                }
                return Vec::new();
            }
        };
        let version = match runner_workspace::bg_session::version::pinned() {
            Some(v) => v,
            None => runner_workspace::bg_session::version::installed()
                .await
                .unwrap_or_default(),
        };
        let dir = runner_platform::config::config_dir();
        let box_ = Box_ {
            version: &version,
            config_dir: dir.as_deref(),
            job: &prompt::job_state,
            project: &project_of,
        };
        self.over(&roster, &box_, &mut Pty::default(), core).await
    }

    /// The pass over `roster`, with what the box reads, its screens and core given.
    pub async fn over(
        &mut self,
        roster: &[BgSession],
        b: &Box_<'_>,
        screens: &mut impl Screens,
        core: &impl Core,
    ) -> Vec<Outcome> {
        let (version, config_dir) = (b.version, b.config_dir);
        let mut out = Vec::new();
        let mut standing = Vec::new();
        for s in roster {
            let (Some(id), Some(name)) = (s.id.as_deref(), s.name.as_deref()) else {
                continue;
            };
            let state = (b.job)(id);
            let Some(waits) = waiting(s, &state) else {
                continue;
            };
            standing.push(id.to_string());
            // the relay hook holds this prompt and answers it by its own timeout: never keyed over
            if config_dir.is_some_and(|d| permission_relay::inflight(d, &s.session_id)) {
                continue;
            }
            let o = self
                .answer(
                    id,
                    name,
                    waits,
                    &state,
                    (version, (b.project)(name)),
                    screens,
                    core,
                    config_dir,
                )
                .await;
            screens.done(id);
            out.push(o);
        }
        self.raised.retain(|id, _| standing.contains(id));
        out
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "one session's whole answer, read once"
    )]
    async fn answer(
        &mut self,
        id: &str,
        name: &str,
        waits: &str,
        state: &JobState,
        (version, project): (&str, Option<String>),
        screens: &mut impl Screens,
        core: &impl Core,
        config_dir: Option<&Path>,
    ) -> Outcome {
        let screen = match screens.read(id).await {
            Ok(s) => s,
            Err(why) => {
                return self
                    .unread(name, id, waits, state, &why, project, core)
                    .await
            }
        };
        let (text, entry, keys) = match plan(version, &screen) {
            Plan::Unread => {
                let why = format!("`claude attach {id}` drew no dialog it could read");
                return self
                    .unread(name, id, waits, state, &why, project, core)
                    .await;
            }
            Plan::Limit { reset } => {
                let secs = reset.as_deref().and_then(|r| {
                    usage_limit::resets_in_seconds(r, runner_platform::clock::now_secs())
                });
                let detail = format!("Claude Code usage-limit list on {name}");
                if let Err(e) = core.usage_limit(secs, &detail).await {
                    let why = format!("core was not told the account is capped ({e}), so the list is left standing");
                    return self
                        .unread(name, id, waits, state, &why, project, core)
                        .await;
                }
                tracing::warn!("{}", usage_limit::dismissed_line(name, secs));
                (prompt::dialog_text(&screen), None, Keys::Escape)
            }
            Plan::Press { text, entry } => (text, entry, entry.map_or(Keys::Escape, |e| e.answer)),
        };
        let after = screens.press(id, keys).await;
        let cleared = after
            .as_deref()
            .is_ok_and(|a| prompt::dialog_text(a) != text);
        let by = if entry.is_some() { "catalog" } else { "safe" };
        let line = format!(
            "{} {name}'s dialog with {}{}: {}",
            if cleared {
                "answered"
            } else {
                "pressed, still standing:"
            },
            keys.wire(),
            entry
                .map(|e| format!(" (catalog: {})", e.name))
                .unwrap_or_default(),
            text.lines().next().unwrap_or_default()
        );
        if let Some(dir) = config_dir {
            let asked = Asked {
                tool: Some(entry.map_or("dialog", |e| e.name).to_string()),
                what: text.lines().next().map(str::to_string),
                agent: None,
                agent_type: None,
            };
            dialog_answer::record_line(
                dir,
                now_ms(),
                project.as_deref(),
                &asked,
                &line,
                Via::Watcher,
            );
        }
        tracing::warn!("[prompt] {line}");
        self.raise(
            id,
            project.as_deref(),
            name,
            &text,
            state,
            by,
            keys.wire(),
            core,
        )
        .await;
        Outcome::Answered {
            session: name.to_string(),
            text,
            by,
            keys,
            cleared,
        }
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "the unread outcome names all it could not do"
    )]
    async fn unread(
        &mut self,
        name: &str,
        id: &str,
        waits: &str,
        state: &JobState,
        why: &str,
        project: Option<String>,
        core: &impl Core,
    ) -> Outcome {
        let text = format!("{name} waits on {waits}; {why}");
        self.raise(
            id,
            project.as_deref(),
            name,
            &text,
            state,
            "unread",
            "no key",
            core,
        )
        .await;
        Outcome::Unread {
            session: name.to_string(),
            why: why.to_string(),
        }
    }

    /// Tell Forge, once per standing text per session.
    #[expect(clippy::too_many_arguments, reason = "the one notice's every field")]
    async fn raise(
        &mut self,
        id: &str,
        project: Option<&str>,
        name: &str,
        text: &str,
        state: &JobState,
        by: &str,
        answer: &str,
        core: &impl Core,
    ) {
        if self.raised.get(id).map(String::as_str) == Some(text) {
            return;
        }
        let Some(project) = project else {
            tracing::error!(
                "[prompt] {name}: its settings name no FORGE_PROJECT_ID, so Forge cannot be told of: {text}"
            );
            return;
        };
        let p = SessionPrompt {
            project_id: project,
            session: name,
            text,
            needs: state.needs.as_deref(),
            by,
            answer,
        };
        match core.raised(&p).await {
            Ok(()) => {
                self.raised.insert(id.to_string(), text.to_string());
            }
            Err(e) => tracing::error!("[prompt] {name}: Forge was not told ({e}) of: {text}"),
        }
    }
}

#[cfg(test)]
mod tests;
