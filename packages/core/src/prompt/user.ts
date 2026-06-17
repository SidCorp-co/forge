/**
 * SSOT for the user prompt (`-p` argument to Claude CLI). Stamped at every
 * issue-bound job insert site (orchestrator, PM dispatch, escalation fallback,
 * chat preview) and forwarded verbatim to the runner via the `job.assigned`
 * WS event.
 *
 * Format:
 *   /<skill> <issueId>
 *
 *   [optional] ## Pipeline Rules (this turn)  — turn-level rules when resuming
 *   <system prompt embedded here>             (fallback path for --resume sessions
 *                                               where CLI may ignore --append-system-prompt)
 *
 *   [optional] ## Issue
 *   Title: ...
 *   Description / Plan / Acceptance (per-state policy + per-state override)
 *
 *   [optional] ## Previous Session Context
 *   currentState / decisions / filesModified / errorsResolved / reviewFeedback
 *
 * The per-state defaults below are overridable via
 * `appConfig.pipeline.states[state].userPromptPolicy`.
 */

import type { JobType } from '../db/schema.js';
import {
  type HandoffScope,
  type HandoffStep,
  type StepHandoffPayload,
  isHandoffStep,
  renderTerminationBlock,
} from '../memory/step-handoff-schema.js';
import { resolveHandoffsPolicy } from '../pipeline/handoff-policy.js';
import type { UserPromptPolicyConfig } from '../pipeline/pipeline-config-schema.js';

