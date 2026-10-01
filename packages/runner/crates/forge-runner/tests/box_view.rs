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
/// Alpha's issues by status, as core's search buckets carry them.
const ALPHA_BY_STATUS: &str =
    r#"{"in_progress":1,"awaiting_release":2,"open":3,"draft":1,"closed":9}"#;
/// A word the table's column heading carries and the text frame does not.
const TABLE: &str = "VERDICT";

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
    // Each project's issues by status, which the table's lanes sum.
    if path.starts_with(&format!("/api/projects/{ALPHA}/issues/search?")) {
        return ok(format!(
            r#"{{"items":[],"total":16,"buckets":{{"byStatus":{ALPHA_BY_STATUS},"detector":0,"humanDraft":0,"waitingOnPersonByStatus":{{}}}}}}"#
        ));
    }
    if path.starts_with(&format!("/api/projects/{BETA}/issues/search?")) {
        return ok(r#"{"items":[],"total":1,"buckets":{"byStatus":{"awaiting_release":1},"detector":0,"humanDraft":0,"waitingOnPersonByStatus":{}}}"#.into());
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

/// How the planted "daemon" comes to be the process the view reads.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Launch {
    /// `sleep` spawned straight away, as a daemon is.
    Direct,
    /// A shell that waits, then execs `sleep`: the spawn has returned long
    /// before the process becomes the binary the view will read, which is
    /// the interleaving a spawn returning before its exec lands can take
    /// (ubuntu CI runs 36694971625 and 36727168719).
    ExecLate,
}

fn plant(core_url: &str) -> PlantedBox {
    plant_launching(core_url, Launch::Direct)
}

fn plant_launching(core_url: &str, launch: Launch) -> PlantedBox {
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
    let daemon = match launch {
        Launch::Direct => Command::new("sleep").arg("120").spawn().unwrap(),
        Launch::ExecLate => Command::new("sh")
            .args(["-c", "sleep 0.5; exec sleep 120"])
            .spawn()
            .unwrap(),
    };
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
    // A spawn can return while the child is still the image it was forked
    // from: the parent is let go as the exec releases the old memory, before
    // `/proc/<pid>/exe` names the new binary. Read that early, beta's "asset"
    // was the bytes of another program and both skills read DRIFT, on ubuntu,
    // now and then (comment 046ff8a6). So the bytes are read once the process
    // is the binary it will stay.
    let sleep = which::which("sleep")
        .expect("a sleep on PATH")
        .canonicalize()
        .expect("the sleep on PATH resolves");
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let now = std::fs::read_link(format!("/proc/{pid}/exe"));
        if now.as_ref().is_ok_and(|l| *l == sleep) {
            break;
        }
        assert!(
            std::time::Instant::now() < until,
            "the planted daemon {pid} never became {}: /proc/{pid}/exe is {now:?}",
            sleep.display()
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
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

    // ISS-1369 criterion 25: one `lanes` line per project, naming its route.
    assert!(
        projects.contains(&format!("lanes    MOV 1 (in_progress 1) · HAND 2 (awaiting_release 2) · QUE 3 (open 3) · BLK 0 · DRF 1 (draft 1) ← GET /api/projects/{ALPHA}/issues/search?limit=1&withBuckets=true")),
        "{projects}"
    );
    assert!(
        projects.contains(&format!("lanes    MOV 0 · HAND 1 (awaiting_release 1) · QUE 0 · BLK 0 · DRF 0 ← GET /api/projects/{BETA}/issues/search?limit=1&withBuckets=true")),
        "{projects}"
    );

    // Criterion 24: the ledger is as it was, byte for byte and stamp for stamp.
    assert!(before == stamp(&b.ledger), "the view wrote the ledger");
    // Criterion 25: tmux was asked to list, and nothing else; core was sent GETs alone.
    let tmux = std::fs::read_to_string(&b.tmux_log).unwrap();
    assert!(tmux.lines().all(|l| l.contains("list-sessions")), "{tmux}");
    let seen = core.seen.lock().unwrap().clone();
    assert!(!seen.is_empty());
    assert!(seen.iter().all(|r| r.starts_with("GET ")), "{seen:#?}");
    for id in [ALPHA, BETA] {
        assert!(
            seen.iter().any(|r| r.starts_with(&format!(
                "GET /api/projects/{id}/issues/search?limit=1&withBuckets=true "
            )) && r.contains("Bearer pat-tok")),
            "{seen:#?}"
        );
    }
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
    /// The terminal's modes before the view started.
    modes_before: libc::termios,
}

/// The terminal's modes on `tty`.
fn modes(tty: &std::fs::File) -> libc::termios {
    use std::os::fd::AsRawFd;
    // SAFETY: tcgetattr on a descriptor this test holds, into a termios it owns.
    let mut t: libc::termios = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::tcgetattr(tty.as_raw_fd(), &mut t) }, 0);
    t
}

