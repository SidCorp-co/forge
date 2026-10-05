//! Local workspace management.
//!
//! - `worktree`   — git worktree add/remove/list (M2)
//! - `worktree_processes` — who is living in a checkout, ended before it is given
//!   back or named where they cannot be (ISS-1271)
//! - `repo`       — resolve repo path from a binding; optional clone under
//!   `projects_root/<slug>` (M4)
//! - `skill_sync` — server-driven `.claude/skills/<name>/` seeding (ISS-278)
//! - `orientation`— `.forge/orientation.md` + CLAUDE.md pointer on provision
//! - `provision`  — workspace provisioning (clone + skills + .mcp.json) on bind
//! - `plugin_sync`— device-level shared-skill plugin channel (ISS-739)
//! - `refresh`    — fetch + fast-forward before an agent reads the workspace
//! - `repo_cred`  — the credential a repository is configured to push with, named
//!   rather than inherited
//! - `salvage`    — commit + push a failed job's uncommitted work
//! - `trust`      — pre-accept Claude Code's workspace-trust dialog for a checkout
pub mod close_loop;
pub mod composer;
pub mod git_cred;
pub mod git_exclude;
pub mod headroom;
pub mod held_report;
pub mod hook_install;
pub mod master_skill;
pub mod mcp;
pub mod orientation;
pub mod pairing;
pub mod plugin_sync;
pub mod provision;
pub mod refresh;
pub mod repo_cred;
pub mod salvage;
pub mod skill_sync;
pub mod terminal;
pub mod terminate;
pub mod trust;
pub mod worktree;
pub mod worktree_processes;
pub mod worktree_reap;
