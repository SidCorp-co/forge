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
- For codebase & project knowledge, call \`forge_knowledge\` (list/get/search) before broad file search, and use forge_memory_search for accumulated knowledge.
- For issues / tasks / status, use forge_issues / forge_comments rather than inventing a tracker. Encode ordering between issues as a \`forge_project_pm action=set_dependency kind:blocks\` edge (NOT prose — only a blocks edge gates dispatch); record a note/follow-up as a \`draft\` issue (NOT \`open\`, which auto-triages a pipeline run).
- Before writing, rewriting, or tuning this project's pipeline skills, read the \`forge-skills\` MCP prompt (the always-latest authoring guide).

This project's projectId is in the repo's CLAUDE.md.`;
