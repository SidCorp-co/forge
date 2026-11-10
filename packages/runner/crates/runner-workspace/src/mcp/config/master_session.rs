//! The session `--mcp-config` a master pane is started with.
//!
//! A master pane reaches Forge's MCP through the union of the checkout's `.mcp.json` and this
//! file. Where the checkout's git tracks `.mcp.json`, [`write_persistent`] puts no credential in
//! it (ISS-1193), so the `forge` server goes here instead: owner-only, under the runner's config
//! directory, which a confined session's view empties.

use super::*;

/// Write the session config a master pane started in `repo` for `slug` is handed: the servers
/// core declares for the project, and the `forge` server where the checkout's git tracks its
/// `.mcp.json`.
pub fn write_master_session(
    repo: &Path,
    slug: &str,
    declared: &serde_json::Map<String, Value>,
) -> Result<Option<PathBuf>> {
    let borrow = cli_borrow_path(slug).ok();
    write_master_session_in(&mcp_config_dir(), borrow.as_deref(), repo, slug, declared)
}

pub(crate) fn write_master_session_in(
    dir: &Path,
    borrow: Option<&Path>,
    repo: &Path,
    slug: &str,
    declared: &serde_json::Map<String, Value>,
) -> Result<Option<PathBuf>> {
    write_session_in(dir, slug, &pane_servers(borrow, repo, slug, declared))
}

/// `declared`, with the `forge` server added where `repo`'s git tracks `.mcp.json` and the
/// project declares no `forge` of its own. Its credential is the checkout's, from the file the
/// provision left at `borrow` for the project's panes; where there is none, nothing is added and
/// the pane's brief says `forge` is absent and why (`reach.rs:ForgeAbsentBecause`).
fn pane_servers(
    borrow: Option<&Path>,
    repo: &Path,
    slug: &str,
    declared: &serde_json::Map<String, Value>,
) -> serde_json::Map<String, Value> {
    let mut servers = declared.clone();
    if servers.contains_key(FORGE_SERVER) || !git_tracks(repo, ".mcp.json") {
        return servers;
    }
    let Some(borrow) = borrow else {
        tracing::warn!(
            slug,
            "mcp config: {} tracks .mcp.json and this box's config directory cannot be resolved, \
             so the master pane gets no `forge` server",
            repo.display()
        );
        return servers;
    };
    match read_borrow(borrow) {
        Ok(b) => {
            servers.insert(
                FORGE_SERVER.to_string(),
                forge_server(&b.url, &b.token, slug),
            );
        }
        Err(why) => tracing::warn!(
            slug,
            "mcp config: {} tracks .mcp.json, and the checkout credential at {} {why}, so the \
             master pane gets no `forge` server — re-provision the checkout",
            repo.display(),
            borrow.display()
        ),
    }
    servers
}
