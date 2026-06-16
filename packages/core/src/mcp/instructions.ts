/**
 * Server-level orientation surfaced to EVERY session connected to Forge MCP.
 *
 * The MCP `instructions` field is auto-loaded into the session context by
 * Claude Code (CLI/IDE) and the desktop chat, so this is how a human running
 * `claude` in a Forge-managed consumer repo learns to use Forge optimally
 * (pipeline jobs already get a richer per-stage preamble; see
 * `prompt/system.ts`). Keep it tight — it costs context tokens on every
 * connected session. Generic by design: this project's projectId lives in the
 * repo's CLAUDE.md, not here, so the string stays cache-shareable across
 * projects.
 *
 * Kept in its own dependency-free module so the parity test (`server.test.ts`)
 * can import it without pulling in the DB-backed tool graph. Pinned there.
 */
export const FORGE_MCP_INSTRUCTIONS = `You are connected to a Forge-managed project — Forge is the control plane for this repo's issues, pipeline, and durable memory. Prefer Forge MCP tools over guessing:

- Project memory is the cross-device source of truth and is NOT auto-loaded. At the start of any task needing project context, recall it first: forge_memory_search({ projectId, query: <topic>, topK: 5 }). Hits are point-in-time — verify against live code/git before trusting.
- For codebase orientation (architecture, key files, conventions), call forge_config with action get_knowledge BEFORE broad file search — it returns pre-indexed context.
- For issues / tasks / status / dependencies, use forge_issues, forge_comments, forge_pm_* rather than inventing a tracker.
- Before writing, rewriting, or tuning this project's pipeline skills, read the \`forge-skills\` MCP prompt (the always-latest authoring guide).

This project's projectId is in the repo's CLAUDE.md.`;
