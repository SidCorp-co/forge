//! ISS-252 — a `job.cancel` frame reaching a pool job's pane, through `on_frame` as the daemon's
//! frame loop calls it: a real tmux pane on a scratch socket, held in the registry `FrameCtx`
//! carries, and a core on a loopback port that records what the box sent it.

use super::*;
use runner_platform::error::{Error, Result};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// A tmux server of this test's own, which nothing else on the box shares, killed with the test.
struct Scratch(PathBuf);

impl Scratch {
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
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = self.tmux(&["kill-server"]);
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The job panes of a box whose terminal is the scratch server.
struct ScratchPanes(PathBuf);

impl ScratchPanes {
    fn run(&self, args: &[&str]) -> std::process::Output {
        std::process::Command::new("tmux")
            .arg("-S")
            .arg(&self.0)
            .args(args)
            .output()
            .expect("tmux could not be run")
    }
}

#[async_trait::async_trait]
impl pool_jobs::Panes for ScratchPanes {
    async fn open(
        &self,
        _name: &str,
        _cwd: &Path,
        _prompt: &str,
        _env: &[(String, String)],
        _launch: &pool_jobs::Launch<'_>,
    ) -> Result<()> {
        unreachable!("a cancel opens nothing")
    }
    async fn released(&self, _name: &str) {}
    async fn gone(&self, name: &str) -> bool {
        !self
            .run(&["has-session", "-t", &format!("={name}")])
            .status
            .success()
    }
    async fn kill(&self, name: &str) -> Result<()> {
        let out = self.run(&["kill-session", "-t", &format!("={name}")]);
        if out.status.success() {
            Ok(())
        } else {
            Err(Error::Other(String::from_utf8_lossy(&out.stderr).into()))
        }
    }
    async fn names(&self) -> Vec<String> {
        Vec::new()
    }
}

/// One named way a box without tmux skips this test; any other absence fails it naming tmux, so
/// it cannot pass having asserted nothing (the rule `runner-workspace`'s terminal tests hold).
fn tmux_or_skip(test: &str) -> bool {
    if which_tmux() {
        return true;
    }
    match std::env::var("FORGE_TEST_SKIP_TMUX") {
        Ok(v) if v == "1" => {
            use std::io::Write;
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

fn which_tmux() -> bool {
    std::process::Command::new("tmux")
        .arg("-V")
        .output()
        .is_ok_and(|o| o.status.success())
}

/// A core that answers every request 200 and records its path and body.
async fn fake_core() -> (CoreClient, Arc<std::sync::Mutex<Vec<(String, String)>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = sock.read(&mut chunk).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let len = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if body.len() >= len {
                        let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                        log.lock().unwrap().push((path, body.to_string()));
                        break;
                    }
                }
            }
            let reply = "{}";
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                reply.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(reply.as_bytes()).await;
            let _ = sock.shutdown().await;
        }
    });
    (
        CoreClient::new(format!("http://{addr}"), "device-token"),
        seen,
    )
}

fn frame_ctx(client: CoreClient, pool: pool_jobs::PoolPanes) -> FrameCtx {
    let base = client.base().to_string();
    FrameCtx {
        client: Arc::new(client),
        runner: Arc::new(ClaudeCodeRunner::new(base, "device-token", 1)),
        masters: Arc::new(master::Masters::new()),
        inflight: Arc::new(AtomicUsize::new(0)),
        cfg: Arc::new(Config::default()),
        wake_tx: master::wake_channel().0,
        pool,
    }
}

#[tokio::test]
async fn a_job_cancel_frame_closes_the_pool_pane_it_names_frees_its_slot_and_acks_killed() {
    if !tmux_or_skip(
        "a_job_cancel_frame_closes_the_pool_pane_it_names_frees_its_slot_and_acks_killed",
    ) {
        return;
    }
    let root = Scratch(std::env::temp_dir().join(format!("fjc-{}", uuid::Uuid::new_v4().simple())));
    std::fs::create_dir_all(&root.0).unwrap();
    let job_id = uuid::Uuid::new_v4().to_string();
    let pane = pool_jobs::pane_name(&job_id);
    let started = root.tmux(&["new-session", "-d", "-s", &pane, "sleep 300"]);
    assert!(
        started.status.success(),
        "tmux new-session: {}",
        String::from_utf8_lossy(&started.stderr)
    );

    let records = pool_jobs::FileRecords {
        dir: root.0.join("pool-jobs"),
    };
    let registry = Arc::new(pool_jobs::JobPanes::new());
    let held = pool_jobs::Live {
        job_id: job_id.clone(),
        pane: pane.clone(),
        watch: runner_core::turn_evidence::Watch::Unhooked,
        seen: None,
        transcript: None,
        opened_at: None,
    };
    pool_jobs::Records::note(&records, &held).await;
    registry.hold(&job_id, &pane, held.watch.clone(), None, None, None);
    let record = records.path(&job_id).unwrap();
    assert!(record.exists(), "the pane's record was never written");

    let (client, seen) = fake_core().await;
    let ctx = frame_ctx(
        client,
        pool_jobs::PoolPanes {
            panes: Arc::new(ScratchPanes(root.socket())),
            records: Arc::new(records),
            registry: registry.clone(),
        },
    );
    on_frame(
        Frame {
            event: "job.cancel".into(),
            data: serde_json::json!({ "jobId": job_id }),
        },
        &ctx,
    );

    let ack_path = format!("/api/jobs/{job_id}/kill-ack");
    let deadline = Instant::now() + Duration::from_secs(10);
    while registry.count() > 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        !root
            .tmux(&["has-session", "-t", &format!("={pane}")])
            .status
            .success(),
        "the pool pane {pane} is still running after its job.cancel"
    );
    let acks: Vec<serde_json::Value> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(path, _)| *path == ack_path)
        .map(|(_, body)| serde_json::from_str(body).unwrap())
        .collect();
    assert_eq!(acks, vec![serde_json::json!({ "outcome": "killed" })]);
    assert_eq!(registry.count(), 0, "the cancelled pane still holds a slot");
    assert!(
        !record.exists(),
        "the cancelled pane's record is still on disk"
    );
}
