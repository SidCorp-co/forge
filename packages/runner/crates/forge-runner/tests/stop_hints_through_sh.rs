//! A refused stop's two hints, filled with a run's own words and run through
//! `sh` exactly as the refusal shows them (ISS-297).
//!
//! A run fills a hint with prose: a comment on where its work stands, a commit
//! message. Prose carries apostrophes, double quotes and line breaks, so a hint
//! is proved only by filling it with all three and watching the text arrive
//! intact — at core as the comment's `body`, and in git as the commit message.
//! The held hint runs this build's own `forge-runner` — the binary a hint
//! names is the one judging the stop — against a one-request core on loopback;
//! the dirty hint runs `git` in a scratch tree.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use runner_core::stop_gate::{
    decide, porcelain_paths, Facts, Issue, Outcome, COMMIT_TEXT, HELD_TEXT,
};

/// What a run writes: an apostrophe, double quotes, a line break, and the
/// characters a shell would expand or a JSON string would escape.
const TEXT: &str =
    "It's \"held\" at `step 2`; $HOME and $(id) stay literal\nsecond line \\ ends here";

const ISSUE_ID: &str = "0d9e6010-b39a-41c3-8702-1d1eab933311";

/// A scratch directory removed when it goes out of scope, a failed assertion
/// included.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("stop-hints-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn refusal(f: &Facts<'_>) -> String {
    match decide(f).outcome {
        Outcome::Refused(r) => r,
        other => panic!("not refused: {other:?}"),
    }
}

/// The command a refusal shows — its lines from the one holding `marker`
/// through the heredoc's terminator — with the run's text in place of
/// `placeholder`. A hint that is not a closed heredoc fails here by name.
fn filled(reason: &str, marker: &str, placeholder: &str, text: &str) -> String {
    let lines: Vec<&str> = reason.lines().skip_while(|l| !l.contains(marker)).collect();
    let first = lines
        .first()
        .unwrap_or_else(|| panic!("no command holding `{marker}` in:\n{reason}"));
    let terminator = first
        .split_once("<<'")
        .and_then(|(_, t)| t.split_once('\''))
        .map(|(t, _)| t)
        .unwrap_or_else(|| panic!("`{first}` opens no quoted heredoc"));
    let end = lines
        .iter()
        .position(|l| *l == terminator)
        .unwrap_or_else(|| panic!("the heredoc in:\n{reason}\nis never closed"));
    let cmd = lines[..=end].join("\n") + "\n";
    assert!(
        cmd.contains(placeholder),
        "the command has no `{placeholder}` to fill:\n{cmd}"
    );
    cmd.replace(placeholder, text)
}

fn sh(cmd: &str, env: &[(&str, &str)]) -> std::process::Output {
    let mut c = Command::new("sh");
    c.arg("-c").arg(cmd).stdin(Stdio::null());
    for (k, v) in env {
        c.env(k, v);
    }
    c.output().unwrap()
}

/// A core that answers one request `201 {}` and hands back its request line
/// and body.
fn one_request_core() -> (String, std::thread::JoinHandle<(String, Vec<u8>)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let served = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut request_line = String::new();
        reader.read_line(&mut request_line).unwrap();
        let mut length = 0usize;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            let header = header.trim_end();
            if header.is_empty() {
                break;
            }
            if let Some((k, v)) = header.split_once(':') {
                if k.eq_ignore_ascii_case("content-length") {
                    length = v.trim().parse().unwrap();
                }
            }
        }
        let mut body = vec![0u8; length];
        reader.read_exact(&mut body).unwrap();
        let mut out = stream;
        out.write_all(
            b"HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        )
        .unwrap();
        (request_line.trim_end().to_string(), body)
    });
    (url, served)
}

/// A config naming `core_url`, where this platform's runner reads it.
fn config_at(home: &Path, xdg: &Path, core_url: &str) {
    let toml = format!("core_url = \"{core_url}\"\n");
    for dir in [
        xdg.join("forge-runner"),
        home.join("Library/Application Support/forge-runner"),
    ] {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.toml"), &toml).unwrap();
    }
}

