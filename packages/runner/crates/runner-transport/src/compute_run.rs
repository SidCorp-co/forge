//! POST `/api/devices/me/compute-runs/:requestId`: this box's answer to a `compute.run`.

use crate::CoreClient;
use runner_platform::error::{Error, Result};

pub async fn answer(client: &CoreClient, request_id: &str, body: &serde_json::Value) -> Result<()> {
    let path = format!("/api/devices/me/compute-runs/{request_id}");
    let resp = crate::status::sent(client.post(&path).json(body), "compute run answer").await?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(crate::status::refused(
            "compute run",
            code,
            &text,
        )));
    }
    Ok(())
}
