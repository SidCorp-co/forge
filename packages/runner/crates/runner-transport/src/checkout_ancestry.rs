//! POST `/api/devices/me/checkout-ancestry/:requestId`: this box's answer to a `checkout.ancestry.read`.

use crate::CoreClient;
use runner_platform::error::{Error, Result};

pub async fn answer(client: &CoreClient, request_id: &str, body: &serde_json::Value) -> Result<()> {
    let path = format!("/api/devices/me/checkout-ancestry/{request_id}");
    let resp =
        crate::status::sent(client.post(&path).json(body), "checkout ancestry answer").await?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(crate::status::refused(
            "checkout ancestry",
            code,
            &text,
        )));
    }
    Ok(())
}
