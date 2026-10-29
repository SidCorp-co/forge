//! An owner-mode channel agent runs confined to its own clone and its own repository (ISS-765,
//! REQ-77): it commits and pushes to that repository with a credential core mints for it alone,
//! and reaches nothing else the box keeps.
//!
//! The box is planted: the `forge` CLI's account, the runner's device token, an SSH key, `gh`'s
//! login, and a `forge-ops` command whose credential sits in another project's `.mcp.json` and whose
//! host answers ops calls. Three servers stand on the box's loopback: a fake core that mints a
//! credential for the project's own repository and refuses every other, a git smart-HTTP server
//! holding that repository and another, and the ops host. The session is spawned as this runner
//! spawns an owner-mode agent, through this build's own egress bridge and `git-credential
//! --session` helper, and runs a shell that tries each of them.
#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use runner_agent::claude_code::own_testkit::{run, OwnBox};
use runner_platform::confine::egress::REFUSAL;
use runner_platform::confine::{availability, Availability};

const TURN: &str = "TURN-TOKEN-own";
const PROJECT: &str = "11111111-2222-3333-4444-555555555555";
const GRANT: &str = "OWN-REPO-GRANT";

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

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

fn write(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

fn executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git did not run");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn head_of(repo: &Path, branch: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args([
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// One request read off `conn`: method, path (an absolute-form target reduced to its path),
/// headers, and body (by `Content-Length`, or chunked).
struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

fn read_request(conn: &TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(conn.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let mut target = parts.next()?.to_string();
    if let Some(rest) = target.strip_prefix("http://") {
        target = rest.find('/').map_or("/".into(), |i| rest[i..].to_string());
    }
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        reader.read_line(&mut h).ok()?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let find = |n: &str| {
        headers
            .iter()
            .find(|(k, _): &&(String, String)| k.eq_ignore_ascii_case(n))
            .map(|(_, v)| v.clone())
    };
    let mut body = Vec::new();
    if let Some(len) = find("content-length").and_then(|v| v.parse::<usize>().ok()) {
        body.resize(len, 0);
        reader.read_exact(&mut body).ok()?;
    } else if find("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) {
        loop {
            let mut size = String::new();
            reader.read_line(&mut size).ok()?;
            let n = usize::from_str_radix(size.trim().split(';').next()?, 16).ok()?;
            let mut chunk = vec![0; n + 2];
            reader.read_exact(&mut chunk).ok()?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..n]);
        }
    }
    Some(Request {
        method,
        path: target,
        headers,
        body,
    })
}

fn reply(mut conn: &TcpStream, status: &str, headers: &[(&str, &str)], body: &[u8]) {
    let mut head = format!("HTTP/1.1 {status}\r\n");
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    ));
    let _ = conn.write_all(head.as_bytes());
    let _ = conn.write_all(body);
}

/// Serve `listener` on a thread, one request per connection.
fn serve(listener: TcpListener, handle: impl Fn(&TcpStream, Request) + Send + 'static) {
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            if let Some(req) = read_request(&conn) {
                handle(&conn, req);
            }
        }
    });
}

