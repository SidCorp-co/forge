//! A prompt standing on a background session, read and answered on a pty the runner holds
//! (ISS-1268 C2). The relay hook answers a permission prompt before it is drawn; one that slips
//! past it (a startup dialog, a prompt no hook event reaches) stands on the session's screen, and
//! `claude agents --json` names only that it waits. So the runner attaches (`claude attach <id>`)
//! on a pseudo-terminal of its own, renders the screen with a terminal emulator, and reads the
//! dialog's exact text. It answers from the dialog catalog where the text is a known dialog of the
//! pinned version, else the safe way: Escape, which closes a Claude Code dialog without accepting
//! it. It never presses Enter on a dialog it has not read.

use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

/// The screen the runner attaches with: wide enough that a dialog's lines do not wrap.
#[cfg(unix)]
const ROWS: u16 = 50;
#[cfg(unix)]
const COLS: u16 = 200;

/// How long an attach is read for before the screen is taken as drawn.
pub const SETTLE: Duration = Duration::from_millis(2500);

/// What the runner presses on a dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keys {
    /// Escape: closes a dialog without accepting it.
    Escape,
}

impl Keys {
    pub fn bytes(self) -> &'static [u8] {
        match self {
            Keys::Escape => b"\x1b",
        }
    }

    pub fn wire(self) -> &'static str {
        match self {
            Keys::Escape => "Escape",
        }
    }
}

/// One dialog the pinned version draws, and the answer decided for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    /// The Claude Code version the canary verified it on.
    pub version: &'static str,
    /// Text the dialog draws, which no other screen does.
    pub reads: &'static str,
    pub name: &'static str,
    pub answer: Keys,
    /// Why this answer, as the record says it.
    pub why: &'static str,
}

/// The dialog catalog (measured on 2.1.322, ISS-1268 BP logs in
/// `~/forge-local-docs/iss1268-chat-channels/bp/`). An entry is added from a dialog the watcher
/// raised as unknown, once a canary on the pinned version shows its text and answer.
pub const CATALOG: &[Entry] = &[
    Entry {
        version: "2.1.322",
        reads: "Do you want to proceed?",
        name: "tool permission",
        answer: Keys::Escape,
        why: "a tool call the relay hook did not answer: refused, as the relay's own timeout would",
    },
    Entry {
        version: "2.1.322",
        reads: "New MCP server found",
        name: "project MCP server",
        answer: Keys::Escape,
        why: "a project .mcp.json server the launch settings did not pre-approve: not enabled",
    },
];

/// The catalog entry `screen` shows on `version`, if any.
pub fn known(version: &str, screen: &str) -> Option<&'static Entry> {
    CATALOG
        .iter()
        .find(|e| e.version == version && screen.contains(e.reads))
}

/// The dialog part of a rendered screen: its non-empty lines, trimmed, from the last solid rule
/// (`─`) Claude Code draws above a dialog down to its "Esc to cancel" line, else the screen's last
/// lines. The dashed rules (`╌`) inside a dialog and the footer rule naming the session are not
/// where it starts (measured on 2.1.322, `bp/c2-live-1.log`).
pub fn dialog_text(screen: &str) -> String {
    let lines: Vec<&str> = screen
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let solid = |l: &str| l.chars().count() > 10 && l.chars().all(|c| c == '─');
    let from = lines
        .iter()
        .rposition(|l| solid(l))
        .map_or(lines.len().saturating_sub(20), |i| i + 1);
    let to = lines[from..]
        .iter()
        .position(|l| l.starts_with("Esc to cancel"))
        .map_or(lines.len(), |i| from + i + 1);
    lines[from..to].join("\n")
}

/// What Claude Code's own record of a background session says it waits on: `jobs/<id>/state.json`
/// `detail` (e.g. "stuck on a startup dialog") and `needs` (e.g. `approve Bash: ...`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobState {
    pub detail: Option<String>,
    pub needs: Option<String>,
}

impl JobState {
    /// Measured on 2.1.322: a session stopped at a startup dialog reads this after about 45 s, and
    /// `claude agents --json` names no wait for it.
    pub fn stuck_at_startup(&self) -> bool {
        self.detail
            .as_deref()
            .is_some_and(|d| d.contains("stuck on a startup dialog"))
    }

    pub fn parse(text: &str) -> Self {
        let v: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
        let s = |k: &str| {
            v.get(k)
                .and_then(serde_json::Value::as_str)
                .filter(|t| !t.trim().is_empty())
                .map(str::to_string)
        };
        Self {
            detail: s("detail"),
            needs: s("needs"),
        }
    }
}

