//! Real scripts in a real bubblewrap sandbox on this box: what a computation can do, and what
//! it cannot reach.

use super::*;
use crate::confine::{availability, Availability};

fn bwrap_or_skip(test: &str) -> bool {
    match availability() {
        Availability::Available => true,
        Availability::Unavailable(why) => match std::env::var("FORGE_TEST_SKIP_BWRAP") {
            Ok(v) if v == "1" => {
                eprintln!(
                    "SKIPPED {test}: this box cannot confine ({why}) and FORGE_TEST_SKIP_BWRAP=1 \
                     opted this run out — nothing was asserted"
                );
                false
            }
            _ => panic!(
                "BWRAP_UNAVAILABLE: {test} needs bubblewrap to start a sandbox ({why}) — install \
                 it, or set FORGE_TEST_SKIP_BWRAP=1 to skip it by name"
            ),
        },
    }
}

fn request(language: Language, script: &str, wall_ms: u64) -> Request {
    Request {
        language,
        script: script.into(),
        inputs: serde_json::json!([{ "fields": [{ "name": "n", "type": "number", "label": "N" }],
                                     "rows": [{ "n": 2 }, { "n": 5 }] }]),
        limits: Limits {
            wall_ms,
            cpu: 1.0,
            memory_mb: 512,
            output_bytes: 256_000,
        },
    }
}

#[tokio::test]
async fn a_python_script_reads_its_inputs_and_hands_back_frames_json() {
    if !bwrap_or_skip("a_python_script_reads_its_inputs_and_hands_back_frames_json") {
        return;
    }
    let script = r#"
import json
frames = json.load(open("inputs.json"))
total = sum(r["n"] for r in frames[0]["rows"])
json.dump({"frames": [{"fields": [{"name": "total", "type": "number", "label": "Total"}],
                       "rows": [{"total": total}]}]}, open("frames.json", "w"))
print("summed", total)
import os
print(os.getcwd())
"#;
    let answer = run(&request(Language::Python, script, 20_000))
        .await
        .expect("it runs");
    assert_eq!(answer.exit, 0, "{answer:?}");
    assert_eq!(answer.stopped, None);
    let mut lines = answer.stdout.lines();
    assert_eq!(lines.next(), Some("summed 7"));
    let workdir = PathBuf::from(lines.next().expect("the script printed where it ran"));
    let output = answer.output.expect("frames.json came back");
    assert_eq!(output.file, "frames.json");
    let frames: serde_json::Value = serde_json::from_str(&output.text).unwrap();
    assert_eq!(frames["frames"][0]["rows"][0]["total"], 7);
    assert!(
        workdir.starts_with(std::env::temp_dir()) && !workdir.exists(),
        "the working directory {} is removed",
        workdir.display()
    );
}

#[tokio::test]
async fn a_bash_script_hands_back_frames_csv() {
    if !bwrap_or_skip("a_bash_script_hands_back_frames_csv") {
        return;
    }
    let answer = run(&request(
        Language::Bash,
        "printf 'team,done\\nweb,3\\n' > frames.csv",
        20_000,
    ))
    .await
    .expect("it runs");
    assert_eq!(answer.exit, 0, "{answer:?}");
    assert_eq!(
        answer.output,
        Some(Output {
            file: "frames.csv",
            text: "team,done\nweb,3\n".into()
        })
    );
}

#[tokio::test]
async fn a_script_that_tries_the_network_fails_inside_and_nothing_leaves() {
    if !bwrap_or_skip("a_script_that_tries_the_network_fails_inside_and_nothing_leaves") {
        return;
    }
    // a listener on this box's own loopback: a sandbox sharing the box's network reaches it
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let script = format!(
        r#"
import socket
for target in [("127.0.0.1", {port}), ("1.1.1.1", 80)]:
    try:
        socket.create_connection(target, timeout=3).sendall(b"leaked")
        print("REACHED", target)
    except OSError as e:
        print("BLOCKED", target, type(e).__name__)
try:
    socket.getaddrinfo("example.com", 443)
    print("RESOLVED")
except OSError as e:
    print("NO_DNS", type(e).__name__)
"#
    );
    let answer = run(&request(Language::Python, &script, 20_000))
        .await
        .expect("it runs");
    assert_eq!(answer.exit, 0, "{answer:?}");
    assert!(!answer.stdout.contains("REACHED"), "{}", answer.stdout);
    assert!(!answer.stdout.contains("RESOLVED"), "{}", answer.stdout);
    assert!(
        answer
            .stdout
            .contains(&format!("BLOCKED ('127.0.0.1', {port})")),
        "{}",
        answer.stdout
    );
    assert!(answer.stdout.contains("NO_DNS"), "{}", answer.stdout);
    assert!(
        matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock),
        "a connection reached the box's own loopback"
    );
}

