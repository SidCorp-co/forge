/**
 * SSOT for system-prompt assembly across all callers (pipeline dispatcher,
 * chat preview, interactive sessions, MCP `forge_config.preview_prompt`).
 *
 * Static prefix order — kept stable so Anthropic API prompt cache (5-min TTL)
 * hits across jobs of the same project:
 *   1. PIPELINE_RULES        — process discipline (status LAST, branch, etc.)
 *   2. TOOL_REFERENCE        — MCP tool catalogue
 *   3. Project Config block  — baseBranch / productionBranch
 *
 * Per-state extras (operator-defined in `appConfig.pipeline.states[state].systemPrompt`):
 *   - mode `append` (default) — appended AFTER the static prefix; cache prefix
 *     still hits up to the last shared char.
 *   - mode `replace` — operator-controlled prompt OVERRIDES the static
 *     prefix entirely. Cache misses on every job. UI surfaces a warning.
 *
 * Per-issue dynamic content (issue body, sessionContext, prior-conversation
 * snapshots) belongs in the USER prompt — never inline here.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { estimateTokens } from '../lib/token-estimator.js';
import type { SystemPromptOverrideConfig } from '../pipeline/pipeline-config-schema.js';

export type PreambleBlockId = 'pipeline-rules' | 'tool-reference' | 'project-config' | 'state-extras';

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

/**
 * Per-state overrides resolved from `appConfig.pipeline.states[state].systemPrompt`.
 * Re-exported from the canonical Zod-inferred type so this module + the
 * preview endpoint + the dispatcher all agree on the shape (including
 * exactOptionalPropertyTypes `| undefined` on each field).
 */
export type SystemPromptOverride = SystemPromptOverrideConfig;

const BRANCH_SENTINEL = '<detect-from-git>';

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

export const TOOL_REFERENCE = `## Tool Reference
- **forge_issues** — list/get/create/update issues. update.documentId is required. Writable: title, description, status, priority, category, complexity, acceptanceCriteria, plan, sessionContext, relations.
- **forge_comments** — create requires issueDocumentId + body. list returns actor, body, isAI, timestamps.
- **forge_memory** — search/sync project + global memory. Strategies: semantic, keyword, graph, hybrid (default), auto.
- **forge_config** — read/write per-project settings: baseBranch, repoPath, productionBranch, agentPrompt, enabledSkills, conventions, knowledgeIndex.
- **forge_skills** — list available skills + per-project enable/disable.`;

const CHAT_NUDGE = `## Project Orientation
You are working in a Forge-managed project. Forge MCP tools are available for project management — \`forge_issues\`, \`forge_comments\`, \`forge_config\`, \`forge_memory\`, \`forge_pm_*\`. Use them when the request relates to issues, tasks, status, or project memory.

For codebase orientation, call \`forge_config\` with action \`get_knowledge\` before exploring with search tools — it returns pre-indexed context (architecture, key files, conventions).`;

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
 * Build a non-pipeline (chat / interactive) system prompt. The chat variant
 * nudges the agent to call `forge_config.get_knowledge` since no per-state
 * preamble has been pre-loaded into the conversation.
 *
 * Returns `''` when the project does not exist / can't be read — the caller
 * concatenates the preamble onto the user prompt, so an empty string keeps
 * the chat send byte-identical to the pre-PR-3 behavior (avoids surprise
 * cache misses or orphaned preambles for missing-project sessions).
 */
export async function buildChatPreamble(projectId: string): Promise<string> {
  const project = await loadProjectBranches(projectId);
  if (!project) return '';
  const sections: string[] = [
    CHAT_NUDGE,
    formatProjectConfig(project.baseBranch, project.productionBranch),
  ];
  return `${sections.join('\n\n')}\n\n---\n\n`;
}

/**
 * Build the structured pipeline preamble + apply per-state override.
 *
 * - `override.mode === 'replace'` and `override.extras` is non-empty: the
 *   operator-supplied text REPLACES the static prefix entirely (cache miss).
 * - Otherwise the override is appended after the static prefix (cache-friendly).
 */
export async function buildPipelinePreambleStructured(
  projectId: string,
  override?: SystemPromptOverride | null,
): Promise<BuiltPreamble> {
  const extras = override?.extras?.trim() ?? '';
  const mode = override?.mode ?? 'append';

  if (mode === 'replace' && extras.length > 0) {
    const blocks: PreambleBlock[] = [
      { id: 'state-extras', kind: 'system', chars: extras.length, estTokens: estimateTokens(extras) },
    ];
    return { content: extras, blocks };
  }

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
  if (extras.length > 0) {
    sections.push({ id: 'state-extras', body: extras });
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

/** Joined string form of buildPipelinePreambleStructured. */
export async function buildPipelinePreamble(
  projectId: string,
  override?: SystemPromptOverride | null,
): Promise<string> {
  const { content } = await buildPipelinePreambleStructured(projectId, override);
  return content;
}
