//! Daemon orchestration.
//!
//! Loop: connect WS → subscribe `device:<id>` (+ `runner:register` when
//! enabled) → heartbeat every 30s → on `job.assigned` dispatch a job and stream
//! its events back; on `job.cancel` abort the matching process. Interactive
//! chat (`agent:start` / `agent:send` / `agent:abort`) is handled out-of-band
//! by `chat`, off the jobs path and under its own concurrency budget (ISS-321).

pub mod chat;
pub mod dispatch;
pub mod preflight;
pub mod skill_pull;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::{mpsc, watch, Semaphore};

use crate::config::Config;
use crate::error::Result;
use crate::runner::claude_code::ClaudeCodeRunner;
use crate::runner::Runner;
use crate::transport::frames::{job_id_of, session_id_of, Frame};
use crate::transport::runners;
use crate::transport::ws::{self, RunnerRegistration, WsConfig};
use crate::transport::{heartbeat, CoreClient};

use dispatch::resolve_repo;

/// RAII counter for in-flight work (pipeline jobs + interactive chat turns).
/// Incremented when a unit of work is spawned, decremented on drop — so the
/// auto-update loop can drain to idle before restarting the service (ISS-392),
/// rather than killing a job or chat session mid-flight. Drop fires on both the
/// success and error paths, so a panicking task still releases its slot.
struct InflightGuard(Arc<AtomicUsize>);

