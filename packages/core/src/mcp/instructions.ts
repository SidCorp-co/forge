export const FORGE_MCP_INSTRUCTIONS = `You are connected to a Forge-managed project — Forge is the control plane for this repo's issues, pipeline, and durable memory. Prefer Forge MCP tools over guessing:

- Project memory is the cross-device source of truth and is NOT auto-loaded. At the start of any task needing project context, recall it first: forge_memory_search({ projectId, query: <topic>, topK: 5 }). Hits are point-in-time — verify against live code/git before trusting.
- For codebase & project knowledge, call \`forge_knowledge\` (list/get/search) before broad file search, and use forge_memory_search for accumulated knowledge.
- Project settings/secrets live in Forge, not the repo: test creds, preview + live URLs via \`forge_projects.get\` → \`environments\`; pipeline/process config via \`forge_config\` (never returns creds/URLs); project prose (build commands, rules, guides) via \`forge_knowledge\`, never \`forge_config\`.
- For issues / tasks / status, use forge_issues / forge_comments rather than inventing a tracker. Dependencies + draft-vs-open: \`forge_guide get issue-dependencies\`.
- Before writing, rewriting, or tuning this project's pipeline skills, read the \`forge-skills\` MCP prompt (the always-latest authoring guide).
- Forge capability guides are fetchable, not preloaded: \`forge_guide\` (action \`list\` → \`get <slug>\`), or \`<host>/api/guides/<slug>.md\`. Look one up before guessing how a Forge feature works.

This project's projectId is in the repo's CLAUDE.md.`;
