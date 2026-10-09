//! Live previews on this box (REQ-39; docs/proposals/live-preview.md): core asks the box to start
//! a run's dev server in the run's worktree (`preview.start`), to stop it (`preview.stop`), or to
//! read what it serves (`preview.snapshot.read`); the box reports each outcome to
//! `POST /api/previews/:id/report` and carries the browser's bytes over its tunnel. Core decides
//! the setting, who may view and for how long (ADR 0009, thin box agent); the box decides nothing.

pub mod codec;
pub mod devserver;
pub mod exposure;
pub mod groups;
pub mod snapshot;
pub mod tunnel;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use runner_transport::CoreClient;
use serde::Deserialize;
use tokio::sync::watch;

use crate::devserver::{Failure, Settings};

/// The frames core sends this module, on the device's control socket.
pub const FRAMES: [&str; 3] = ["preview.start", "preview.stop", "preview.snapshot.read"];

/// Where a run's worktree is on this box, from the box's own ledger: the frame never names a path.
pub trait Worktrees: Send + Sync + 'static {
    fn of_session(&self, session_id: &str) -> Option<PathBuf>;
}

/// Core's `preview.start` frame (`PreviewControlFrames["preview.start"]`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Start {
    preview_id: String,
    session_id: String,
    settings: Option<Settings>,
    #[serde(default)]
    env: serde_json::Map<String, serde_json::Value>,
    ready_timeout_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Named {
    preview_id: String,
    /// `preview.stop`'s reason: an idle stop keeps the worktree, so an approval can still read it.
    #[serde(default)]
    why: Option<String>,
}

/// One preview this box holds: the worktree it serves and, while it runs, its dev server.
struct Held {
    worktree: PathBuf,
    /// Bumped on every start, so an older start's watcher knows it was superseded.
    generation: u64,
    /// Asked to start and not yet serving or failed: it needs the tunnel too.
    starting: bool,
    server: Option<tokio::process::Child>,
}

struct Inner {
    core: CoreClient,
    worktrees: Arc<dyn Worktrees>,
    held: Mutex<HashMap<String, Held>>,
    ports: tunnel::Ports,
    wanted: watch::Sender<bool>,
    groups: groups::Groups,
}

/// This box's previews, shared by the frame loop and the tunnel.
#[derive(Clone)]
pub struct Previews(Arc<Inner>);

/// The lockfile names detection reads (`detectPreviewSettings`).
const LOCKFILES: [&str; 5] = [
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
];
const PACKAGE_JSON_LIMIT: u64 = 65_536;

impl Previews {
    /// The previews of a box served by `core`, whose tunnel dials `core_url` while one is held.
    /// `record` is where the dev servers' groups are written down: any an earlier image left
    /// there are stopped first (see [`groups`]).
    pub fn start(
        core: CoreClient,
        core_url: &str,
        device_token: &str,
        worktrees: Arc<dyn Worktrees>,
        record: Option<PathBuf>,
        cancel: watch::Receiver<bool>,
    ) -> Self {
        if let Some(path) = &record {
            groups::reap_left(path, devserver::STOP_GRACE);
        }
        let (wanted, wanted_rx) = watch::channel(false);
        let inner = Arc::new(Inner {
            core,
            worktrees,
            held: Mutex::new(HashMap::new()),
            ports: Arc::new(Mutex::new(HashMap::new())),
            wanted,
            groups: groups::Groups::at(record),
        });
        let cfg = tunnel::TunnelConfig {
            url: tunnel_url(core_url),
            device_token: device_token.to_string(),
        };
        tokio::spawn(tunnel::run(cfg, inner.ports.clone(), wanted_rx, cancel));
        Self(inner)
    }

    /// Route one of [`FRAMES`]; each is handled off the frame loop.
    pub fn on_frame(&self, event: &str, data: serde_json::Value) {
        let this = self.clone();
        match event {
            "preview.start" => match serde_json::from_value::<Start>(data) {
                Ok(start) => {
                    tokio::spawn(async move { this.start_preview(start).await });
                }
                Err(e) => tracing::warn!("[preview] preview.start refused: {e}"),
            },
            "preview.stop" => match serde_json::from_value::<Named>(data) {
                Ok(n) => {
                    let forget = n.why.as_deref() != Some("idle");
                    tokio::spawn(async move { this.stop(&n.preview_id, forget).await });
                }
                Err(e) => tracing::warn!("[preview] preview.stop refused: {e}"),
            },
            "preview.snapshot.read" => match serde_json::from_value::<Named>(data) {
                Ok(n) => {
                    tokio::spawn(async move { this.snapshot(&n.preview_id).await });
                }
                Err(e) => tracing::warn!("[preview] preview.snapshot.read refused: {e}"),
            },
            other => tracing::debug!("[preview] not a preview frame: {other}"),
        }
    }

