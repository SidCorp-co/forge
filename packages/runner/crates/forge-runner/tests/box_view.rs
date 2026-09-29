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
const BETA: &str = "22222222-2222-4222-8222-222222222222";

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

fn answer(path: &str, runners_status: &str) -> (String, String) {
    let ok = |b: String| ("200 OK".to_string(), b);
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
    // page lists less than core holds.
    if path.starts_with(&format!("/api/questions?projectId={ALPHA}")) && path.contains("&cursor=c2")
    {
        return ok(r#"{"questions":[{"id":"q2","blockerKind":"human","createdAt":"2026-09-30T01:10:00.000Z","prompt":"Rotate the key?"}],"total":1,"hasMore":false,"nextCursor":null}"#.into());
    }
    if path.starts_with(&format!("/api/questions?projectId={ALPHA}")) {
        return ok(r#"{"questions":[{"id":"q1","blockerKind":"human","createdAt":"2026-09-30T01:00:00.000Z","prompt":"Ship the migration?\nIt drops a column."}],"total":1,"hasMore":true,"nextCursor":"c2"}"#.into());
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
        return ok(r#"{"hasReleaseGate":false,"blockers":[{"code":"NO_RELEASE_GATE","httpStatus":409,"message":"This project has no release step","evaluated":true}],"warnings":[]}"#.into());
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
    assert!(waiting.contains("alpha: 2 at awaiting_release (ISS-7, ISS-8) with no release path: NO_RELEASE_GATE — This project has no release step"), "{waiting}");
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
    assert!(text.contains("job panes  UNREADABLE — "), "{text}");
    assert!(
        text.contains("questions  UNREADABLE — ") && text.contains("no personal access token"),
        "{text}"
    );
    assert!(text.contains("abandoned  UNREADABLE — "), "{text}");
    assert!(!text.contains("abandoned  none"), "{text}");
}

/// Criterion 3.
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
