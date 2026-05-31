/**
 * SSOT for system-prompt assembly across all callers (pipeline dispatcher,
 * chat preview, interactive sessions, MCP `forge_config.preview_prompt`).
 *
 * Static prefix order — kept stable so Anthropic API prompt cache (5-min TTL)
 * hits across jobs of the same project:
 *   1. PIPELINE_RULES        — process discipline (status LAST, branch, etc.)
 *   2. TOOL_REFERENCE        — MCP tool catalogue
 *   3. Project Config block  — baseBranch / productionBranch
 *   4. Project Context block — projectId + hint to call forge_projects.get
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
import { type JobType, projects } from '../db/schema.js';
import { estimateTokens } from '../lib/token-estimator.js';
import type { SystemPromptOverrideConfig } from '../pipeline/pipeline-config-schema.js';
import { getStatePrompt } from './state-prompts/index.js';

export type PreambleBlockId =
  | 'pipeline-rules'
  | 'tool-reference'
  | 'project-config'
  | 'project-context'
  | 'state-block'
  | 'state-extras';

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
- **Always advance the state — never leave an issue parked.** The FINAL action of every step MUST be a \`forge_issues.update\` that moves \`status\`. Setting status is what triggers the next step; an issue left in its current status stalls the pipeline forever. Do this even if your skill instructions don't mention a transition.
- **Where to move next.** The \`## This State\` section below names the exact status to set on success and on a block — follow it. If that section is absent, default forward along: \`open → confirmed → approved → developed → deploying → testing → pass → staging → released → closed\` (intermediate states you don't own auto-advance).
- **Deviate freely when warranted.** Transitions are NOT restricted to the happy path. From ANY state you may set \`needs_info\` (requirements missing/unclear), \`reopen\` (regression or failed check), or \`on_hold\` (deliberate pause) the moment you hit that condition — don't force the ladder. Only \`draft\` is never a valid target.
- **Decompose is system-owned — do NOT hand-set parent/child statuses.** When you decompose a parent into children, core parks the parent at \`waiting\` (the review gate) and creates the children at \`draft\`. A human approving the parent (→ \`approved\`) auto-cascades the children to \`approved\`. The parent's own forward work is held by the dispatcher until ALL children merge, then the parent runs its integration LAST. The kickoff is anchored to these system transitions — manually moving a decompose parent or child breaks it.
- **Status LAST**, after all other work (commits, comments, handoff). Do NOT set \`merged_at\` or other derived fields by hand — \`merged_at\` is stamped automatically when you leave \`released\`.
- **Branch discipline.** Run \`git branch --show-current\` + \`git status\` before any checkout. Branch from \`baseBranch\`: \`git checkout <baseBranch> && git pull && git checkout -b ISS-XX-short-title\`. Never switch branches mid-work.
- **ISS-* branch is source of truth.** Kept alive through the pipeline. Squash-merges to \`productionBranch\` at release.
- **Fetch issue first.** Never assume data from the prompt — always fetch via \`forge_issues.get\` for the full body.

## Capture Learnings
Only when you hit a reusable lesson — a project convention, a non-obvious gotcha, or a fix pattern that will help a DIFFERENT agent on a DIFFERENT issue. If it's specific to this issue, it belongs in \`sessionContext\`, not memory.
1. Search first: \`forge_memory.search({ projectId, query, topK: 3, sourceFilter: ['knowledge'] })\`.
2. If nothing comes back scoring > 0.8, write it: \`forge_memory.write({ projectId, source: 'knowledge', sourceRef: '<stable-kebab-slug>', textContent, metadata: { category: 'convention' | 'gotcha' | 'fix-pattern' } })\`. Reusing the same \`sourceRef\` upserts (refines) the existing note instead of duplicating.
\`projectId\` comes from \`forge_issues.get\`. Keep \`textContent\` tight — one lesson, no issue-specific detail.

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
- **forge_memory** — per-project semantic memory. \`.search({projectId, query, topK, sourceFilter?})\` → scored hits; \`.write({projectId, source, sourceRef, textContent, metadata?})\` upserts on (projectId, source, sourceRef); \`.get\` for natural-key lookups, \`.delete\` to remove. Sources: issue, comment, job, note, knowledge, decision, policy.
- **forge_config** — read/write per-project settings: baseBranch, repoPath, productionBranch, agentPrompt, enabledSkills, conventions, knowledgeIndex.
- **forge_skills** — list available skills + per-project enable/disable.`;

const CHAT_NUDGE = `## Project Orientation
You are working in a Forge-managed project. Forge MCP tools are available for project management — \`forge_issues\`, \`forge_comments\`, \`forge_config\`, \`forge_memory\`, \`forge_pm_*\`. Use them when the request relates to issues, tasks, status, or project memory.

For codebase orientation, call \`forge_config\` with action \`get_knowledge\` before exploring with search tools — it returns pre-indexed context (architecture, key files, conventions).`;

function formatProjectContext(projectId: string): string {
  return `## Project Context
- projectId: ${projectId}

Call \`forge_projects.get\` with this id to retrieve repo paths, branches, staging URLs, and test credentials. Do NOT echo passwords in commits, PR descriptions, or tool output beyond the immediate authentication step.`;
}

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

/** Options for the pipeline preamble builders. */
export interface BuildPreambleOptions {
  /**
   * The step (jobType) this preamble is for. Drives the built-in per-state
   * `state-block` (see `prompt/state-prompts`). Omit for non-pipeline callers
   * (chat / generic preview) — no state block is added.
   */
  step?: JobType | null;
  /** Project per-state override (`states[state].systemPrompt`). */
  override?: SystemPromptOverride | null;
}

/**
 * Build the structured pipeline preamble. Layer order:
 *   1-4. shared prefix (Pipeline Rules / Tool Reference / Project Config /
 *        Project Context) — identical across every job, so the Anthropic prompt
 *        cache hits broadly.
 *   5.   `state-block` — the built-in default for `opts.step` (depth per state;
 *        shared across jobs of the same step).
 *   6.   `state-extras` — the project's per-state override, layered last.
 *
 * - `override.mode === 'replace'` with non-empty extras: the operator text
 *   REPLACES everything (no shared prefix, no state block; full cache miss).
 * - Otherwise extras are appended after the state block (cache-friendly).
 */
export async function buildPipelinePreambleStructured(
  projectId: string,
  opts?: BuildPreambleOptions,
): Promise<BuiltPreamble> {
  const override = opts?.override ?? null;
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
  // ISS-225 — inline the projectId so agents can call forge_projects.get
  // without having to re-discover it. Placed AFTER project-config so the
  // cache-friendly static prefix is unaffected; BEFORE the state block so the
  // shared prefix stays the longest common cacheable span.
  sections.push({
    id: 'project-context',
    body: formatProjectContext(projectId),
  });
  // Built-in per-state depth. After the shared prefix (so cross-state cache on
  // the prefix is preserved) and before any operator override (so the override
  // remains the last word).
  const stateBlock = getStatePrompt(opts?.step);
  if (stateBlock) {
    sections.push({ id: 'state-block', body: stateBlock });
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
  opts?: BuildPreambleOptions,
): Promise<string> {
  const { content } = await buildPipelinePreambleStructured(projectId, opts);
  return content;
}