/// The fields of two terminal modes that differ, by name.
fn modes_differ(a: &libc::termios, b: &libc::termios) -> Vec<&'static str> {
    let mut out = Vec::new();
    if a.c_iflag != b.c_iflag {
        out.push("c_iflag");
    }
    if a.c_oflag != b.c_oflag {
        out.push("c_oflag");
    }
    if a.c_cflag != b.c_cflag {
        out.push("c_cflag");
    }
    if a.c_lflag != b.c_lflag {
        out.push("c_lflag");
    }
    if a.c_cc != b.c_cc {
        out.push("c_cc");
    }
    out
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
    on_a_terminal_with(b, cols, rows, args, keys, &[])
}

/// As `on_a_terminal_reading`, with `env` set for the child as well.
fn on_a_terminal_with(
    b: &PlantedBox,
    cols: u16,
    rows: u16,
    args: &[&str],
    keys: bool,
    env: &[(&str, &str)],
) -> Pty {
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
    let modes_before = modes(&secondary);
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
        .envs(env.iter().copied())
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
        modes_before,
    }
}

impl Pty {
    /// Everything drawn, its colour taken out: every `ESC [ … m` goes, and
    /// the home-and-clear that starts each screen stays.
    fn text(&self) -> String {
        uncoloured(&String::from_utf8_lossy(&self.drawn.lock().unwrap()))
    }

    /// Everything drawn, colour and all.
    fn raw(&self) -> String {
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

fn uncoloured(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("\x1b[") {
        out.push_str(&rest[..at]);
        let seq = &rest[at + 2..];
        let end = seq.find(|c: char| !(c.is_ascii_digit() || c == ';'));
        match end {
            Some(e) if seq[e..].starts_with('m') => rest = &seq[e + 1..],
            _ => {
                out.push_str("\x1b[");
                rest = seq;
            }
        }
    }
    out.push_str(rest);
    out
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
        pty.wait_for(TABLE, std::time::Duration::from_secs(20)),
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
/// box's frame, the box's detail (ISS-1369 criterion 22: the whole frame)
/// fits the screen on every page, the pages are said, and the long question
/// reads whole across its wrapped rows.
#[test]
fn a_live_frame_fits_the_screen_it_is_drawn_on_and_pages_the_rest() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let (cols, rows) = (100usize, 20usize);
    let mut pty = on_a_terminal_reading(&b, cols as u16, rows as u16, &["--interval", "1"], true);
    open_the_box(&mut pty);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut frames = Vec::new();
    // The header wraps by the host's name, so the page row is found, not
    // counted: it is the first row that opens with `page `, and the body
    // starts under the row its sentence ends on.
    let page_row = |f: &[String]| f.iter().position(|l| l.starts_with("page "));
    let body_from = |f: &[String]| f.iter().position(|l| l.ends_with(" whole")).map(|i| i + 1);
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
        frames = pty
            .frames()
            .into_iter()
            .filter(|f| page_row(f).is_some())
            .collect();
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
        !pty.text().contains(TABLE),
        "the reading line came before the frame, not with it"
    );
    assert!(
        pty.text().contains("forge-runner top — "),
        "{:?}",
        pty.text()
    );
    assert!(
        pty.wait_for(TABLE, std::time::Duration::from_secs(20)),
        "no frame followed: {:?}",
        pty.text()
    );
}

/// Criteria 3 and 38 (judge r3b, finding 87): every interval outside the
/// range is refused in words an operator reads, never Rust's `1..=3600`,
/// and a negative one is a bad value rather than an unknown flag.
#[test]
fn an_interval_out_of_range_is_refused_naming_the_range_in_words() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    for bad in ["0", "3601", "-1", "abc", "2.5", "99999999999999999999999"] {
        let out = top(&b, &["--interval", bad]);
        assert!(!out.status.success(), "--interval {bad} was taken");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(
            err.contains(&format!("invalid value '{bad}' for '--interval <SECONDS>'"))
                && err.contains("a whole number of seconds from 1 to 3600"),
            "--interval {bad}: {err}"
        );
        assert!(!err.contains("1..=3600"), "--interval {bad}: {err}");
    }
}

