//! Daemon orchestration.
//!
//! Loop: connect WS → subscribe `device:<id>` (+ `runner:register` when
//! enabled) → heartbeat every 30s → on `job.assigned` dispatch a job and stream
//! its events back; on `job.cancel` abort the matching process.

pub mod dispatch;

use std::sync::Arc;

use tokio::sync::{mpsc, watch};

use crate::config::Config;
use crate::error::Result;
use crate::runner::claude_code::ClaudeCodeRunner;
use crate::runner::Runner;
use crate::transport::frames::{job_id_of, Frame};
use crate::transport::runners;
use crate::transport::ws::{self, RunnerRegistration, WsConfig};
use crate::transport::{heartbeat, CoreClient};

use dispatch::resolve_repo;

/// Run the daemon until Ctrl-C. `device_token` comes from the cred store.
pub async fn run(
    cfg: Config,
    core_url: String,
    device_id: String,
    device_token: String,
) -> Result<()> {
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

    // Update check loop: warn when a newer release exists; auto-apply +
    // restart when `update.auto` is set. Checks ~30s after start, then every 6h.
    if let Some(url) =
        crate::update::manifest_url(cfg.update.manifest_url.as_deref(), Some(&core_url))
    {
        let auto = cfg.update.auto;
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
                                    tracing::warn!(
                                        "[update] applied {} → {} — restarting service",
                                        o.from,
                                        o.to
                                    );
                                    let _ = std::process::Command::new("systemctl")
                                        .args(["--user", "restart", "forge-runner"])
                                        .status();
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

    let cfg = Arc::new(cfg);
    let mut cancel_rx = cancel_rx.clone();
    loop {
        tokio::select! {
            frame = frame_rx.recv() => {
                let Some(frame) = frame else { break };
                match frame.event.as_str() {
                    "job.assigned" => {
                        let (client, runner, cfg) = (client.clone(), runner.clone(), cfg.clone());
                        tokio::spawn(async move {
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
                    "skill.sync" => {
                        let (client, cfg) = (client.clone(), cfg.clone());
                        tokio::spawn(async move {
                            if let Err(e) = dispatch::handle_skill_sync(&client, &cfg, frame.data).await {
                                tracing::warn!("[skill.sync] {e}");
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
