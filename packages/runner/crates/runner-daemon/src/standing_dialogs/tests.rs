//! ISS-280 — dialogs standing on panes before the sweep runs, on a real tmux
//! server of the test's own.
//!
//! Each pane runs this test binary as a stand-in for Claude Code
//! ([`fake_claude_code_pane`]): it draws a dialog the way the 2.1.292 captures
//! under `runner-workspace/assets/composer/` show it, acts on Down, Up, Tab,
//! typed text and Enter as Claude Code does, and writes down every byte it was
//! sent and the reason it was handed.

use super::*;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Instant;

/// A tmux server of this test's own, killed with the test.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("fsd-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn socket(&self) -> PathBuf {
        self.0.join("s")
    }

    fn tmux(&self, args: &[&str]) -> std::process::Output {
        std::process::Command::new("tmux")
            .arg("-S")
            .arg(self.socket())
            .args(args)
            .output()
            .expect("tmux could not be run")
    }

    /// Stand a fake pane of `kind` as session `name`, writing under `<root>/<name>/`.
    fn pane(&self, name: &str, kind: &str, project: Option<&str>) -> PathBuf {
        let dir = self.0.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = std::env::current_exe().unwrap();
        let mut args: Vec<String> = ["new-session", "-d", "-s", name, "-x", "900", "-y", "40"]
            .map(String::from)
            .to_vec();
        for (k, v) in [
            ("FORGE_FAKE_PANE", kind),
            ("FORGE_FAKE_PANE_DIR", &dir.to_string_lossy()),
        ] {
            args.push("-e".into());
            args.push(format!("{k}={v}"));
        }
        if let Some(p) = project {
            args.push("-e".into());
            args.push(format!("FORGE_PROJECT_ID={p}"));
        }
        args.extend(["sh".into(), "-c".into(), format!(
            "stty raw -echo; exec '{}' --ignored --exact standing_dialogs::tests::fake_claude_code_pane --nocapture --test-threads=1",
            exe.display()
        )]);
        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = self.tmux(&borrowed);
        assert!(
            out.status.success(),
            "tmux new-session {name}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        dir
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = self.tmux(&["kill-server"]);
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn tmux_or_skip(test: &str) -> bool {
    if std::process::Command::new("tmux")
        .arg("-V")
        .output()
        .is_ok_and(|o| o.status.success())
    {
        return true;
    }
    match std::env::var("FORGE_TEST_SKIP_TMUX") {
        Ok(v) if v == "1" => {
            let _ = writeln!(
                std::io::stderr(),
                "SKIPPED {test}: tmux is not on PATH and FORGE_TEST_SKIP_TMUX=1 opted this run out — nothing was asserted"
            );
            false
        }
        _ => panic!(
            "TMUX_NOT_ON_PATH: {test} needs a real tmux server — install tmux, or set FORGE_TEST_SKIP_TMUX=1 to skip it by name"
        ),
    }
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

async fn drawn(tmux: &Tmux, name: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if matches!(
            tmux.standing(name).await,
            Some(Standing::Permission(_) | Standing::Other { .. } | Standing::UsageLimit { .. })
        ) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{name} never drew its dialog");
}

fn of<'a>(out: &'a [Outcome], pane: &str) -> &'a Outcome {
    out.iter()
        .find(|o| match o {
            Outcome::Answered { pane: p, .. }
            | Outcome::Stopped { pane: p, .. }
            | Outcome::Cannot { pane: p, .. }
            | Outcome::UsageLimit { pane: p, .. }
            | Outcome::Moved { pane: p } => p == pane,
        })
        .unwrap_or_else(|| panic!("no outcome for {pane}: {out:?}"))
}

/// The record holds the one answer the sweep gave, under the pane's project.
fn one_answer_recorded_as_the_sweep_s(config: &Path) {
    let lines: Vec<serde_json::Value> = read(&dialog_answer::answers_path(config))
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["project"], "p1");
    assert_eq!(lines[0]["via"], "sweep");
    assert_eq!(
        lines[0]["reason"],
        "denied Bash command: Delete victim.txt \u{b7} rm -f victim.txt"
    );
}

