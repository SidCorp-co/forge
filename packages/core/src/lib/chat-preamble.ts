import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';

const BRANCH_SENTINEL = '<detect-from-git>';

/**
 * Tool reference block shared with the desktop runner. Trimmed from the
 * Strapi-era TOOL_REFERENCE — kept entries that map to MCP tools currently
 * shipping in core (`forge_issues`, `forge_comments`, `forge_memory`,
 * `forge_config`, `forge_skills`). Antigravity / Coolify / Cloudflare entries
 * removed since those subsystems are not on core today.
 */
export const TOOL_REFERENCE = `## Tool Reference
- **forge_issues** — list/get/create/update issues. update.documentId is required. Writable: title, description, status, priority, category, complexity, acceptanceCriteria, plan, sessionContext, relations.
- **forge_comments** — create requires issueDocumentId + body. list returns actor, body, isAI, timestamps.
- **forge_memory** — search/sync project + global memory. Strategies: semantic, keyword, graph, hybrid (default), auto.
- **forge_config** — read/write per-project settings: stagingBranch, repoPath, productionBranch, agentPrompt, enabledSkills, conventions, knowledgeIndex.
- **forge_skills** — list available skills + per-project enable/disable.`;

function formatProjectConfig(
  baseBranch: string | null,
  productionBranch: string | null,
): string {
  const b = baseBranch ?? BRANCH_SENTINEL;
  const p = productionBranch ?? BRANCH_SENTINEL;
  let out = `## Project Config\n- stagingBranch: ${b}\n- productionBranch: ${p}`;
  if (!baseBranch || !productionBranch) {
    out += `\n\nBranch detection: any value shown as \`${BRANCH_SENTINEL}\` is not configured. Before any git operation, run \`git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'\` and use the result instead. If detection fails, abort and ask the user via \`forge_config\`.`;
  }
  return out;
}

/**
 * Lightweight chat preamble for non-pipeline conversations started from web.
 * Strapi parity used `knowledgeIndex` + `conventions` columns that do not
 * exist in core's `projects` schema — we ship the project config block only
 * and let the agent fetch knowledge via `forge_config` if needed.
 */
export async function buildChatPreamble(projectId: string): Promise<string> {
  const [project] = await db
    .select({
      baseBranch: projects.baseBranch,
      productionBranch: projects.productionBranch,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return '';
  return `${formatProjectConfig(project.baseBranch, project.productionBranch)}\n\n---\n\n`;
}
