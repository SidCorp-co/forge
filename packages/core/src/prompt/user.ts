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

/** Per-state policy override resolved from `appConfig.pipeline.states[state].userPromptPolicy`. */
export interface UserPromptPolicyOverride {
  includeFields?: IssueField[];
  sessionContext?: {
    depth?: number;
    fields?: SessionContextField[];
  };
  fieldCaps?: Partial<Record<IssueField, number>>;
  truncationStrategy?: 'paragraph-boundary' | 'byte-cut';
}

const DEFAULT_FIELD_CAPS: Record<IssueField, number> = {
  description: 8000,
  plan: 16000,
  acceptanceCriteria: 4000,
};

const DEFAULT_SESSION_DEPTH = 10;

const SESSION_CAPS = {
  decisions: 10,
  filesModified: 15,
  errorsResolved: 5,
  reviewFeedback: 5,
} as const;

const ISSUE_FIELDS_PER_STATE: Record<JobType, IssueField[]> = {
  triage: ['description'],
  clarify: ['description', 'acceptanceCriteria'],
  plan: ['description', 'acceptanceCriteria'],
  code: ['description', 'plan', 'acceptanceCriteria'],
  review: ['plan', 'acceptanceCriteria'],
  test: ['acceptanceCriteria'],
  release: [],
  fix: ['description', 'plan', 'acceptanceCriteria'],
  custom: ['description'],
  pm: [],
};

interface SessionFieldPolicy {
  decisions: boolean;
  filesModified: boolean;
  errorsResolved: boolean;
  reviewFeedback: boolean;
}

const SESSION_FIELDS_PER_STATE: Record<JobType, SessionFieldPolicy> = {
  triage:   { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  clarify:  { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  plan:     { decisions: true,  filesModified: false, errorsResolved: false, reviewFeedback: false },
  code:     { decisions: true,  filesModified: true,  errorsResolved: true,  reviewFeedback: true  },
  review:   { decisions: true,  filesModified: true,  errorsResolved: false, reviewFeedback: false },
  test:     { decisions: false, filesModified: true,  errorsResolved: false, reviewFeedback: false },
  release:  { decisions: true,  filesModified: true,  errorsResolved: false, reviewFeedback: false },
  fix:      { decisions: true,  filesModified: true,  errorsResolved: true,  reviewFeedback: true  },
  custom:   { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  pm:       { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
};

function truncate(
  text: string,
  cap: number,
  strategy: 'paragraph-boundary' | 'byte-cut',
): string {
  if (text.length <= cap) return text;
  if (strategy === 'byte-cut') {
    return `${text.slice(0, cap)}\n\n… [truncated at ${cap}/${text.length} chars — call forge_issues.get for full body]`;
  }
  const minStart = Math.max(0, Math.floor(cap * 0.8));
  const head = text.slice(0, cap);
  const candidates = [
    head.lastIndexOf('\n\n'),
    head.lastIndexOf('\n'),
    head.lastIndexOf(' '),
  ];
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
    decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false,
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

function formatIssueSnapshot(
  snapshot: IssueSnapshot,
  jobType: JobType,
  policy?: UserPromptPolicyOverride | null,
): string {
  const fields = resolveIssueFields(jobType, policy?.includeFields);
  const fieldCaps = { ...DEFAULT_FIELD_CAPS, ...(policy?.fieldCaps ?? {}) };
  const strategy = policy?.truncationStrategy ?? 'paragraph-boundary';
  const lines: string[] = ['## Issue', `Title: ${snapshot.title}`];

  const meta: string[] = [];
  if (snapshot.status) meta.push(`Status: ${snapshot.status}`);
  if (snapshot.priority) meta.push(`Priority: ${snapshot.priority}`);
  if (snapshot.complexity) meta.push(`Complexity: ${snapshot.complexity}`);
  if (meta.length > 0) lines.push(meta.join(' · '));

  if (fields.includes('description') && snapshot.description) {
    lines.push('', 'Description:', truncate(snapshot.description, fieldCaps.description, strategy));
  }
  if (fields.includes('plan') && snapshot.plan) {
    lines.push('', 'Plan:', truncate(snapshot.plan, fieldCaps.plan, strategy));
  }
  if (fields.includes('acceptanceCriteria') && snapshot.acceptanceCriteria) {
    lines.push('', 'Acceptance:', truncate(snapshot.acceptanceCriteria, fieldCaps.acceptanceCriteria, strategy));
  }
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
export function buildJobPromptString(args: {
  skillName?: string | null;
  jobType: JobType;
  issueId: string;
  issueSnapshot?: IssueSnapshot | null;
  policy?: UserPromptPolicyOverride | null;
  turnLevelSystemPrompt?: string | null;
}): string {
  const skill =
    args.skillName && args.skillName.length > 0 ? args.skillName : `forge-${args.jobType}`;
  const lines: string[] = [`/${skill} ${args.issueId}`];

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

  const snapshot = args.issueSnapshot;
  if (snapshot) {
    lines.push('', formatIssueSnapshot(snapshot, args.jobType, args.policy ?? null));

    const sc = snapshot.sessionContext;
    if (sc && (sc.sessionCount ?? 0) >= 1) {
      lines.push('', formatSessionContext(sc, args.jobType, args.policy?.sessionContext));
    }
  }

  return lines.join('\n');
}