    fn held(&self) -> std::sync::MutexGuard<'_, HashMap<String, Held>> {
        self.0.held.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn set_port(&self, preview: &str, port: Option<u16>) {
        let mut ports = self.0.ports.lock().unwrap_or_else(|p| p.into_inner());
        match port {
            Some(port) => ports.insert(preview.to_string(), port),
            None => ports.remove(preview),
        };
    }

    /// Whether a preview still needs the tunnel: one is starting or live.
    fn refresh_wanted(&self) {
        let any = self
            .held()
            .values()
            .any(|h| h.starting || h.server.is_some());
        let _ = self.0.wanted.send_if_modified(|w| {
            let changed = *w != any;
            *w = any;
            changed
        });
    }

    async fn start_preview(&self, start: Start) {
        let id = start.preview_id.clone();
        let Some(worktree) = self.0.worktrees.of_session(&start.session_id) else {
            let detail = format!(
                "this box holds no worktree for run session {}: the run ended or its checkout was released",
                start.session_id
            );
            self.report_failure(
                &id,
                &Failure {
                    reason: "WORKTREE_GONE",
                    detail,
                },
            )
            .await;
            return;
        };
        let generation = self.stop(&id, false).await + 1;
        self.held().insert(
            id.clone(),
            Held {
                worktree: worktree.clone(),
                generation,
                starting: true,
                server: None,
            },
        );
        // The tunnel opens as the box is asked to start: core reads it as this runner taking previews.
        self.refresh_wanted();
        match start.settings {
            // Still starting: core answers the facts with a second start, or fails it and stops it.
            None => self.report_facts(&id, &worktree).await,
            Some(settings) => {
                let ready = Duration::from_secs(start.ready_timeout_seconds);
                if let Err(f) = self
                    .run_server(&id, generation, &worktree, &settings, &start.env, ready)
                    .await
                {
                    self.forget_server(&id, generation);
                    self.report_failure(&id, &f).await;
                }
            }
        }
        self.refresh_wanted();
    }

    async fn run_server(
        &self,
        id: &str,
        generation: u64,
        worktree: &std::path::Path,
        settings: &Settings,
        env: &serde_json::Map<String, serde_json::Value>,
        ready: Duration,
    ) -> Result<(), Failure> {
        let dir = devserver::working_dir(worktree, settings.cwd.as_deref())?;
        let (port, command) = devserver::plan_port(settings)?;
        let mut server = devserver::spawn(&dir, &command, port, env)?;
        self.0.groups.note(id, server.child.id());
        tracing::info!("[preview] {id}: started `{command}` on 127.0.0.1:{port}");
        let refused = match devserver::ready(&mut server, ready).await {
            Err(f) => Some(f),
            Ok(()) => exposure::beyond_loopback(port).map(|addr| Failure {
                reason: "DEV_SERVER_EXPOSED",
                detail: format!(
                    "`{command}` listens on {addr}, beyond loopback, where anyone who reaches this box could open it without Forge; the box stopped it. Bind it to 127.0.0.1 (Next: `next dev --hostname 127.0.0.1`) and open the preview again"
                ),
            }),
        };
        if let Some(f) = refused {
            devserver::stop(server.child).await;
            self.0.groups.forget(id);
            return Err(f);
        }
        let output = server.output.clone();
        let superseded = {
            let mut held = self.held();
            match held.get_mut(id) {
                Some(h) if h.generation == generation => {
                    h.server = Some(server.child);
                    h.starting = false;
                    None
                }
                _ => Some(server.child),
            }
        };
        if let Some(child) = superseded {
            // the newer start noted its own group under this id; this one ends unrecorded
            devserver::stop(child).await;
            return Ok(());
        }
        self.set_port(id, Some(port));
        let answer = self
            .report(id, serde_json::json!({ "kind": "live", "port": port }))
            .await;
        if answer == Answer::Closed {
            self.stop(id, true).await;
            return Ok(());
        }
        self.watch_exit(id.to_string(), generation, output);
        Ok(())
    }

