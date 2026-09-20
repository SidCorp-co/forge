import { env } from '../config/env.js';

/** The public, credential-free address of the guide corpus, on the web host.
 *  Named in the MCP instruction block so an agent that holds nothing but this
 *  server learns the corpus exists and that it can read it without a token —
 *  the discovery gap ISS-1124 was filed for. */
export function publicGuidesUrl(): string {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/guides`;
}

/** Built per call rather than frozen at import: `env` is read lazily here so
 *  this module stays side-effect free, and a deploy that changes APP_BASE_URL
 *  changes what agents are told. */
export function forgeMcpInstructions(): string {
  return `You are connected to a Forge-managed project — Forge is the control plane for this repo's issues, pipeline, and durable memory. Prefer Forge MCP tools over guessing:

- Project memory is the cross-device source of truth and is NOT auto-loaded. At the start of any task needing project context, recall it first: forge_memory_search({ projectId, query: <topic>, topK: 5 }). Hits are point-in-time — verify against live code/git before trusting.
- For codebase & project knowledge, call \`forge_knowledge\` (list/get/search) before broad file search, and use forge_memory_search for accumulated knowledge.
- Project settings/secrets live in Forge, not the repo: test creds, preview + live URLs via \`forge_projects.get\` → \`environments\`; pipeline/process config via \`forge_config\` (never returns creds/URLs); project prose (build commands, rules, guides) via \`forge_knowledge\`, never \`forge_config\`.
- For issues / tasks / status, use forge_issues / forge_comments rather than inventing a tracker. Dependencies + draft-vs-open: \`forge_guide get issue-dependencies\`.
- Before writing, rewriting, or tuning this project's pipeline skills, read the \`forge-skills\` MCP prompt (the always-latest authoring guide).
- Forge capability guides are fetchable, not preloaded: \`forge_guide\` (action \`list\` → \`get <slug>\`), or \`<host>/api/guides/<slug>.md\`. Look one up before guessing how a Forge feature works.
- The whole guide corpus is public and needs no credential — no token, no session, no login. Readable pages for a person at ${publicGuidesUrl()}, the same bytes as markdown at \`<host>/api/guides/<slug>.md\`, and the index at \`<host>/api/guides\`. Hand that URL to anyone; it is also where to point an agent that does not hold this server.

This project's projectId is in the repo's CLAUDE.md.`;
}
