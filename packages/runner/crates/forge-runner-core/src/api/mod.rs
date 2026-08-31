//! `forge-runner api` — the whole REST surface, reachable from a shell.
//!
//! Step 3 of `docs/proposals/cli-data-surface.html`: an escape hatch in the
//! shape of `gh api`, so a new endpoint is callable the day it ships instead
//! of the day a subcommand is written for it. It is the piece that makes
//! step 4 — deleting an MCP tool — a per-tool decision rather than one
//! blocked on a complete subcommand surface.
//!
//! Two things it standardises, because the proposal says the transport layer
//! is where standardising belongs: the `{ code, message, details }` error
//! body that `middleware/error.ts` emits, and whether the caller should try
//! again. Both leave as an exit code AND as JSON on stderr, so a skill can
//! branch on `$?` and a program can parse the reason.

mod exit;
mod request;

pub use exit::{classify, is_json, usage_failure, Outcome, EXIT_TAXONOMY};
pub use request::{run, Request, Response};