fn base64(input: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// A fake core: the session's git credential for the project's own repository, under the
/// session's turn token; every other repository refused, as core refuses it.
fn fake_core(asks: Arc<Mutex<Vec<String>>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.3:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    serve(listener, move |conn, req| {
        let route = format!("/api/projects/{PROJECT}/support/session/git-credential");
        let authed = req.header("authorization") == Some(&format!("Bearer {TURN}"));
        if req.method != "POST" || req.path != route || !authed {
            asks.lock()
                .unwrap()
                .push(format!("REFUSED {} {}", req.method, req.path));
            return reply(conn, "401 Unauthorized", &[], b"{}");
        }
        let ask: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
        let path = ask["path"].as_str().unwrap_or_default().to_string();
        asks.lock().unwrap().push(path.clone());
        if path.trim_end_matches(".git") == "org/own" {
            let body = serde_json::json!({
                "username": "x-access-token",
                "password": GRANT,
                "expiresAt": "2099-01-01T00:00:00.000Z",
            });
            reply(
                conn,
                "200 OK",
                &[("Content-Type", "application/json")],
                body.to_string().as_bytes(),
            );
        } else {
            let body = serde_json::json!({
                "code": "SUPPORT_GIT_NOT_OWN_REPO",
                "detail": "not the repository this project binds",
            });
            reply(
                conn,
                "403 Forbidden",
                &[("Content-Type", "application/json")],
                body.to_string().as_bytes(),
            );
        }
    });
    port
}

/// A git smart-HTTP server over `root`, through `git http-backend`, answering only a request
/// carrying the credential core minted.
fn git_server(root: PathBuf) -> u16 {
    let listener = TcpListener::bind("127.0.0.2:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let expected = format!(
        "Basic {}",
        base64(format!("x-access-token:{GRANT}").as_bytes())
    );
    serve(listener, move |conn, req| {
        if req.header("authorization") != Some(expected.as_str()) {
            return reply(
                conn,
                "401 Unauthorized",
                &[("WWW-Authenticate", "Basic realm=\"own\"")],
                b"",
            );
        }
        let (path, query) = req.path.split_once('?').unwrap_or((&req.path, ""));
        let mut cgi = std::process::Command::new("git");
        cgi.arg("http-backend")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("GIT_PROJECT_ROOT", &root)
            .env("GIT_HTTP_EXPORT_ALL", "1")
            .env("PATH_INFO", path)
            .env("QUERY_STRING", query)
            .env("REQUEST_METHOD", &req.method)
            .env("REMOTE_USER", "x-access-token")
            .env("REMOTE_ADDR", "127.0.0.1")
            .env("CONTENT_LENGTH", req.body.len().to_string())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped());
        for (header, var) in [
            ("content-type", "CONTENT_TYPE"),
            ("content-encoding", "HTTP_CONTENT_ENCODING"),
            ("git-protocol", "GIT_PROTOCOL"),
        ] {
            if let Some(v) = req.header(header) {
                cgi.env(var, v);
            }
        }
        let mut child = cgi.spawn().expect("git http-backend runs");
        let _ = child.stdin.take().unwrap().write_all(&req.body);
        let out = child.wait_with_output().unwrap();
        let split = out
            .stdout
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| (i, 4))
            .or_else(|| {
                out.stdout
                    .windows(2)
                    .position(|w| w == b"\n\n")
                    .map(|i| (i, 2))
            });
        let Some((at, gap)) = split else {
            return reply(conn, "500 Internal Server Error", &[], &out.stdout);
        };
        let head = String::from_utf8_lossy(&out.stdout[..at]).into_owned();
        let mut status = "200 OK".to_string();
        let mut headers: Vec<(String, String)> = Vec::new();
        for line in head.lines() {
            if let Some((k, v)) = line.split_once(':') {
                if k.eq_ignore_ascii_case("status") {
                    status = v.trim().to_string();
                } else {
                    headers.push((k.trim().to_string(), v.trim().to_string()));
                }
            }
        }
        let headers: Vec<(&str, &str)> = headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        reply(conn, &status, &headers, &out.stdout[at + gap..]);
    });
    port
}

/// The ops host `forge-ops` calls: answers every request it gets, and counts them.
fn ops_host(hits: Arc<Mutex<usize>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.4:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    serve(listener, move |conn, _| {
        *hits.lock().unwrap() += 1;
        reply(conn, "200 OK", &[], b"OPS-REACHED");
    });
    port
}

/// Every planted credential, by marker: what it is and where the box keeps it, under its home.
const PLANTED: &[(&str, &str, &str)] = &[
    (
        "LEAK-forge-cli-account",
        "the `forge` CLI's account",
        ".config/forge/config.json",
    ),
    (
        "LEAK-device-token",
        "the runner's device token",
        ".config/forge-runner/credentials.json",
    ),
    (
        "LEAK-ssh-key",
        "the SSH key git pushes with",
        ".ssh/id_ed25519",
    ),
    (
        "LEAK-gh-token",
        "`gh`'s GitHub token",
        ".config/gh/hosts.yml",
    ),
];

