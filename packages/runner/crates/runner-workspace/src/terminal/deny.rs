//! Refusing a permission dialog that stands on a pane, by its keys.
//!
//! The pane's `PermissionRequest` hook refuses a dialog as it is raised. One
//! that was raised where no hook answered — under an older daemon, during a
//! restart — stays drawn until somebody presses something, so the box presses
//! what a person would: down to `No`, Tab to open it for text, the reason,
//! Enter. Claude Code hands that text to the agent as the reason its call was
//! refused, and the turn carries on, which is the hook's own `interrupt: false`
//! deny (`composer::Permission` says what each step looks like).
//!
//! tmux holds no lock over a pane's input, so every key is followed by a read,
//! and the first read that is not what the key should have drawn stops it.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::composer::{self, Permission, Standing};

/// How long a key's effect is waited for before the step is called failed.
pub const STEP_WITHIN: Duration = Duration::from_secs(5);

const POLL: Duration = Duration::from_millis(100);

/// One tmux server, addressed by its socket.
#[derive(Debug, Clone)]
pub struct Tmux {
    socket: PathBuf,
}

/// The step of a refusal that did not read back as it should.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// The dialog read at the start was no longer a fresh permission dialog.
    Start,
    /// The highlight never reached `No`.
    Highlight,
    /// Tab never opened the `No` row for text.
    Amend,
    /// The row never read back the reason typed into it.
    Typed,
    /// The dialog was still standing after Enter.
    Submit,
}

impl Step {
    pub fn describe(self) -> &'static str {
        match self {
            Step::Start => {
                "before the first key, the pane no longer showed a fresh permission dialog"
            }
            Step::Highlight => "the highlight never reached No",
            Step::Amend => "Tab on No never opened the row for the reason",
            Step::Typed => "the No row never read back the reason typed into it",
            Step::Submit => "the dialog was still standing after Enter",
        }
    }
}

/// Why a refusal stopped, and what the pane showed when it did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stopped {
    /// tmux could not be asked, or refused a key.
    Unaskable(String),
    /// A key's effect never read back.
    At { step: Step, read: String },
}

impl std::fmt::Display for Stopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Stopped::Unaskable(why) => write!(f, "tmux did not answer: {why}"),
            Stopped::At { step, read } => {
                write!(f, "stopped because {}; it showed {read}", step.describe())
            }
        }
    }
}

impl Tmux {
    /// The box's own server, which every pane it places stands on. `None`
    /// where the box has no socket of its own: its panes then share the
    /// default server with whatever a person runs there, which is not the
    /// box's to read.
    pub fn the_boxs() -> Option<Self> {
        super::socket_path().map(Self::on)
    }

    pub fn on(socket: PathBuf) -> Self {
        Self { socket }
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    async fn run(&self, args: &[&str]) -> Result<std::process::Output, String> {
        tokio::process::Command::new("tmux")
            .arg("-S")
            .arg(&self.socket)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|e| format!("tmux {}: {e}", args.first().copied().unwrap_or("")))
    }

