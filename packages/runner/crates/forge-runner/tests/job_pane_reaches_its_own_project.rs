//! A job pane's `forge-runner api` reaches its own project with that project's checkout
//! credential, read through the binary. A box serving several projects holds one stored PAT, which
//! a person minted fenced to the projects they pasted it for; a release job for a second project
//! that went out on it was answered `404 project not found` on every route of its own project
//! (sidcorp-mail on sid-xeon-1-dev, 2026-10-27). The pane is started with the environment
//! `terminal::pane_env_in` builds, the same one a master pane is, and the call is answered by a
//! stand-in core that knows each credential's project.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

const FORGE_ID: &str = "d1bb4907-0000-4000-8000-000000000001";
const MAIL_ID: &str = "a417a126-7b96-4b8f-8d83-faa1e7ccbd56";
const BOX_PAT: &str = "forge_pat_box_fenced_to_forge";
const FORGE_CHECKOUT: &str = "forge_pat_checkout_forge";
const MAIL_CHECKOUT: &str = "forge_pat_checkout_mail";

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A core that answers a project's routes to the credential minted for that project, and `404
/// project not found` to any other, as a fenced token is answered.
struct StandInCore {
    url: String,
    seen: Arc<Mutex<Vec<String>>>,
}

fn stand_in_core() -> StandInCore {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                head.push(byte[0]);
            }
            let head = String::from_utf8_lossy(&head).to_string();
            let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
            let bearer = head
                .lines()
                .find_map(|l| {
                    l.strip_prefix("authorization: Bearer ")
                        .or_else(|| l.strip_prefix("Authorization: Bearer "))
                })
                .unwrap_or("")
                .trim()
                .to_string();
            log.lock().unwrap().push(bearer.clone());
            let reaches = match bearer.as_str() {
                MAIL_CHECKOUT => path.contains(MAIL_ID),
                FORGE_CHECKOUT | BOX_PAT => path.contains(FORGE_ID),
                _ => false,
            };
            let (status, body) = if reaches {
                ("200 OK", r#"{"id":"run-1"}"#)
            } else {
                (
                    "404 Not Found",
                    r#"{"error":"project not found","code":"NOT_FOUND"}"#,
                )
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    StandInCore { url, seen }
}

fn write(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

/// A box serving `forge` and `sidcorp-mail`: its stored PAT reaches `forge` alone, and each
/// project's checkout was provisioned with its own credential where `provisioned` names it.
fn a_box(core: &str, provisioned: &[(&str, &str)]) -> (Scratch, PathBuf) {
    let root = std::env::temp_dir().join(format!("frjp-{}", uuid::Uuid::new_v4().simple()));
    let daemon = root.join("xdg/forge-runner");
    write(
        &daemon.join("config.toml"),
        &format!("core_url = \"{core}\"\n"),
    );
    write(
        &daemon.join("credentials.json"),
        &format!(r#"{{"device_token":"forge_pat_device","pat":"{BOX_PAT}"}}"#),
    );
    for (slug, token) in provisioned {
        write(
            &runner_workspace::mcp::config::cli_borrow_path_in(&daemon, slug),
            &format!(r#"{{"url":"{core}","token":"{token}"}}"#),
        );
    }
    std::fs::create_dir_all(root.join("home")).unwrap();
    (Scratch(root), daemon)
}

/// `forge-runner api <path>` run in a pane started for `slug` by the daemon serving `daemon`.
fn in_a_job_pane(root: &Path, daemon: &Path, project_id: &str, slug: &str, path: &str) -> Output {
    let (env, _) = runner_workspace::terminal::pane_env_in(project_id, slug, Some(daemon));
    Command::new(env!("CARGO_BIN_EXE_forge-runner"))
        .args(["api", path])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", root.join("home"))
        .env("FORGE_RUNNER_CRED_STORE", "file")
        .envs(env)
        .current_dir(root)
        .output()
        .unwrap()
}

#[test]
fn a_job_for_the_second_project_calls_it_with_that_projects_credential() {
    let core = stand_in_core();
    let (root, daemon) = a_box(
        &core.url,
        &[("forge", FORGE_CHECKOUT), ("sidcorp-mail", MAIL_CHECKOUT)],
    );
    let out = in_a_job_pane(
        &root.0,
        &daemon,
        MAIL_ID,
        "sidcorp-mail",
        &format!("projects/{MAIL_ID}/release-batches/run-1"),
    );
    let seen = core.seen.lock().unwrap().clone();
    assert!(
        out.status.success(),
        "a release job for sidcorp-mail was refused on its own project: {}\nsent: {}",
        String::from_utf8_lossy(&out.stderr),
        describe(&seen)
    );
    assert_eq!(
        seen,
        vec![MAIL_CHECKOUT.to_string()],
        "the call went out on {}, not on sidcorp-mail's checkout credential",
        describe(&seen)
    );
}

#[test]
fn a_job_whose_checkout_holds_no_credential_names_the_one_it_went_out_on() {
    let core = stand_in_core();
    let (root, daemon) = a_box(&core.url, &[("forge", FORGE_CHECKOUT)]);
    let out = in_a_job_pane(
        &root.0,
        &daemon,
        MAIL_ID,
        "sidcorp-mail",
        &format!("projects/{MAIL_ID}/release-batches/run-1"),
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(5), "{err}");
    assert!(
        !core
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|t| t == FORGE_CHECKOUT),
        "another project's checkout credential was sent for sidcorp-mail"
    );
    assert!(
        err.contains("this box's stored personal access token")
            && err.contains(&daemon.join("credentials.json").display().to_string()),
        "a refusal does not say which credential the call went out on: {err}"
    );
    assert!(
        !err.contains(BOX_PAT),
        "the refusal printed the token: {err}"
    );
}

fn describe(seen: &[String]) -> String {
    let names: Vec<&str> = seen
        .iter()
        .map(|t| match t.as_str() {
            BOX_PAT => "the box's stored PAT (fenced to forge)",
            FORGE_CHECKOUT => "forge's checkout credential",
            MAIL_CHECKOUT => "sidcorp-mail's checkout credential",
            _ => "an unknown credential",
        })
        .collect();
    format!("{names:?}")
}
