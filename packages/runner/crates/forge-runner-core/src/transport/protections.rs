/*
 * Asking core which park protections it is running.
 *
 * Read before this box releases a process, and never from a version number:
 * the installed runner and `origin/main` both reported `0.12.1` on 2026-09-08,
 * so a version is not a discriminator here even in principle. What the box
 * needs is which protections are RUNNING (ISS-964 criterion 27).
 *
 * Nothing in this module returns an error. An old core has no such route, a
 * reachable core may still be starting, and a box cannot tell those apart from
 * a genuine "none" — so all of them answer the same way, which is the answer
 * that keeps the park shut.
 */

use serde::Deserialize;

use crate::transport::CoreClient;

#[derive(Debug, Deserialize)]
struct Advertisement {
    protections: Vec<String>,
}

/// What core advertises, or nothing at all.
// cm:edge contract -> packages/core/src/devices/pool-routes.ts — `GET /me/protections` is the other half, and it reports what that BUILD of core runs rather than anything about this device.
// cm:guard every failure answers `vec![]` and none of them answers `Err`: a 404 IS the old core, and a timeout is a box that cannot tell an old core from a slow one. Returning an error would make a caller choose between propagating it — which fails a run for a deploy in progress — and swallowing it, which is the silent park this gate exists to stop.
// cm:guard NOT cached: the whole point is a rolling deploy, so an answer cached from before core came up would keep the park shut for the life of the daemon, or open it against a core that has since been rolled back (criterion 27a).
pub async fn park_protections(client: &CoreClient) -> Vec<String> {
    let url = client.url("/api/devices/me/protections");
    let Ok(resp) = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
    else {
        tracing::info!("[park] core did not answer the protections read — treating as none");
        return Vec::new();
    };
    if !resp.status().is_success() {
        tracing::info!(
            "[park] core advertises no park protections ({}) — this is what an old core answers",
            resp.status()
        );
        return Vec::new();
    }
    match resp.json::<Advertisement>().await {
        Ok(a) => a.protections,
        Err(err) => {
            tracing::warn!("[park] the protections read did not decode ({err}) — treating as none");
            Vec::new()
        }
    }
}