    async fn ok(&self, args: &[&str]) -> Result<(), Stopped> {
        let out = self.run(args).await.map_err(Stopped::Unaskable)?;
        if out.status.success() {
            return Ok(());
        }
        Err(Stopped::Unaskable(format!(
            "tmux {}: {}",
            args.first().copied().unwrap_or(""),
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }

    /// Every session on this server, or why it could not be listed. A server
    /// that is not running holds no session and is not an error.
    pub async fn sessions(&self) -> Result<Vec<String>, String> {
        let out = self
            .run(&["list-sessions", "-F", "#{session_name}"])
            .await?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map(str::to_string)
                .collect());
        }
        let said = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if said.contains("no server running") || said.contains("No such file") {
            return Ok(Vec::new());
        }
        Err(said)
    }

    /// The pane as `capture-pane -p -e` draws it, scrollback included.
    pub async fn capture(&self, name: &str) -> Option<String> {
        let target = super::pane_target(name);
        let out = self
            .run(&["capture-pane", "-p", "-e", "-S", "-500", "-t", &target])
            .await
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// What stands on the pane, `None` where it could not be read.
    pub async fn standing(&self, name: &str) -> Option<Standing> {
        self.capture(name).await.map(|c| composer::standing(&c))
    }

    /// The project the box placed the session for: its `FORGE_PROJECT_ID`.
    pub async fn project_of(&self, name: &str) -> Option<String> {
        let target = super::session_target(name);
        let out = self
            .run(&["show-environment", "-t", &target, "FORGE_PROJECT_ID"])
            .await
            .ok()?;
        let said = String::from_utf8_lossy(&out.stdout);
        said.trim()
            .strip_prefix("FORGE_PROJECT_ID=")
            .filter(|p| !p.is_empty())
            .map(str::to_string)
    }

    /// Refuse the permission dialog `asked` standing on `name`, with `reason`
    /// as what the agent is told.
    pub async fn deny(&self, name: &str, asked: &Permission, reason: &str) -> Result<(), Stopped> {
        let target = super::pane_target(name);
        let fresh = |p: &Permission| !p.amending && p.is_same_dialog(asked);
        let start = self
            .until(name, Step::Start, Duration::ZERO, &fresh)
            .await?;
        let key = if start.no > start.highlighted {
            "Down"
        } else {
            "Up"
        };
        let mut keys = vec!["send-keys", "-t", &target];
        keys.extend(std::iter::repeat_n(
            key,
            start.no.abs_diff(start.highlighted),
        ));
        if keys.len() > 3 {
            self.ok(&keys).await?;
        }
        let on_no = |p: &Permission| fresh(p) && p.highlighted == p.no;
        self.until(name, Step::Highlight, STEP_WITHIN, &on_no)
            .await?;
        self.ok(&["send-keys", "-t", &target, "Tab"]).await?;
        let open = |p: &Permission| p.amending && p.highlighted == p.no && p.is_same_dialog(asked);
        self.until(name, Step::Amend, STEP_WITHIN, &open).await?;
        self.ok(&["send-keys", "-t", &target, "-l", reason]).await?;
        let typed: String = reason.chars().filter(|c| !c.is_whitespace()).collect();
        let holds = |p: &Permission| open(p) && p.amended_with().as_deref() == Some(typed.as_str());
        self.until(name, Step::Typed, STEP_WITHIN, &holds).await?;
        self.ok(&["send-keys", "-t", &target, "Enter"]).await?;
        self.gone(name, asked).await
    }

    /// Read the pane until `wanted` holds of the dialog on it, for at most `within`.
    async fn until(
        &self,
        name: &str,
        step: Step,
        within: Duration,
        wanted: &(dyn Fn(&Permission) -> bool + Sync),
    ) -> Result<Permission, Stopped> {
        let deadline = Instant::now() + within;
        loop {
            let read = self.standing(name).await;
            if let Some(Standing::Permission(p)) = &read {
                if wanted(p) {
                    return Ok(p.clone());
                }
            }
            if Instant::now() >= deadline {
                return Err(Stopped::At {
                    step,
                    read: shown(read.as_ref()),
                });
            }
            tokio::time::sleep(POLL).await;
        }
    }

    async fn gone(&self, name: &str, asked: &Permission) -> Result<(), Stopped> {
        let deadline = Instant::now() + STEP_WITHIN;
        loop {
            let read = self.standing(name).await;
            match &read {
                Some(Standing::Permission(p)) if p.is_same_dialog(asked) => {}
                Some(_) => return Ok(()),
                None => {}
            }
            if Instant::now() >= deadline {
                return Err(Stopped::At {
                    step: Step::Submit,
                    read: shown(read.as_ref()),
                });
            }
            tokio::time::sleep(POLL).await;
        }
    }
}

/// What a read showed, for a log line.
fn shown(read: Option<&Standing>) -> String {
    match read {
        None => "nothing tmux could capture".into(),
        Some(Standing::Nothing) => "no choice list".into(),
        Some(Standing::Other { highlighted, .. }) => {
            format!("another choice list, at \u{ab}{highlighted}\u{bb}")
        }
        Some(Standing::Permission(p)) => format!(
            "\u{ab}{}\u{bb} with \u{ab}{}\u{bb} highlighted{}",
            p.question,
            composer::excerpt(p.options.get(p.highlighted).map_or("", String::as_str), 120),
            if p.amending { ", its No row open" } else { "" }
        ),
    }
}
