//! Local workspace management.
//!
//! - `worktree`   — git worktree add/remove/list (M2)
//! - `repo`       — resolve repo path from a binding; optional clone under
//!   `projects_root/<slug>` (M4)
//! - `skill_sync` — server-driven `.claude/skills/<name>/` seeding (ISS-278)
//! - `bundled_skills` — the autonomous skill set embedded in this binary
//! - `orientation`— `.forge/orientation.md` + CLAUDE.md pointer on provision
//! - `provision`  — workspace provisioning (clone + skills + .mcp.json) on bind
//! - `plugin_sync`— device-level shared-skill plugin channel (ISS-739)
//! - `refresh`    — fetch + fast-forward before an agent reads the workspace

pub mod bundled_skills;
pub mod orientation;
pub mod plugin_sync;
pub mod provision;
pub mod refresh;
pub mod skill_sync;
pub mod verdict;
pub mod worktree;
