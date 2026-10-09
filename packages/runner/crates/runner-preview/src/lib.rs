//! Live previews on this box (REQ-39; docs/proposals/live-preview.md): core asks the box to start
//! a run's dev server in the run's worktree (`preview.start`), to stop it (`preview.stop`), or to
//! read what it serves (`preview.snapshot.read`); the box reports each outcome to
//! `POST /api/previews/:id/report` and carries the browser's bytes over its tunnel. Core decides
//! the setting, who may view and for how long (ADR 0009, thin box agent); the box decides nothing.
//! A preview no run holds (REQ-41) names the checkout the box cuts for it ([`checkout`]).

pub mod checkout;
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

use crate::checkout::Checkout;
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
    /// The run whose worktree is served; none for a reproduce, which no run holds.
    #[serde(default)]
    session_id: Option<String>,
    /// The checkout this box cuts where no run's worktree is served (REQ-41).
    #[serde(default)]
    checkout: Option<Checkout>,
    /// The demo seed run in the checkout before the dev server (REQ-41 BC-22).
    #[serde(default)]
    seed: Option<String>,
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
    /// `preview.snapshot.read`: a keep (REQ-41 BC-16) commits and pins the sketch's head too.
    #[serde(default)]
    keep: bool,
    /// `preview.snapshot.read`: a POC room's settle (REQ-44 BC-8) merges the kept sketch into
    /// origin's dev branch after the keep.
    #[serde(default)]
    settle: Option<snapshot::SettleAsk>,
    /// `preview.stop`: an abandoned or settled POC room's checkout (REQ-44 BC-10), removed with its
    /// branch and kept ref whether this box still holds the preview or not.
    #[serde(default)]
    drop: Option<Checkout>,
}

/// One preview this box holds: the worktree it serves and, while it runs, its dev server.
struct Held {
    worktree: PathBuf,
    /// The checkout this box cut for it, where no run's worktree is served.
    checkout: Option<Checkout>,
    /// Whether the demo seed already ran in this checkout: it runs once, not on every start.
    seeded: bool,
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
                    tokio::spawn(async move {
                        this.close(&n.preview_id, n.why.as_deref()).await;
                        if let Some(c) = n.drop {
                            checkout::drop_sketch(&c, &n.preview_id).await;
                        }
                    });
                }
                Err(e) => tracing::warn!("[preview] preview.stop refused: {e}"),
            },
            "preview.snapshot.read" => match serde_json::from_value::<Named>(data) {
                Ok(n) => {
                    tokio::spawn(
                        async move { this.snapshot(&n.preview_id, n.keep, n.settle).await },
                    );
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

    /// The directory a preview serves: the checkout it names, cut here, or its run's worktree.
    async fn worktree_of(&self, start: &Start) -> Result<PathBuf, Failure> {
        if let Some(c) = &start.checkout {
            return checkout::cut(c).await;
        }
        let Some(session) = start.session_id.as_deref() else {
            return Err(Failure {
                reason: "WORKTREE_GONE",
                detail: "core named neither a run nor a checkout to serve".into(),
            });
        };
        self.0.worktrees.of_session(session).ok_or_else(|| Failure {
            reason: "WORKTREE_GONE",
            detail: format!(
                "this box holds no worktree for run session {session}: the run ended or its checkout was released"
            ),
        })
    }

    async fn start_preview(&self, start: Start) {
        let id = start.preview_id.clone();
        let worktree = match self.worktree_of(&start).await {
            Ok(w) => w,
            Err(f) => {
                self.report_failure(&id, &f).await;
                return;
            }
        };
        let seeded = self.held().get(&id).is_some_and(|h| h.seeded);
        let generation = self.stop(&id, false).await + 1;
        self.held().insert(
            id.clone(),
            Held {
                worktree: worktree.clone(),
                checkout: start.checkout.clone(),
                seeded,
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
                let seeded = match start.seed.as_deref() {
                    Some(seed) if !seeded => checkout::seed(&worktree, seed, &start.env, ready)
                        .await
                        .map(|()| {
                            if let Some(h) = self.held().get_mut(&id) {
                                h.seeded = true;
                            }
                        }),
                    _ => Ok(()),
                };
                let served = match seeded {
                    Ok(()) => {
                        self.run_server(&id, generation, &worktree, &settings, &start.env, ready)
                            .await
                    }
                    Err(f) => Err(f),
                };
                if let Err(f) = served {
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
            self.close(id, None).await;
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

    async fn snapshot(&self, id: &str, keep: bool, settle: Option<snapshot::SettleAsk>) {
        let held = self.held().get(id).map(|h| {
            (
                h.worktree.clone(),
                match &h.checkout {
                    Some(Checkout::Sketch { branch, .. }) => Some(branch.clone()),
                    _ => None,
                },
            )
        });
        let Some((worktree, sketch)) = held else {
            tracing::warn!(
                "[preview] {id}: a snapshot was asked of a preview this box does not hold"
            );
            return;
        };
        if (keep || settle.is_some()) && sketch.is_none() {
            // only a sketch this box cut is committed to: core answers its keep "unavailable" by name
            tracing::warn!("[preview] {id}: a keep was asked of a preview that is not a sketch");
            return;
        }
        let read = if keep || settle.is_some() {
            snapshot::keep(&worktree, id).await
        } else {
            snapshot::read(&worktree).await
        };
        match read {
            Ok(s) => {
                let mut body = serde_json::json!({ "kind": "snapshot", "base": s.base, "patchId": s.patch_id, "files": s.files });
                if let Some(head) = s.head {
                    body["head"] = serde_json::Value::String(head);
                }
                if let (Some(ask), Some(branch)) = (settle, sketch.as_deref()) {
                    match snapshot::settle(&worktree, branch, &ask).await {
                        Ok(sha) => {
                            body["merged"] = serde_json::json!({ "into": ask.into, "sha": sha });
                        }
                        Err(e) => {
                            tracing::warn!("[preview] {id}: the settle's merge did not land: {e}");
                            body["mergeRefused"] = serde_json::Value::String(devserver::tail(
                                &e,
                                devserver::DETAIL_LIMIT,
                            ));
                        }
                    }
                }
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

    /// Close a preview core stopped (`preview.stop`): an idle stop keeps its worktree and checkout,
    /// so it can start again; any other forgets it, and removes the checkout this box cut for it
    /// where [`Checkout::removed_on`] says the box owns it.
    async fn close(&self, id: &str, why: Option<&str>) {
        let forget = why != Some("idle");
        let checkout = if forget {
            self.held().get(id).and_then(|h| h.checkout.clone())
        } else {
            None
        };
        self.stop(id, forget).await;
        if let Some(c) = checkout.filter(|c| c.removed_on(why)) {
            checkout::remove(&c).await;
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
