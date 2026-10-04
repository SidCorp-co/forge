import type { ContentLanguageRecord } from '@forge/contracts/content-language';
import { and, eq } from 'drizzle-orm';
import {
  contentLanguageBlock,
  contentLanguageRecord,
  jobContentContext,
} from '../content-language/block.js';
import { readContentLanguage } from '../content-language/read.js';
import { db } from '../db/client.js';
import {
  type JobType,
  type MemberLens,
  memberLenses,
  organizationMembers,
  projects,
} from '../db/schema.js';
import { estimateTokens } from '../lib/token-estimator.js';
import { logger } from '../logger.js';
import { NO_PROGRESS_ROUNDS } from '../pipeline/reopen-policy.js';
import type { DispatchState } from '../project-config/dispatch-policy.js';
import { promotedBranch, readReleasePath } from '../project-config/release-path.js';
import { mandatoryPreambleBlocks } from './facts/mandatory-blocks.js';
import { OPERATING_AFFORDANCES_TEXT } from './facts/registry.js';
import {
  loadActiveIntegrationRows,
  loadProjectFactInputs,
  renderIntegrations,
  renderStageFactsText,
} from './facts/resolve.js';
import { getStatePrompt } from './state-prompts/index.js';

export type PreambleBlockId =
  | 'pipeline-rules'
  | 'tool-reference'
  | 'project-config'
  | 'policy'
  | 'project-context'
  | 'forge-facts'
  | 'state-block'
  | 'contract-context'
  | 'artifact-context'
  | 'pinned-contract-context'
  | 'content-language';

export interface PreambleBlock {
  id: PreambleBlockId;
  kind: 'system' | 'user';
  chars: number;
  estTokens: number;
}

export interface BuiltPreamble {
  content: string;
  blocks: PreambleBlock[];
  /** The content language a step's preamble told it; absent where no step was named. */
  contentLanguage?: ContentLanguageRecord;
}

const BRANCH_SENTINEL = '<detect-from-git>';

// Canonical text for these two mandatory blocks now lives in the Forge Facts
// registry (`./facts/registry.ts`) so author-time surfaces and the runtime
// preamble share one source. Re-exported here unchanged for existing callers
// (chat-preamble shim, schedules, agent-sessions).
export { PIPELINE_RULES, TOOL_REFERENCE } from './facts/mandatory-blocks.js';

const CHAT_ORIENTATION = `## Project Orientation
You are working in a Forge-managed project. Its issues, comments, status and project memory are reached through the Forge REST API (\`forge-runner api <path>\` or the \`forge\` CLI): \`issues/<id>\`, \`issues/<id>/comments\`, \`projects/<id>/config\`, \`memory/search\`. Use them when the request relates to issues, tasks, status, or project memory.

For codebase & project knowledge, read \`projects/<id>/knowledge\` (or \`forge knowledge\`) — no local file. Follow any always-applied Project rules in this preamble, then explore with search tools.`;

const CHAT_ISSUE_RULES = `## Turning a request into issues — consolidate, do NOT pre-split
When the conversation produces work to track, capture **one coherent request as ONE issue** whose body holds the full spec the user gave — all the parts, sub-features, acceptance criteria, and context, kept together. Do NOT shatter a multi-part request into many atomic tickets yourself. **Splitting is the pipeline's call, not yours**: whoever works the issue decides whether it is one change or several, and orders them itself. Your job is to gather and clarify; theirs is to break down. One feature-set the user described together = one issue, not N. If the user explicitly asks for separate issues, follow them — but the default is consolidate.`;

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
  const fetch = `Read repo paths and branches with \`forge-runner api projects/${projectId}\`, and environments, promotions and the testing profile each environment names with \`forge-runner api projects/${projectId}/config\`.`;
  return `## Project Context
- projectId: ${projectId}

${fetch} A testing profile names \`secret://\` references, never values. Do NOT echo passwords in commits, PR descriptions, or tool output beyond the immediate authentication step.`;
}

export function formatProjectConfig(
  baseBranch: string | null,
  deploysFrom: string | null,
): string {
  const b = baseBranch ?? BRANCH_SENTINEL;
  const park = 'needs_info';
  const liveLine =
    deploysFrom !== null
      ? `\n- production deploysFrom: ${deploysFrom} — a change landed on ${b} reaches it by the project document's promotions`
      : '';
  let out = `## Project Config\n- baseBranch: ${b}${liveLine}\n- noProgressRounds: ${NO_PROGRESS_ROUNDS} — a stop signal, NOT a cap. Nothing limits how many times an issue may be reopened. If you have fixed the same problem this many times and NOTHING changed (same failure, same symptom, no new information), stop and set \`${park}\` with what you tried and what you need. Rounds that each move something forward are normal work.`;
  if (!baseBranch) {
    out += `\n\nBranch detection: any value shown as \`${BRANCH_SENTINEL}\` is not configured. Before any git operation, run \`git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'\` and use the result instead. If detection fails, abort and say so in a comment.`;
  }
  return out;
}

const QA_LINE: Record<DispatchState['qa'], string> = {
  self: 'self — the run that builds a change may also be the one that says it works.',
  independent:
    'independent — the run that built a change may not be the run that says it works; another run judges it.',
};

