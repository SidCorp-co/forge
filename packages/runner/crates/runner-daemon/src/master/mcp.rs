use super::*;

/// What core answered about this project's declared MCP servers, or why it
/// could not be asked. Kept as the failure's own text so the refusal that
/// follows can name it.
pub(crate) type ServersRead = std::result::Result<mcp_servers::ProjectMcpServers, String>;

pub(crate) async fn project_mcp_servers(client: &CoreClient, project_id: &str) -> ServersRead {
    mcp_servers::fetch(client, project_id)
        .await
        .map_err(|e| e.to_string())
}

/// The declaration a new pane may be started with, or the reason none may be.
///
/// There is no third answer. Reading a failure as an empty declaration is what
/// started masters carrying none of their project's servers (ISS-1235).
pub(crate) fn servers_for_start(
    asked: &ServersRead,
) -> std::result::Result<&mcp_servers::ProjectMcpServers, Unplaced> {
    asked
        .as_ref()
        .map_err(|detail| Unplaced::ServersUnreadable {
            detail: detail.clone(),
        })
}

/// Whether this box can honestly describe what it is about to hand a pane.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LaunchRecord {
    /// The file on disk says exactly what the pane will be given.
    Truthful,
    /// The config could not be written, the project declares nothing, and the
    /// record now says the pane gets nothing — which is what it was owed.
    NoneAndSaysSo,
    /// The config could not be written and the project declares servers the
    /// pane would then lack, so no pane is started (ISS-1235).
    Withheld,
    /// A record of OTHER servers survives that the pane will not carry.
    Lying,
}

pub(crate) fn launch_record(wrote: bool, cleared: bool, declares_any: bool) -> LaunchRecord {
    match (wrote, cleared, declares_any) {
        (true, _, _) => LaunchRecord::Truthful,
        (false, false, _) => LaunchRecord::Lying,
        (false, true, true) => LaunchRecord::Withheld,
        (false, true, false) => LaunchRecord::NoneAndSaysSo,
    }
}

/// What a sweep may conclude about a live pane's MCP configuration.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PaneConfig {
    /// Core could not be asked, so nothing about this pane is known.
    Unknown,
    /// The pane carries what core resolves now.
    Current,
    /// The pane cannot carry what core resolves now: an operator must end it.
    Stale,
    /// The session file exists and cannot be read, so whether the pane carries
    /// what core resolves is not known. Neither current nor rewritten over.
    Unreadable(String),
}

pub(crate) fn pane_config(
    asked: Option<&mcp_servers::ProjectMcpServers>,
    on_disk: Option<runner_workspace::mcp::config::SessionConfigRead>,
) -> PaneConfig {
    use runner_workspace::mcp::config::SessionConfigRead as Read;
    match (asked, on_disk) {
        (None, _) | (Some(_), None) => PaneConfig::Unknown,
        (Some(_), Some(Read::Matches)) => PaneConfig::Current,
        (Some(_), Some(Read::Differs)) => PaneConfig::Stale,
        (Some(_), Some(Read::Unreadable(why))) => PaneConfig::Unreadable(why),
    }
}

pub(crate) fn report_stale_pane_config(
    masters: &Arc<Masters>,
    project_id: &str,
    name: &str,
    slug: &str,
    asked: Option<&mcp_servers::ProjectMcpServers>,
) {
    let on_disk =
        asked.map(|d| runner_workspace::mcp::config::read_session_config(slug, &d.mcp_servers));
    let declared = match pane_config(asked, on_disk) {
        PaneConfig::Unknown => return,
        PaneConfig::Current => {
            if let Some(d) = asked {
                let _ = runner_workspace::mcp::config::write_session(slug, &d.mcp_servers);
            }
            masters.clear_mcp_stale(project_id);
            return;
        }
        PaneConfig::Unreadable(why) => {
            if masters.claim_mcp_stale(project_id) {
                tracing::error!(
                    "[master] {slug}: the resident session {name}'s MCP session file cannot be read ({why}), so whether its runs carry the servers core resolves is NOT known and the file is left as it is. Fix the file's permissions or remove it, or end the pane with `forge-runner master kill {slug}`."
                );
            }
            return;
        }
        PaneConfig::Stale => asked.expect("Stale is only reachable with an answer"),
    };
    if !masters.claim_mcp_stale(project_id) {
        return;
    }
    tracing::error!(
        "[master] {slug}: the resident session {name} was started before this project's MCP servers were resolved, or before they last changed, so its runs do NOT have {}. A pane cannot be told a new MCP config — end it with `forge-runner master kill {slug}`, which reaches the tmux server masters run on where a bare `tmux kill-session` does not, and the next sweep starts one that carries them.",
        if declared.resolved_names.is_empty() {
            "the servers it now declares".to_string()
        } else {
            declared.resolved_names.join(", ")
        }
    );
}

#[cfg(test)]
mod pane_config_tests {
    use super::*;
    use runner_workspace::mcp::config::SessionConfigRead as Read;

    #[test]
    fn an_unreadable_session_file_is_never_current() {
        let asked = mcp_servers::ProjectMcpServers::default();
        assert_eq!(
            pane_config(Some(&asked), Some(Read::Unreadable("denied".into()))),
            PaneConfig::Unreadable("denied".into())
        );
        assert_eq!(
            pane_config(Some(&asked), Some(Read::Matches)),
            PaneConfig::Current
        );
        assert_eq!(
            pane_config(Some(&asked), Some(Read::Differs)),
            PaneConfig::Stale
        );
        assert_eq!(pane_config(None, None), PaneConfig::Unknown);
    }
}
