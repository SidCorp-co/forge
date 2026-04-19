/**
 * Pipeline Preamble
 *
 * Pre-fetches project knowledge + conventions and builds a shared preamble
 * for pipeline prompts. Used by both desktop and Antigravity runners.
 *
 * Why: skills previously told agents to call forge_config get_knowledge and
 * get_conventions as their first actions. This cost 2-3 tool calls per step,
 * and the large responses sat in conversation history replaying on every
 * subsequent turn in resumed sessions. Pre-fetching and inlining eliminates
 * those tool calls and keeps the data in the prompt (cacheable) instead of
 * tool_result blocks (verbose, not cacheable).
 */

const PROJECT_UID = 'api::project.project' as any;

/**
 * Pre-fetch knowledge and conventions for a project.
 * Returns raw data — caller decides how to format.
 */
async function fetchProjectContext(strapi: any, projectDocumentId: string): Promise<{
  knowledge: any | null;
  conventions: string | null;
  baseBranch: string;
  productionBranch: string;
}> {
  const project = await strapi.documents(PROJECT_UID).findOne({
    documentId: projectDocumentId,
    fields: ['knowledgeIndex', 'conventions', 'baseBranch', 'productionBranch'],
  });

  return {
    knowledge: project?.knowledgeIndex || null,
    conventions: project?.conventions || null,
    baseBranch: project?.baseBranch || 'main',
    productionBranch: project?.productionBranch || 'master',
  };
}

/**
 * Extended tool usage guide. Supplements the short MCP tool descriptions
 * with parameter requirements and semantics that agents need to make correct calls.
 * Shared across pipeline preamble and chat system prompt.
 */
export const TOOL_REFERENCE = `## Tool Reference
- **forge_issues** — list: returns issueId, documentId, title, status, priority, category, taskCount, timestamps (use filters: search, status, statusNot, priority, category, createdAfter/Before, updatedAfter). get: requires documentId, returns full issue with description, plan, acceptanceCriteria, sessionContext, relations, complexity. create: requires data.title, auto-sets status open + priority medium. update: requires documentId + data object. Writable fields: title, description, status, priority, category, complexity (Simple/Medium/Complex), acceptanceCriteria, plan (markdown), sessionContext (object), attachments (media IDs array), relations (array of {type, targetDocumentId, reason}).
- **forge_comments** — create: requires issueDocumentId + body. list: requires issueDocumentId, returns comments with actor, body, isAI, timestamps.
- **forge_memory** — Role hierarchy (high→low): ceo→cto→pm→po→techlead→dev→qa→devops. Visibility: "down"=roles below see it, "up"=roles above, "same"=same role, "all"=everyone. Scope: "user"=this user, "project"=this project, "global"=all projects. Search strategies: semantic (vector), keyword (BM25+entity), graph (knowledge graph), hybrid (default, combined RRF), auto (intent-based). sync returns memories as markdown. CEO directives: role:ceo, scope:global, visibility:down.
- **forge_config** — Settable fields: baseBranch, repoPath, productionBranch, previewDeploy, pipelineConfig, crossProjectAccess, projectMeta, defaultProvider, agentProvider, agentPrompt, agentMemoryEnabled, coolifyResources, sentryProject, antigravityProjectId, webhookUrl, webhookSecret, webhookStatuses, enabledSkills, conventions, knowledgeIndex, pipelineSteps.
- **forge_coolify_deploy** — deploy: by uuid/name or all if omitted. start/stop/restart: requires uuid. set-env: requires uuid+key+value. delete-env: requires uuid+env_uuid. cancel-deploy: requires deployment_uuid. logs: optional uuid+lines.
- **forge_pipeline** — unstick: retrigger issues stuck at auto-pipeline statuses for >staleDays (default 1). heartbeat-config: get/set heartbeat config (enabled, intervalSeconds, paused). Scope: "global" or "project" (default).
- **forge_claude** — runner: "desktop" (Claude CLI), "antigravity" (server-side), or omit for auto-routing. Use targetProjectSlug for cross-project runs (requires crossProjectAccess).
- **forge_cloudflare** — list_accounts (all configured), list_zones (zones for account), zone_details (zone info), dns_list/dns_create/dns_update/dns_delete (DNS records), purge_cache (zone cache).
- **forge_schedule** — Jobs execute prompts on a cron schedule via desktop/antigravity runners.
- **forge_projects** — antigravity_exclude/antigravity_include: toggle project assignment on an antigravity runner.`;

