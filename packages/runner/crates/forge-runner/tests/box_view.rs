//! `forge-runner top`, run as the binary an operator runs, against a box
//! planted whole: its own config, credentials, ledger, pool-job records,
//! checkouts, forge CLI records, a `tmux` that records what it was asked, a
//! "daemon" that is a process this test started, and a core that records
//! every request it is sent.
//!
//! Nothing here reaches the box the test runs on. The environment is cleared
//! and every directory the binary resolves points into the scratch, so the
//! live daemon's ledger, tmux server and credentials are never opened.

#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Arc, Mutex};

use forge_runner_core::daemon::agent_activity::{Doing, Event};
use forge_runner_core::daemon::job_exit::Reported;
use forge_runner_core::daemon::pool_jobs::{FileRecords, Live, Records};
use forge_runner_core::daemon::serving;
use forge_runner_core::daemon::turn_evidence::Watch;
use forge_runner_core::runner::ledger::{Ledger, NewRun};
use forge_runner_core::test_scratch::Scratch;

const ALPHA: &str = "11111111-1111-4111-8111-111111111111";
/// A first line past any clip width, ending in the issue it waits for (the
/// judge's plant at d7da543 lost `ISS-45` to a clip at 110).
const LONG_PROMPT: &str = "Ship the migration? It supersedes the draft whose wording no longer describes what ships, and the hotfix draft is held until the owner answers, because the column it drops is still read by the nightly export job waiting for ISS-45";
/// A blocker message whose last sentence says what is owed (clipped at 160
/// at d7da543, where core's own messages say it).
const LONG_BLOCKER: &str = "This project has no release step, so nothing can take these rows to production until one is declared in the project's pipeline configuration and a runner is online. Owed: ISS-2 criteria 3 and 4.";
const BETA: &str = "22222222-2222-4222-8222-222222222222";
/// What the live view draws before its first frame is gathered.
const READING: &str = "reading this box's sources for the first frame";
/// A core whose one question on alpha carries terminal control sequences.
const CONTROL_PROMPT: &str = "control-prompt";

/// A core that answers the routes `top` reads and records every request line.
struct FakeCore {
    url: String,
    seen: Arc<Mutex<Vec<String>>>,
}

fn fake_core(runners_status: &'static str) -> FakeCore {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            if reader.read_line(&mut first).is_err() {
                continue;
            }
            let mut auth = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if line.to_lowercase().starts_with("authorization:") {
                    auth = line.trim().to_string();
                }
            }
            let request = first.trim().to_string();
            log.lock().unwrap().push(format!("{request} | {auth}"));
            let path = request.split(' ').nth(1).unwrap_or("").to_string();
            let (status, body) = answer(&path, runners_status);
            let mut s = stream;
            let _ = write!(
                s,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    FakeCore { url, seen }
}

/// The mode a fake core answers in: `200 OK` or a refusal for discovery, or
/// `QUIET_ALPHA_REFUSED_BETA`, where alpha holds nothing and beta's reads are
/// refused.
const QUIET_ALPHA_REFUSED_BETA: &str = "quiet-alpha/refused-beta";

