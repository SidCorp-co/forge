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
use crate::transport::ws::{self, RunnerRegistration, WsConfig};
use crate::transport::{heartbeat, CoreClient};

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

    // One runner registration per bound project that has a project_id.
    let device_name = crate::auth::pairing::default_device_name();
    let registrations: Vec<RunnerRegistration> = cfg
        .bindings
        .iter()
        .filter_map(|(slug, b)| {
            b.project_id.clone().map(|pid| RunnerRegistration {
                project_id: pid,
                name: format!("{device_name} ({slug})"),
                runner_type: "claude-code".into(),
            })
        })
        .collect();

    if cfg.bindings.is_empty() {
        tracing::warn!("no project bindings — jobs cannot be routed. Run `forge-runner bind`.");
    }

    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (frame_tx, mut frame_rx) = mpsc::channel::<Frame>(256);

    // WebSocket connect loop.
    {
        let ws_cfg = WsConfig {
            url: format!("{}/ws", core_url.trim_end_matches('/')),
            device_token: device_token.clone(),
            device_id: device_id.clone(),
            registrations,
            register_enabled: cfg.runner.register_enabled,
        };
        let cancel_rx = cancel_rx.clone();
        tokio::spawn(async move { ws::connect(ws_cfg, frame_tx, cancel_rx).await });
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
                    "runner.registered" => tracing::info!("[ws] runner registered"),
                    other => tracing::debug!("[ws] ignored event {other}"),
                }
            }
            _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
        }
    }

    Ok(())
}
