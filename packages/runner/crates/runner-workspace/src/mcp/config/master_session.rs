//! The session `--mcp-config` a master pane is started with.

use super::*;

/// Write the session config a master pane started in `repo` for `slug` is handed, from the
/// servers core declares for the project.
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
    _borrow: Option<&Path>,
    _repo: &Path,
    slug: &str,
    declared: &serde_json::Map<String, Value>,
) -> Result<Option<PathBuf>> {
    write_session_in(dir, slug, declared)
}
