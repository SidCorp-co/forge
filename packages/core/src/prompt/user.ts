/**
 * SSOT for the user prompt (`-p` argument to Claude CLI): `/<skill> <issueId>`, then the turn's
 * rules, the issue's title and status, and the previous session context, each when present.
 */

import type { JobType } from '../db/schema.js';
import {
  type HandoffScope,
  type HandoffStep,
  isHandoffStep,
  renderDriveTerminationBlock,
  renderTerminationBlock,
  type StepHandoffPayload,
} from '../memory/step-handoff-schema.js';
import { handoffInjectSteps } from '../pipeline/handoff-policy.js';
import { markUntrusted } from '../lib/untrusted-text.js';

/** ISS-699 — steps that finished after `sessionContext.lastUpdated`, measured
 *  from the jobs ledger by `loadIssueSnapshot`. null when nothing is newer. */
export interface SupersededBy {
  count: number;
  latestType: string;
  latestFinishedAt: string;
}

export interface IssueSnapshot {
  supersededBy?: SupersededBy | null | undefined;
  title: string;
  status?: string | null;
  priority?: string | null;
  complexity?: string | null;
  description?: string | null;
  descriptionFormat?: string | null;
  plan?: string | null;
  acceptanceCriteria?: string | null;
  sessionContext?: SessionContextSnapshot | null;
}

export interface SessionContextSnapshot {
  currentState?: string | null;
  sessionCount?: number;
  lastUpdated?: string | null;
  decisions?: string[];
  filesModified?: string[];
  errorsResolved?: string[];
  reviewFeedback?: unknown[];
  reproEvidence?: unknown[];
}

export interface PriorHandoff {
  step: HandoffStep;
  payload: StepHandoffPayload;
}

const OPEN_ITEM_FIELDS: Partial<
  Record<HandoffStep, 'openQuestions' | 'unknowns' | 'knownLimitations'>
> = {
  clarify: 'openQuestions',
  plan: 'unknowns',
  code: 'knownLimitations',
};

function handoffHasOpenItems(h: PriorHandoff): boolean {
  const f = OPEN_ITEM_FIELDS[h.step];
  if (!f) return false;
  const v = (h.payload as Record<string, unknown>)[f];
  return Array.isArray(v) && v.length > 0;
}

const ADDRESS_OPEN_ITEMS_BLOCK = `\n**Before you advance — address the open items above.** The handoff(s) above carry open items (clarify \`openQuestions\`, plan \`unknowns\`, code \`knownLimitations\`). For EACH item: resolve it in your work, or explicitly acknowledge it with a reason in your stage comment/handoff. Do not silently drop them.\nNeed context the handoff does not carry? Re-query the prior stage's session (max 3 calls this step): \`forge-runner api projects/<projectId>/agent-sessions?issueId=<id>\` → pick the prior stage's session (match \`pipelineRunId\`) → \`forge-runner api projects/<projectId>/agent-sessions/<sessionId>\` (returns the last-20 message tail only). This is prompt-layer guidance, not a status gate.`;

/**
 * Render the `## Prior step handoffs` block. Renders each handoff as a
 * fenced JSON block keyed by step so the agent can scan structured data
 * rather than re-derive context from raw issue fields.
 *
 * When any rendered handoff carries non-empty open items (clarify.openQuestions,
 * plan.unknowns, code.knownLimitations), appends a mandatory address block and
 * re-query how-to so the consuming stage does not silently drop them.
 */
function formatPriorHandoffs(handoffs: PriorHandoff[]): string {
  const lines: string[] = ['## Prior step handoffs'];
  for (const h of handoffs) {
    lines.push('', `### ${h.step}`, '```json', JSON.stringify(h.payload, null, 2), '```');
  }
  if (handoffs.some(handoffHasOpenItems)) {
    lines.push(ADDRESS_OPEN_ITEMS_BLOCK);
  }
  return lines.join('\n');
}

function formatIssueSnapshot(snapshot: IssueSnapshot, jobType: JobType): string {
  // ISS-532: the issue title is untrusted free-text and the only untrusted text inlined — frame it
  // as DATA on its own lines (markUntrusted output is multi-line).
  const lines: string[] = [
    '## Issue',
    'Title:',
    markUntrusted(snapshot.title, { source: 'issue.title' }),
  ];

  const meta: string[] = [];
  if (snapshot.status) meta.push(`Status: ${snapshot.status}`);
  if (snapshot.priority) meta.push(`Priority: ${snapshot.priority}`);
  if (snapshot.complexity) meta.push(`Complexity: ${snapshot.complexity}`);
  if (meta.length > 0) lines.push(meta.join(' · '));

  lines.push(
    '',
    jobType === 'drive'
      ? 'Full issue body, comments and attachments are NOT inlined here — read them with `forge-runner api issues/<id>` and `forge-runner api issues/<id>/comments`.'
      : 'Full issue body, comments, attachments, and prior step handoffs are NOT inlined here — read them with `forge-runner api issues/<id>`, `forge-runner api issues/<id>/comments` and `forge-runner api issue-step-contexts?projectId=<projectId>&issueId=<id>`. Read an attached image/file with the `forge_uploads` MCP tool.',
  );
  return lines.join('\n');
}