/**
 * Shared pipeline rules included in every pipeline prompt.
 * Extracted from individual skills to avoid duplication across steps.
 */
const PIPELINE_RULES = `## Pipeline Rules
- **Status LAST.** Always set issue status as the final action — it triggers the next pipeline step.
- **Branch discipline.** Run \`git branch --show-current\` + \`git status\` before any checkout. Branch from baseBranch: \`git checkout <baseBranch> && git pull && git checkout -b ISS-XX-short-title\`. Never switch branches mid-work.
- **ISS-* branch is source of truth.** Kept alive through the pipeline. Merges to baseBranch for staging. Squash-merges to productionBranch at release.
- **Fetch issue first.** Never assume data from the prompt — always fetch via forge_issues.

## Capture Learnings
When encountering a non-obvious pattern, convention violation, or fix worth teaching future agents:
1. Search forge_memory first (strategy \`keyword\`, scoped to current skill, limit 3).
2. If no result scores > 0.8, add via forge_memory (role appropriate to skill, category \`correction\` or \`convention\`).
Filter: would this help a DIFFERENT agent on a DIFFERENT issue? If not, skip.

## Session Context (coding/fix tasks)
Before your final status update, update the issue's sessionContext via forge_issues:
\`{ currentState, decisions, filesModified, errorsResolved, reviewFeedback, sessionCount, lastUpdated }\`
Merge with existing: increment sessionCount, append to arrays (skip duplicates), replace currentState. Cap arrays at 20.

## Output Rules
- Zero narration. Tool calls are self-documenting.
- Code only while implementing. No explanations between edits.
- Never repeat file contents after reading — just edit.
- One-line status at the end (e.g. "Plan written, set approved." or "Fix applied, pushed, set deploying.").
- Comments go to forge_comments, not to chat output.

${TOOL_REFERENCE}`;

/**
 * Build the pipeline preamble for desktop runner prompts.
 * Only pipeline rules + project config (branches). Knowledge and conventions
 * are fetched by skills via forge_config when needed.
 */
export async function buildDesktopPreamble(
  strapi: any,
  projectDocumentId: string,
): Promise<string> {
  const { baseBranch, productionBranch } = await fetchProjectContext(strapi, projectDocumentId);
  const projectConfig = `## Project Config\n- baseBranch: ${baseBranch}\n- productionBranch: ${productionBranch}`;
  return `${PIPELINE_RULES}\n\n${projectConfig}\n\n---\n\n`;
}

/**
 * Build the context section for Antigravity runner prompts.
 * Only pipeline rules + project config (branches). Knowledge and conventions
 * are fetched by skills via forge_config when needed.
 */
export async function buildAntigravityContext(
  strapi: any,
  projectDocumentId: string,
): Promise<string> {
  const { baseBranch, productionBranch } = await fetchProjectContext(strapi, projectDocumentId);
  const projectConfig = `## Project Config\n- baseBranch: ${baseBranch}\n- productionBranch: ${productionBranch}`;
  return `${PIPELINE_RULES}\n\n${projectConfig}`;
}

/**
 * Build a lightweight preamble for non-pipeline chat sessions.
 * Just project context (knowledge + conventions) — no pipeline rules,
 * no branch discipline, no session context save, no output rules.
 * For manual chats started from the web UI or REST API.
 */
export async function buildChatPreamble(
  strapi: any,
  projectDocumentId: string,
): Promise<string> {
  const { knowledge, conventions, baseBranch, productionBranch } =
    await fetchProjectContext(strapi, projectDocumentId);

  if (!knowledge && !conventions) return '';

  const sections: string[] = [];

  if (knowledge) {
    const knowledgeStr = typeof knowledge === 'string' ? knowledge : JSON.stringify(knowledge);
    const capped = knowledgeStr.length > 4000
      ? knowledgeStr.slice(0, 4000) + '\n... (truncated)'
      : knowledgeStr;
    sections.push(`## Codebase Knowledge\n${capped}`);
  }

  if (conventions) {
    const capped = conventions.length > 2000
      ? conventions.slice(0, 2000) + '\n... (truncated)'
      : conventions;
    sections.push(`## Conventions\n${capped}`);
  }

  sections.push(`## Project\n- baseBranch: ${baseBranch}\n- productionBranch: ${productionBranch}`);

  return sections.join('\n\n') + '\n\n---\n\n';
}