    /// A live server that exits on its own is reported failed with what it printed.
    fn watch_exit(&self, id: String, generation: u64, output: devserver::Output) {
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let status = {
                    let mut held = this.held();
                    match held.get_mut(&id) {
                        Some(Held {
                            generation: g,
                            server: Some(child),
                            ..
                        }) if *g == generation => match child.try_wait() {
                            Ok(Some(status)) => Some(status),
                            Ok(None) | Err(_) => None,
                        },
                        _ => return,
                    }
                };
                if let Some(status) = status {
                    this.forget_server(&id, generation);
                    let detail = format!("the dev server exited ({status}):\n{}", output.text());
                    let f = Failure {
                        reason: "DEV_SERVER_EXITED",
                        detail: devserver::tail(&detail, devserver::DETAIL_LIMIT),
                    };
                    this.report_failure(&id, &f).await;
                    this.refresh_wanted();
                    return;
                }
            }
        });
    }

    fn forget_server(&self, id: &str, generation: u64) {
        if let Some(h) = self.held().get_mut(id) {
            if h.generation == generation {
                h.server = None;
                h.starting = false;
                self.0.groups.forget(id);
            }
        }
        self.set_port(id, None);
    }

    /// Stop a preview's dev server; `forget` also drops its worktree (it closed for good). Answers
    /// the generation it held, so a restart counts on from it.
    async fn stop(&self, id: &str, forget: bool) -> u64 {
        self.set_port(id, None);
        let (child, generation) = {
            let mut held = self.held();
            let Some(h) = held.get_mut(id) else { return 0 };
            let generation = h.generation;
            let child = h.server.take();
            h.starting = false;
            if forget {
                held.remove(id);
            }
            (child, generation)
        };
        if let Some(child) = child {
            devserver::stop(child).await;
            self.0.groups.forget(id);
            tracing::info!("[preview] {id}: dev server stopped");
        }
        self.refresh_wanted();
        generation
    }

    async fn report_facts(&self, id: &str, worktree: &std::path::Path) {
        let pkg = worktree.join("package.json");
        let package_json = match std::fs::metadata(&pkg) {
            Ok(m) if m.len() > PACKAGE_JSON_LIMIT => {
                let detail = format!(
                    "package.json is {} bytes, over the 64 KiB Forge reads; set preview.command",
                    m.len()
                );
                self.report_failure(
                    id,
                    &Failure {
                        reason: "NO_START_COMMAND",
                        detail,
                    },
                )
                .await;
                return;
            }
            Ok(_) => std::fs::read_to_string(&pkg).ok(),
            Err(_) => None,
        };
        let lockfiles: Vec<&str> = LOCKFILES
            .into_iter()
            .filter(|l| worktree.join(l).is_file())
            .collect();
        let facts =
            serde_json::json!({ "cwd": "", "packageJson": package_json, "lockfiles": lockfiles });
        self.report(id, serde_json::json!({ "kind": "facts", "facts": facts }))
            .await;
    }

    async fn snapshot(&self, id: &str) {
        let worktree = self.held().get(id).map(|h| h.worktree.clone());
        let Some(worktree) = worktree else {
            tracing::warn!(
                "[preview] {id}: a snapshot was asked of a preview this box does not hold"
            );
            return;
        };
        match snapshot::read(&worktree).await {
            Ok(s) => {
                let body = serde_json::json!({ "kind": "snapshot", "base": s.base, "patchId": s.patch_id, "files": s.files });
                self.report(id, body).await;
            }
            Err(e) => tracing::warn!("[preview] {id}: no snapshot: {e}"),
        }
    }

    async fn report_failure(&self, id: &str, f: &Failure) {
        tracing::warn!("[preview] {id}: {}: {}", f.reason, f.detail);
        let body = serde_json::json!({ "kind": "failed", "reason": f.reason, "detail": f.detail });
        self.report(id, body).await;
    }

    async fn report(&self, id: &str, body: serde_json::Value) -> Answer {
        let path = format!("/api/previews/{id}/report");
        match self.0.core.post(&path).json(&body).send().await {
            Ok(r) if r.status().is_success() => Answer::Taken,
            Ok(r) if r.status().as_u16() == 404 || r.status().as_u16() == 409 => {
                let text = r.text().await.unwrap_or_default();
                tracing::warn!("[preview] {id}: core refused the report: {text}");
                Answer::Closed
            }
            Ok(r) => {
                tracing::warn!("[preview] {id}: core answered the report {}", r.status());
                Answer::Unheard
            }
            Err(e) => {
                tracing::warn!("[preview] {id}: the report did not reach core: {e}");
                Answer::Unheard
            }
        }
    }

    /// Stop every dev server: the daemon is winding down.
    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.held().keys().cloned().collect();
        for id in ids {
            self.stop(&id, true).await;
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Answer {
    Taken,
    /// Core knows no such preview for this box, or it is closed: its dev server has to stop.
    Closed,
    Unheard,
}

/// `wss://<core>/ws/preview-tunnel` for an `https://<core>` base.
pub fn tunnel_url(core_url: &str) -> String {
    let base = core_url
        .trim_end_matches('/')
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    format!("{base}/ws/preview-tunnel")
}