#[tokio::test]
async fn dialogs_standing_before_the_daemon_starts_are_answered_or_named_and_never_allowed() {
    if !tmux_or_skip(
        "dialogs_standing_before_the_daemon_starts_are_answered_or_named_and_never_allowed",
    ) {
        return;
    }
    let root = Scratch::new();
    let config = root.0.join("config");
    let asked = root.pane("forge-master-p", "permission", Some("p1"));
    let trust = root.pane("forge-job-trust", "trust", Some("p2"));
    let vanish = root.pane("forge-job-vanish", "vanish", None);
    let stuck = root.pane("forge-job-stuck", "stuck", None);
    let tmux = Tmux::on(root.socket());
    for name in [
        "forge-master-p",
        "forge-job-trust",
        "forge-job-vanish",
        "forge-job-stuck",
    ] {
        drawn(&tmux, name).await;
    }

    let mut sweep = DialogSweep::new(Duration::from_secs(2));
    let gone = vanish.join("go");
    let vanishing = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(600)).await;
        std::fs::write(gone, "").unwrap();
    });
    let first = sweep.pass(&tmux, Some(&config), &NoCore).await;
    vanishing.await.unwrap();

    assert_eq!(
        of(&first, "forge-master-p"),
        &Outcome::Answered {
            pane: "forge-master-p".into(),
            project: Some("p1".into()),
            reason: "denied Bash command: Delete victim.txt \u{b7} rm -f victim.txt".into(),
        }
    );
    assert_eq!(
        read(&asked.join("chose")),
        "",
        "Enter decided a highlighted option"
    );
    assert_eq!(read(&asked.join("answers")), format!("{REPHRASE}\n"));

    match of(&first, "forge-job-trust") {
        Outcome::Cannot {
            highlighted,
            why,
            said_now,
            ..
        } => {
            assert_eq!(highlighted, "No, exit");
            assert!(why.contains("not numbered"), "{why}");
            assert!(said_now, "the first sight of it is logged");
        }
        other => panic!("trust read as {other:?}"),
    }
    assert_eq!(read(&trust.join("keys")), "", "a trust dialog was keyed");

    assert!(matches!(
        of(&first, "forge-job-vanish"),
        Outcome::Moved { .. }
    ));
    assert_eq!(
        read(&vanish.join("keys")),
        "",
        "a dialog that went was keyed"
    );

    match of(&first, "forge-job-stuck") {
        Outcome::Stopped { why, .. } => assert!(why.contains("Tab on No"), "{why}"),
        other => panic!("stuck read as {other:?}"),
    }
    assert_eq!(read(&stuck.join("keys")), "\u{1b}[B\u{1b}[B\t");

    one_answer_recorded_as_the_sweep_s(&config);

    let next = sweep.pass(&tmux, Some(&config), &NoCore).await;
    match of(&next, "forge-master-p") {
        Outcome::Answered { reason, .. } => {
            assert_eq!(reason, "denied Overwrite file: victim.txt")
        }
        other => panic!("the dialog raised after the first pass read as {other:?}"),
    }
    assert_eq!(
        read(&asked.join("answers")),
        format!("{REPHRASE}\n{REPHRASE}\n")
    );
    assert!(
        matches!(
            of(&next, "forge-job-trust"),
            Outcome::Cannot {
                said_now: false,
                ..
            }
        ),
        "the same trust dialog was logged a second time"
    );
    assert_eq!(read(&trust.join("keys")), "");
    assert_eq!(dialog_answer::report(&config)[0].count, 2);
}