/// The box: every credential it keeps, and `forge-ops` with its credential in another project.
/// Its runner config names the fake core; the session's MCP config and that config are returned.
fn plant_box(home: &Path, ops_port: u16, core_port: u16) -> (PathBuf, PathBuf) {
    for (marker, _, at) in PLANTED {
        write(&home.join(at), marker);
    }
    let ops_mcp = home.join("projects/adminhub/.mcp.json");
    write(
        &ops_mcp,
        &format!(
            "{{\"mcpServers\":{{\"forge-ops\":{{\"url\":\"http://127.0.0.4:{ops_port}/mcp\",\
             \"headers\":{{\"Authorization\":\"Bearer LEAK-forge-ops-token\"}}}}}}}}"
        ),
    );
    let forge_ops = home.join(".local/bin/forge-ops");
    write(
        &forge_ops,
        &format!(
            "#!/bin/sh\n# forge-ops: one ops call, its credential read from another project\n\
             token=$(grep -o 'LEAK-[a-z-]*' '{mcp}') || {{ echo \"forge-ops: no forge-ops entry in {mcp}\" >&2; exit 1; }}\n\
             curl -sS --max-time 10 -H \"Authorization: Bearer $token\" http://127.0.0.4:{ops_port}/mcp\n",
            mcp = ops_mcp.display()
        ),
    );
    executable(&forge_ops);
    let runner_config = home.join(".config/forge-runner/config.toml");
    write(
        &runner_config,
        &format!("core_url = \"http://127.0.0.3:{core_port}\"\n"),
    );
    let mcp = home.join(".config/forge-runner/mcp/forge-mcp-p-own.json");
    write(&mcp, "{}");
    (mcp, runner_config)
}

/// The repository and another on the git server, and the agent's own clone of the first, whose
/// origin is the server: the server's root, the clone, and the server's port.
fn plant_repos(root: &Path) -> (PathBuf, PathBuf, u16) {
    let srv = root.join("srv");
    let seed = root.join("seed");
    std::fs::create_dir_all(srv.join("org")).unwrap();
    std::fs::create_dir_all(&seed).unwrap();
    for name in ["own.git", "other.git"] {
        git(
            &srv.join("org"),
            &["init", "-q", "--bare", "-b", "dev", name],
        );
    }
    git(&seed, &["init", "-q", "-b", "dev"]);
    write(&seed.join("README"), "the project\n");
    git(&seed, &["add", "README"]);
    git(
        &seed,
        &[
            "-c",
            "user.name=Seed",
            "-c",
            "user.email=seed@example.test",
            "commit",
            "-q",
            "-m",
            "seed",
        ],
    );
    for name in ["own.git", "other.git"] {
        let to = srv.join("org").join(name);
        git(&seed, &["push", "-q", to.to_str().unwrap(), "dev"]);
    }
    let git_port = git_server(srv.clone());
    let clone = root.join("clone");
    git(
        root,
        &[
            "clone",
            "-q",
            "-b",
            "dev",
            srv.join("org/own.git").to_str().unwrap(),
            "clone",
        ],
    );
    let origin = format!("http://127.0.0.2:{git_port}/org/own.git");
    git(&clone, &["remote", "set-url", "origin", &origin]);
    (srv, clone, git_port)
}

#[tokio::test]
async fn an_owner_mode_agent_pushes_its_own_repository_and_reaches_nothing_else_on_the_box() {
    if !bwrap_or_skip("an_owner_mode_agent_pushes_its_own_repository") {
        return;
    }
    assert!(
        which::which("curl").is_ok(),
        "CURL_UNAVAILABLE: this test calls the ops host with curl"
    );
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let scratch =
        Scratch(std::env::temp_dir().join(format!("own-{}-{nanos:x}", std::process::id())));
    let root = scratch.0.clone();
    let home = root.join("home");

    let asks = Arc::new(Mutex::new(Vec::new()));
    let hits = Arc::new(Mutex::new(0usize));
    let core_port = fake_core(asks.clone());
    let ops_port = ops_host(hits.clone());
    let (mcp, runner_config) = plant_box(&home, ops_port, core_port);
    let (srv, clone, git_port) = plant_repos(&root);

    let own_box = OwnBox {
        home: home.clone(),
        clone: clone.clone(),
        base: "dev".into(),
        key: "own-b1".into(),
        hosts: vec![format!("http://127.0.0.2:{git_port}")],
        mcp,
        runner_config,
        runner_exe: PathBuf::from(env!("CARGO_BIN_EXE_forge-runner")),
        egress_dir: root.join("e"),
        inherited: vec![
            (
                "PATH".into(),
                format!("{}:/usr/bin:/bin", home.join(".local/bin").display()).into(),
            ),
            ("HOME".into(), home.clone().into_os_string()),
            ("SSH_AUTH_SOCK".into(), "LEAK-ssh-agent-env".into()),
            ("GH_TOKEN".into(), "LEAK-gh-env".into()),
            ("OPS_MCP_TOKEN".into(), "LEAK-ops-env".into()),
        ],
        project_id: PROJECT.into(),
        core_url: format!("http://127.0.0.3:{core_port}"),
        turn: TURN.into(),
    };
    let reads: String = PLANTED
        .iter()
        .map(|(_, _, at)| format!("cat '{}' 2>/dev/null; echo; ", home.join(at).display()))
        .collect();
    let script = format!(
        "{reads}env; \
         forge-ops status 2>&1; echo \"FORGE_OPS_RC=$?\"; \
         curl -sS --max-time 10 http://127.0.0.4:{ops_port}/mcp 2>&1; echo \"OPS_CURL_RC=$?\"; \
         git -c user.name=Agent -c user.email=agent@example.test commit -q --allow-empty -m 'agent work' && echo COMMITTED; \
         git push origin HEAD:refs/heads/agent-work 2>&1; echo \"PUSH_RC=$?\"; \
         git push http://127.0.0.2:{git_port}/org/other.git HEAD:refs/heads/agent-work 2>&1; echo \"OTHER_PUSH_RC=$?\"; \
         git push '{other}' HEAD:refs/heads/by-path 2>&1; echo \"PATH_PUSH_RC=$?\"; \
         true",
        other = srv.join("org/other.git").display(),
    );
    let out = run(&own_box, &script)
        .await
        .expect("the owner-mode session ran");
    assert_confined(&out, &hits, &asks, &srv, &clone);
}