/// Criterion 39: `--help` says the range in the same words.
#[test]
fn help_says_the_interval_range_in_words() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let out = top(&b, &["--help"]);
    let help = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{help}");
    let words = help.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        words.contains("--interval <SECONDS>")
            && words.contains("a whole number of seconds from 1 to 3600")
            && words.contains("[default: 5]"),
        "{help}"
    );
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
    // Three seconds and the gather's own time, which on a planted box is a
    // fraction of one: neither the one-second sleep the judge planted nor the
    // five-second default fits (consult on the r4 head, F3).
    assert!(
        gaps.iter().all(|g| (2.9..4.5).contains(g)),
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

impl Pty {
    fn screens_drawn(&self) -> usize {
        self.cleared.lock().unwrap().len()
    }

    /// The page row of each whole screen drawn after the first `after`, the
    /// wrapped row joined back into one line.
    fn page_rows_after(&self, after: usize) -> Vec<String> {
        let text = self.text();
        let parts: Vec<&str> = text.split("\x1b[H\x1b[2J").collect();
        parts
            .iter()
            .skip(after + 1)
            .filter_map(|screen| {
                let rows: Vec<&str> = screen.split("\r\n").collect();
                let from = rows.iter().position(|r| r.starts_with("page "))?;
                let to = rows[from..].iter().position(|r| r.ends_with(" whole"))?;
                Some(
                    rows[from..=from + to]
                        .iter()
                        .map(|r| r.trim())
                        .collect::<Vec<_>>()
                        .join(" "),
                )
            })
            .collect()
    }

    /// Whether a screen drawn after the first `after` has a page row opening
    /// with `what`, waiting up to `within` for one.
    fn draws_page(&self, after: usize, what: &str, within: std::time::Duration) -> bool {
        let until = std::time::Instant::now() + within;
        loop {
            if self
                .page_rows_after(after)
                .iter()
                .any(|r| r.starts_with(what))
            {
                return true;
            }
            if std::time::Instant::now() > until {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    fn type_keys(&mut self, keys: &str) {
        self.keyboard.write_all(keys.as_bytes()).unwrap();
        self.keyboard.flush().unwrap();
    }
}

/// Criteria 32, 33, 34, 35 and 37 (judge r3j, finding 78): on a terminal
/// whose stdin is the terminal, space holds the page across redraws and the
/// page row says so, `n` and `p` turn it at once, space lets pages turn
/// again, and Ctrl-C gives the terminal back the modes it had.
#[test]
fn keys_hold_and_turn_pages_and_the_terminal_is_given_back() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let mut pty = on_a_terminal_reading(&b, 100, 20, &["--interval", "5"], true);
    let second = std::time::Duration::from_secs(1);
    open_the_box(&mut pty);
    assert!(
        pty.draws_page(0, "page 1 of ", std::time::Duration::from_secs(20)),
        "no first page: {}",
        pty.text()
    );
    let first = pty.page_rows_after(0).remove(0);
    let pages: usize = first["page 1 of ".len()..]
        .split(' ')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("{first}"));
    assert!(pages > 3, "{first}");
    assert!(first.contains("space holds, n and p turn"), "{first}");
    let taken = modes(&pty.secondary);
    assert_eq!(
        taken.c_lflag & (libc::ICANON | libc::ECHO),
        0,
        "the view reads keys a byte at a time, unechoed"
    );
    assert_ne!(taken.c_lflag & libc::ISIG, 0, "Ctrl-C still interrupts");

    let at = pty.screens_drawn();
    pty.type_keys(" ");
    let held = format!("page 1 of {pages} HELD until space");
    assert!(
        pty.draws_page(at, &held, second),
        "space: {:?}",
        pty.page_rows_after(at)
    );
    // Two intervals: pages would have turned twice.
    let at = pty.screens_drawn();
    std::thread::sleep(std::time::Duration::from_secs(11));
    let since = pty.page_rows_after(at);
    assert!(since.len() >= 2, "the view kept redrawing: {since:?}");
    assert!(since.iter().all(|r| r.starts_with(&held)), "{since:?}");

    for (key, page) in [("n", 2), ("p", 1), ("p", pages)] {
        let at = pty.screens_drawn();
        pty.type_keys(key);
        let want = format!("page {page} of {pages} HELD until space");
        assert!(
            pty.draws_page(at, &want, second),
            "{key}: {:?}",
            pty.page_rows_after(at)
        );
    }
    let at = pty.screens_drawn();
    pty.type_keys(" ");
    assert!(
        pty.draws_page(at, &format!("page {pages} of {pages} — "), second),
        "space again: {:?}",
        pty.page_rows_after(at)
    );
    assert!(
        pty.draws_page(
            at,
            &format!("page 1 of {pages} — "),
            std::time::Duration::from_secs(8)
        ),
        "pages turn again: {:?}",
        pty.page_rows_after(at)
    );

    // SAFETY: a signal to the child this test spawned and still holds.
    assert_eq!(
        unsafe { libc::kill(pty.child.id() as libc::pid_t, libc::SIGINT) },
        0
    );
    let st = pty.exited_within(std::time::Duration::from_secs(8));
    assert!(st.is_some_and(|s| s.success()), "{st:?}");
    let after = modes(&pty.secondary);
    assert_eq!(
        modes_differ(&pty.modes_before, &after),
        Vec::<&str>::new(),
        "the terminal was not given back its modes"
    );
}

/// ISS-1341's criterion 36 and ISS-1369's 26: with stdin not a terminal,
/// the table says keys are not read, and why, and still redraws.
#[test]
fn a_view_that_cannot_read_keys_says_so_on_its_table() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let pty = on_a_terminal(&b, 100, 30, &["--interval", "1"]);
    assert!(
        pty.wait_for(TABLE, std::time::Duration::from_secs(20)),
        "{}",
        pty.text()
    );
    let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while pty.frames().len() < 2 && std::time::Instant::now() < until {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let frames = pty.frames();
    assert!(frames.len() >= 2, "it redraws: {}", pty.text());
    let words = frames[0]
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        words.contains("keys are not read (stdin is not a terminal), so no row can be opened; the table redraws every 1s"),
        "{words}"
    );
}

/// A tmux that answers at once for the first frame and takes three seconds
/// for every one after it, so a gather can be caught under way.
fn slow_after_the_first_gather(b: &PlantedBox) -> PathBuf {
    let count = b.root.join("tmux.count");
    std::fs::write(
        b.root.join("bin/tmux"),
        format!(
            "#!/bin/sh\nn=$(cat '{c}' 2>/dev/null || echo 0)\necho $((n+1)) > '{c}'\n[ \"$n\" -ge 1 ] && sleep 3\nprintf 'forge-master-alpha\\t{}\\n'\n",
            now_secs() - 3600,
            c = count.display()
        ),
    )
    .unwrap();
    count
}

/// Wait for the table, then press Enter on its first row, the box, whose
/// detail is the whole frame, paged.
fn open_the_box(pty: &mut Pty) {
    assert!(
        pty.wait_for(TABLE, std::time::Duration::from_secs(20)),
        "no table: {}",
        pty.text()
    );
    pty.type_keys("\r");
}

fn first_page_count(pty: &mut Pty) -> usize {
    open_the_box(pty);
    assert!(
        pty.draws_page(0, "page 1 of ", std::time::Duration::from_secs(20)),
        "no first page: {}",
        pty.text()
    );
    let first = pty.page_rows_after(0).remove(0);
    first["page 1 of ".len()..]
        .split(' ')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("{first}"))
}