#[tokio::test]
async fn the_box_files_are_not_in_view_and_the_system_is_read_only() {
    if !bwrap_or_skip("the_box_files_are_not_in_view_and_the_system_is_read_only") {
        return;
    }
    let home = PathBuf::from(std::env::var_os("HOME").expect("HOME"));
    let canary = std::env::temp_dir().join(format!("forge-compute-canary-{}", std::process::id()));
    std::fs::write(&canary, "box secret").unwrap();
    let script = format!(
        "cat {canary} 2>/dev/null && echo SAW_TMP; \
         find {home} -not -type d -not -path \"$PWD/*\" 2>/dev/null | wc -l; \
         touch /usr/forge-written 2>/dev/null && echo WROTE_USR; env | sort",
        canary = canary.display(),
        home = home.display()
    );
    let answer = run(&request(Language::Bash, &script, 20_000))
        .await
        .expect("it runs");
    let _ = std::fs::remove_file(&canary);
    assert!(!answer.stdout.contains("box secret"), "{}", answer.stdout);
    assert!(!answer.stdout.contains("SAW_TMP"), "{}", answer.stdout);
    assert!(!answer.stdout.contains("WROTE_USR"), "{}", answer.stdout);
    let lines: Vec<&str> = answer.stdout.lines().collect();
    assert_eq!(
        lines.first().map(|l| l.trim()),
        Some("0"),
        "nothing of the home but the working directory: {lines:?}"
    );
    let env: Vec<&str> = lines[1..].to_vec();
    assert!(
        env.iter().all(|l| [
            "PATH=", "LANG=", "LC_ALL=", "PYTHON", "HOME=", "TMPDIR=", "PWD=", "SHLVL=", "_="
        ]
        .iter()
        .any(|p| l.starts_with(p))),
        "only the listed environment: {env:?}"
    );
}

#[tokio::test]
async fn a_script_past_its_wall_limit_is_stopped_and_named() {
    if !bwrap_or_skip("a_script_past_its_wall_limit_is_stopped_and_named") {
        return;
    }
    let started = std::time::Instant::now();
    let answer = run(&request(
        Language::Bash,
        "echo start; sleep 30; echo late > frames.csv",
        500,
    ))
    .await
    .expect("it runs");
    assert_eq!(answer.stopped, Some("wallMs"), "{answer:?}");
    assert_eq!(answer.output, None);
    assert_eq!(answer.stdout, "start\n");
    assert!(started.elapsed().as_secs() < 10, "{:?}", started.elapsed());
}

#[tokio::test]
async fn a_script_past_its_cpu_time_is_stopped_and_named() {
    if !bwrap_or_skip("a_script_past_its_cpu_time_is_stopped_and_named") {
        return;
    }
    let mut req = request(Language::Python, "while True:\n    pass\n", 8_000);
    req.limits.cpu = 0.1;
    let answer = run(&req).await.expect("it runs");
    assert_eq!(answer.stopped, Some("cpu"), "{answer:?}");
    assert!(answer.duration_ms < 7_000, "{answer:?}");
}

#[tokio::test]
async fn a_script_past_its_memory_cannot_allocate_it() {
    if !bwrap_or_skip("a_script_past_its_memory_cannot_allocate_it") {
        return;
    }
    let mut req = request(
        Language::Python,
        "x = bytearray(512 * 1024 * 1024)\nprint('allocated')",
        20_000,
    );
    req.limits.memory_mb = 128;
    let answer = run(&req).await.expect("it runs");
    assert_ne!(answer.exit, 0, "{answer:?}");
    assert!(!answer.stdout.contains("allocated"), "{answer:?}");
    assert!(answer.stderr.contains("MemoryError"), "{answer:?}");
}

#[tokio::test]
async fn a_frames_file_that_is_a_link_is_refused_never_followed() {
    if !bwrap_or_skip("a_frames_file_that_is_a_link_is_refused_never_followed") {
        return;
    }
    let err = run(&request(
        Language::Bash,
        "ln -s /etc/passwd frames.json",
        20_000,
    ))
    .await
    .expect_err("a link is refused");
    assert!(err.contains("frames.json is not a plain file"), "{err}");
    assert!(!err.contains("root:"), "{err}");
}

#[tokio::test]
async fn a_request_past_what_this_box_runs_is_refused_by_name() {
    let mut req = request(Language::Bash, "true", 0);
    assert_eq!(
        run(&req).await.unwrap_err(),
        "this box refuses the request: limits.wallMs 0 is outside 1..=120000"
    );
    req.limits.wall_ms = 1000;
    req.inputs = serde_json::json!({ "not": "frames" });
    assert_eq!(
        run(&req).await.unwrap_err(),
        "this box refuses the request: inputs is not an array of frames"
    );
}

#[test]
fn the_caps_line_sets_every_cap_before_it_becomes_the_interpreter() {
    let limits = Limits {
        wall_ms: 30_000,
        cpu: 1.0,
        memory_mb: 512,
        output_bytes: 256_000,
    };
    assert_eq!(
        caps_line(&limits),
        "ulimit -v 524288 && ulimit -S -t 30 && ulimit -H -t 31 && ulimit -f 1064 && exec \"$@\""
    );
    assert_eq!(stopped_by(128 + 24), Some("cpu"));
    assert_eq!(stopped_by(128 + 25), Some("outputBytes"));
    assert_eq!(stopped_by(1), None);
}