fn answer(path: &str, runners_status: &str) -> (String, String) {
    let ok = |b: String| ("200 OK".to_string(), b);
    let split = runners_status == QUIET_ALPHA_REFUSED_BETA;
    let control = runners_status == CONTROL_PROMPT;
    let runners_status = if split || control {
        "200 OK"
    } else {
        runners_status
    };
    if control && path.starts_with(&format!("/api/questions?projectId={ALPHA}")) {
        return ok(r#"{"questions":[{"id":"q9","blockerKind":"human","createdAt":"2026-09-30T01:00:00.000Z","askedAt":"","prompt":"\u001b[2J\u001b]0;owned\u0007\u001b[31mShip it?\u001b[0m"}],"total":1,"hasMore":false,"nextCursor":null}"#.into());
    }
    if split && !path.starts_with("/api/devices/") {
        if path.contains(BETA) {
            return ("403 Forbidden".into(), r#"{"error":"not a member"}"#.into());
        }
        if path.starts_with("/api/questions?") {
            return ok(r#"{"questions":[],"total":0,"hasMore":false,"nextCursor":null}"#.into());
        }
        if path.contains("/issues?") {
            return ok(
                r#"{"items":[],"returned":0,"total":0,"limit":200,"offset":0,"hasMore":false}"#
                    .into(),
            );
        }
    }
    if path.starts_with("/api/devices/me/runners") {
        if runners_status != "200 OK" {
            return (
                runners_status.to_string(),
                r#"{"error":"unauthorized"}"#.into(),
            );
        }
        return ok(format!(
            r#"[{{"projectId":"{ALPHA}","runnerId":"r-a","slug":"alpha","status":"online"}},{{"projectId":"{BETA}","runnerId":"r-b","slug":"beta-core","status":"online"}}]"#
        ));
    }
    // Alpha answers in two pages each, so a view that reads only the first
    // page lists less than core holds; its cursor is one that must be encoded.
    if path.starts_with(&format!("/api/questions?projectId={ALPHA}"))
        && path.ends_with("&cursor=c2%2B%2F%3D")
    {
        return ok(r#"{"questions":[{"id":"q2","blockerKind":"human","createdAt":"2026-09-30T01:10:00.000Z","askedAt":"","prompt":"Rotate the key?"}],"total":1,"hasMore":false,"nextCursor":null}"#.into());
    }
    if path.starts_with(&format!("/api/questions?projectId={ALPHA}")) {
        return ok(format!(
            r#"{{"questions":[{{"id":"q1","blockerKind":"human","createdAt":"2026-09-30T01:00:00.000Z","askedAt":"2026-09-30T01:00:00.000Z","prompt":"{LONG_PROMPT}\nIt drops a column."}}],"total":1,"hasMore":true,"nextCursor":"c2+/="}}"#
        ));
    }
    if path.starts_with("/api/questions?") {
        return ok(r#"{"questions":[],"total":0,"hasMore":false,"nextCursor":null}"#.into());
    }
    if path.starts_with(&format!("/api/projects/{ALPHA}/issues")) && path.ends_with("&offset=200") {
        return ok(r#"{"items":[{"displayId":"ISS-8","title":"t"}],"returned":1,"total":2,"limit":200,"offset":200,"hasMore":false}"#.into());
    }
    if path.starts_with(&format!("/api/projects/{ALPHA}/issues")) && path.ends_with("&offset=0") {
        return ok(r#"{"items":[{"displayId":"ISS-7","title":"t"}],"returned":1,"total":2,"limit":200,"offset":0,"hasMore":true}"#.into());
    }
    if path.starts_with(&format!("/api/projects/{BETA}/issues")) {
        return ok(r#"{"items":[{"displayId":"ISS-9","title":"t"}],"returned":1,"total":1,"limit":50,"offset":0,"hasMore":false}"#.into());
    }
    if path.starts_with(&format!("/api/projects/{ALPHA}/release-readiness")) {
        return ok(format!(
            r#"{{"hasReleaseGate":false,"blockers":[{{"code":"NO_RELEASE_GATE","httpStatus":409,"message":"{LONG_BLOCKER}","evaluated":true}},{{"code":"NO_RUNNER_ONLINE","httpStatus":409,"message":"m","evaluated":true}}],"warnings":[]}}"#
        ));
    }
    if path.starts_with(&format!("/api/projects/{BETA}/release-readiness")) {
        return ok(r#"{"hasReleaseGate":true,"blockers":[],"warnings":[]}"#.into());
    }
    (
        "404 Not Found".into(),
        r#"{"error":"no such route"}"#.into(),
    )
}

struct PlantedBox {
    _scratch: Scratch,
    root: PathBuf,
    ledger: PathBuf,
    tmux_log: PathBuf,
    daemon: Child,
}

impl Drop for PlantedBox {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn plant(core_url: &str) -> PlantedBox {
    let scratch = Scratch::short("bv");
    let root = scratch.path().to_path_buf();
    let cfg = root.join("c/forge-runner");
    std::fs::create_dir_all(&cfg).unwrap();
    let repo_a = root.join("repos/alpha");
    let repo_b = root.join("repos/beta");
    std::fs::write(
        cfg.join("config.toml"),
        format!(
            "core_url = \"{core_url}\"\n\n[bindings.alpha]\nrepo_path = \"{}\"\nproject_id = \"{ALPHA}\"\n\n[bindings.beta]\nrepo_path = \"{}\"\nproject_id = \"{BETA}\"\n",
            repo_a.display(),
            repo_b.display()
        ),
    )
    .unwrap();
    std::fs::write(
        cfg.join("credentials.json"),
        r#"{"device_token":"device-tok","pat":"pat-tok"}"#,
    )
    .unwrap();

    // The "daemon": a process of this test's, whose executable the view reads.
    let daemon = Command::new("sleep").arg("120").spawn().unwrap();
    let pid = daemon.id();
    let record = serving::Record {
        pid,
        boot_id: forge_runner_core::runner::inflight::boot_identity(),
        start_ticks: serving::start_ticks(pid),
        version: "0.0.1".into(),
        commit: "feedface".into(),
        started_at_ms: 0,
        drain: None,
    };
    serving::write(&cfg, &record).unwrap();
    let exe = std::fs::read(format!("/proc/{pid}/exe")).unwrap();

    // alpha stands on a skill the daemon's file does not carry; beta on bytes it does.
    for (repo, body) in [
        (
            &repo_a,
            b"---\nname: forge-master\n---\nan older build's skill\n".to_vec(),
        ),
        (&repo_b, exe[4096..4608].to_vec()),
    ] {
        let dir = repo.join(".claude/skills/forge-master");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), body).unwrap();
    }

    // The forge CLI's records: alpha's names another project, beta has none.
    let cli = root.join("c/forge/projects/alpha");
    std::fs::create_dir_all(&cli).unwrap();
    std::fs::write(cli.join("config.json"), r#"{"slug":"forge-dev"}"#).unwrap();

    // A tmux that answers `list-sessions` and records every call.
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let tmux_log = root.join("tmux.log");
    let tmux = bin.join("tmux");
    std::fs::write(
        &tmux,
        format!(
            "#!/bin/sh\necho \"$@\" >> '{}'\nprintf 'forge-master-alpha\\t{}\\n'\n",
            tmux_log.display(),
            now_secs() - 3600
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&tmux, std::fs::Permissions::from_mode(0o755)).unwrap();

    // The ledger, written by the ledger itself.
    let data = root.join("d/forge-runner");
    std::fs::create_dir_all(&data).unwrap();
    let ledger = data.join("ledger.sqlite");
    let boot = forge_runner_core::runner::inflight::boot_identity().unwrap_or_default();
    let mut led = Ledger::open(&ledger).unwrap();
    let wt = root.join("wt/live");
    std::fs::create_dir_all(wt.join("src")).unwrap();
    std::fs::write(wt.join("src/lib.rs"), "fn main() {}").unwrap();
    for (run, master, keys, tree) in [
        ("run-live", "sess-now", vec!["ISS-1"], wt.clone()),
        (
            "run-gone",
            "sess-now",
            vec!["ISS-2"],
            root.join("wt/removed"),
        ),
        (
            "run-orphan",
            "sess-before",
            vec!["ISS-3"],
            root.join("wt/removed-too"),
        ),
        ("run-park", "sess-now", vec!["ISS-4"], root.join("wt/park")),
    ] {
        led.create_run_group(NewRun {
            run_id: run.into(),
            project_id: ALPHA.into(),
            master_session_id: master.into(),
            worktree_path: tree,
            boot_id: boot.clone(),
            issue_keys: keys.into_iter().map(str::to_string).collect(),
        })
        .unwrap();
        led.bind_agent(run, &format!("agent-{run}")).unwrap();
    }
    led.declare_parked_human("run-park", None, None).unwrap();
    led.note_master(ALPHA, "forge-master-alpha", None, Some("sess-now"), &boot)
        .unwrap();
    drop(led);

    // A job pane stopped on a permission question, as the daemon records it.
    let jobs = cfg.join("pool-jobs");
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    rt.block_on(FileRecords { dir: jobs }.note(&Live {
        job_id: "job-77".into(),
        pane: "forge-job-job-77".into(),
        watch: Watch::Adopted {
            session_id: "s".into(),
        },
        seen: Some(Reported {
            doing: Doing::AwaitingPermission,
            last_event: Event::PermissionRequested,
            at: now_secs() * 1000 - 12 * 60_000,
            prompts: 1,
        }),
        transcript: None,
        opened_at: None,
    }));

    PlantedBox {
        _scratch: scratch,
        root,
        ledger,
        tmux_log,
        daemon,
    }
}

fn top(b: &PlantedBox, args: &[&str]) -> Output {
    let path = format!("{}:/usr/bin:/bin", b.root.join("bin").display());
    Command::new(env!("CARGO_BIN_EXE_forge-runner"))
        .arg("top")
        .args(args)
        .env_clear()
        .env("PATH", path)
        .env("HOME", b.root.join("h"))
        .env("XDG_CONFIG_HOME", b.root.join("c"))
        .env("XDG_DATA_HOME", b.root.join("d"))
        .env("FORGE_RUNNER_CRED_STORE", "file")
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn stamp(p: &Path) -> (Vec<u8>, std::time::SystemTime) {
    (
        std::fs::read(p).unwrap(),
        std::fs::metadata(p).unwrap().modified().unwrap(),
    )
}

fn section<'a>(out: &'a str, name: &str) -> &'a str {
    let at = out
        .find(&format!("\n{name}"))
        .unwrap_or_else(|| panic!("no {name} section:\n{out}"));
    let rest = &out[at + 1..];
    let end = rest[1..].find("\n\n").map(|e| e + 1).unwrap_or(rest.len());
    &rest[..end]
}

/// Criteria 1, 2, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 21, 24, 25, 28.
#[test]
fn one_frame_of_a_planted_box_reads_every_source_and_writes_nothing() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let before = stamp(&b.ledger);

    let out = top(&b, &[]);
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr).into_owned();
    assert!(out.status.success(), "stdout:\n{text}\nstderr:\n{err}");
    assert_eq!(
        text.matches("forge-runner top —").count(),
        1,
        "one frame:\n{text}"
    );
    assert!(text.contains("one frame"), "{text}");

    let binary = section(&text, "BINARY");
    assert!(
        binary.contains(&format!(
            "pid {} serving 0.0.1 (feedface) — NOT the build of this binary",
            b.daemon.id()
        )),
        "{binary}"
    );
    assert!(
        binary.contains(&format!("/proc/{}/exe", b.daemon.id()))
            && binary.contains("still the file on disk"),
        "{binary}"
    );
    // Criterion 21: the daemon line names the record it was read from.
    let daemon_line = binary
        .lines()
        .find(|l| l.trim_start().starts_with("daemon "))
        .unwrap_or_else(|| panic!("no daemon line: {binary}"));
    assert!(
        daemon_line.ends_with(&format!(
            "← {}",
            b.root.join("c/forge-runner/serving.json").display()
        )),
        "{daemon_line}"
    );

    let projects = section(&text, "PROJECTS");
    assert!(
        projects.contains("2 bound")
            && projects.contains("2 served to this box ← GET /api/devices/me/runners"),
        "{projects}"
    );
    assert!(
        projects.contains("forge-master-alpha running"),
        "{projects}"
    );
    assert!(
        projects.contains("forge-master-beta-core not running"),
        "{projects}"
    );
    assert!(
        projects.contains("DRIFT — is NOT the forge-master asset"),
        "{projects}"
    );
    assert!(projects.contains("AFTER its pane started"), "{projects}");
    assert!(
        projects.contains("is the forge-master asset of the binary the daemon runs"),
        "{projects}"
    );
    assert!(
        projects.contains("SLUG DRIFT — the forge CLI here resolves `forge-dev`, and core's slug for the bound project is `alpha`")
            && projects.contains("c/forge/projects/alpha/config.json"),
        "{projects}"
    );
    assert!(
        projects.contains("no forge CLI project record at")
            && projects.contains("projects/beta/config.json"),
        "{projects}"
    );
    assert!(
        projects.contains("ISS-1  run run-live  newest write") && projects.contains("src/lib.rs"),
        "{projects}"
    );
    assert!(
        projects.contains("ISS-2  run run-gone  no worktree on disk at this path"),
        "{projects}"
    );
    assert!(
        projects.contains("1 at awaiting_release (ISS-9), releasable"),
        "{projects}"
    );
    for word in ["agent", "status line", "claude"] {
        let runs: Vec<&str> = projects
            .lines()
            .filter(|l| l.contains("  run run-"))
            .collect();
        assert!(
            runs.iter().all(|l| !l.contains(word)),
            "a run row read `{word}`: {runs:?}"
        );
    }

    let waiting = section(&text, "WAITING ON A PERSON");
    assert!(
        waiting.contains("questions  alpha: 2 open")
            && waiting.contains("human blocker, asked")
            && waiting.contains("Ship the migration?")
            && waiting.contains("Rotate the key?"),
        "{waiting}"
    );
    // Criterion 14: the first line whole, beside the id that answers it.
    assert!(
        waiting.contains(&format!(", question q1: {LONG_PROMPT}"))
            && waiting.contains(", question q2: Rotate the key?"),
        "{waiting}"
    );
    assert!(
        !waiting.contains("It drops a column"),
        "only the prompt's first line: {waiting}"
    );
    assert!(
        waiting.contains("forge-job-job-77 (job job-77) has waited 12m on a permission answer"),
        "{waiting}"
    );
    assert!(
        waiting.contains("parked     ISS-4 run run-park waits on"),
        "{waiting}"
    );
    // Criterion 17: the first blocker to its last sentence, and the rest by code.
    assert!(
        waiting.contains(&format!(
            "alpha: 2 at awaiting_release (ISS-7, ISS-8) with no release path: NO_RELEASE_GATE — {LONG_BLOCKER}"
        )),
        "{waiting}"
    );
    assert!(
        waiting.contains("and 1 more blocker(s): NO_RUNNER_ONLINE"),
        "{waiting}"
    );
    assert!(
        !waiting.contains("ISS-9"),
        "a releasable roster waits on nobody: {waiting}"
    );

    let health = section(&text, "HEALTH");
    assert!(
        health.contains("gate       no degraded or undeclared dispatch recorded ← ")
            && health.contains("gate-marks.jsonl"),
        "{health}"
    );
    assert!(
        health.contains("pool       no failed pool read recorded")
            && health.contains("pool-reads.json"),
        "{health}"
    );
    assert!(health.contains("abandoned  ISS-3 run run-orph still holds its lease(s): declared by master session sess-bef"), "{health}");

    // Criterion 24: the ledger is as it was, byte for byte and stamp for stamp.
    assert!(before == stamp(&b.ledger), "the view wrote the ledger");
    // Criterion 25: tmux was asked to list, and nothing else; core was sent GETs alone.
    let tmux = std::fs::read_to_string(&b.tmux_log).unwrap();
    assert!(tmux.lines().all(|l| l.contains("list-sessions")), "{tmux}");
    let seen = core.seen.lock().unwrap().clone();
    assert!(!seen.is_empty());
    assert!(seen.iter().all(|r| r.starts_with("GET ")), "{seen:#?}");
    assert!(
        seen.iter()
            .filter(|r| r.contains("/api/devices/me/runners"))
            .all(|r| r.contains("Bearer device-tok")),
        "{seen:#?}"
    );
    assert!(
        seen.iter()
            .filter(|r| !r.contains("/api/devices/"))
            .all(|r| r.contains("Bearer pat-tok")),
        "{seen:#?}"
    );
}

/// Criterion 27.
#[test]
fn a_project_list_core_refuses_is_said_to_be_partial() {
    let core = fake_core("401 Unauthorized");
    let b = plant(&core.url);
    let out = top(&b, &["--once"]);
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(out.status.success(), "{text}");
    let projects = section(&text, "PROJECTS");
    assert!(
        projects.contains("UNREADABLE — GET /api/devices/me/runners"),
        "{projects}"
    );
    assert!(
        projects.contains("Listed are only the 2 project(s) bound in"),
        "{projects}"
    );
    assert!(
        projects.contains(
            "core's slug could not be read, so whether that is this project cannot be said"
        ),
        "no slug from core is not a match: {projects}"
    );
    // Whole-set consult at c0d0604, F2: the daemon names a master pane from
    // core's slug alone. With that slug unread, the pane is the one the ledger
    // recorded, or it cannot be named — never `forge-master-<binding key>`.
    assert!(
        projects.contains("master   forge-master-alpha "),
        "the ledger's recorded pane: {projects}"
    );
    assert!(
        projects.contains(
            "master   its pane cannot be named: core's slug for this project is unreadable"
        ),
        "{projects}"
    );
    assert!(
        !projects.contains("forge-master-beta "),
        "a pane guessed from the binding key: {projects}"
    );
}

/// Whole-set consult at c0d0604, F1: no project is claimed only where both
/// sources that name projects were read.
#[test]
fn an_empty_project_list_is_claimed_only_from_sources_read() {
    let core = fake_core("401 Unauthorized");
    let b = plant(&core.url);
    let cfg = b.root.join("c/forge-runner/config.toml");
    std::fs::write(&cfg, format!("core_url = \"{}\"\n", core.url)).unwrap();
    let text = String::from_utf8_lossy(&top(&b, &["--once"]).stdout).into_owned();
    let projects = section(&text, "PROJECTS");
    assert!(
        projects
            .contains("none bound here — PARTIAL: whether core serves this box any cannot be seen"),
        "{projects}"
    );
    assert!(
        !projects.contains("no project is bound here or served to this box"),
        "{projects}"
    );
}

/// Criterion 22, for the sources a box can lose: the ledger, the pool-job
/// directory and a PAT.
#[test]
fn a_source_that_cannot_be_read_is_unreadable_and_never_empty() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    std::fs::write(
        &b.ledger,
        b"not a database, long enough to be taken for one",
    )
    .unwrap();
    let jobs = b.root.join("c/forge-runner/pool-jobs");
    std::fs::remove_dir_all(&jobs).unwrap();
    std::fs::write(&jobs, "a file where a directory belongs").unwrap();
    std::fs::write(
        b.root.join("c/forge-runner/credentials.json"),
        r#"{"device_token":"device-tok"}"#,
    )
    .unwrap();
    let text = String::from_utf8_lossy(&top(&b, &["--once"]).stdout).into_owned();
    assert!(
        text.contains("runs   UNREADABLE — ") && text.contains("ledger.sqlite"),
        "{text}"
    );
    assert!(!text.contains("none holding a lease"), "{text}");
    // The master core names still has a ledger line, saying it was not read.
    assert!(
        text.contains("master   forge-master-alpha running")
            && text.contains("ledger: UNREADABLE — ")
            && text.contains("so when the daemon last placed and saw this master cannot be said"),
        "{text}"
    );
    assert!(text.contains("job panes  UNREADABLE — "), "{text}");
    assert!(
        text.contains("questions  UNREADABLE — ") && text.contains("no personal access token"),
        "{text}"
    );
    assert!(text.contains("abandoned  UNREADABLE — "), "{text}");
    assert!(!text.contains("abandoned  none"), "{text}");
}

/// Criterion 3.
/// Consult whole-set F1: a record the view could not read may be the job that
/// waits, so "none waits" is never all the line says once one is unread.
#[test]
fn no_waiting_job_among_records_partly_unread_is_partial() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let jobs = b.root.join("c/forge-runner/pool-jobs");
    std::fs::remove_file(jobs.join("job-77.json")).unwrap();
    std::fs::write(jobs.join("job-78.json"), "{ half a record").unwrap();
    let text = String::from_utf8_lossy(&top(&b, &["--once"]).stdout).into_owned();
    let waiting = section(&text, "WAITING ON A PERSON");
    assert!(waiting.contains("job-78.json: does not parse"), "{waiting}");
    assert!(
        waiting.contains("job panes  none of the 0 readable record(s) reports waiting — PARTIAL: 1 could not be read"),
        "{waiting}"
    );
    assert!(
        !waiting.contains("none reports waiting on a permission answer"),
        "{waiting}"
    );
}

/// Whole-set consult at 912de89, F1: a project core would not answer is not a
/// project with nothing waiting, so "none" is said only of the ones read.
#[test]
fn none_waiting_is_said_only_of_the_projects_read() {
    let core = fake_core(QUIET_ALPHA_REFUSED_BETA);
    let b = plant(&core.url);
    let text = String::from_utf8_lossy(&top(&b, &["--once"]).stdout).into_owned();
    let waiting = section(&text, "WAITING ON A PERSON");
    assert!(
        waiting.contains("questions  beta: UNREADABLE — GET /api/questions?projectId=")
            && waiting.contains("releases   beta: UNREADABLE — GET /api/projects/"),
        "{waiting}"
    );
    assert!(
        waiting.contains(
            "questions  PARTIAL — 1 of 2 project(s) not read, named above; of the 1 read, none has an open question"
        ),
        "{waiting}"
    );
    assert!(
        waiting.contains("releases   PARTIAL — 1 of 2 project(s) not read, named above; of the 1 read, none rests at awaiting_release without a release path"),
        "{waiting}"
    );
    assert!(
        !waiting.contains("none open on any project listed")
            && !waiting.contains("no issue rests at awaiting_release without a release path"),
        "{waiting}"
    );
}

/// Criterion 22, as the judge planted it at d7da543: core's slug and the
/// ledger both unread. The master line says the ledger was not read, and
/// never that it records no master.
#[test]
fn an_unread_ledger_is_not_read_as_one_recording_no_master() {
    let core = fake_core("401 Unauthorized");
    let b = plant(&core.url);
    std::fs::write(
        &b.ledger,
        b"not a database, long enough to be taken for one",
    )
    .unwrap();
    let text = String::from_utf8_lossy(&top(&b, &["--once"]).stdout).into_owned();
    let projects = section(&text, "PROJECTS");
    assert!(!projects.contains("records no master"), "{projects}");
    assert!(
        projects.contains("its pane cannot be named: core's slug for this project is unreadable, above, and the ledger, which records the pane the daemon placed, is UNREADABLE — ")
            && projects.contains("ledger.sqlite"),
        "{projects}"
    );
}

/// Alpha's skill line: alpha's checkout stands on a skill the daemon's
/// executable does not carry, under a master pane the planted tmux runs.
fn alpha_skill_line(text: &str) -> &str {
    text.lines()
        .find(|l| l.contains("repos/alpha/.claude/skills/forge-master/SKILL.md"))
        .unwrap_or_else(|| panic!("no skill line for alpha:\n{text}"))
}

/// Judge w3's variant `tmux-fails` (finding 53, criterion 22): tmux cannot
/// be asked, so alpha's drifted skill is not said to have no pane on it while
/// its pane runs.
#[test]
fn a_drifted_skill_is_not_called_paneless_when_tmux_cannot_be_asked() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    std::fs::write(
        b.root.join("bin/tmux"),
        "#!/bin/sh\necho 'error connecting to /tmp/tmux-1000/forge (Permission denied)' >&2\nexit 1\n",
    )
    .unwrap();
    let text = String::from_utf8_lossy(&top(&b, &["--once"]).stdout).into_owned();
    let projects = section(&text, "PROJECTS");
    assert!(
        projects.contains("master   forge-master-alpha: UNREADABLE — tmux list-sessions"),
        "{projects}"
    );
    let line = alpha_skill_line(projects);
    assert!(
        line.contains("DRIFT — is NOT the forge-master asset"),
        "{line}"
    );
    assert!(!line.contains("no running master pane is seen"), "{line}");
    assert!(
        line.contains("whether a master pane runs on it cannot be read"),
        "{line}"
    );
}

/// Judge w3's variant `ledger-000-runners-401`: core's project list refused
/// and the ledger unreadable, so the pane cannot even be named, and alpha's
/// drifted skill is still not said to have no pane on it.
#[test]
fn a_drifted_skill_is_not_called_paneless_when_its_pane_cannot_be_named() {
    let core = fake_core("401 Unauthorized");
    let b = plant(&core.url);
    std::fs::write(
        &b.ledger,
        b"not a database, long enough to be taken for one",
    )
    .unwrap();
    let text = String::from_utf8_lossy(&top(&b, &["--once"]).stdout).into_owned();
    let projects = section(&text, "PROJECTS");
    assert!(projects.contains("its pane cannot be named"), "{projects}");
    let line = alpha_skill_line(projects);
    assert!(!line.contains("no running master pane is seen"), "{line}");
    assert!(
        line.contains("whether a master pane runs on it cannot be read"),
        "{line}"
    );
}

/// A terminal for the view to draw on: the child's stdout is the pty's
/// secondary end, sized as asked, and everything drawn is kept.
struct Pty {
    child: Child,
    drawn: Arc<Mutex<Vec<u8>>>,
    /// When each home-and-clear arrived, in order: one per screen drawn.
    cleared: Arc<Mutex<Vec<std::time::Instant>>>,
    /// The primary end, for typing into the view where its stdin is the pty.
    keyboard: std::fs::File,
    /// The secondary end, kept open to read the terminal's modes from.
    secondary: std::fs::File,
}

/// What a home-and-clear is: the start of every screen the view draws.
const CLEAR: &[u8] = b"\x1b[H\x1b[2J";

impl Drop for Pty {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn on_a_terminal(b: &PlantedBox, cols: u16, rows: u16, args: &[&str]) -> Pty {
    on_a_terminal_reading(b, cols, rows, args, false)
}

/// As `on_a_terminal`, and with `keys` the child's stdin is the pty too, so
/// what the test types on `Pty::keyboard` reaches the view as keys.
fn on_a_terminal_reading(b: &PlantedBox, cols: u16, rows: u16, args: &[&str], keys: bool) -> Pty {
    use std::os::fd::FromRawFd;
    // SAFETY: plain libc calls on descriptors this test opens and owns; the
    // secondary's name is copied out of the buffer ptsname_r fills.
    let (primary, secondary) = unsafe {
        let fd = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY);
        assert!(fd >= 0, "posix_openpt");
        assert_eq!(libc::grantpt(fd), 0);
        assert_eq!(libc::unlockpt(fd), 0);
        let mut name = [0 as libc::c_char; 128];
        assert_eq!(libc::ptsname_r(fd, name.as_mut_ptr(), name.len()), 0);
        let path = std::ffi::CStr::from_ptr(name.as_ptr()).to_owned();
        let sec = libc::open(path.as_ptr(), libc::O_RDWR | libc::O_NOCTTY);
        assert!(sec >= 0, "open the secondary");
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        assert_eq!(libc::ioctl(sec, libc::TIOCSWINSZ, &ws), 0);
        (
            std::fs::File::from_raw_fd(fd),
            std::fs::File::from_raw_fd(sec),
        )
    };
    let path = format!("{}:/usr/bin:/bin", b.root.join("bin").display());
    let child = Command::new(env!("CARGO_BIN_EXE_forge-runner"))
        .arg("top")
        .args(args)
        .env_clear()
        .env("PATH", path)
        .env("HOME", b.root.join("h"))
        .env("XDG_CONFIG_HOME", b.root.join("c"))
        .env("XDG_DATA_HOME", b.root.join("d"))
        .env("FORGE_RUNNER_CRED_STORE", "file")
        .stdin(if keys {
            Stdio::from(secondary.try_clone().unwrap())
        } else {
            Stdio::null()
        })
        .stdout(Stdio::from(secondary.try_clone().unwrap()))
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let drawn = Arc::new(Mutex::new(Vec::new()));
    let cleared = Arc::new(Mutex::new(Vec::new()));
    let (sink, stamps) = (Arc::clone(&drawn), Arc::clone(&cleared));
    let keyboard = primary.try_clone().unwrap();
    std::thread::spawn(move || {
        let mut primary = primary;
        let mut buf = [0u8; 8192];
        while let Ok(n) = primary.read(&mut buf) {
            if n == 0 {
                break;
            }
            let mut all = sink.lock().unwrap();
            let before = all.windows(CLEAR.len()).filter(|w| *w == CLEAR).count();
            all.extend_from_slice(&buf[..n]);
            let after = all.windows(CLEAR.len()).filter(|w| *w == CLEAR).count();
            let now = std::time::Instant::now();
            stamps.lock().unwrap().extend((before..after).map(|_| now));
        }
    });
    Pty {
        child,
        drawn,
        cleared,
        keyboard,
        secondary,
    }
}

impl Pty {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.drawn.lock().unwrap()).into_owned()
    }

    /// Every frame drawn in full so far: each runs from one home-and-clear
    /// to the next.
    fn frames(&self) -> Vec<Vec<String>> {
        let text = self.text();
        let parts: Vec<&str> = text.split("\x1b[H\x1b[2J").skip(1).collect();
        let whole = parts.len().saturating_sub(1);
        parts[..whole]
            .iter()
            .filter(|f| !f.contains(READING))
            .map(|f| f.split("\r\n").map(str::to_string).collect())
            .collect()
    }

    fn wait_for(&self, what: &str, within: std::time::Duration) -> bool {
        let until = std::time::Instant::now() + within;
        while std::time::Instant::now() < until {
            if what_is_there(&self.text(), what) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        false
    }

    fn exited_within(&mut self, within: std::time::Duration) -> Option<std::process::ExitStatus> {
        let until = std::time::Instant::now() + within;
        while std::time::Instant::now() < until {
            if let Some(st) = self.child.try_wait().unwrap() {
                return Some(st);
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        None
    }
}

fn what_is_there(text: &str, what: &str) -> bool {
    text.matches(what).count() > 0
}

/// The judge's finding at d7da543: a Ctrl-C sent while a frame was being
/// gathered went to no listener, and the view kept redrawing. Here the second
/// gather is held in a slow `tmux`, the interrupt is sent inside it, and the
/// view must end on it.
#[test]
fn a_ctrl_c_sent_while_a_frame_is_gathered_ends_the_view() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let tmux = b.root.join("bin/tmux");
    let count = b.root.join("tmux.count");
    std::fs::write(
        &tmux,
        format!(
            "#!/bin/sh\nn=$(cat '{c}' 2>/dev/null || echo 0)\necho $((n+1)) > '{c}'\n[ \"$n\" -ge 1 ] && sleep 3\nprintf 'forge-master-alpha\\t{}\\n'\n",
            now_secs() - 3600,
            c = count.display()
        ),
    )
    .unwrap();
    let mut pty = on_a_terminal(&b, 200, 60, &["--interval", "1"]);
    assert!(
        pty.wait_for("WAITING ON A PERSON", std::time::Duration::from_secs(20)),
        "no first frame: {}",
        pty.text()
    );
    // The first frame is drawn; one second of sleep, then the second gather
    // sits three seconds in tmux. Send the interrupt inside that.
    std::thread::sleep(std::time::Duration::from_millis(2_000));
    assert_eq!(
        std::fs::read_to_string(&count).unwrap().trim(),
        "2",
        "the second gather is under way"
    );
    // SAFETY: a signal to the child this test spawned and still holds.
    assert_eq!(
        unsafe { libc::kill(pty.child.id() as libc::pid_t, libc::SIGINT) },
        0
    );
    let st = pty.exited_within(std::time::Duration::from_secs(8));
    assert!(
        st.is_some_and(|s| s.success()),
        "the view did not end on a Ctrl-C sent while it gathered ({st:?})"
    );
}

/// The judge's finding at d7da543: at 120x40 the live frame took 217 rows and
/// only its last 25 stayed on screen. On a screen smaller than the planted
/// box's frame, every frame drawn fits the screen, the pages are said, and
/// the long question reads whole across its wrapped rows.
#[test]
fn a_live_frame_fits_the_screen_it_is_drawn_on_and_pages_the_rest() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let (cols, rows) = (100usize, 20usize);
    let pty = on_a_terminal(&b, cols as u16, rows as u16, &["--interval", "1"]);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut frames = Vec::new();
    // The header wraps by the host's name, so the page row is found, not
    // counted: it is the first row that opens with `page `, and the body
    // starts under the row its sentence ends on.
    let page_row = |f: &[String]| f.iter().position(|l| l.starts_with("page "));
    let body_from = |f: &[String]| {
        f.iter()
            .position(|l| l.ends_with("reads it whole"))
            .map(|i| i + 1)
    };
    let pages_of = |f: &[String]| {
        let l = &f[page_row(f)?];
        l.split(" of ")
            .nth(1)?
            .split(' ')
            .next()?
            .parse::<usize>()
            .ok()
    };
    while std::time::Instant::now() < until {
        frames = pty.frames();
        if frames
            .first()
            .and_then(|f| pages_of(f))
            .is_some_and(|n| frames.len() > n)
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let first = frames
        .first()
        .unwrap_or_else(|| panic!("no frame: {}", pty.text()));
    let pages = pages_of(first).unwrap_or_else(|| panic!("no page row: {first:#?}"));
    assert!(pages > 1, "{first:#?}");
    assert!(
        frames.len() > pages,
        "{} frame(s) for {pages} pages",
        frames.len()
    );
    let mut body = String::new();
    for (i, f) in frames.iter().take(pages).enumerate() {
        assert!(f.len() <= rows, "frame {i} is {} rows: {f:#?}", f.len());
        for l in f {
            assert!(
                l.chars().count() <= cols,
                "a row of {}: {l}",
                l.chars().count()
            );
        }
        let at = page_row(f).unwrap_or_else(|| panic!("no page row: {f:#?}"));
        assert!(
            f[at].starts_with(&format!("page {} of {pages}", i + 1)),
            "{f:#?}"
        );
        // A heading carried onto the page repeats a row of an earlier one.
        let own: Vec<&str> = f[body_from(f).expect("the page row's end")..]
            .iter()
            .map(String::as_str)
            .filter(|l| !l.ends_with(" (continued)"))
            .collect();
        body.push_str(&own.join(" "));
        body.push(' ');
    }
    assert!(
        frames[pages][page_row(&frames[pages]).unwrap()].starts_with(&format!("page 1 of {pages}")),
        "the pages come round: {:#?}",
        frames[pages]
    );
    let words = |t: &str| t.split_whitespace().collect::<Vec<_>>().join(" ");
    for section in ["BINARY", "PROJECTS", "WAITING ON A PERSON", "HEALTH"] {
        assert!(body.contains(section), "{section} is on no page");
    }
    assert!(
        words(&body).contains(&words(&format!("question q1: {LONG_PROMPT}"))),
        "the long question, whole across its rows"
    );
}

/// Judge w3's finding 55, decided: `--once` writes a control character
/// core's text carries out as its escape, as the live screen does, so a
/// prompt cannot clear, retitle or recolour the operator's terminal.
#[test]
fn one_frame_writes_the_control_characters_in_cores_text_out() {
    let core = fake_core(CONTROL_PROMPT);
    let b = plant(&core.url);
    let out = top(&b, &["--once"]);
    assert!(out.status.success());
    assert!(
        !out.stdout.iter().any(|&c| c == 0x1b || c == 0x07),
        "a raw ESC or BEL reached stdout: {:?}",
        String::from_utf8_lossy(&out.stdout)
    );
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(
        text.contains("question q9: \\u{1b}[2J\\u{1b}]0;owned\\u{7}\\u{1b}[31mShip it?\\u{1b}[0m"),
        "{text}"
    );
}

/// Judge w3's finding 57: the first gather takes seconds, and the screen is
/// never blank for them: the header and a reading line are drawn first.
#[test]
fn the_live_view_says_it_is_reading_before_its_first_frame() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    std::fs::write(
        b.root.join("bin/tmux"),
        format!(
            "#!/bin/sh\nsleep 3\nprintf 'forge-master-alpha\\t{}\\n'\n",
            now_secs() - 3600
        ),
    )
    .unwrap();
    let pty = on_a_terminal(&b, 200, 60, &["--interval", "1"]);
    assert!(
        pty.wait_for(READING, std::time::Duration::from_secs(2)),
        "nothing drawn inside two seconds: {:?}",
        pty.text()
    );
    assert!(
        !pty.text().contains("WAITING ON A PERSON"),
        "the reading line came before the frame, not with it"
    );
    assert!(
        pty.text().contains("forge-runner top — "),
        "{:?}",
        pty.text()
    );
    assert!(
        pty.wait_for("WAITING ON A PERSON", std::time::Duration::from_secs(20)),
        "no frame followed: {:?}",
        pty.text()
    );
}

#[test]
fn an_interval_of_nothing_is_refused_naming_the_range() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let out = top(&b, &["--interval", "0"]);
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("1..=3600"), "{err}");
}

/// Criterion 4: `status --watch` is the view, not the stub.
#[test]
fn status_watch_is_the_same_view() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let path = format!("{}:/usr/bin:/bin", b.root.join("bin").display());
    let out = Command::new(env!("CARGO_BIN_EXE_forge-runner"))
        .args(["status", "--watch"])
        .env_clear()
        .env("PATH", path)
        .env("HOME", b.root.join("h"))
        .env("XDG_CONFIG_HOME", b.root.join("c"))
        .env("XDG_DATA_HOME", b.root.join("d"))
        .env("FORGE_RUNNER_CRED_STORE", "file")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let mut text = String::new();
    out.stdout.as_slice().read_to_string(&mut text).unwrap();
    assert!(
        text.contains("forge-runner top —") && text.contains("WAITING ON A PERSON"),
        "{text}"
    );
    assert!(!text.contains("not implemented"), "{text}");
}

