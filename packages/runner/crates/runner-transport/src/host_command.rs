//! POST `/api/devices/me/host-commands/:requestId`: this box's answer to a `host.command`.

use crate::CoreClient;
use runner_platform::error::{Error, Result};

pub async fn answer(client: &CoreClient, request_id: &str, body: &serde_json::Value) -> Result<()> {
    let path = format!("/api/devices/me/host-commands/{request_id}");
    let resp = crate::status::sent(client.post(&path).json(body), "host command answer").await?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(crate::status::refused(
            "host command",
            code,
            &text,
        )));
    }
    Ok(())
}