/// Consult on the r4 head, F2: a key typed while the next frame is being
/// gathered redraws the frame on screen at once, and a page held then is the
/// one the gathered frame is drawn on.
#[test]
fn a_key_typed_while_a_frame_is_gathered_is_answered_at_once() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let count = slow_after_the_first_gather(&b);
    let mut pty = on_a_terminal_reading(&b, 100, 20, &["--interval", "2"], true);
    let pages = first_page_count(&mut pty);
    assert!(pages > 2);
    // The first frame, two seconds, then the second gather sits three
    // seconds in tmux.
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::fs::read_to_string(&count).unwrap_or_default().trim() != "2" {
        assert!(std::time::Instant::now() < until, "no second gather");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let second = std::time::Duration::from_secs(1);
    let at = pty.screens_drawn();
    pty.type_keys("n");
    assert!(
        pty.draws_page(at, &format!("page 2 of {pages} — "), second),
        "n inside a gather: {:?}",
        pty.page_rows_after(at)
    );
    let at = pty.screens_drawn();
    pty.type_keys(" ");
    let held = format!("page 2 of {pages} HELD until space");
    assert!(
        pty.draws_page(at, &held, second),
        "space inside a gather: {:?}",
        pty.page_rows_after(at)
    );
    assert_eq!(
        std::fs::read_to_string(&count).unwrap().trim(),
        "2",
        "both answered inside the one gather"
    );
    // The gathered frame comes on the held page, not the one after it.
    let at = pty.screens_drawn();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(8);
    while pty.screens_drawn() == at && std::time::Instant::now() < until {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    let since = pty.page_rows_after(at);
    assert!(!since.is_empty(), "no frame after the gather");
    assert!(since.iter().all(|r| r.starts_with(&held)), "{since:?}");
}

/// Consult on the r4 head, F1, and the whole-set read at 2b6a996, F1:
/// SIGTERM and SIGQUIT each end a view reading keys through its loop, so the
/// terminal is given back the modes it had; and while it runs, Ctrl-\\ and
/// Ctrl-Z send nothing, and Ctrl-C is still the interrupt.
#[test]
fn a_view_ended_by_a_signal_gives_the_terminal_back() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    for signal in [libc::SIGTERM, libc::SIGQUIT] {
        let mut pty = on_a_terminal_reading(&b, 100, 20, &["--interval", "1"], true);
        first_page_count(&mut pty);
        let taken = modes(&pty.secondary);
        assert_eq!(taken.c_lflag & libc::ICANON, 0, "the view took the input");
        assert_eq!(taken.c_cc[libc::VQUIT], 0, "Ctrl-\\ still quits");
        assert_eq!(taken.c_cc[libc::VSUSP], 0, "Ctrl-Z still stops");
        assert_eq!(
            taken.c_cc[libc::VINTR],
            pty.modes_before.c_cc[libc::VINTR],
            "Ctrl-C is no longer the interrupt"
        );
        // SAFETY: a signal to the child this test spawned and still holds.
        assert_eq!(
            unsafe { libc::kill(pty.child.id() as libc::pid_t, signal) },
            0
        );
        let st = pty.exited_within(std::time::Duration::from_secs(8));
        assert!(st.is_some_and(|s| s.success()), "signal {signal}: {st:?}");
        assert_eq!(
            modes_differ(&pty.modes_before, &modes(&pty.secondary)),
            Vec::<&str>::new(),
            "signal {signal}"
        );
    }
}

