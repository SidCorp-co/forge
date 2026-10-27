use super::*;

/// The newest decisive record in this master's own conversation, however old.
/// The report to core takes it only while it is fresh; the re-ask reads it
/// whatever its age.
pub(crate) fn account_record(
    repo: &std::path::Path,
    conversation: Option<&str>,
    now_unix: i64,
) -> Option<master_limit::Decisive> {
    let id = conversation.filter(|c| !c.is_empty())?;
    let path = conversation_transcript(repo, id)?;
    let tail = master_limit::read_tail(&path)?;
    master_limit::newest_record(&tail, now_unix)
}

pub(crate) async fn report_account_limit(
    client: &CoreClient,
    said: &[master_limit::Decisive],
    now_unix: i64,
) {
    let Some(record) = master_limit::newest_wire(said, now_unix) else {
        return;
    };
    match master_api::send_limit_record(client, &record).await {
        Ok(answer) => match (answer.outcome.as_str(), &record) {
            ("reported", master_api::LimitRecord::Refused { reason, detail, .. }) => {
                tracing::warn!(
                    "[master] this box's Claude account is capped ({reason}) — core holds it: {detail}"
                );
            }
            ("cleared", _) => tracing::info!(
                "[master] this box's Claude account answered a turn — the limit core was holding is lifted"
            ),
            ("unreadable", master_api::LimitRecord::Unreadable { slug }) => tracing::warn!(
                "[master] this box's Claude account refused a turn with `{slug}`, which this binary has not been taught to read — nothing was reported, so core will go on calling this box healthy until it is taught that name"
            ),
            _ => {}
        },
        Err(e) => tracing::warn!(
            "[master] could not give core this box's account record: {e} — core decides nothing about the account until it can be reached, and this is sent again next sweep"
        ),
    }
}