/// The record of the background session `id` (its short id); empty where none is readable.
pub fn job_state(id: &str) -> JobState {
    super::claude_dir()
        .map(|d| d.join("jobs").join(id).join("state.json"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| JobState::parse(&t))
        .unwrap_or_default()
}

/// A session attached on a pty this runner holds.
#[cfg(unix)]
pub struct Attached {
    child: std::process::Child,
    master: std::fs::File,
    parser: vt100::Parser,
}

#[cfg(unix)]
impl Attached {
    /// Attach to the background session `id` (its short id).
    pub fn open(id: &str) -> Result<Self, String> {
        use std::os::fd::OwnedFd;
        use std::process::Stdio;
        let size = nix::pty::Winsize {
            ws_row: ROWS,
            ws_col: COLS,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let pty = nix::pty::openpty(Some(&size), None).map_err(|e| format!("openpty: {e}"))?;
        let flags = nix::fcntl::fcntl(&pty.master, nix::fcntl::FcntlArg::F_GETFL)
            .map_err(|e| format!("pty flags: {e}"))?;
        nix::fcntl::fcntl(
            &pty.master,
            nix::fcntl::FcntlArg::F_SETFL(
                nix::fcntl::OFlag::from_bits_truncate(flags) | nix::fcntl::OFlag::O_NONBLOCK,
            ),
        )
        .map_err(|e| format!("pty nonblocking: {e}"))?;
        let slave: OwnedFd = pty.slave;
        let io = |fd: &OwnedFd| -> Result<Stdio, String> {
            Ok(Stdio::from(
                fd.try_clone().map_err(|e| format!("pty: {e}"))?,
            ))
        };
        let child = std::process::Command::new(runner_platform::process::resolve_claude_bin())
            .args(["attach", id])
            .env("TERM", "xterm-256color")
            .env_remove("CLAUDECODE")
            .stdin(io(&slave)?)
            .stdout(io(&slave)?)
            .stderr(io(&slave)?)
            .spawn()
            .map_err(|e| format!("`claude attach {id}`: {e}"))?;
        drop(slave);
        Ok(Self {
            child,
            master: std::fs::File::from(pty.master),
            parser: vt100::Parser::new(ROWS, COLS, 0),
        })
    }

    /// Read what the session draws for `within`, and answer the screen as it then stands.
    pub async fn screen(&mut self, within: Duration) -> String {
        use std::io::Read;
        let deadline = Instant::now() + within;
        let mut buf = [0u8; 8192];
        while Instant::now() < deadline {
            match self.master.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => self.parser.process(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(_) => break,
            }
        }
        self.parser.screen().contents()
    }

    /// Press `keys`. Only ever a catalog answer or Escape: Enter is not one of [`Keys`].
    pub fn press(&mut self, keys: Keys) -> Result<(), String> {
        use std::io::Write;
        self.master
            .write_all(keys.bytes())
            .map_err(|e| format!("pressing {}: {e}", keys.wire()))
    }
}

#[cfg(unix)]
impl Drop for Attached {
    /// Detach: the attach client ends; the background session it viewed goes on.
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The dialog as 2.1.322 drew it on a pty (`bp/c2-live-1.log`), its footer included.
    const SCREEN: &str = "  some earlier output\n────────────────────────────────────────\n Bash command\n Remove the e/sub directory\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n X=$PWD/e; rm -rf \"$X/sub\"\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n A variable in this command can't be checked before it runs\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and switch to auto mode\n   3. No\n Esc to cancel · Tab to amend\n──────────────────── forge-bp-c2-1 ─\n";

    #[test]
    fn a_dialog_is_read_from_its_rule_down_and_matched_on_its_version_only() {
        let text = dialog_text(SCREEN);
        assert!(text.starts_with("Bash command"), "{text}");
        assert!(
            text.contains("rm -rf") && text.contains("can't be checked"),
            "{text}"
        );
        assert!(text.ends_with("Esc to cancel · Tab to amend"), "{text}");
        assert!(
            !text.contains("earlier output") && !text.contains("forge-bp-c2-1"),
            "{text}"
        );
        assert_eq!(
            known("2.1.322", SCREEN).map(|e| e.name),
            Some("tool permission")
        );
        assert_eq!(
            known("2.1.400", SCREEN),
            None,
            "an entry answered a version it was never verified on"
        );
        assert_eq!(known("2.1.322", "Choose a theme"), None);
    }

    #[test]
    fn a_session_stuck_at_a_startup_dialog_is_read_from_its_job_record() {
        let st = JobState::parse(
            r#"{"state":"blocked","detail":"stuck on a startup dialog","needs":"approve the MCP server"}"#,
        );
        assert!(st.stuck_at_startup());
        assert_eq!(st.needs.as_deref(), Some("approve the MCP server"));
        assert!(!JobState::parse(r#"{"state":"working"}"#).stuck_at_startup());
        assert_eq!(JobState::parse("not json"), JobState::default());
    }

    /// A live read of a prompt standing on a throwaway session: `FORGE_PROMPT_SESSION=<short id>
    /// cargo test -p runner-workspace prompt_live -- --ignored --nocapture`. It prints the screen,
    /// the catalog entry it matched, presses that answer, and prints the screen after.
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "attaches to a real claude --bg session"]
    async fn prompt_live() {
        let id = std::env::var("FORGE_PROMPT_SESSION").unwrap();
        let version = std::env::var("FORGE_PROMPT_VERSION").unwrap_or_else(|_| "2.1.322".into());
        let mut a = Attached::open(&id).unwrap();
        let screen = a.screen(SETTLE).await;
        println!(
            "--- screen ---\n{screen}\n--- dialog ---\n{}",
            dialog_text(&screen)
        );
        let entry = known(&version, &screen);
        println!("--- catalog: {:?}", entry.map(|e| e.name));
        let keys = entry.map_or(Keys::Escape, |e| e.answer);
        a.press(keys).unwrap();
        let after = a.screen(SETTLE).await;
        println!("--- after {} ---\n{}", keys.wire(), dialog_text(&after));
        assert!(
            entry.is_some(),
            "the dialog is not in the {version} catalog"
        );
        assert_ne!(
            dialog_text(&after),
            dialog_text(&screen),
            "the dialog still stands"
        );
    }

    #[test]
    fn the_catalog_never_answers_with_enter() {
        for e in CATALOG {
            assert_ne!(e.answer.bytes(), b"\r", "{} answers with Enter", e.name);
            assert_ne!(e.answer.bytes(), b"\n", "{} answers with Enter", e.name);
        }
    }
}
