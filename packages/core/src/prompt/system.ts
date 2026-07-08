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

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type JobType,
  type MemberLens,
  memberLenses,
  organizationMembers,
  projects,
} from '../db/schema.js';
import { estimateTokens } from '../lib/token-estimator.js';
import type { SystemPromptOverrideConfig } from '../pipeline/pipeline-config-schema.js';
import { OPERATING_AFFORDANCES_TEXT, renderFact } from './facts/registry.js';
import { loadProjectFactInputs, renderStageFactsText } from './facts/resolve.js';
import { getStatePrompt } from './state-prompts/index.js';

export type PreambleBlockId =
  | 'pipeline-rules'
  | 'tool-reference'
  | 'project-config'
  | 'project-context'
  | 'forge-facts'
  | 'state-block'
  | 'mcp-servers'
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

// Canonical text for these two mandatory blocks now lives in the Forge Facts
// registry (`./facts/registry.ts`) so author-time surfaces and the runtime
// preamble share one source. Re-exported here unchanged for existing callers
// (chat-preamble shim, schedules, agent-sessions); a parity test in
// system.test.ts pins the rendered text.
export const PIPELINE_RULES = renderFact('pipeline-rules') ?? '';

export const TOOL_REFERENCE = renderFact('mcp-tool-reference') ?? '';

const CHAT_ORIENTATION = `## Project Orientation
You are working in a Forge-managed project. Forge MCP tools are available for project management — \`forge_issues\`, \`forge_comments\`, \`forge_config\`, \`forge_memory\`, \`forge_pm_*\`. Use them when the request relates to issues, tasks, status, or project memory.

For codebase & project knowledge, call \`forge_knowledge\` (list/get/search) — no local file. Follow any always-applied Project rules in this preamble, then explore with search tools.`;

const CHAT_ISSUE_RULES = `## Turning a request into issues — consolidate, do NOT pre-decompose
When the conversation produces work to track, capture **one coherent request as ONE issue** whose body holds the full spec the user gave — all the parts, sub-features, acceptance criteria, and context, kept together. Do NOT shatter a multi-part request into many atomic tickets yourself. **Decomposition is owned by the Forge pipeline**: the triage and plan stages decide whether and how to split an issue into children (the system-owned decompose protocol). Your job is to gather and clarify; the pipeline's job is to break down. One feature-set the user described together = one issue, not N. If the user explicitly asks for separate issues, follow them — but the default is consolidate.`;

/**
 * The "## Your role in this chat" section, tuned to the reader's assigned
 * working lens(es) (ISS role-aware chat). Lenses are SOFT: they change only the
 * altitude/voice of the answer, never correctness, permissions, or the
 * security posture below (which is shared by every variant).
 *
 *   - `technical`            → implementation depth (files, diffs, mechanism).
 *   - `product` / none       → non-technical, outcome/behavior voice (the
 *                              historical default — unchanged for members with
 *                              no lens assigned).
 *   - both                   → lead with outcome, then concise technical detail.
 *
 * Exported for a focused unit test on the wording per lens.
 */
export function buildChatRoleSection(lenses: readonly MemberLens[]): string {
  const tech = lenses.includes('technical');
  const product = lenses.includes('product');
  let audience: string;
  if (tech && product) {
    audience =
      'Your counterpart works across BOTH product and engineering. Lead with the outcome — the feature, user impact, and behavior — then add concise technical detail (concrete files as `path:line`, mechanism, commands) when it sharpens the answer. Weave the two; do not split the reply into two disjoint explanations.';
  } else if (tech) {
    audience =
      'Your counterpart is **technical** and comfortable with code. Answer at implementation depth: reference concrete files (`path:line`), diffs, architecture, and commands directly, and explain the mechanism plainly. Skip business-101 preamble.';
  } else {
    // Explicit `product` lens OR no lens assigned — the historical default.
    audience =
      'Assume your counterpart is **non-technical** by default: a business owner, BA, or stakeholder who thinks in outcomes and business logic, not code. **Speak their language** — features, user impact, and behavior, NOT files, functions, or implementation. Only talk about code when they **explicitly ask to understand it**.';
  }
  return `## Your role in this chat
You are a thinking partner, not an auto-implementer. ${audience} Default to **discussing, clarifying, and aligning** on the request before any work is tracked or built: draw out the goal, expectations, constraints, and definition of done; surface ambiguity and trade-offs the way a good PM would.

Stay security-conscious regardless of lens: explain behavior at a conceptual level and NEVER reveal secrets, credentials, tokens, connection strings, or sensitive internal logic / data (auth and permission checks, security mechanisms, validation that could be bypassed, or anything that aids an attacker). When unsure whether a detail is sensitive, stay high-level or decline.

Do NOT jump into writing or changing code on your own — act on the codebase ONLY when the user explicitly asks you to do it now. Otherwise the outcome of the conversation is an issue (below), and the Forge pipeline does the building.`;
}

/** Assemble the full chat orientation nudge for the reader's lens(es). */
function buildChatNudge(lenses: readonly MemberLens[]): string {
  return [
    CHAT_ORIENTATION,
    buildChatRoleSection(lenses),
    CHAT_ISSUE_RULES,
    OPERATING_AFFORDANCES_TEXT,
  ].join('\n\n');
}

/**
 * Resolve the interactive reader's assigned working lens(es) for the project's
 * org (ISS role-aware chat). Best-effort + fail-open: no user (system/scheduled
 * session), no org, or any error → `[]` (the non-technical default). Only known
 * lens values survive, so a stray DB value can't corrupt the prompt.
 */