export interface IssueSnapshot {
  title: string;
  status?: string | null;
  priority?: string | null;
  complexity?: string | null;
  description?: string | null;
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

export type IssueField = 'description' | 'plan' | 'acceptanceCriteria';

export type SessionContextField =
  | 'decisions'
  | 'filesModified'
  | 'errorsResolved'
  | 'reviewFeedback';

/**
 * Per-state policy override resolved from `appConfig.pipeline.states[state].userPromptPolicy`.
 * Re-exported from the canonical Zod-inferred type so this module + the
 * preview endpoint + the orchestrator all agree on the shape (including
 * exactOptionalPropertyTypes `| undefined` on each field).
 */
export type UserPromptPolicyOverride = UserPromptPolicyConfig;

const DEFAULT_FIELD_CAPS: Record<IssueField, number> = {
  description: 8000,
  plan: 16000,
  acceptanceCriteria: 4000,
};

/**
 * Default sessionContext depth. `Number.POSITIVE_INFINITY` so callers that
 * do NOT supply a `userPromptPolicy.sessionContext.depth` retain the original
 * per-field SESSION_CAPS limits (decisions:10, filesModified:15,
 * errorsResolved:5, reviewFeedback:5) instead of being narrowed to a single
 * shared cap. Operators who want narrower history pass an explicit depth.
 */
const DEFAULT_SESSION_DEPTH = Number.POSITIVE_INFINITY;

const SESSION_CAPS = {
  decisions: 10,
  filesModified: 15,
  errorsResolved: 5,
  reviewFeedback: 5,
} as const;

/**
 * Per-state issue fields inlined into the user prompt. Default is now EMPTY for
 * every state (fetch-via-tool): the agent calls `forge_step_start` first, which
 * returns the full issue + comments + attachments + handoffs, so duplicating
 * description/plan/AC into the prompt only burns tokens and creates a second,
 * staler source of truth. The prompt instead carries a one-line pointer (see
 * `formatIssueSnapshot`). Operators who want a field re-inlined for a state set
 * `appConfig.pipeline.states[state].userPromptPolicy.includeFields` — the
 * override still flows through `resolveIssueFields`.
 */
const ISSUE_FIELDS_PER_STATE: Record<JobType, IssueField[]> = {
  triage: [],
  clarify: [],
  plan: [],
  code: [],
  review: [],
  test: [],
  staging: [],
  release: [],
  fix: [],
  custom: [],
  pm: [],
  smoke: [],
};

interface SessionFieldPolicy {
  decisions: boolean;
  filesModified: boolean;
  errorsResolved: boolean;
  reviewFeedback: boolean;
}

/**
 * Per-state `sessionContext` fields inlined into the prompt. Default is now ALL
 * OFF (fetch-via-tool): `forge_step_start` / `forge_issues.get` return the full
 * `sessionContext`, so the agent reads it from the tool bundle rather than from
 * a prompt copy. Operators re-enable per state via
 * `appConfig.pipeline.states[state].userPromptPolicy.sessionContext.fields`.
 */
const SESSION_FIELDS_PER_STATE: Record<JobType, SessionFieldPolicy> = {
  triage: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  clarify: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  plan: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  code: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  review: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  test: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  staging: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  release: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  fix: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  custom: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  pm: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  smoke: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
};

function truncate(text: string, cap: number, strategy: 'paragraph-boundary' | 'byte-cut'): string {
  if (text.length <= cap) return text;
  if (strategy === 'byte-cut') {
    return `${text.slice(0, cap)}\n\n… [truncated at ${cap}/${text.length} chars — call forge_issues.get for full body]`;
  }
  const minStart = Math.max(0, Math.floor(cap * 0.8));
  const head = text.slice(0, cap);
  const candidates = [head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.lastIndexOf(' ')];
  const cut = candidates.find((idx) => idx >= minStart) ?? cap;
  const body = text.slice(0, cut).replace(/\s+$/, '');
  return `${body}\n\n… [truncated at ${cut}/${text.length} chars — call forge_issues.get for full body]`;
}

function resolveIssueFields(
  jobType: JobType,
  override?: UserPromptPolicyOverride['includeFields'],
): IssueField[] {
  if (override && override.length > 0) return override;
  return ISSUE_FIELDS_PER_STATE[jobType] ?? [];
}

function resolveSessionPolicy(
  jobType: JobType,
  override?: UserPromptPolicyOverride['sessionContext'],
): { policy: SessionFieldPolicy; depth: number } {
  const base = SESSION_FIELDS_PER_STATE[jobType] ?? {
    decisions: false,
    filesModified: false,
    errorsResolved: false,
    reviewFeedback: false,
  };
  if (override?.fields) {
    const set = new Set(override.fields);
    return {
      policy: {
        decisions: set.has('decisions'),
        filesModified: set.has('filesModified'),
        errorsResolved: set.has('errorsResolved'),
        reviewFeedback: set.has('reviewFeedback'),
      },
      depth: override.depth ?? DEFAULT_SESSION_DEPTH,
    };
  }
  return { policy: base, depth: override?.depth ?? DEFAULT_SESSION_DEPTH };
}

export interface PriorHandoff {
  step: HandoffStep;
  payload: StepHandoffPayload;
}

/**
 * Render the `## Prior step handoffs` block. Renders each handoff as a
 * fenced JSON block keyed by step so the agent can scan structured data
 * rather than re-derive context from raw issue fields.
 */
function formatPriorHandoffs(handoffs: PriorHandoff[]): string {
  const lines: string[] = ['## Prior step handoffs'];
  for (const h of handoffs) {
    lines.push('', `### ${h.step}`, '```json', JSON.stringify(h.payload, null, 2), '```');
  }
  return lines.join('\n');
}

function formatIssueSnapshot(
  snapshot: IssueSnapshot,
  jobType: JobType,
  policy?: UserPromptPolicyOverride | null,
  /**
   * Set of HandoffSteps whose handoffs are present in this prompt. When a
   * step's handoff is injected, the overlapping raw field is dropped:
   *   triage handoff → drop raw `description`
   *   plan handoff   → drop raw `plan`
   * Other handoffs (code/review/test/fix) are additive — no overlap.
   */
  injectedSteps?: ReadonlySet<HandoffStep>,
): string {
  const fields = resolveIssueFields(jobType, policy?.includeFields);
  // Layer policy overrides onto defaults, skipping undefined values so an
  // unset cap doesn't clobber the default to `undefined` (Zod's optional
  // properties carry `| undefined` in their value type).
  const fieldCaps: Record<IssueField, number> = { ...DEFAULT_FIELD_CAPS };
  if (policy?.fieldCaps) {
    for (const [k, v] of Object.entries(policy.fieldCaps) as Array<
      [IssueField, number | undefined]
    >) {
      if (typeof v === 'number') fieldCaps[k] = v;
    }
  }
  const strategy = policy?.truncationStrategy ?? 'paragraph-boundary';
  const lines: string[] = ['## Issue', `Title: ${snapshot.title}`];

  const meta: string[] = [];
  if (snapshot.status) meta.push(`Status: ${snapshot.status}`);
  if (snapshot.priority) meta.push(`Priority: ${snapshot.priority}`);
  if (snapshot.complexity) meta.push(`Complexity: ${snapshot.complexity}`);
  if (meta.length > 0) lines.push(meta.join(' · '));

  const skipDescription =
    policy?.handoffs?.fallbackToRawIssueFieldIfMissing === false || injectedSteps?.has('triage');
  const skipPlan =
    policy?.handoffs?.fallbackToRawIssueFieldIfMissing === false || injectedSteps?.has('plan');

  if (fields.includes('description') && snapshot.description && !skipDescription) {
    lines.push('', 'Description:', truncate(snapshot.description, fieldCaps.description, strategy));
  }
  if (fields.includes('plan') && snapshot.plan && !skipPlan) {
    lines.push('', 'Plan:', truncate(snapshot.plan, fieldCaps.plan, strategy));
  }
  if (fields.includes('acceptanceCriteria') && snapshot.acceptanceCriteria) {
    lines.push(
      '',
      'Acceptance:',
      truncate(snapshot.acceptanceCriteria, fieldCaps.acceptanceCriteria, strategy),
    );
  }
  // Fetch-via-tool pointer: the prompt no longer inlines the issue body by
  // default. Tell the agent where the full data lives so it never works off
  // the title alone.
  lines.push(
    '',
    'Full issue body, comments, attachments, and prior step handoffs are NOT inlined here — call `forge_step_start` first to load them. Read an attached image/file with `forge_uploads` action=fetch.',
  );
  return lines.join('\n');
}

function formatSessionContext(
  ctx: SessionContextSnapshot,
  jobType: JobType,
  policyOverride?: UserPromptPolicyOverride['sessionContext'],
): string {
  const { policy, depth } = resolveSessionPolicy(jobType, policyOverride);
  const lines: string[] = ['## Previous Session Context'];

  if (ctx.currentState) {
    lines.push(`**Current state:** ${ctx.currentState}`);
  }

  if (policy.decisions && ctx.decisions && ctx.decisions.length > 0) {
    lines.push('**Key decisions:**');
    for (const d of ctx.decisions.slice(-Math.min(depth, SESSION_CAPS.decisions))) {
      lines.push(`- ${d}`);
    }
  }

  if (policy.filesModified && ctx.filesModified && ctx.filesModified.length > 0) {
    const files = ctx.filesModified.slice(-Math.min(depth, SESSION_CAPS.filesModified)).join(', ');
    lines.push(`**Files touched:** ${files}`);
  }

  if (policy.errorsResolved && ctx.errorsResolved && ctx.errorsResolved.length > 0) {
    lines.push('**Errors resolved:**');
    for (const e of ctx.errorsResolved.slice(-Math.min(depth, SESSION_CAPS.errorsResolved))) {
      lines.push(`- ${e}`);
    }
  }

  if (policy.reviewFeedback && ctx.reviewFeedback && ctx.reviewFeedback.length > 0) {
    lines.push('**Review feedback:**');
    for (const f of ctx.reviewFeedback.slice(-Math.min(depth, SESSION_CAPS.reviewFeedback))) {
      lines.push(`- ${typeof f === 'string' ? f : JSON.stringify(f)}`);
    }
  }

  const sessionCount = ctx.sessionCount ?? 0;
  const lastUpdated = ctx.lastUpdated ?? 'unknown';
  lines.push(`_Context from ${sessionCount} previous session(s), last updated ${lastUpdated}_`);

  return lines.join('\n');
}

/**
 * Build the user prompt for a job.
 *
 * Per-state policy overrides (from `appConfig.pipeline.states[state].userPromptPolicy`)
 * tune which issue fields to include, sessionContext depth/fields, field caps,
 * and truncation strategy.
 *
 * `turnLevelSystemPrompt` is used by PR-5b session-group resume path: when
 * resuming a Claude CLI session via `--resume`, the CLI may ignore
 * `--append-system-prompt` (undocumented), so we redundantly embed the state's
 * system prompt at the top of the user prompt as turn-level rules. The agent
 * follows the rules either way; cache may miss for that turn.
 */
/**
 * Inject a "Pipeline Rules (this turn)" block into an already-built prompt
 * string. Used at dispatch time (NOT enqueue time) when we discover the
 * job is resuming a prior CLI session — embeds the current state's system
 * prompt redundantly into the user message so the agent follows it even if
 * the Claude CLI ignores `--append-system-prompt` on `--resume`
 * (behavior undocumented).
 *
 * Inserts the block immediately after the first line (the `/<skill> <id>`
 * invocation) so the agent reads the rules before any issue context.
 *
 * Returns the input unchanged when `turnLevelSystemPrompt` is empty.
 */
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
  // Find the first \n (end of the `/<skill> <id>` line) and splice in the
  // rules block right after it. If there is no newline (single-line prompt),
  // append the block to the end.
  const firstNl = promptString.indexOf('\n');
  if (firstNl === -1) return `${promptString}${block}`;
  return `${promptString.slice(0, firstNl)}${block}${promptString.slice(firstNl)}`;
}