/// `forge-runner <args>` in the planted box, as `top` runs there.
fn runner(b: &PlantedBox, args: &[&str]) -> Output {
    let path = format!("{}:/usr/bin:/bin", b.root.join("bin").display());
    Command::new(env!("CARGO_BIN_EXE_forge-runner"))
        .args(args)
        .env_clear()
        .env("PATH", path)
        .env("HOME", b.root.join("h"))
        .env("XDG_CONFIG_HOME", b.root.join("c"))
        .env("XDG_DATA_HOME", b.root.join("d"))
        .env("FORGE_RUNNER_CRED_STORE", "file")
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

/// Criterion 18 (judge r3b, finding 86: the planted box had no marks, so
/// dropping a gate line stayed green). With degraded and undeclared marks of
/// two reasons each, HEALTH holds every line of `forge-runner status`'s gate
/// block, in its order, and no other gate line.
#[test]
fn the_gate_block_is_the_one_status_prints() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    // Half a minute off the minute, so both reads say the same ages.
    let at = |mins: i64| (now_secs() - mins * 60 - 30) * 1000;
    let marks: Vec<String> = [
        (
            "degraded",
            "this pane carries no control capability, so nothing could be asked",
            300,
        ),
        (
            "degraded",
            "this pane carries no control capability, so nothing could be asked",
            200,
        ),
        ("degraded", "the control socket did not answer", 100),
        (
            "undeclared",
            "the run declared no role, so its gate could not be read",
            90,
        ),
        ("undeclared", "the hand-off named no run", 50),
    ]
    .iter()
    .map(|(kind, detail, mins)| {
        format!(
            r#"{{"kind":"{kind}","detail":"{detail}","at":{}}}"#,
            at(*mins)
        )
    })
    .collect();
    std::fs::write(
        b.root.join("c/forge-runner/gate-marks.jsonl"),
        marks.join("\n") + "\n",
    )
    .unwrap();

    let status = String::from_utf8_lossy(&runner(&b, &["status"]).stdout).into_owned();
    let block: Vec<&str> = status
        .lines()
        .skip_while(|l| !l.starts_with("gate"))
        .take_while(|l| !l.starts_with("pool"))
        .collect();
    assert!(
        block.len() > 4
            && block.iter().any(|l| l.contains("degraded   3"))
            && block.iter().any(|l| l.contains("undeclared 2"))
            && block
                .iter()
                .any(|l| l.contains("the control socket did not answer")),
        "status's own gate block: {status}"
    );

    let text = String::from_utf8_lossy(&top(&b, &["--once"]).stdout).into_owned();
    let health = section(&text, "HEALTH");
    let shown: Vec<&str> = health
        .lines()
        .skip_while(|l| !l.starts_with("  gate"))
        .take_while(|l| !l.trim_start().starts_with("← "))
        .collect();
    let wanted: Vec<String> = block.iter().map(|l| format!("  {l}")).collect();
    assert_eq!(shown, wanted, "HEALTH:\n{health}\nstatus:\n{status}");
    assert!(
        health.contains(&format!(
            "← {}",
            b.root.join("c/forge-runner/gate-marks.jsonl").display()
        )),
        "{health}"
    );
}