impl InflightGuard {
    fn enter(counter: &Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::AcqRel);
        Self(counter.clone())
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Auto-update restart drains to idle, but cap the wait so a stuck/long job
/// can't pin a runner on a stale binary forever. The binary is already swapped
/// on disk by `apply()`, so giving up this cycle just defers the restart to the
/// next idle window or the next 6h tick.
const DRAIN_TIMEOUT_SECS: u64 = 30 * 60;
const DRAIN_POLL_SECS: u64 = 30;

/// Run the daemon until Ctrl-C. `device_token` comes from the cred store.
pub async fn run(
    cfg: Config,
    core_url: String,
    device_id: String,
    device_token: String,
) -> Result<()> {
    // Surface which credential store the daemon resolved, so the journal makes
    // recovery unambiguous (ISS-467) — interactive/headless/systemd contexts can
    // otherwise disagree about where the token lives.
    tracing::info!(
        "[cred] device token store: {}",
        crate::auth::cred_store::active_backend()
    );
    let client = Arc::new(CoreClient::new(core_url.clone(), device_token.clone()));
    let runner = Arc::new(ClaudeCodeRunner::new(
        core_url.clone(),
        device_token.clone(),
    ));

    // Discover server-side assignments (`/me/runners`). This is the source of
    // truth for which projects route to this device and for their repo paths;
    // config.toml is only a local fallback now (ISS-271). Best-effort: an old
    // server or transient failure falls back to config-only behaviour.
    let server = match runners::list_me(&client).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(
                "[me/runners] discovery failed ({e}) — using local config bindings only"
            );
            Vec::new()
        }
    };

    // One runner registration per assigned project. Union the server
    // assignments (authoritative project_id + slug) with any local config
    // binding that already has a project_id, deduped by project_id.
    let device_name = crate::auth::pairing::default_device_name();
    let mut seen_project_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut registrations: Vec<RunnerRegistration> = Vec::new();

    for r in &server {
        if seen_project_ids.insert(r.project_id.clone()) {
            registrations.push(RunnerRegistration {
                project_id: r.project_id.clone(),
                name: format!("{device_name} ({})", r.slug),
                runner_type: "claude-code".into(),
            });
        }
        // AC 5 — warn when assigned on the server but no usable repo path
        // (neither server nor local), with the exact command to fix it.
        if resolve_repo(&server, &cfg, &r.project_id).is_err() {
            tracing::warn!(
                "[me/runners] project '{}' is assigned but has no local repo path — run `forge-runner bind {} --path <dir>`",
                r.slug,
                r.slug
            );
        }
    }
    for (slug, b) in &cfg.bindings {
        if let Some(pid) = b.project_id.clone() {
            if seen_project_ids.insert(pid.clone()) {
                registrations.push(RunnerRegistration {
                    project_id: pid,
                    name: format!("{device_name} ({slug})"),
                    runner_type: "claude-code".into(),
                });
            }
        }
    }

    if registrations.is_empty() {
        tracing::warn!(
            "no project assignments — jobs cannot be routed. Bind a device in the web UI, then run `forge-runner bind <slug> --path <dir>`."
        );
    }

    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (frame_tx, mut frame_rx) = mpsc::channel::<Frame>(256);

    // WebSocket connect loop.
    {
        // tungstenite needs a ws:// / wss:// scheme, not http(s)://.
        let ws_base = core_url
            .trim_end_matches('/')
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        let ws_cfg = WsConfig {
            url: format!("{ws_base}/ws"),
            device_token: device_token.clone(),
            device_id: device_id.clone(),
            registrations,
            register_enabled: cfg.runner.register_enabled,
        };
        let cancel_rx = cancel_rx.clone();
        tokio::spawn(async move { ws::connect(ws_cfg, frame_tx, cancel_rx).await });
    }

    // In-flight work counter (pipeline jobs + chat turns). The update loop
    // drains this to zero before restarting so auto-update never kills running
    // work (ISS-392). Created before any spawn so every worker can register.
    let inflight = Arc::new(AtomicUsize::new(0));

    // Update check loop: warn when a newer release exists; auto-apply +
    // restart when `update.auto` is set. Checks ~30s after start, then every 6h.
    if let Some(url) =
        crate::update::manifest_url(cfg.update.manifest_url.as_deref(), Some(&core_url))
    {
        let auto = cfg.update.auto;
        let inflight = inflight.clone();
        let mut cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(6 * 3600));
            loop {
                match crate::update::fetch_manifest(&url).await {
                    Ok(m)
                        if crate::update::is_newer(&m.version, crate::update::CURRENT_VERSION) =>
                    {
                        tracing::warn!(
                            "[update] available: {} → {}",
                            crate::update::CURRENT_VERSION,
                            m.version
                        );
                        if auto {
                            match crate::update::apply(&m).await {
                                Ok(Some(o)) => {
                                    // The new binary is already swapped on disk;
                                    // drain in-flight jobs/chat to idle before
                                    // restarting so we never kill running work.
                                    tracing::warn!(
                                        "[update] applied {} → {} — draining before restart",
                                        o.from,
                                        o.to
                                    );
                                    let mut waited = 0u64;
                                    loop {
                                        let busy = inflight.load(Ordering::Acquire);
                                        if busy == 0 {
                                            break;
                                        }
                                        if waited >= DRAIN_TIMEOUT_SECS {
                                            tracing::warn!(
                                                "[update] still busy ({busy} in-flight) after {waited}s — deferring restart to next idle window"
                                            );
                                            break;
                                        }
                                        tokio::time::sleep(std::time::Duration::from_secs(
                                            DRAIN_POLL_SECS,
                                        ))
                                        .await;
                                        waited += DRAIN_POLL_SECS;
                                    }
                                    if inflight.load(Ordering::Acquire) == 0 {
                                        tracing::warn!(
                                            "[update] idle — restarting to apply update"
                                        );
                                        // Exit 0 → systemd Restart=always relaunches THIS
                                        // unit, which re-execs the freshly-swapped binary.
                                        // Name-agnostic, so it works for multi-instance
                                        // forge-runner-<id> units too — same mechanism as the
                                        // credential-watch path below. The old hardcoded
                                        // `systemctl --user restart forge-runner` only bounced
                                        // the default unit, so any instance under a different
                                        // unit name (forge-runner-aiNNN) downloaded the new
                                        // binary but never re-execed it, re-applying the same
                                        // update every cycle forever while staying on the old
                                        // in-memory build.
                                        std::process::exit(0);
                                    }
                                }
                                Ok(None) => {}
                                Err(e) => tracing::warn!("[update] apply failed: {e}"),
                            }
                        }
                    }
                    Ok(_) => tracing::debug!("[update] up to date"),
                    Err(e) => tracing::debug!("[update] check failed: {e}"),
                }
                tokio::select! {
                    _ = tick.tick() => {}
                    _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
                }
            }
        });
    }

    // Credential-watch loop (ISS-467): a fresh `forge-runner login` rotates the
    // device token in the cred store, but the HTTP `CoreClient` and the WS were
    // built with the token captured at startup and can't swap it in place. When
    // the stored token changes from what we booted with, drain in-flight work
    // and exit — systemd's `Restart=always` relaunches us and `start` rebuilds
    // every client (WS + HTTP) with the new token. This fires ONLY on an actual
    // change (never on a still-dead token with no re-login), so it can't become
    // the old 401 fast-restart hammer; the WS backoff covers the dead window.
    {
        let startup_token = device_token.clone();
        let inflight = inflight.clone();
        let mut cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
            tick.tick().await; // skip the immediate tick
            loop {
                tokio::select! {
                    _ = tick.tick() => {}
                    _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
                }
                // Only act on a confirmed, changed token. None/Err (a transient
                // read during the atomic rename, or a cleared store) is left
                // alone so a blip never triggers a restart.
                if let Ok(Some(current)) = crate::auth::cred_store::load_device_token() {
                    if current != startup_token {
                        tracing::warn!(
                            "[cred] device token changed (re-login detected) — draining in-flight work, then restarting to apply it"
                        );
                        let mut waited = 0u64;
                        while inflight.load(Ordering::Acquire) != 0 && waited < DRAIN_TIMEOUT_SECS {
                            tokio::time::sleep(std::time::Duration::from_secs(DRAIN_POLL_SECS))
                                .await;
                            waited += DRAIN_POLL_SECS;
                        }
                        tracing::warn!("[cred] restarting to pick up new credentials");
                        // Exit 0 → systemd Restart=always relaunches THIS unit
                        // (name-agnostic, so it works for multi-instance
                        // forge-runner-<id> units too).
                        std::process::exit(0);
                    }
                }
            }
        });
    }

    // Heartbeat loop.
    {
        let client = client.clone();
        let mut cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            let mut tick =
                tokio::time::interval(std::time::Duration::from_secs(heartbeat::INTERVAL_SECS));
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        if let Err(e) = heartbeat::beat(&client).await {
                            tracing::warn!("[heartbeat] {e}");
                        }
                    }
                    _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
                }
            }
        });
    }

    // Ctrl-C → cancel.
    {
        let cancel_tx = cancel_tx.clone();
        tokio::spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down…");
            let _ = cancel_tx.send(true);
        });
    }

    tracing::info!(
        "runner online — device {device_id}, {} binding(s)",
        cfg.bindings.len()
    );

    // Interactive-chat concurrency budget — separate from the pipeline
    // `job.assigned` path so a long chat never consumes a pipeline cap slot and
    // a burst of chats can't exhaust the box (ISS-321). Clamp to >= 1.
    let chat_sem = Arc::new(Semaphore::new(
        (cfg.runner.chat_max_concurrent as usize).max(1),
    ));

    let cfg = Arc::new(cfg);

    // Workspace-provisioning sweep. Runs once at startup then periodically so a
    // device that was offline when a project was assigned catches up on its own;
    // the `provision.request` WS event below makes a fresh bind prompt. Server
    // only returns `queued` rows, so this is a no-op once everything is ready.
    {
        let (client, cfg) = (client.clone(), cfg.clone());
        let mut cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(90));
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        crate::workspace::provision::run_pending(&client, &cfg).await;
                    }
                    _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
                }
            }
        });
    }

    // Background skill auto-pull (ISS-736) — OFF by default (canary gate).
    // Independent poller; `skill.sync` above stays the immediate, explicit path.
    if cfg.skills.auto_pull {
        let (client, cfg) = (client.clone(), cfg.clone());
        let cancel_rx = cancel_rx.clone();
        tokio::spawn(async move { skill_pull::run(client, cfg, cancel_rx).await });
        tracing::info!("[skills] background auto-pull enabled");
    } else {
        tracing::debug!(
            "[skills] background auto-pull disabled (set skills.auto_pull=true to enable)"
        );
    }

    // Shared-skill plugin-marketplace sweep (ISS-739, 3rd delivery channel).
    // Jittered <=10min initial delay (avoids every device in a fleet hammering
    // the marketplace git remote at the same instant on a simultaneous restart),
    // then a periodic tick at `plugins.poll_interval_secs`. Cheap no-op when
    // `plugins.enabled == false` — `ensure_plugins` early-returns immediately.
    {
        let cfg = cfg.clone();
        let mut cancel_rx = cancel_rx.clone();
        tokio::spawn(async move {
            let jitter_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_millis() as u64
                % 1000;
            let initial_delay_ms = jitter_ms * 600; // spreads across ~0-600s (<=10min)
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(initial_delay_ms)) => {}
                _ = cancel_rx.changed() => { if *cancel_rx.borrow() { return; } }
            }
            crate::workspace::plugin_sync::ensure_plugins(&cfg.plugins).await;

            let mut tick = tokio::time::interval(std::time::Duration::from_secs(
                cfg.plugins.poll_interval_secs.max(1),
            ));
            tick.tick().await; // skip the immediate tick — we just ran above
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        crate::workspace::plugin_sync::ensure_plugins(&cfg.plugins).await;
                    }
                    _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
                }
            }
        });
    }

    let mut cancel_rx = cancel_rx.clone();
    loop {
        tokio::select! {
            frame = frame_rx.recv() => {
                let Some(frame) = frame else { break };
                match frame.event.as_str() {
                    "job.assigned" => {
                        let (client, runner, cfg) = (client.clone(), runner.clone(), cfg.clone());
                        let guard = InflightGuard::enter(&inflight);
                        tokio::spawn(async move {
                            let _guard = guard; // released when the job finishes (drain gate)
                            if let Err(e) = dispatch::handle(&client, runner, &cfg, frame.data).await {
                                tracing::error!("[dispatch] {e}");
                            }
                        });
                    }
                    "job.cancel" | "job.cancelRequested" => {
                        if let Some(jid) = job_id_of(&frame.data) {
                            tracing::info!("[cancel] job={jid}");
                            let _ = runner.abort(&jid).await;
                        }
                    }
                    "agent:start" => {
                        let (client, runner, cfg, sem) =
                            (client.clone(), runner.clone(), cfg.clone(), chat_sem.clone());
                        let guard = InflightGuard::enter(&inflight);
                        tokio::spawn(async move {
                            let _guard = guard; // released when the chat turn finishes (drain gate)
                            if let Err(e) = chat::handle_start(&client, runner, &cfg, sem, frame.data).await {
                                tracing::error!("[chat] start: {e}");
                            }
                        });
                    }
                    "agent:send" => {
                        let (client, runner, cfg, sem) =
                            (client.clone(), runner.clone(), cfg.clone(), chat_sem.clone());
                        let guard = InflightGuard::enter(&inflight);
                        tokio::spawn(async move {
                            let _guard = guard; // released when the chat turn finishes (drain gate)
                            if let Err(e) = chat::handle_send(&client, runner, &cfg, sem, frame.data).await {
                                tracing::error!("[chat] send: {e}");
                            }
                        });
                    }
                    "agent:abort" => {
                        if let Some(sid) = session_id_of(&frame.data) {
                            tracing::info!("[chat] abort session={sid}");
                            let runner = runner.clone();
                            tokio::spawn(async move { chat::handle_abort(runner, &sid).await });
                        }
                    }
                    "skill.sync" => {
                        let (client, cfg) = (client.clone(), cfg.clone());
                        tokio::spawn(async move {
                            if let Err(e) = dispatch::handle_skill_sync(&client, &cfg, frame.data).await {
                                tracing::warn!("[skill.sync] {e}");
                            }
                        });
                    }
                    "provision.request" => {
                        // Wake → run the pending-provision sweep (server returns
                        // only `queued` rows, so this provisions the requested one).
                        let (client, cfg) = (client.clone(), cfg.clone());
                        tokio::spawn(async move {
                            if let Err(e) = crate::workspace::provision::handle_request(&client, &cfg).await {
                                tracing::warn!("[provision] {e}");
                            }
                        });
                    }
                    "runner.registered" => tracing::info!("[ws] runner registered"),
                    other => tracing::debug!("[ws] ignored event {other}"),
                }
            }
            _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
        }
    }

    Ok(())
}