export function buildJobPromptString(args: {
  skillName?: string | null;
  jobType: JobType;
  issueId: string;
  issueSnapshot?: IssueSnapshot | null;
  policy?: UserPromptPolicyOverride | null;
  turnLevelSystemPrompt?: string | null;
  /**
   * ISS-232 — merge-required injection. Caller resolves the text via
   * `prompt/merge-required.ts:buildMergeRequiredBlock` from the project's
   * `pipelineConfig.mergeStates` + the job's `stageStatus`; when non-null,
   * it is spliced in immediately after the `/<skill> <issueId>` line so the
   * skill reads it before any issue context. Whitespace-only strings are
   * treated as null.
   */
  mergeRequiredText?: string | null;
  /**
   * Step-handoff injection (proposal Y). Pre-fetched by the caller from
   * `issue_step_contexts` (kind='handoff') for the current issue. When
   * `policy.handoffs.enabled`, the prompt renders these under
   * `## Prior step handoffs` and drops overlapping raw fields (triage drops
   * `description`, plan drops `plan`).
   */
  priorHandoffs?: PriorHandoff[] | null;
  /**
   * Step-handoff scope literals for the `## Termination protocol` block.
   * Required when `policy.handoffs.enabled` AND `jobType` is a handoff step
   * (triage/plan/code/review/test/fix) — without it the agent can't form
   * the `forge_memory.write` call. Caller pre-fills these from the job +
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

  // System-default-on (see pipeline/handoff-policy.ts). Explicit project
  // config still wins per-field; absent config falls back to enabled=true
  // with canonical inject lists per step.
  const resolvedHandoffs = resolveHandoffsPolicy(args.policy ?? null, args.jobType);
  const handoffsEnabled = resolvedHandoffs.enabled;
  const injectFromSteps = new Set<HandoffStep>(resolvedHandoffs.injectFromSteps);
  // Filter pre-fetched handoffs to the policy's allow-list so callers can
  // fetch broadly (all handoffs for the run) without leaking ones the
  // current state's policy didn't whitelist.
  const handoffsToRender =
    handoffsEnabled && args.priorHandoffs && args.priorHandoffs.length > 0
      ? args.priorHandoffs.filter((h) => injectFromSteps.has(h.step))
      : [];
  const injectedSteps = new Set<HandoffStep>(handoffsToRender.map((h) => h.step));

  const snapshot = args.issueSnapshot;
  if (snapshot) {
    lines.push('', formatIssueSnapshot(snapshot, args.jobType, args.policy ?? null, injectedSteps));

    if (handoffsToRender.length > 0) {
      lines.push('', formatPriorHandoffs(handoffsToRender));
    }

    const sc = snapshot.sessionContext;
    if (sc && (sc.sessionCount ?? 0) >= 1) {
      lines.push('', formatSessionContext(sc, args.jobType, args.policy?.sessionContext));
    }
  } else if (handoffsToRender.length > 0) {
    lines.push('', formatPriorHandoffs(handoffsToRender));
  }

  // Append `## Termination protocol` last so it sits at the end of the
  // prompt — agents read top-down; the work body comes first, the
  // termination contract is the final thing they see before acting.
  if (handoffsEnabled && isHandoffStep(args.jobType) && args.handoffScope) {
    lines.push('', renderTerminationBlock({ step: args.jobType, scope: args.handoffScope }));
  }

  return lines.join('\n');
}