/// What the session printed and did, held to the confinement: nothing the box keeps was seen or
/// reached, its own repository took its commit, and no other repository took anything.
fn assert_confined(
    out: &std::process::Output,
    hits: &Mutex<usize>,
    asks: &Mutex<Vec<String>>,
    srv: &Path,
    clone: &Path,
) {
    let seen = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let line = |key: &str| {
        seen.lines()
            .find_map(|l| l.strip_prefix(&format!("{key}=")))
            .unwrap_or_else(|| panic!("the probe printed no {key}: {seen} / {stderr}"))
            .to_string()
    };

    let mut leaked: Vec<String> = PLANTED
        .iter()
        .filter(|(marker, _, _)| seen.contains(marker))
        .map(|(marker, what, at)| format!("{what} (~/{at}, {marker})"))
        .collect();
    for marker in [
        "LEAK-forge-ops-token",
        "LEAK-ssh-agent-env",
        "LEAK-gh-env",
        "LEAK-ops-env",
    ] {
        if seen.contains(marker) {
            leaked.push(marker.to_string());
        }
    }
    assert!(
        leaked.is_empty(),
        "the owner-mode session saw what the box keeps: {leaked:?}"
    );
    assert_ne!(
        line("FORGE_OPS_RC"),
        "0",
        "forge-ops ran an ops call from inside the session: {seen}"
    );
    assert!(
        seen.contains(REFUSAL),
        "the ops host was not refused by the session's egress: {seen}"
    );
    assert_eq!(
        *hits.lock().unwrap(),
        0,
        "the ops host was reached from the session"
    );

    assert!(
        seen.contains("COMMITTED"),
        "the agent could not commit in its own clone: {seen}"
    );
    assert_eq!(
        line("PUSH_RC"),
        "0",
        "the agent could not push its own repository: {seen} / {stderr}"
    );
    assert_eq!(
        head_of(&srv.join("org/own.git"), "agent-work"),
        Some(git(clone, &["rev-parse", "HEAD"])),
        "the push did not land the agent's commit in its own repository"
    );

    assert_ne!(
        line("OTHER_PUSH_RC"),
        "0",
        "the agent pushed a repository that is not its own: {seen}"
    );
    assert_ne!(
        line("PATH_PUSH_RC"),
        "0",
        "the agent pushed another repository by its path on the box: {seen}"
    );
    for (name, branch) in [("other.git", "agent-work"), ("other.git", "by-path")] {
        assert_eq!(
            head_of(&srv.join("org").join(name), branch),
            None,
            "{name} took the agent's {branch}"
        );
    }
    let asks = asks.lock().unwrap().clone();
    assert!(
        asks.iter().any(|a| a == "org/own.git") && asks.iter().any(|a| a == "org/other.git"),
        "the helper did not ask core, as the session, for each repository: {asks:?}"
    );
    assert!(
        !asks.iter().any(|a| a.starts_with("REFUSED")),
        "the helper asked core without the session's own turn token: {asks:?}"
    );
}