/// The box_view flake (ISS-1341 comments fba234f3 and 046ff8a6): the planted
/// daemon's bytes were read the moment its spawn returned, which can be
/// before the process has become `sleep`, so beta's "asset" was the bytes of
/// another binary and both skills read DRIFT. Forced here: the daemon becomes
/// `sleep` half a second after its spawn returns, and beta must still read
/// as the asset of the binary the daemon runs.
#[test]
fn a_daemon_that_becomes_its_binary_late_is_planted_from_that_binary() {
    let core = fake_core("200 OK");
    let b = plant_launching(&core.url, Launch::ExecLate);
    // The view reads the daemon once it is `sleep`, as in CI it read it
    // seconds after the plant.
    let exe = format!("/proc/{}/exe", b.daemon.id());
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !std::fs::read_link(&exe).is_ok_and(|l| l.ends_with("sleep")) {
        assert!(
            std::time::Instant::now() < until,
            "the daemon never became sleep"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let text = String::from_utf8_lossy(&top(&b, &["--once"]).stdout).into_owned();
    let projects = section(&text, "PROJECTS");
    let beta = projects
        .lines()
        .find(|l| l.contains("repos/beta/.claude/skills/forge-master/SKILL.md"))
        .unwrap_or_else(|| panic!("no beta skill line: {projects}"));
    assert!(
        beta.contains("is the forge-master asset of the binary the daemon runs"),
        "{beta}"
    );
}

impl Pty {
    /// Each whole screen drawn after the first `after`, colour taken out.
    fn screens_after(&self, after: usize) -> Vec<String> {
        let text = self.text();
        let parts: Vec<&str> = text.split("\x1b[H\x1b[2J").collect();
        parts
            .iter()
            .skip(after + 1)
            .map(|s| s.to_string())
            .collect()
    }

    /// Whether a screen drawn after the first `after` satisfies `ok`,
    /// waiting up to `within` for one.
    fn draws(&self, after: usize, ok: impl Fn(&str) -> bool, within: std::time::Duration) -> bool {
        let until = std::time::Instant::now() + within;
        loop {
            if self.screens_after(after).iter().any(|s| ok(s)) {
                return true;
            }
            if std::time::Instant::now() > until {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    /// The first whole frame of the table.
    fn first_table(&self) -> Vec<String> {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            if let Some(f) = self
                .frames()
                .into_iter()
                .find(|f| f.iter().any(|l| l.contains(TABLE)))
            {
                return f;
            }
            assert!(
                std::time::Instant::now() < until,
                "no table: {}",
                self.text()
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}

/// The word in a table row's VERDICT column, found under the heading.
fn verdict_of(frame: &[String], row: &str) -> String {
    let heading = frame.iter().find(|l| l.contains(TABLE)).unwrap();
    let at = heading[..heading.find(TABLE).unwrap()].chars().count();
    let line = frame
        .iter()
        .find(|l| l.contains(row))
        .unwrap_or_else(|| panic!("no {row} row: {frame:#?}"));
    line.chars()
        .skip(at)
        .collect::<String>()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string()
}

/// ISS-1369 criteria 1, 2, 6, 7 and 12 on the binary a person runs: the first
/// screen is the table — the box, then alpha, then beta — at 80 and at 170
/// columns no row is wider than the screen and the frame fits its rows, and
/// each row's verdict is whole: the box's job pane waiting on permission,
/// alpha's runnable run whose worktree is gone, beta's served pane down.
#[test]
fn the_table_is_the_first_screen_and_fits_80_and_170_columns() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    for cols in [80usize, 170] {
        let pty = on_a_terminal(&b, cols as u16, 40, &["--interval", "1"]);
        let f = pty.first_table();
        assert!(f.len() <= 40, "{cols}: {} rows: {f:#?}", f.len());
        for l in &f {
            assert!(
                l.chars().count() <= cols,
                "{cols}: a row of {}: {l}",
                l.chars().count()
            );
        }
        let at = |what: &str| {
            f.iter()
                .position(|l| l.contains(what))
                .unwrap_or_else(|| panic!("{cols}: no {what}: {f:#?}"))
        };
        assert!(
            at(TABLE) < at("(box)") && at("(box)") < at(" alpha ") && at(" alpha ") < at(" beta "),
            "{f:#?}"
        );
        assert!(f[at("(box)")].starts_with('>'), "the box is selected first");
        assert_eq!(verdict_of(&f, "(box)"), "ASKS", "{cols}");
        assert_eq!(verdict_of(&f, " alpha "), "STALL", "{cols}");
        assert_eq!(verdict_of(&f, " beta "), "DOWN", "{cols}");
        // Alpha's lanes, as core's buckets counted them.
        let alpha: Vec<&str> = f[at(" alpha ")].split_whitespace().collect();
        // Four runs hold a lease: live, gone, orphaned, and parked on a person.
        assert_eq!(
            &alpha[2..9],
            &["up", "4", "1", "2", "3", "·", "1"],
            "{alpha:?}"
        );
        let under: Vec<&String> = f[at(" alpha ")..at(" beta ")]
            .iter()
            .filter(|l| l.contains("▶"))
            .collect();
        assert_eq!(
            under.len(),
            4,
            "one line a run, the parked one once: {under:#?}"
        );
        // The run whose worktree is gone, on its own line under alpha.
        assert!(
            f[at(" alpha ")..at(" beta ")]
                .iter()
                .any(|l| l.contains("▶ ISS-2 runnable · worktree gone")),
            "{f:#?}"
        );
    }
}

/// ISS-1369 criteria 12, 13, 14 and 15: on a terminal a red row is written
/// red and the selected row reversed; under `NO_COLOR` not one colour escape
/// is written, and the selection still reads `>`.
#[test]
fn colour_marks_severity_on_a_terminal_and_never_under_no_color() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let pty = on_a_terminal(&b, 170, 40, &["--interval", "1"]);
    pty.first_table();
    let raw = pty.raw();
    let line = |what: &str| {
        raw.split("\r\n")
            .find(|l| l.contains(what))
            .unwrap_or_else(|| panic!("no {what}: {raw:?}"))
            .to_string()
    };
    assert!(
        line(" alpha ").starts_with("\x1b[31m "),
        "{:?}",
        line(" alpha ")
    );
    assert!(
        line(" beta ").starts_with("\x1b[33m "),
        "{:?}",
        line(" beta ")
    );
    assert!(line("(box)").contains("\x1b[31;7m>"), "{:?}", line("(box)"));

    let plain = on_a_terminal_with(
        &b,
        170,
        40,
        &["--interval", "1"],
        false,
        &[("NO_COLOR", "1")],
    );
    let f = plain.first_table();
    let raw = plain.raw().replace("\x1b[H\x1b[2J", "");
    assert!(
        !raw.contains('\x1b'),
        "a colour escape under NO_COLOR: {raw:?}"
    );
    assert!(
        f.iter().any(|l| l.starts_with('>') && l.contains("(box)")),
        "{f:#?}"
    );
    assert_eq!(verdict_of(&f, " alpha "), "STALL");
}

/// ISS-1369 criteria 17, 19, 20, 21, 23 and 24 on a terminal: `j` and the
/// down arrow move the selection, Enter opens the selected project's detail
/// with its findings and lanes, Esc returns to the table, `s` shows each
/// row's sources, and `q` ends the view and gives the terminal back.
#[test]
fn keys_select_open_return_show_sources_and_quit() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let mut pty = on_a_terminal_reading(&b, 170, 40, &["--interval", "5"], true);
    pty.first_table();
    let second = std::time::Duration::from_secs(2);
    let selected = |who: &'static str| {
        move |s: &str| {
            s.split("\r\n")
                .any(|l| l.starts_with('>') && l.contains(who))
        }
    };

    let at = pty.screens_drawn();
    pty.type_keys("j");
    assert!(
        pty.draws(at, selected(" alpha "), second),
        "{:?}",
        pty.screens_after(at)
    );

    let at = pty.screens_drawn();
    pty.type_keys("\r");
    let opened = |s: &str| {
        s.contains("DETAIL alpha")
            && s.contains("STALL  ISS-2 run run-gone is runnable and its worktree is gone")
            && s.contains("LANES BY STATUS")
    };
    assert!(pty.draws(at, opened, second), "{:?}", pty.screens_after(at));

    let at = pty.screens_drawn();
    pty.type_keys("\x1b");
    assert!(
        pty.draws(at, |s| s.contains(TABLE) && selected(" alpha ")(s), second),
        "Esc: {:?}",
        pty.screens_after(at)
    );

    let at = pty.screens_drawn();
    pty.type_keys("s");
    assert!(
        pty.draws(
            at,
            |s| s.contains(TABLE) && s.contains("← PANE tmux list-sessions"),
            second
        ),
        "s: {:?}",
        pty.screens_after(at)
    );

    let at = pty.screens_drawn();
    pty.type_keys("\x1b[B");
    assert!(
        pty.draws(at, selected(" beta "), second),
        "down: {:?}",
        pty.screens_after(at)
    );

    pty.type_keys("q");
    let st = pty.exited_within(std::time::Duration::from_secs(8));
    assert!(st.is_some_and(|s| s.success()), "q: {st:?}");
    assert_eq!(
        modes_differ(&pty.modes_before, &modes(&pty.secondary)),
        Vec::<&str>::new(),
        "the terminal was not given back its modes"
    );
}

/// ISS-1369 criterion 28 and judge findings 2 and 5 at e3617a0, on a
/// terminal: at 80x24 the legend is the short one, naming every column and
/// verdict word, so the table keeps its rows; `l` gives every word's meaning
/// and takes it back; at 170x50 the full legend has room from the start. A
/// project's detail opens held, and space lets it turn.
#[test]
fn the_legend_fits_the_screen_and_l_switches_it() {
    let core = fake_core("200 OK");
    let b = plant(&core.url);
    let second = std::time::Duration::from_secs(2);
    let fits = |s: &str, cols: usize, rows: usize| {
        let lines: Vec<&str> = s.trim_end_matches("\r\n").split("\r\n").collect();
        lines.len() <= rows && lines.iter().all(|l| l.chars().count() <= cols)
    };

    // Every column and verdict word, written here rather than read off the
    // view, each the start of an item of a legend row.
    // The cells' own marks are read the same way: `?`, `·` and `—`.
    let columns = [
        "!", "PANE", "RUNS", "MOV", "HAND", "QUE", "BLK", "DRF", "VERDICT", "NOW", "CHANGE", "?",
        "·", "—",
    ];
    let words = [
        "STALL", "ASKS", "DRIFT", "ORPHAN", "NOPATH", "GATE", "DAEMON", "AGEING", "DOWN", "WAITS",
    ];
    let items = |s: &str| -> Vec<String> {
        s.split("\r\n")
            .flat_map(|l| {
                l.trim()
                    .split(" · ")
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .collect()
    };
    let names_every_column = |s: &str| {
        let items = items(s);
        columns
            .iter()
            .all(|c| items.iter().any(|i| i.starts_with(&format!("{c} "))))
    };
    let full = |s: &str| {
        let items = items(s);
        names_every_column(s)
            && words
                .iter()
                .chain(&["ok", "idle"])
                .all(|w| items.iter().any(|i| i.starts_with(&format!("{w} "))))
            && s.contains("l shortens the legend")
    };

    let mut pty = on_a_terminal_reading(&b, 80, 24, &["--interval", "5"], true);
    let f = pty.first_table().join("\r\n");
    assert!(
        names_every_column(&f)
            && f.contains(
                "VERDICT worst: STALL ASKS DRIFT ORPHAN NOPATH GATE DAEMON AGEING DOWN WAITS"
            )
            && f.contains("ok or idle no finding")
            && f.contains("l explains words")
            && !f.contains("STALL a runnable run"),
        "{f}"
    );
    let at = pty.screens_drawn();
    pty.type_keys("l");
    assert!(
        pty.draws(at, |s| full(s) && fits(s, 80, 24), second),
        "l: {:?}",
        pty.screens_after(at)
    );
    let at = pty.screens_drawn();
    pty.type_keys("l");
    assert!(
        pty.draws(
            at,
            |s| s.contains("l explains words") && !full(s) && fits(s, 80, 24),
            second
        ),
        "l again: {:?}",
        pty.screens_after(at)
    );

    let at = pty.screens_drawn();
    pty.type_keys("j\r");
    assert!(
        pty.draws(
            at,
            |s| s.contains("DETAIL alpha") && s.contains("HELD until space"),
            second
        ),
        "a project's detail opens held: {:?}",
        pty.screens_after(at)
    );
    let at = pty.screens_drawn();
    pty.type_keys(" ");
    assert!(
        pty.draws(
            at,
            |s| s.contains("DETAIL alpha") && s.contains("space holds, n and p turn"),
            second
        ),
        "space lets it turn: {:?}",
        pty.screens_after(at)
    );
    pty.type_keys("q");
    let st = pty.exited_within(std::time::Duration::from_secs(8));
    assert!(st.is_some_and(|s| s.success()), "q: {st:?}");

    let pty = on_a_terminal_reading(&b, 170, 50, &["--interval", "5"], true);
    let f = pty.first_table().join("\r\n");
    assert!(full(&f) && fits(&f, 170, 50), "{f}");
}
