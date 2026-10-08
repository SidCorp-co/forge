//! Permission dialogs already standing on the panes this box placed.
//!
//! The pane's `PermissionRequest` hook refuses a dialog as it is raised
//! (`runner_core::dialog_answer`, ISS-272). A dialog raised where no hook
//! answered — under an older daemon, or while this one restarted — stayed
//! drawn until a person came by: forge-master-catalog-fe stood on a Bash
//! dialog from 18:35Z on 2026-10-06 across a restart onto the build that had
//! the hook, and its run on ISS-9 with it (FB-94, ISS-280).
//!
//! So on start and at the head of every master sweep, the box reads every
//! session on its own tmux server — every one of them a pane it placed — and
//! answers a permission dialog it finds the way the hook would: refused, with
//! [`REPHRASE`] as the reason. A choice list it cannot answer that way gets no
//! key and is named, once, with why.
//!
//! A dialog is acted on only when it reads the same twice, [`SETTLE`] apart,
//! so one the hook is answering at that moment is never keyed over.

mod usage_limit;
pub use usage_limit::{LimitReporter, NoCore};

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use runner_core::agent_activity::now_ms;
use runner_core::dialog_answer::{self, Asked, Via, REPHRASE};
use runner_workspace::composer::{Permission, Standing};
use runner_workspace::terminal::deny::Tmux;

/// How long a dialog must stand unchanged before the box presses anything.
pub const SETTLE: Duration = Duration::from_secs(3);

/// What one pass did about one pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The dialog was refused with [`REPHRASE`] and recorded under `project`.
    Answered {
        pane: String,
        project: Option<String>,
        reason: String,
    },
    /// The refusal stopped part-way; `why` names the step.
    Stopped { pane: String, why: String },
    /// A choice list the box does not answer; `said_now` where this pass logged it.
    Cannot {
        pane: String,
        highlighted: String,
        why: String,
        said_now: bool,
    },
    /// The account's usage-limit list: reported to core (`reported_resets_in`
    /// is the printed reset in seconds where it was readable) and dismissed.
    UsageLimit {
        pane: String,
        resets_in_seconds: Option<u64>,
    },
    /// It changed or went within [`SETTLE`], so nothing was pressed.
    Moved { pane: String },
}

/// The sweep, holding what it has already said about each pane.
pub struct DialogSweep {
    settle: Duration,
    said: HashMap<String, String>,
}

impl DialogSweep {
    pub fn new(settle: Duration) -> Self {
        Self {
            settle,
            said: HashMap::new(),
        }
    }

    /// Answer what stands on every session of `tmux`, recording each answer
    /// beside `config_dir`'s `config.toml`.
    pub async fn pass(
        &mut self,
        tmux: &Tmux,
        config_dir: Option<&Path>,
        limit: &impl LimitReporter,
    ) -> Vec<Outcome> {
        let names = match tmux.sessions().await {
            Ok(names) => {
                self.said.remove("");
                names
            }
            Err(why) => {
                self.say(
                    "",
                    &why,
                    &format!(
                        "[dialog] the sessions on {} could not be listed ({why}), so no standing dialog was looked for",
                        tmux.socket().display()
                    ),
                );
                return Vec::new();
            }
        };
        let mut seen = Vec::new();
        for name in names {
            match tmux.standing(&name).await {
                None | Some(Standing::Nothing) => {}
                Some(found) => seen.push((name, found)),
            }
        }
        self.said
            .retain(|pane, _| pane.is_empty() || seen.iter().any(|(n, _)| n == pane));
        if seen.is_empty() {
            return Vec::new();
        }
        tokio::time::sleep(self.settle).await;
        let mut out = Vec::with_capacity(seen.len());
        for (pane, first) in seen {
            let now = tmux.standing(&pane).await;
            if !unchanged(&first, now.as_ref()) {
                out.push(Outcome::Moved { pane });
                continue;
            }
            out.push(match first {
                Standing::Permission(p) if p.amending => self.cannot(
                    pane,
                    p.options.get(p.highlighted).cloned().unwrap_or_default(),
                    "its No row is already open for text, so somebody may be typing there".into(),
                ),
                Standing::Permission(p) => self.answer(tmux, config_dir, pane, &p).await,
                Standing::UsageLimit { reset, .. } => {
                    self.usage_limit(tmux, limit, pane, reset).await
                }
                Standing::Other { highlighted, why } => self.cannot(pane, highlighted, why),
                Standing::Nothing => continue,
            });
        }
        out
    }

