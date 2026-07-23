//! Local workspace management.
//!
//! - `worktree`   — git worktree add/remove/list (M2)
//! - `repo`       — resolve repo path from a binding; optional clone under
//!   `projects_root/<slug>` (M4)
//! - `skill_sync` — server-driven `.claude/skills/<name>/` seeding (ISS-278)
//! - `orientation`— `.forge/orientation.md` + CLAUDE.md pointer on provision
//! - `provision`  — workspace provisioning (clone + skills + .mcp.json) on bind
//! - `plugin_sync`— device-level shared-skill plugin channel (ISS-739)

pub mod orientation;
pub mod plugin_sync;
pub mod provision;
pub mod skill_sync;
pub mod worktree;