async function resolveMemberLenses(
  projectId: string,
  userId: string | null,
): Promise<MemberLens[]> {
  if (!userId) return [];
  try {
    const [proj] = await db
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!proj?.orgId) return [];
    const [member] = await db
      .select({ lenses: organizationMembers.lenses })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, proj.orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    const known = new Set<string>(memberLenses);
    return ((member?.lenses ?? []) as string[]).filter((l): l is MemberLens => known.has(l));
  } catch {
    return [];
  }
}

function formatProjectContext(projectId: string): string {
  return `## Project Context
- projectId: ${projectId}

Call \`forge_projects.get\` with this id to retrieve repo paths, branches, staging URLs, and test credentials. Do NOT echo passwords in commits, PR descriptions, or tool output beyond the immediate authentication step.`;
}

function formatProjectConfig(baseBranch: string | null, productionBranch: string | null): string {
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
 * nudges the agent to use forge_knowledge for orientation since no per-state
 * preamble has been pre-loaded into the conversation.
 *
 * Returns `''` when the project does not exist / can't be read — the caller
 * concatenates the preamble onto the user prompt, so an empty string keeps
 * the chat send byte-identical to the pre-PR-3 behavior (avoids surprise
 * cache misses or orphaned preambles for missing-project sessions).
 *
 * `userId` (the interactive reader) tunes the role section to their assigned
 * working lens(es) (ISS role-aware chat). Omitted / null (system/scheduled
 * sessions) → the non-technical default, unchanged.
 */
export async function buildChatPreamble(
  projectId: string,
  userId?: string | null,
): Promise<string> {
  const project = await loadProjectBranches(projectId);
  if (!project) return '';
  const lenses = await resolveMemberLenses(projectId, userId ?? null);
  const sections: string[] = [
    buildChatNudge(lenses),
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
  /**
   * ISS-623 W2 — the dispatcher's post-merge MCP server diagnostics for THIS
   * dispatch: which sentinel/shorthand names resolved into the runner's
   * final `mcpServers` map, and which declared names silently dropped (an
   * unknown catalog/integration name, or a declared-but-not-active
   * integration). Omit for non-pipeline callers (chat / preview) — no
   * dispatch has happened, so there is nothing to diagnose.
   */
  mcpDiagnostics?: { resolved: string[]; dropped: string[] } | null;
}

/**
 * ISS-623 W2 — render the `mcp-servers` preamble block. Only called when
 * `dropped.length > 0` (a clean dispatch adds nothing, so the shared prefix
 * stays cache-friendly for the common case). Tells the agent what actually
 * resolved and what it declared-but-didn't-get, plus WHY a name commonly
 * fails to resolve, so it can self-diagnose instead of guessing (the
 * motivating incident: 4 pipeline runs blamed `needs_reauth` for a config
 * typo that a human had to read core source to find).
 */
function formatMcpServersBlock(resolved: string[], dropped: string[]): string {
  const resolvedList =
    resolved.length > 0 ? resolved.map((n) => `\`mcp__${n}__*\``).join(', ') : '(none)';
  return `## MCP servers — this dispatch
Resolved and available this session: ${resolvedList}

WARNING — declared in \`pipelineConfig.mcpServers\` but did NOT resolve: ${dropped.map((n) => `\`${n}\``).join(', ')}

A declared name fails to resolve when it is neither a known catalog server nor a known integration name (a typo), OR it names a real integration (e.g. \`epodsystem\`) that has no active binding for this project. If your task depends on tools from one of the dropped names, STOP and report the unresolved name in your response instead of retrying or assuming a credential/auth problem — the integration status badge does not gate injection, so "connected" does not mean "declared for this dispatch".`;
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
      {
        id: 'state-extras',
        kind: 'system',
        chars: extras.length,
        estTokens: estimateTokens(extras),
      },
    ];
    return { content: extras, blocks };
  }

  // On a pipeline step the facts resolver reads the `projects` row anyway
  // (branches + agentConfig + previewDeploy + integrations), so reuse its
  // branches for the Project Config block instead of reading `projects` a
  // second time. With no step (chat / generic preview) there is no facts
  // block, so just read the branches.
  const step = opts?.step ?? null;
  const factInputs = step ? await loadProjectFactInputs(projectId) : null;
  const project = factInputs?.branches ?? (await loadProjectBranches(projectId));
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
  // Forge facts for this stage — the project-resolved contextual facts (status
  // ladder, complexity, decompose, handoff, …) + connected integrations + a
  // fetch-on-demand index of the author's projectFacts guides (values are NOT
  // inlined — the agent fetches via `forge_config` when needed). Injecting them
  // here keeps skill bodies pure business logic ("write the skill however you
  // want") and stays current without re-syncing skill files.
  if (step && factInputs) {
    const factsBlock = renderStageFactsText(factInputs, projectId, step);
    if (factsBlock) sections.push({ id: 'forge-facts', body: factsBlock });
  }
  // Built-in per-state depth. After the shared prefix (so cross-state cache on
  // the prefix is preserved) and before any operator override (so the override
  // remains the last word).
  const stateBlock = getStatePrompt(opts?.step);
  if (stateBlock) {
    sections.push({ id: 'state-block', body: stateBlock });
  }
  const mcpDiagnostics = opts?.mcpDiagnostics ?? null;
  if (mcpDiagnostics && mcpDiagnostics.dropped.length > 0) {
    sections.push({
      id: 'mcp-servers',
      body: formatMcpServersBlock(mcpDiagnostics.resolved, mcpDiagnostics.dropped),
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
  opts?: BuildPreambleOptions,
): Promise<string> {
  const { content } = await buildPipelinePreambleStructured(projectId, opts);
  return content;
}
