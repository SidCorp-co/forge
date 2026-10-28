//! The frames core addresses to this box about one project: reading or setting up its checkout
//! (`skill.sync`, `checkout.head.read`, `checkout.ancestry.read`, `provision.request`), and a
//! support room's acts the box carries out for it (`host.command`, `build.push`, REQ-75 r5).
//! `actors::on_frame` routes them here; each is handled off the frame loop.

use crate::*;

/// Whether `event` is one of the frames [`on_frame`] takes.
pub(crate) fn takes(event: &str) -> bool {
    BOX_FRAMES.contains(&event)
}

/// The frames [`on_frame`] takes.
const BOX_FRAMES: [&str; 6] = [
    "skill.sync",
    "checkout.head.read",
    "checkout.ancestry.read",
    "provision.request",
    "host.command",
    "build.push",
];

/// The frames that read or set up a project's checkout on this box.
pub(crate) fn on_frame(frame: Frame, client: &Arc<CoreClient>, cfg: &Arc<Config>) {
    match frame.event.as_str() {
        "skill.sync" => {
            let (client, cfg) = (client.clone(), cfg.clone());
            tokio::spawn(async move {
                if let Err(e) = dispatch::handle_skill_sync(&client, &cfg, frame.data).await {
                    tracing::warn!("[skill.sync] {e}");
                }
            });
        }
        "checkout.head.read" => {
            let client = client.clone();
            tokio::spawn(async move { crate::head_read::handle(&client, frame.data).await });
        }
        "checkout.ancestry.read" => {
            let client = client.clone();
            tokio::spawn(async move { crate::ancestry_read::handle(&client, frame.data).await });
        }
        "host.command" => {
            let client = client.clone();
            tokio::spawn(async move { crate::host_command::handle(&client, frame.data).await });
        }
        "build.push" => {
            let client = client.clone();
            tokio::spawn(async move { crate::build_push::handle(&client, frame.data).await });
        }
        "provision.request" => {
            // Wake → run the pending-provision sweep (server returns
            // only `queued` rows, so this provisions the requested one).
            let (client, cfg) = (client.clone(), cfg.clone());
            tokio::spawn(async move {
                if let Err(e) = runner_workspace::provision::handle_request(&client, &cfg).await {
                    tracing::warn!("[provision] {e}");
                }
            });
        }
        _ => {}
    }
}