    async fn answer(
        &mut self,
        tmux: &Tmux,
        config_dir: Option<&Path>,
        pane: String,
        p: &Permission,
    ) -> Outcome {
        let project = tmux.project_of(&pane).await;
        let asked = Asked::of_dialog(&p.head);
        let reason = dialog_answer::reason(&asked);
        match tmux.deny(&pane, p, REPHRASE).await {
            Ok(()) => {
                if let Some(dir) = config_dir {
                    dialog_answer::record(dir, now_ms(), project.as_deref(), &asked, Via::Sweep);
                }
                self.said.remove(&pane);
                tracing::info!(
                    "[dialog] {pane}: a permission dialog was standing on this pane with no hook to answer it — {reason}, with how to rephrase"
                );
                Outcome::Answered {
                    pane,
                    project,
                    reason,
                }
            }
            Err(stopped) => {
                let why = stopped.to_string();
                self.say(
                    &pane,
                    &why,
                    &format!(
                        "[dialog] {pane}: a permission dialog is standing on this pane (\u{ab}{}\u{bb}) and the box could not answer it: {why}. It is tried again next sweep; until then the pane waits on a person",
                        p.question
                    ),
                );
                Outcome::Stopped { pane, why }
            }
        }
    }

    async fn usage_limit(
        &mut self,
        tmux: &Tmux,
        limit: &impl LimitReporter,
        pane: String,
        reset: Option<String>,
    ) -> Outcome {
        let resets_in_seconds = match &reset {
            Some(text) => usage_limit::resets_in_seconds(text, runner_platform::clock::now_secs()),
            None => None,
        };
        let detail = match (&reset, resets_in_seconds) {
            (Some(text), Some(_)) => format!("Claude Code usage-limit list on {pane}; it resets at {text}"),
            (Some(text), None) => format!(
                "Claude Code usage-limit list on {pane}; its printed reset \u{ab}{text}\u{bb} could not be read"
            ),
            (None, _) => format!("Claude Code usage-limit list on {pane}; it printed no reset"),
        };
        // Core first: the list is not dismissed until the limit is on record,
        // so a failed report leaves it standing and the next sweep tries again.
        if let Err(e) = limit.usage_limit(resets_in_seconds, &detail).await {
            let why = format!("core was not told the account is capped: {e}");
            self.say(
                &pane,
                &why,
                &format!("[dialog] {pane}: the account usage-limit list stands and {why} — it is left standing and tried again next sweep"),
            );
            return Outcome::Stopped { pane, why };
        }
        match tmux.dismiss_usage_limit(&pane).await {
            Ok(()) => {
                self.said.remove(&pane);
                tracing::warn!("{}", usage_limit::dismissed_line(&pane, resets_in_seconds));
                Outcome::UsageLimit {
                    pane,
                    resets_in_seconds,
                }
            }
            Err(stopped) => {
                let why = stopped.to_string();
                self.say(
                    &pane,
                    &why,
                    &format!("[dialog] {pane}: the account usage-limit list stands and Escape did not dismiss it: {why}"),
                );
                Outcome::Stopped { pane, why }
            }
        }
    }

    fn cannot(&mut self, pane: String, highlighted: String, why: String) -> Outcome {
        let said_now = self.say(
            &pane,
            &format!("{highlighted}\n{why}"),
            &format!(
                "[dialog] {pane}: a choice list stands on this pane at \u{ab}{highlighted}\u{bb} and the box does not answer it: {why}. It waits on a person"
            ),
        );
        Outcome::Cannot {
            pane,
            highlighted,
            why,
            said_now,
        }
    }

    /// Log `line` unless `key` is what was last said about `pane`.
    fn say(&mut self, pane: &str, key: &str, line: &str) -> bool {
        if self.said.get(pane).map(String::as_str) == Some(key) {
            return false;
        }
        self.said.insert(pane.to_string(), key.to_string());
        tracing::warn!("{line}");
        true
    }
}

/// The sweep over this box's own tmux server, as the master loop runs it.
pub struct BoxDialogs {
    tmux: Option<Tmux>,
    sweep: DialogSweep,
}

impl BoxDialogs {
    pub fn new() -> Self {
        let tmux = Tmux::the_boxs();
        if tmux.is_none() {
            tracing::error!(
                "[dialog] this box has no tmux socket of its own, so a permission dialog standing on one of its panes is never looked for: the default server it falls back to is shared with whatever a person runs there"
            );
        }
        Self {
            tmux,
            sweep: DialogSweep::new(SETTLE),
        }
    }

    pub async fn pass(&mut self, core: &impl LimitReporter) {
        let Some(tmux) = &self.tmux else {
            return;
        };
        let dir = runner_platform::config::config_dir();
        self.sweep.pass(tmux, dir.as_deref(), core).await;
    }
}

impl Default for BoxDialogs {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether what stands now is what stood at the first read.
fn unchanged(first: &Standing, now: Option<&Standing>) -> bool {
    match (first, now) {
        (Standing::Permission(a), Some(Standing::Permission(b))) => {
            a.is_same_dialog(b) && a.highlighted == b.highlighted && a.amending == b.amending
        }
        (a, Some(b)) => a == b,
        (_, None) => false,
    }
}

#[cfg(all(test, unix))]
mod tests;