/** The policy state this job runs under, as the project's policy-v1 declares it. */
export function formatPolicy(policy: DispatchState): string {
  const how =
    policy.from === 'entry'
      ? `the entry state \`${policy.status}\`, because this job is for no status the policy governs`
      : `\`${policy.status}\``;
  const denied =
    policy.deniedTools.length === 0
      ? 'none'
      : `${policy.deniedTools.map((t) => `\`${t}\``).join(', ')} — this session was started without them; do not reach for them or for a way around them`;
  return `## Policy
- state: ${how} (policy revision ${policy.revision}, profile \`${policy.profile}\`), model ${policy.model}
- qa: ${QA_LINE[policy.qa]}
- denied tools: ${denied}`;
}

async function loadProjectBranches(projectId: string): Promise<{
  baseBranch: string | null;
  deploysFrom: string | null;
  orgId: string | null;
} | null> {
  let project: { orgId: string | null } | undefined;
  try {
    [project] = await db
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
  } catch {
    return null;
  }
  if (!project) return null;
  const read = await readReleasePath(projectId);
  return {
    orgId: project.orgId,
    baseBranch: read.ok ? read.path.defaultBranch : null,
    deploysFrom: read.ok ? promotedBranch(read.path) : null,
  };
}

export async function buildChatPreamble(
  projectId: string,
  userId?: string | null,
  forceLenses?: readonly MemberLens[] | null,
): Promise<string> {
  const project = await loadProjectBranches(projectId);
  if (!project) return '';
  const known = new Set<string>(memberLenses);
  const lenses = forceLenses
    ? forceLenses.filter((l): l is MemberLens => known.has(l))
    : await resolveMemberLenses(projectId, userId ?? null);
  const sections: string[] = [
    buildChatNudge(lenses),
    formatProjectConfig(project.baseBranch, project.deploysFrom),
  ];
  const integrations = await renderChatIntegrations(projectId, project.orgId);
  if (integrations) sections.push(integrations);
  return `${sections.join('\n\n')}\n\n---\n\n`;
}

async function renderChatIntegrations(
  projectId: string,
  orgId: string | null,
): Promise<string | null> {
  try {
    const rows = await loadActiveIntegrationRows(projectId, orgId);
    return rows.length > 0 ? renderIntegrations(rows) : null;
  } catch (err) {
    logger.warn({ err, projectId }, 'chat preamble: integrations block unavailable');
    return null;
  }
}

/** Options for the pipeline preamble builders. */
export interface BuildPreambleOptions {
  /**
   * The step (jobType) this preamble is for. Drives the built-in per-state
   * `state-block` (see `prompt/state-prompts`). Omit for non-pipeline callers
   * (chat / generic preview) — no state block is added.
   */
  step?: JobType | null;
  /** The policy state the job runs under; absent for a preamble no job runs (chat, preview). */
  policy?: DispatchState | null;
}

export async function buildPipelinePreambleStructured(
  projectId: string,
  opts?: BuildPreambleOptions,
): Promise<BuiltPreamble> {
  // On a pipeline step the facts resolver reads the `projects` row anyway
  // (branches + agentConfig + project document + integrations), so reuse its
  // branches for the Project Config block instead of reading `projects` a
  // second time. With no step (chat / generic preview) there is no facts
  // block, so just read the branches.
  const step = opts?.step ?? null;
  const factInputs = step ? await loadProjectFactInputs(projectId) : null;
  const project = factInputs?.branches ?? (await loadProjectBranches(projectId));
  const mandatory = mandatoryPreambleBlocks(step);
  const sections: Array<{ id: PreambleBlockId; body: string }> = [
    { id: 'pipeline-rules', body: mandatory.pipelineRules },
    { id: 'tool-reference', body: mandatory.toolReference },
  ];
  if (project) {
    sections.push({
      id: 'project-config',
      body: formatProjectConfig(project.baseBranch, project.deploysFrom),
    });
  }
  if (opts?.policy) sections.push({ id: 'policy', body: formatPolicy(opts.policy) });
  // ISS-225 — inline the projectId so agents can read the project
  // without having to re-discover it. Placed AFTER project-config so the
  // cache-friendly static prefix is unaffected; BEFORE the state block so the
  // shared prefix stays the longest common cacheable span.
  sections.push({
    id: 'project-context',
    body: formatProjectContext(projectId),
  });
  if (step && factInputs) {
    const factsBlock = renderStageFactsText(factInputs, projectId, step);
    if (factsBlock) sections.push({ id: 'forge-facts', body: factsBlock });
  }
  // Built-in per-state depth, after the shared prefix so cross-state cache on
  // the prefix is preserved.
  const stateBlock = getStatePrompt(opts?.step);
  if (stateBlock) {
    sections.push({ id: 'state-block', body: stateBlock });
  }
  let contentLanguage: ContentLanguageRecord | undefined;
  if (step) {
    const setting = await readContentLanguage(projectId);
    const context = jobContentContext(step);
    contentLanguage = contentLanguageRecord(setting, context, setting.revision);
    sections.push({ id: 'content-language', body: contentLanguageBlock(setting, context) });
  }
  const content = sections.map((s) => s.body).join('\n\n');
  const blocks: PreambleBlock[] = sections.map((s) => ({
    id: s.id,
    kind: 'system',
    chars: s.body.length,
    estTokens: estimateTokens(s.body),
  }));
  return contentLanguage ? { content, blocks, contentLanguage } : { content, blocks };
}

/** Joined string form of buildPipelinePreambleStructured. */
export async function buildPipelinePreamble(
  projectId: string,
  opts?: BuildPreambleOptions,
): Promise<string> {
  const { content } = await buildPipelinePreambleStructured(projectId, opts);
  return content;
}