function formatSessionContext(
  ctx: SessionContextSnapshot,
  supersededBy?: SupersededBy | null,
): string {
  const lines: string[] = ['## Previous Session Context'];

  if (supersededBy && supersededBy.count > 0) {
    const plural = supersededBy.count === 1 ? 'step has' : 'steps have';
    lines.push(
      `> **SUPERSEDED — do not act on the verdict below.** ${supersededBy.count} ${plural} finished since this snapshot was written (most recently \`${supersededBy.latestType}\` at ${supersededBy.latestFinishedAt}). It describes a state that has since changed. Re-derive the current situation from the issue's comments and step handoffs; use the text below only for background such as files touched.`,
    );
  }

  if (ctx.currentState) {
    lines.push(`**Current state:** ${ctx.currentState}`);
  }

  const sessionCount = ctx.sessionCount ?? 0;
  const lastUpdated = ctx.lastUpdated ?? 'unknown';
  lines.push(`_Context from ${sessionCount} previous session(s), last updated ${lastUpdated}_`);

  return lines.join('\n');
}

export function injectTurnLevelRules(
  promptString: string,
  turnLevelSystemPrompt: string | null | undefined,
): string {
  const tlSp = turnLevelSystemPrompt?.trim();
  if (!tlSp || tlSp.length === 0) return promptString;
  const block = [
    '',
    '## Pipeline Rules (this turn)',
    'These rules apply to this turn — apply them in addition to any session-level system prompt:',
    '',
    tlSp,
  ].join('\n');
  const firstNl = promptString.indexOf('\n');
  if (firstNl === -1) return `${promptString}${block}`;
  return `${promptString.slice(0, firstNl)}${block}${promptString.slice(firstNl)}`;
}

export function injectAfterInvocation(promptString: string, block: string): string {
  const b = block.trim();
  if (b.length === 0) return promptString;
  const wrapped = `\n\n${b}`;
  const firstNl = promptString.indexOf('\n');
  if (firstNl === -1) return `${promptString}${wrapped}`;
  return `${promptString.slice(0, firstNl)}${wrapped}${promptString.slice(firstNl)}`;
}

export function buildJobPromptString(args: {
  skillName?: string | null;
  jobType: JobType;
  issueId: string;
  issueSnapshot?: IssueSnapshot | null;
  turnLevelSystemPrompt?: string | null;
  mergeRequiredText?: string | null;
  priorHandoffs?: PriorHandoff[] | null;
  /**
   * Step-handoff scope literals for the `## Termination protocol` block.
   * Required when `jobType` is a handoff step
   * (triage/plan/code/review/test/fix) — without it the agent can't form
   * the handoff write. Caller pre-fills these from the job +
   * pipeline_run row so the agent does NOT have to guess identifiers.
   */
  handoffScope?: HandoffScope | null;
}): string {
  const skill =
    args.skillName && args.skillName.length > 0 ? args.skillName : `forge-${args.jobType}`;
  const lines: string[] = [`/${skill} ${args.issueId}`];

  const merge = args.mergeRequiredText?.trim();
  if (merge && merge.length > 0) {
    lines.push('', merge);
  }

  const tlSp = args.turnLevelSystemPrompt?.trim();
  if (tlSp && tlSp.length > 0) {
    lines.push(
      '',
      '## Pipeline Rules (this turn)',
      'These rules apply to this turn — apply them in addition to any session-level system prompt:',
      '',
      tlSp,
    );
  }

  const injectFromSteps = new Set<HandoffStep>(handoffInjectSteps(args.jobType));
  const handoffsToRender =
    args.priorHandoffs && args.priorHandoffs.length > 0
      ? args.priorHandoffs.filter((h) => injectFromSteps.has(h.step))
      : [];

  const snapshot = args.issueSnapshot;
  if (snapshot) {
    lines.push('', formatIssueSnapshot(snapshot, args.jobType));

    if (handoffsToRender.length > 0) {
      lines.push('', formatPriorHandoffs(handoffsToRender));
    }

    const sc = snapshot.sessionContext;
    if (sc && (sc.sessionCount ?? 0) >= 1) {
      lines.push('', formatSessionContext(sc, snapshot.supersededBy));
    }
  } else if (handoffsToRender.length > 0) {
    lines.push('', formatPriorHandoffs(handoffsToRender));
  }

  if (isHandoffStep(args.jobType) && args.handoffScope) {
    lines.push(
      '',
      args.jobType === 'drive'
        ? renderDriveTerminationBlock(args.handoffScope)
        : renderTerminationBlock({ step: args.jobType, scope: args.handoffScope }),
    );
  }

  return lines.join('\n');
}