/// Criterion 2 on a terminal (judge r3b, finding 86: no test ran `--once` on
/// a pty, so a view ignoring it stayed green): one frame, no redraw, exit 0.
#[test]
fn once_on_a_terminal_is_one_frame_and_an_exit() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let mut pty = on_a_terminal(&b, 200, 60, &["--once", "--interval", "1"]);
    let st = pty.exited_within(std::time::Duration::from_secs(30));
    assert!(
        st.is_some_and(|s| s.success()),
        "--once on a terminal did not end ({st:?}): {}",
        pty.text()
    );
    // Whatever was still in flight on the pty when the child ended.
    std::thread::sleep(std::time::Duration::from_millis(300));
    let text = pty.text();
    assert_eq!(text.matches("forge-runner top —").count(), 1, "{text}");
    assert!(text.contains("one frame"), "{text}");
    assert!(pty.cleared.lock().unwrap().is_empty(), "a redraw: {text:?}");
    assert!(text.contains("WAITING ON A PERSON"), "{text}");
}

/// Criterion 1 (judge r3b, finding 86: no test timed a redraw, so a sleep
/// that ignored `--interval` stayed green): on a terminal, frames follow one
/// another `--interval` seconds apart.
#[test]
fn a_live_view_redraws_every_interval_seconds() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let pty = on_a_terminal(&b, 200, 60, &["--interval", "3"]);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
    // The first clear draws the reading line; each after it draws a frame.
    while pty.cleared.lock().unwrap().len() < 5 && std::time::Instant::now() < until {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let at = pty.cleared.lock().unwrap().clone();
    assert!(
        at.len() >= 5,
        "{} screen(s) drawn in 30 s: {}",
        at.len(),
        pty.text()
    );
    let gaps: Vec<f64> = at[1..]
        .windows(2)
        .map(|w| (w[1] - w[0]).as_secs_f64())
        .collect();
    assert!(
        gaps.iter().all(|g| (2.9..3.0 + 5.0).contains(g)),
        "redraws are not 3 s apart: {gaps:?}"
    );
}

/// Criterion 40 (judge r3b, finding 88): with core's port refusing
/// connections, every questions and releases row that could not be read
/// names the cause, as the PROJECTS row does, and none is left saying only
/// that a request could not be sent.
#[test]
fn a_core_that_cannot_be_reached_is_named_by_its_cause_on_every_row() {
    // A port that was just this test's, and now refuses.
    let url = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", l.local_addr().unwrap())
    };
    let b = plant(&url);
    let text = String::from_utf8_lossy(&top(&b, &["--once"]).stdout).into_owned();
    let projects = section(&text, "PROJECTS");
    assert!(projects.contains("could not connect"), "{projects}");
    let waiting = section(&text, "WAITING ON A PERSON");
    let rows: Vec<&str> = waiting
        .lines()
        .filter(|l| l.contains("UNREADABLE — GET /api/"))
        .collect();
    assert!(
        rows.iter().filter(|l| l.contains("questions")).count() == 2
            && rows.iter().filter(|l| l.contains("releases")).count() == 2,
        "{waiting}"
    );
    for row in &rows {
        assert!(
            row.contains("could not connect: ") && !row.contains("error sending request"),
            "{row}"
        );
    }
}
