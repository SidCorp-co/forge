import { env } from '../config/env.js';

/** The public, credential-free address of the guide corpus, on the web host. */
export function publicGuidesUrl(): string {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/guides`;
}

/** Built per call so `env` is read lazily and this module stays side-effect free. */
export function forgeMcpInstructions(): string {
  return `You are connected to a Forge-managed project — Forge is the control plane for this repo's issues, pipeline, and durable memory. The REST API (\`<host>/api/...\`, a personal access token as \`Authorization: Bearer\`) is the primary door and the \`forge\` CLI sits on it; this server carries only what neither covers:

- \`forge_agent_report\` — report friction, a skill gap or a learning mid-run (\`submit\` reads your live job or session context).
- \`forge_uploads\` — read an issue, comment or session attachment; an image comes back as a viewable block.
- \`forge_channel\` and \`forge_ecosystem\` — a project's channel inside its ecosystem: what it owes a reply to (\`forge_channel action=unanswered\`), gates, and the contract context. How a master works the inbox: \`GET <host>/api/guides/ecosystem-inbox.md\`.
- \`forge_source\`, \`forge_coolify_deploy\`, \`forge_sentry\`, \`forge_google_sheets\`, \`forge_storefront_target\` — a connected integration whose credential stays in core.

Everything else is REST or the CLI:
- Project memory is NOT auto-loaded. At the start of any task needing project context, recall it first: \`POST /api/memory/search\` \`{ projectId, query, topK: 5 }\`. Hits are point-in-time — verify against live code/git before trusting, then report it at \`POST /api/memory/feedback\`.
- Project prose (build commands, rules, guides): \`/api/projects/:id/knowledge\` or \`forge knowledge\`. Settings: \`GET /api/projects/:id/config\` → \`projectDocument\` (environments, their URLs, promotions and the testing profile each names; a testing profile holds \`secret://\` references, never a credential).
- Issues, comments, status and dependencies: \`/api/projects/:id/issues\`, \`/api/issues/:id\`, \`/api/issues/:id/comments\`, or \`forge issue\` / \`forge new\` / \`forge comment\`. A person's comment on an issue is owed a reply, at any status but closed or dropped, until an agent comments on that issue after it.
- Before writing, rewriting, or tuning this project's pipeline skills, read the \`forge-skills\` MCP prompt (the always-latest authoring guide).
- Forge capability guides are fetchable, not preloaded: \`<host>/api/guides\` lists them and \`<host>/api/guides/<slug>.md\` reads one. Look one up before guessing how a Forge feature works. The corpus is public and needs no credential; readable pages for a person are at ${publicGuidesUrl()}.

This project's projectId is in the repo's CLAUDE.md.`;
}
