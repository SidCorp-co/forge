import type { JobType } from '../db/schema.js';

/**
 * Snapshot of an issue at job enqueue time. Pre-loaded by the caller
 * (orchestrator) so the agent doesn't have to spend an MCP round-trip on
 * `forge_issues.get` for the basics. The agent can still fetch via MCP
 * for relations / attachments / comments that aren't snapshotted here.
 *
 * Per-state field inclusion is decided by `ISSUE_FIELDS_PER_STATE` below;
 * the caller hands in the full record, the renderer picks what each state
 * needs. Keeps the orchestrator simple (one SELECT) and the per-state
 * policy co-located here with the formatter.
 */
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

const FIELD_CAPS = {
  description: 8000,
  plan: 16000,
  acceptanceCriteria: 4000,
} as const;

const SESSION_CAPS = {
  decisions: 10,
  filesModified: 15,
  errorsResolved: 5,
  reviewFeedback: 5,
} as const;

type IssueField = 'description' | 'plan' | 'acceptanceCriteria';

/**
 * Per-state issue field inclusion. Triage just needs the description; code
 * needs the full plan; review checks plan against changes; release only
 * needs the title. Drives prompt token cost — minimise per state.
 */
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

/**
 * Per-state sessionContext field inclusion. Plan reads decisions only; code
 * and fix need everything (they resume work and need the full trail);
 * review reads decisions + filesModified (to focus on changed files);
 * triage/clarify skip entirely (issue is fresh).
 */
interface SessionFieldPolicy {
  decisions: boolean;
  filesModified: boolean;
  errorsResolved: boolean;
  reviewFeedback: boolean;
}

const SESSION_FIELDS_PER_STATE: Record<JobType, SessionFieldPolicy> = {
  triage: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  clarify: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  plan: { decisions: true, filesModified: false, errorsResolved: false, reviewFeedback: false },
  code: { decisions: true, filesModified: true, errorsResolved: true, reviewFeedback: true },
  review: { decisions: true, filesModified: true, errorsResolved: false, reviewFeedback: false },
  test: { decisions: false, filesModified: true, errorsResolved: false, reviewFeedback: false },
  release: { decisions: true, filesModified: true, errorsResolved: false, reviewFeedback: false },
  fix: { decisions: true, filesModified: true, errorsResolved: true, reviewFeedback: true },
  custom: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
  pm: { decisions: false, filesModified: false, errorsResolved: false, reviewFeedback: false },
};

/**
 * Truncate at the last paragraph boundary (`\n\n`) before `cap`, falling back
 * to the last newline or word boundary so the cut never lands inside a code
 * fence, list item, or sentence. Appends a hint pointing the agent at
 * `forge_issues.get` for the full body.
 *
 * Search window for the boundary is `cap*0.2` chars back from the cap — past
 * that, paragraphs are too far apart and we'd waste too much capacity, so we
 * fall through to newline/word/byte cuts.
 */
function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
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

function formatIssueSnapshot(snapshot: IssueSnapshot, jobType: JobType): string {
  const fields = ISSUE_FIELDS_PER_STATE[jobType] ?? [];
  const lines: string[] = ['## Issue', `Title: ${snapshot.title}`];

  const meta: string[] = [];
  if (snapshot.status) meta.push(`Status: ${snapshot.status}`);
  if (snapshot.priority) meta.push(`Priority: ${snapshot.priority}`);
  if (snapshot.complexity) meta.push(`Complexity: ${snapshot.complexity}`);
  if (meta.length > 0) lines.push(meta.join(' · '));

  if (fields.includes('description') && snapshot.description) {
    lines.push('', 'Description:', truncate(snapshot.description, FIELD_CAPS.description));
  }
  if (fields.includes('plan') && snapshot.plan) {
    lines.push('', 'Plan:', truncate(snapshot.plan, FIELD_CAPS.plan));
  }
  if (fields.includes('acceptanceCriteria') && snapshot.acceptanceCriteria) {
    lines.push(
      '',
      'Acceptance:',
      truncate(snapshot.acceptanceCriteria, FIELD_CAPS.acceptanceCriteria),
    );
  }
  return lines.join('\n');
}

function formatSessionContext(ctx: SessionContextSnapshot, jobType: JobType): string {
  const policy = SESSION_FIELDS_PER_STATE[jobType];
  const lines: string[] = ['## Previous Session Context'];

  if (ctx.currentState) {
    lines.push(`**Current state:** ${ctx.currentState}`);
  }

  if (policy.decisions && ctx.decisions && ctx.decisions.length > 0) {
    lines.push('**Key decisions:**');
    for (const d of ctx.decisions.slice(-SESSION_CAPS.decisions)) {
      lines.push(`- ${d}`);
    }
  }

  if (policy.filesModified && ctx.filesModified && ctx.filesModified.length > 0) {
    const files = ctx.filesModified.slice(-SESSION_CAPS.filesModified).join(', ');
    lines.push(`**Files touched:** ${files}`);
  }

  if (policy.errorsResolved && ctx.errorsResolved && ctx.errorsResolved.length > 0) {
    lines.push('**Errors resolved:**');
    for (const e of ctx.errorsResolved.slice(-SESSION_CAPS.errorsResolved)) {
      lines.push(`- ${e}`);
    }
  }

  if (policy.reviewFeedback && ctx.reviewFeedback && ctx.reviewFeedback.length > 0) {
    lines.push('**Review feedback:**');
    for (const f of ctx.reviewFeedback.slice(-SESSION_CAPS.reviewFeedback)) {
      lines.push(`- ${typeof f === 'string' ? f : JSON.stringify(f)}`);
    }
  }

  const sessionCount = ctx.sessionCount ?? 0;
  const lastUpdated = ctx.lastUpdated ?? 'unknown';
  lines.push(`_Context from ${sessionCount} previous session(s), last updated ${lastUpdated}_`);

  return lines.join('\n');
}

/**
 * SSOT for the runner-facing prompt string. Stamped at every issue-bound
 * job insert site (orchestrator, PM dispatch, escalation fallback) and
 * forwarded verbatim to the runner via the `job.assigned` WS event.
 *
 * `issueSnapshot` is optional — when present the renderer inlines title +
 * per-state issue fields + per-state sessionContext (gated by
 * `sessionCount >= 1`) directly into the prompt, so the agent doesn't
 * round-trip MCP for the basics. Caller is responsible for one SELECT
 * upfront; we centralise the per-state field policy here.
 *
 * Falls back to the conventional `forge-<jobType>` skill name when no
 * project-specific skill is registered.
 */
export function buildJobPromptString(args: {
  skillName?: string | null;
  jobType: JobType;
  issueId: string;
  issueSnapshot?: IssueSnapshot | null;
}): string {
  const skill =
    args.skillName && args.skillName.length > 0 ? args.skillName : `forge-${args.jobType}`;
  const lines: string[] = [`/${skill} ${args.issueId}`];

  const snapshot = args.issueSnapshot;
  if (snapshot) {
    lines.push('', formatIssueSnapshot(snapshot, args.jobType));

    const sc = snapshot.sessionContext;
    if (sc && (sc.sessionCount ?? 0) >= 1) {
      lines.push('', formatSessionContext(sc, args.jobType));
    }
  }

  return lines.join('\n');
}