/// A dialog as the fake draws it.
struct Dialog {
    head: [&'static str; 3],
    question: &'static str,
    options: [&'static str; 3],
}

const DIALOGS: [Dialog; 2] = [
    Dialog {
        head: ["Bash command", "Delete victim.txt", "rm -f victim.txt"],
        question: "Do you want to proceed?",
        options: [
            "Yes",
            "Yes, and always allow access to /home/u/work from this project",
            "No",
        ],
    },
    Dialog {
        head: ["Overwrite file", "victim.txt", ""],
        question: "Do you want to overwrite victim.txt?",
        options: [
            "Yes",
            "Yes, and switch to accept edits for this session",
            "No",
        ],
    },
];

const RULE: &str = "\u{2500}";
const DASH: &str = "\u{254c}";

fn draw(lines: &[String]) {
    let mut out = std::io::stdout().lock();
    let _ = write!(out, "\x1b[H\x1b[2J{}", lines.join("\r\n"));
    let _ = out.flush();
}

fn composer() -> Vec<String> {
    vec![RULE.repeat(80), "\u{276f} ".into(), RULE.repeat(80)]
}

fn permission(d: &Dialog, highlighted: usize, amend: Option<&str>) -> Vec<String> {
    let mut lines = vec![RULE.repeat(80)];
    lines.extend(
        d.head[..2]
            .iter()
            .filter(|l| !l.is_empty())
            .map(|l| format!(" {l}")),
    );
    if !d.head[2].is_empty() {
        lines.extend([DASH.repeat(80), format!(" {}", d.head[2]), DASH.repeat(80)]);
    }
    lines.push(format!(" {}", d.question));
    for (i, option) in d.options.iter().enumerate() {
        let mark = if i == highlighted {
            " \u{276f} "
        } else {
            "   "
        };
        let text = match amend {
            Some("") if i == 2 => "No, and tell Claude what to do differently".to_string(),
            Some(typed) if i == 2 => format!("No, {typed}"),
            _ => option.to_string(),
        };
        lines.push(format!("{mark}{}. {text}", i + 1));
    }
    lines.push(String::new());
    lines.push(if amend.is_some() {
        " Esc to cancel".into()
    } else {
        " Esc to cancel \u{b7} Tab to amend".into()
    });
    lines
}

fn limit_list() -> Vec<String> {
    vec![
        RULE.repeat(80),
        " You've hit your usage limit".into(),
        String::new(),
        " What do you want to do?".into(),
        String::new(),
        " \u{276f} 1. Stop and wait for limit to reset".into(),
        "   2. Wait here, then continue automatically at 3:40pm (UTC)".into(),
        "   3. Ask your admin".into(),
        String::new(),
        " Enter to confirm \u{b7} Esc to cancel".into(),
    ]
}

fn trust() -> Vec<String> {
    vec![
        RULE.repeat(80),
        " Accessing workspace:".into(),
        " /home/u/work".into(),
        " \u{276f} No, exit".into(),
        "   Yes, I trust this folder".into(),
        String::new(),
        " Enter to confirm \u{b7} Esc to cancel".into(),
    ]
}

/// Claude Code as far as a permission dialog goes, run inside a pane by the
/// test above; it returns at once anywhere else.
#[test]
#[ignore = "a pane's program, started by the tmux test above"]
fn fake_claude_code_pane() {
    let (Ok(kind), Ok(dir)) = (
        std::env::var("FORGE_FAKE_PANE"),
        std::env::var("FORGE_FAKE_PANE_DIR"),
    ) else {
        return;
    };
    let dir = PathBuf::from(dir);
    let note = |file: &str, text: &str| {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(file))
            .unwrap();
        f.write_all(text.as_bytes()).unwrap();
    };
    let (tx, rx) = std::sync::mpsc::channel::<u8>();
    std::thread::spawn(move || {
        let mut byte = [0u8; 1];
        let mut stdin = std::io::stdin().lock();
        while stdin.read_exact(&mut byte).is_ok() {
            if tx.send(byte[0]).is_err() {
                return;
            }
        }
    });
    let (mut at, mut highlighted, mut amend): (usize, usize, Option<Vec<u8>>) = (0, 0, None);
    let mut shown = Vec::new();
    loop {
        let lines = match kind.as_str() {
            "trust" => trust(),
            "limit" if dir.join("gone").exists() => composer(),
            "limit" | "limit-stuck" => limit_list(),
            "vanish" if dir.join("go").exists() => composer(),
            _ if at >= DIALOGS.len() => composer(),
            _ => permission(
                &DIALOGS[at],
                highlighted,
                amend.as_deref().map(String::from_utf8_lossy).as_deref(),
            ),
        };
        if lines != shown {
            draw(&lines);
            shown = lines;
        }
        let Ok(b) = rx.recv_timeout(Duration::from_millis(50)) else {
            continue;
        };
        note("keys", &char::from(b).to_string());
        if kind == "limit" || kind == "limit-stuck" {
            if kind == "limit" && b == 0x1b {
                note("gone", "");
            }
            continue;
        }
        if kind == "trust" || kind == "vanish" || at >= DIALOGS.len() {
            continue;
        }
        match (b, amend.as_mut()) {
            (0x1b, _) => {
                let seq: Vec<u8> = (0..2)
                    .filter_map(|_| rx.recv_timeout(Duration::from_secs(1)).ok())
                    .collect();
                note("keys", &String::from_utf8_lossy(&seq));
                match (seq.get(1), amend.is_none()) {
                    (Some(b'B'), true) => highlighted = (highlighted + 1).min(2),
                    (Some(b'A'), true) => highlighted = highlighted.saturating_sub(1),
                    _ => {}
                }
            }
            (b'\t', None) if highlighted == 2 && kind != "stuck" => amend = Some(Vec::new()),
            (b'\r', Some(typed)) => {
                note("answers", &format!("{}\n", String::from_utf8_lossy(typed)));
                (at, highlighted, amend) = (at + 1, 0, None);
            }
            (b'\r', None) => {
                note("chose", &format!("{}\n", highlighted + 1));
                (at, highlighted) = (at + 1, 0);
            }
            (b, Some(typed)) if b >= 0x20 => typed.push(b),
            _ => {}
        }
    }
}

/// Records what a sweep told core about the account.
struct Told(std::sync::Mutex<Vec<(Option<u64>, String)>>, bool);

impl LimitReporter for Told {
    async fn usage_limit(
        &self,
        resets_in_seconds: Option<u64>,
        detail: &str,
    ) -> runner_platform::error::Result<()> {
        if self.1 {
            return Err(runner_platform::error::Error::Other("core is down".into()));
        }
        self.0
            .lock()
            .unwrap()
            .push((resets_in_seconds, detail.into()));
        Ok(())
    }
}

#[tokio::test]
async fn the_usage_limit_list_is_reported_to_core_then_dismissed_with_escape_and_never_chosen() {
    if !tmux_or_skip(
        "the_usage_limit_list_is_reported_to_core_then_dismissed_with_escape_and_never_chosen",
    ) {
        return;
    }
    let root = Scratch::new();
    let limited = root.pane("forge-master-lim", "limit", Some("p1"));
    let trust = root.pane("forge-job-trust", "trust", Some("p2"));
    let tmux = Tmux::on(root.socket());
    drawn(&tmux, "forge-master-lim").await;
    drawn(&tmux, "forge-job-trust").await;
    let told = Told(Default::default(), false);
    let mut sweep = DialogSweep::new(Duration::from_millis(500));
    let out = sweep.pass(&tmux, None, &told).await;
    match of(&out, "forge-master-lim") {
        Outcome::UsageLimit {
            resets_in_seconds, ..
        } => {
            assert!(resets_in_seconds.is_some_and(|s| s > 0 && s <= 24 * 3600))
        }
        other => panic!("read as {other:?}"),
    }
    assert_eq!(told.0.lock().unwrap().len(), 1);
    assert_eq!(
        read(&limited.join("keys")),
        "\u{1b}",
        "only Escape was sent"
    );
    assert!(matches!(
        of(&out, "forge-job-trust"),
        Outcome::Cannot { .. }
    ));
    assert_eq!(
        read(&trust.join("keys")),
        "",
        "another choice list was keyed"
    );
}

#[tokio::test]
async fn a_usage_limit_list_core_was_not_told_about_is_left_standing() {
    if !tmux_or_skip("a_usage_limit_list_core_was_not_told_about_is_left_standing") {
        return;
    }
    let root = Scratch::new();
    let limited = root.pane("forge-master-lim", "limit", None);
    let tmux = Tmux::on(root.socket());
    drawn(&tmux, "forge-master-lim").await;
    let mut sweep = DialogSweep::new(Duration::from_millis(500));
    let out = sweep
        .pass(&tmux, None, &Told(Default::default(), true))
        .await;
    assert!(matches!(
        of(&out, "forge-master-lim"),
        Outcome::Stopped { .. }
    ));
    assert_eq!(
        read(&limited.join("keys")),
        "",
        "a list core was never told of was dismissed"
    );
}

#[tokio::test]
async fn a_usage_limit_list_escape_does_not_close_is_named_not_chosen() {
    if !tmux_or_skip("a_usage_limit_list_escape_does_not_close_is_named_not_chosen") {
        return;
    }
    let root = Scratch::new();
    let limited = root.pane("forge-master-lim", "limit-stuck", None);
    let tmux = Tmux::on(root.socket());
    drawn(&tmux, "forge-master-lim").await;
    let mut sweep = DialogSweep::new(Duration::from_millis(500));
    let out = sweep
        .pass(&tmux, None, &Told(Default::default(), false))
        .await;
    match of(&out, "forge-master-lim") {
        Outcome::Stopped { why, .. } => assert!(why.contains("Escape"), "{why}"),
        other => panic!("read as {other:?}"),
    }
    assert_eq!(read(&limited.join("keys")), "\u{1b}");
}
