/*
 * The answers to feedback a session's own account filed to Forge that none of its sessions has been
 * told (REQ-47 BC-11), claimed from core's Forge door. The claim records each answer as told in the
 * same act, so what comes back is this caller's to say and nobody else's.
 */

use serde::Deserialize;

use crate::{status, CoreClient};
use runner_platform::error::Result;

/// The route core hands the answers out on.
pub const CLAIM_PATH: &str = "/api/forge/feedback/answers/claim";

/// One answer: the item's key and what its triage said.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Answered {
    pub key: String,
    pub answer: String,
}

#[derive(Debug, Deserialize)]
struct Claimed {
    answers: Vec<Answered>,
}

/// Claim the caller's untold answers, within `within`.
pub async fn claim(client: &CoreClient, within: std::time::Duration) -> Result<Vec<Answered>> {
    let what = "feedback answer claim";
    let resp = status::sent(
        client
            .post(CLAIM_PATH)
            .json(&serde_json::json!({}))
            .timeout(within),
        what,
    )
    .await?;
    let resp = status::checked(resp, what).await?;
    let parsed: Claimed = status::decode(resp, what).await?;
    Ok(parsed.answers)
}