#[test]
fn the_held_hint_filled_with_prose_posts_it_as_the_comment_body() {
    let scratch = Scratch::new("held");
    let (home, xdg) = (scratch.0.join("home"), scratch.0.join("xdg"));
    let (core, served) = one_request_core();
    config_at(&home, &xdg, &core);

    let tree = scratch.0.join("tree");
    let reason = refusal(&Facts {
        run_id: "296f5496-870e-428f-b386-d1c6007bfd9c",
        tree: &tree,
        runner: env!("CARGO_BIN_EXE_forge-runner"),
        issues: vec![(
            "ISS-297".into(),
            Issue::HeldUnwritten {
                id: ISSUE_ID.into(),
            },
        )],
        dirty: Ok(vec![]),
        standing: Ok(vec![]),
        refused_in_a_row: 0,
    });
    let cmd = filled(&reason, " api issues/", HELD_TEXT, TEXT);
    let out = sh(
        &cmd,
        &[
            ("HOME", home.to_str().unwrap()),
            ("XDG_CONFIG_HOME", xdg.to_str().unwrap()),
            ("FORGE_PAT", "pat-for-the-test"),
            ("FORGE_BORROW_FROM", ""),
            ("FORGE_PROJECT_SLUG", ""),
        ],
    );
    assert!(
        out.status.success(),
        "the held hint, filled, failed:\n{cmd}\nstderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let (request_line, body) = served.join().unwrap();
    assert_eq!(
        request_line,
        format!("POST /api/issues/{ISSUE_ID}/comments HTTP/1.1")
    );
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body, serde_json::json!({ "body": TEXT }));
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .envs(git_env())
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn git_env() -> [(&'static str, &'static str); 7] {
    [
        ("GIT_EDITOR", "true"),
        ("GIT_AUTHOR_NAME", "t"),
        ("GIT_AUTHOR_EMAIL", "t@t"),
        ("GIT_COMMITTER_NAME", "t"),
        ("GIT_COMMITTER_EMAIL", "t@t"),
        ("GIT_CONFIG_GLOBAL", "/dev/null"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
    ]
}

/// In a tree whose path needs quoting, holding a modified file, a deleted one,
/// a deletion already staged (`git rm`), a staged rename (`git mv`) and an
/// untracked file whose own name needs quoting, with no terminal and an editor
/// that writes nothing: the commit carries the run's text as its message, and
/// the tree is left clean.
#[test]
fn the_dirty_hint_filled_with_prose_commits_it_as_the_message() {
    let scratch = Scratch::new("dirty");
    let tree = scratch.0.join("a tree").join("it's");
    std::fs::create_dir_all(&tree).unwrap();
    git(&tree, &["init", "-q"]);
    std::fs::write(tree.join("kept.rs"), "fn a() {}").unwrap();
    std::fs::write(tree.join("gone.rs"), "fn b() {}").unwrap();
    std::fs::write(tree.join("removed.rs"), "fn c() {}").unwrap();
    std::fs::write(tree.join("moved.rs"), "fn d() {}").unwrap();
    git(&tree, &["add", "."]);
    git(&tree, &["commit", "-q", "-m", "base"]);
    std::fs::write(tree.join("kept.rs"), "fn a() { 1; }").unwrap();
    std::fs::remove_file(tree.join("gone.rs")).unwrap();
    git(&tree, &["rm", "-q", "removed.rs"]);
    git(&tree, &["mv", "moved.rs", "it's moved.rs"]);
    std::fs::write(tree.join("the run's \"notes\".md"), "new").unwrap();
    let dirty = porcelain_paths(&git(
        &tree,
        &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
    ));
    assert_eq!(dirty.len(), 5, "{dirty:?}");

    let reason = refusal(&Facts {
        run_id: "296f5496-870e-428f-b386-d1c6007bfd9c",
        tree: &tree,
        runner: env!("CARGO_BIN_EXE_forge-runner"),
        issues: vec![],
        dirty: Ok(dirty),
        standing: Ok(vec![]),
        refused_in_a_row: 0,
    });
    let cmd = filled(&reason, "git -C", COMMIT_TEXT, TEXT);
    let out = sh(&cmd, &git_env());
    assert!(
        out.status.success(),
        "the dirty hint, filled, failed:\n{cmd}\nstderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(git(&tree, &["status", "--porcelain"]), "", "{cmd}");
    assert_eq!(git(&tree, &["log", "-1", "--format=%B"]).trim_end(), TEXT);
}

/// A tree whose only change is a deletion `git rm` already staged: nothing is
/// left to stage, and the hint still commits it.
#[test]
fn the_dirty_hint_commits_a_deletion_already_staged() {
    let scratch = Scratch::new("rm");
    let tree = scratch.0.join("tree");
    std::fs::create_dir_all(&tree).unwrap();
    git(&tree, &["init", "-q"]);
    std::fs::write(tree.join("work.rs"), "fn a() {}").unwrap();
    git(&tree, &["add", "work.rs"]);
    git(&tree, &["commit", "-q", "-m", "base"]);
    git(&tree, &["rm", "-q", "work.rs"]);
    let dirty = porcelain_paths(&git(
        &tree,
        &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
    ));

    let reason = refusal(&Facts {
        run_id: "296f5496-870e-428f-b386-d1c6007bfd9c",
        tree: &tree,
        runner: env!("CARGO_BIN_EXE_forge-runner"),
        issues: vec![],
        dirty: Ok(dirty),
        standing: Ok(vec![]),
        refused_in_a_row: 0,
    });
    let cmd = filled(&reason, "git -C", COMMIT_TEXT, TEXT);
    let out = sh(&cmd, &git_env());
    assert!(
        out.status.success(),
        "the dirty hint, filled, failed:\n{cmd}\nstderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(git(&tree, &["status", "--porcelain"]), "", "{cmd}");
    assert_eq!(git(&tree, &["log", "-1", "--format=%B"]).trim_end(), TEXT);
    assert_eq!(git(&tree, &["ls-files"]), "", "{cmd}");
}

/// The refusal after a hint whose commit failed: its `git add` had already
/// staged the deletion, so the next stop reads it staged, and the hint that
/// refusal shows runs as written.
#[test]
fn the_hint_after_a_failed_commit_runs_as_written() {
    let scratch = Scratch::new("retry");
    let tree = scratch.0.join("tree");
    std::fs::create_dir_all(&tree).unwrap();
    git(&tree, &["init", "-q"]);
    std::fs::write(tree.join("kept.rs"), "fn a() {}").unwrap();
    std::fs::write(tree.join("gone.rs"), "fn b() {}").unwrap();
    git(&tree, &["add", "."]);
    git(&tree, &["commit", "-q", "-m", "base"]);
    std::fs::write(tree.join("kept.rs"), "fn a() { 1; }").unwrap();
    std::fs::remove_file(tree.join("gone.rs")).unwrap();
    let hook = tree.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();

    let hint = || {
        let dirty = porcelain_paths(&git(
            &tree,
            &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
        ));
        let reason = refusal(&Facts {
            run_id: "296f5496-870e-428f-b386-d1c6007bfd9c",
            tree: &tree,
            runner: env!("CARGO_BIN_EXE_forge-runner"),
            issues: vec![],
            dirty: Ok(dirty),
            standing: Ok(vec![]),
            refused_in_a_row: 0,
        });
        filled(&reason, "git -C", COMMIT_TEXT, TEXT)
    };
    let first = hint();
    assert!(
        !sh(&first, &git_env()).status.success(),
        "the hook let it through"
    );
    std::fs::remove_file(&hook).unwrap();
    let again = hint();
    let out = sh(&again, &git_env());
    assert!(
        out.status.success(),
        "the hint after a failed commit, filled, failed:\n{again}\nstderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(git(&tree, &["status", "--porcelain"]), "", "{again}");
}
