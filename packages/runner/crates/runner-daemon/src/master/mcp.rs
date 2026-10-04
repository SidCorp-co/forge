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

/// ISS-1208 ends a deaf pane only where a replacement would be placed. A
/// declaration that could not be read withholds the replacement below, so the
/// pane is left standing rather than ended for a placement that is refused.
pub(crate) fn replacement_gate(act: CapabilityAct, servers_readable: bool) -> CapabilityAct {
    match act {
        CapabilityAct::Replace if !servers_readable => CapabilityAct::LeaveDeaf(
            "this box could not read the project's declared MCP servers, so no replacement would be placed in its stead",
        ),
        other => other,
    }
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
}

pub(crate) fn pane_config(
    asked: Option<&mcp_servers::ProjectMcpServers>,
    on_disk_matches: bool,
) -> PaneConfig {
    match asked {
        None => PaneConfig::Unknown,
        Some(_) if on_disk_matches => PaneConfig::Current,
        Some(_) => PaneConfig::Stale,
    }
}

pub(crate) fn report_stale_pane_config(
    masters: &Arc<Masters>,
    project_id: &str,
    name: &str,
    slug: &str,
    asked: Option<&mcp_servers::ProjectMcpServers>,
) {
    let on_disk_matches = asked
        .map(|d| runner_workspace::mcp::config::session_matches(slug, &d.mcp_servers))
        .unwrap_or(false);
    let declared = match pane_config(asked, on_disk_matches) {
        PaneConfig::Unknown => return,
        PaneConfig::Current => {
            if let Some(d) = asked {
                let _ = runner_workspace::mcp::config::write_session(slug, &d.mcp_servers);
            }
            masters.clear_mcp_stale(project_id);
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
