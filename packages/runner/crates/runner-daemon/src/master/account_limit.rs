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

/// The line a limit re-ask is announced by.
///
/// The reset is said and never waited on: the account can be swapped, topped
/// up or re-planned before it, and only the turn this nudge starts can tell.
/// The pane's `forge` CLI borrows the account its checkout was provisioned with,
/// so it reaches this project as the agent the pane's MCP server is — or, where
/// the provision left none, nothing is set and it reads its home's own account.
pub(crate) fn cli_borrow_env(slug: &str) -> Option<(String, String)> {
    let path = runner_workspace::mcp::config::cli_borrow_path(slug).ok()?;
    if !path.is_file() {
        tracing::warn!(
            "[master] {slug}: no checkout credential at {} — this pane's forge CLI reads the box's own account, which may not reach {slug}; re-provision the checkout",
            path.display()
        );
        return None;
    }
    Some((
        runner_workspace::mcp::config::CLI_BORROW_VAR.to_string(),
        path.to_string_lossy().into_owned(),
    ))
}

pub(crate) fn limit_reask_line(slug: &str, pane: &str, refusal: &master_limit::Refusal) -> String {
    let reset = match refusal.resets_in_seconds {
        Some(secs) => format!("the account reports its reset in {secs}s"),
        None => "the account reported no reset".to_string(),
    };
    format!(
        "[master] {slug}: its last turn was refused ({}) — asking {pane} again; {reset}, and capacity restored before then is seen only by a turn that tries",
        refusal.reason.wire()
    )
}

pub(crate) const REPORT_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) async fn bounded<F>(call: F) -> runner_platform::error::Result<()>
where
    F: std::future::Future<Output = runner_platform::error::Result<()>>,
{
    match tokio::time::timeout(REPORT_TIMEOUT, call).await {
        Ok(result) => result,
        Err(_) => Err(runner_platform::error::Error::Other(format!(
            "core did not answer within {}s",
            REPORT_TIMEOUT.as_secs()
        ))),
    }
}

pub(crate) async fn report_account_limit(
    client: &CoreClient,
    served: &[runners::MeRunner],
    said: &[master_limit::Decisive],
    memo: &mut Option<String>,
    now_unix: i64,
) {
    let core_limited = served.iter().any(|r| r.limit_reason.is_some());
    match master_limit::decide(said, core_limited, memo.as_deref(), now_unix) {
        master_limit::Action::Nothing => {}
        master_limit::Action::Unreadable(slug) => tracing::warn!(
            "[master] this box's Claude account refused a turn with `{slug}`, which this binary has not been taught to read — nothing was reported, so core will go on calling this box healthy until it is taught that name"
        ),
        master_limit::Action::Report(r, uuid) => {
            let sent = bounded(master_api::report_limit(
                client,
                r.reason.wire(),
                r.resets_in_seconds,
                &r.detail,
            ))
            .await;
            match sent {
                Ok(()) => {
                    tracing::warn!(
                        "[master] this box's Claude account is capped ({}{}) — reported to core: {}",
                        r.reason.wire(),
                        match r.resets_in_seconds {
                            Some(secs) => format!(", {secs}s to go"),
                            None => String::new(),
                        },
                        r.detail
                    );
                    *memo = Some(uuid);
                }
                Err(e) => tracing::warn!(
                    "[master] could not tell core this box's account is capped: {e} — sending it again next sweep"
                ),
            }
        }
        master_limit::Action::Clear => match bounded(master_api::clear_limit(client)).await {
            Ok(()) => {
                tracing::info!(
                    "[master] this box's Claude account answered a turn — the limit core was holding is lifted"
                );
                *memo = None;
            }
            Err(e) => tracing::warn!(
                "[master] could not lift this box's account limit at core: {e} — trying again next sweep"
            ),
        },
    }
}
