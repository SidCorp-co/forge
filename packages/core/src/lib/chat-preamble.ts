import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { estimateTokens } from './token-estimator.js';

export type PreambleBlockId = 'pipeline-rules' | 'tool-reference' | 'project-config';

export interface PreambleBlock {
  id: PreambleBlockId;
  kind: 'system' | 'user';
  chars: number;
  estTokens: number;
}

export interface BuiltPreamble {
  content: string;
  blocks: PreambleBlock[];
}

const BRANCH_SENTINEL = '<detect-from-git>';

/**
 * Pipeline rules — pinned at the top of every pipeline system prompt. Stable
 * across all jobs of a project so Claude API prompt cache (TTL 5min) hits
 * for the 2nd+ job in the window. Do NOT inline per-issue dynamic content
 * here — anything dynamic belongs in the user prompt (`-p`).
 */
export const PIPELINE_RULES = `## Pipeline Rules
- **Status LAST.** Always set issue status as the final action — it triggers the next pipeline step.
- **Branch discipline.** Run \`git branch --show-current\` + \`git status\` before any checkout. Branch from \`baseBranch\`: \`git checkout <baseBranch> && git pull && git checkout -b ISS-XX-short-title\`. Never switch branches mid-work.
- **ISS-* branch is source of truth.** Kept alive through the pipeline. Squash-merges to \`productionBranch\` at release.
- **Fetch issue first.** Never assume data from the prompt — always fetch via \`forge_issues.get\` for the full body.

## Capture Learnings
When encountering a non-obvious pattern, convention violation, or fix worth teaching future agents:
1. Search \`forge_memory\` first (strategy \`keyword\`, scoped to current skill, limit 3).
2. If no result scores > 0.8, add via \`forge_memory\` (role appropriate to skill, category \`correction\` or \`convention\`).
Filter: would this help a DIFFERENT agent on a DIFFERENT issue? If not, skip.

## Session Context (coding / fix / review tasks)
Before your final status update, update \`issues.sessionContext\` via \`forge_issues.update\`:
\`{ currentState, decisions, filesModified, errorsResolved, reviewFeedback, sessionCount, lastUpdated }\`
Merge with existing: increment sessionCount, append to arrays (skip duplicates), replace currentState. Cap arrays at 20.

## Output Rules
- Zero narration. Tool calls are self-documenting.
- Code only while implementing. No explanations between edits.
- Never repeat file contents after reading — just edit.
- One-line status at the end (e.g. "Plan written, set approved." or "Fix applied, pushed, set deploying.").
- Comments go to \`forge_comments.create\`, not to chat output.`;

/**
 * Tool reference block — kept entries that map to MCP tools currently
 * shipping in core. Trimmed from the Strapi-era TOOL_REFERENCE (Antigravity
 * / Coolify / Cloudflare entries removed; not on core today).
 */
export const TOOL_REFERENCE = `## Tool Reference
- **forge_issues** — list/get/create/update issues. update.documentId is required. Writable: title, description, status, priority, category, complexity, acceptanceCriteria, plan, sessionContext, relations.
- **forge_comments** — create requires issueDocumentId + body. list returns actor, body, isAI, timestamps.
- **forge_memory** — search/sync project + global memory. Strategies: semantic, keyword, graph, hybrid (default), auto.
- **forge_config** — read/write per-project settings: baseBranch, repoPath, productionBranch, agentPrompt, enabledSkills, conventions, knowledgeIndex.
- **forge_skills** — list available skills + per-project enable/disable.`;

function formatProjectConfig(
  baseBranch: string | null,
  productionBranch: string | null,
): string {
  const b = baseBranch ?? BRANCH_SENTINEL;
  const p = productionBranch ?? BRANCH_SENTINEL;
  let out = `## Project Config\n- baseBranch: ${b}\n- productionBranch: ${p}`;
  if (!baseBranch || !productionBranch) {
    out += `\n\nBranch detection: any value shown as \`${BRANCH_SENTINEL}\` is not configured. Before any git operation, run \`git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'\` and use the result instead. If detection fails, abort and ask the user via \`forge_config\`.`;
  }
  return out;
}

async function loadProjectBranches(projectId: string): Promise<{
  baseBranch: string | null;
  productionBranch: string | null;
} | null> {
  // Wrap in try/catch so a transient DB hiccup or test mock that doesn't
  // stub this specific SELECT chain doesn't block dispatch — we still want
  // the static PIPELINE_RULES + TOOL_REFERENCE to ship.
  try {
    const [project] = await db
      .select({
        baseBranch: projects.baseBranch,
        productionBranch: projects.productionBranch,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return project ?? null;
  } catch {
    return null;
  }
}

/**
 * Lightweight chat preamble for non-pipeline conversations started from web.
 * Strapi parity used `knowledgeIndex` + `conventions` columns that do not
 * exist in core's `projects` schema — we ship the project config block only
 * and let the agent fetch knowledge via `forge_config` if needed.
 */
export async function buildChatPreamble(projectId: string): Promise<string> {
  const project = await loadProjectBranches(projectId);
  if (!project) return '';
  return `${formatProjectConfig(project.baseBranch, project.productionBranch)}\n\n---\n\n`;
}

/**
 * Pipeline preamble — bigger, stable, cacheable. Combines:
 *   PIPELINE_RULES + TOOL_REFERENCE + Project Config (branches)
 *
 * Stamped on every pipeline job dispatch and passed to the runner as the
 * Claude CLI `--append-system-prompt`. Content is identical across jobs of
 * the same project (until branches change), so Claude API prompt cache
 * (5-min TTL) hits for the 2nd+ job in a window — ~90% saving on the
 * cached system block input cost.
 *
 * Per-issue dynamic content (issue body, sessionContext) belongs in the
 * USER prompt (`-p`), not here — otherwise cache misses on every job.
 */
export async function buildPipelinePreamble(projectId: string): Promise<string> {
  const project = await loadProjectBranches(projectId);
  if (!project) {
    // Project gone or RLS denied. Return rules + tools without project block;
    // worker can still operate but will rely on forge_config.get_knowledge.
    return `${PIPELINE_RULES}\n\n${TOOL_REFERENCE}`;
  }
  return [
    PIPELINE_RULES,
    TOOL_REFERENCE,
    formatProjectConfig(project.baseBranch, project.productionBranch),
  ].join('\n\n');
}

/**
 * Structured variant of buildPipelinePreamble. Returns the same joined
 * string plus a per-block breakdown (chars + estTokens) for the prompt
 * snapshot stored on `jobs.prompt_blocks` (Surface A / Surface C analytics).
 *
 * Kept independent of `buildPipelinePreamble` — duplicating ~3 lines is
 * cheaper than refactoring the heavily-tested existing function.
 */
export async function buildPipelinePreambleStructured(projectId: string): Promise<BuiltPreamble> {
  const project = await loadProjectBranches(projectId);
  const sections: Array<{ id: PreambleBlockId; body: string }> = [
    { id: 'pipeline-rules', body: PIPELINE_RULES },
    { id: 'tool-reference', body: TOOL_REFERENCE },
  ];
  if (project) {
    sections.push({
      id: 'project-config',
      body: formatProjectConfig(project.baseBranch, project.productionBranch),
    });
  }
  const content = sections.map((s) => s.body).join('\n\n');
  const blocks: PreambleBlock[] = sections.map((s) => ({
    id: s.id,
    kind: 'system',
    chars: s.body.length,
    estTokens: estimateTokens(s.body),
  }));
  return { content, blocks };
}
