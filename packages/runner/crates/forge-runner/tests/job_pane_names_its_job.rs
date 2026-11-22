//! A job pane's `forge-runner api` names the job it acts for, read through the binary (ISS-1410).
//! dev.789's release attempts 38611445 and d80cba45 were failed while their panes stood and the
//! next attempt was handed the same run; core could refuse neither's acts, because no call from a
//! job pane said which job made it. The box sets `$FORGE_JOB` in each job pane, and every call
//! goes out with `x-forge-job`, which core reads on a release run's acts.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::mpsc;

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A core answering one call with `{}`, handing back the request head it read.
fn one_call_core() -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
            head.push(byte[0]);
        }
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        );
        let _ = tx.send(String::from_utf8_lossy(&head).to_string());
    });
    (url, rx)
}

/// `forge-runner api` run with `job` as `$FORGE_JOB`, where it names one, against `core`.
fn api_call(core: &str, job: Option<&str>) -> (Output, Scratch) {
    let root = std::env::temp_dir().join(format!("frjn-{}", uuid::Uuid::new_v4().simple()));
    let daemon = root.join("xdg/forge-runner");
    std::fs::create_dir_all(&daemon).unwrap();
    std::fs::write(
        daemon.join("config.toml"),
        format!("core_url = \"{core}\"\n"),
    )
    .unwrap();
    std::fs::create_dir_all(root.join("home")).unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_forge-runner"));
    cmd.args(["api", "projects/p-1/release-batches/r-1/method", "-d", "{}"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", root.join("home"))
        .env("XDG_CONFIG_HOME", root.join("xdg"))
        .env("FORGE_RUNNER_CRED_STORE", "file")
        .env("FORGE_PAT", "forge_pat_person")
        .env("FORGE_PROJECT_SLUG", "forge");
    if let Some(system_root) = std::env::var_os("SYSTEMROOT") {
        cmd.env("SYSTEMROOT", system_root);
    }
    if let Some(job) = job {
        cmd.env("FORGE_JOB", job);
    }
    let out = cmd.current_dir(&root).output().unwrap();
    (out, Scratch(root))
}

fn job_header(head: &str) -> Vec<String> {
    head.lines()
        .filter_map(|l| l.split_once(':'))
        .filter(|(k, _)| k.trim().eq_ignore_ascii_case("x-forge-job"))
        .map(|(_, v)| v.trim().to_string())
        .collect()
}

#[test]
fn a_call_from_a_job_pane_names_its_job_and_one_from_elsewhere_names_none() {
    let job = "d80cba45-0000-4000-8000-000000000002";
    let (core, head) = one_call_core();
    let (out, _root) = api_call(&core, Some(job));
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let head = head.recv().unwrap();
    assert_eq!(job_header(&head), vec![job], "{head}");

    let (core, head) = one_call_core();
    let (out, _root) = api_call(&core, None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let head = head.recv().unwrap();
    assert!(job_header(&head).is_empty(), "{head}");
}
