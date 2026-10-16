import { postSystemComment } from '../comments/system-write.js';
import { db, type Tx } from '../db/client.js';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
import { actorAgency, type TransitionActor } from './actor-agency.js';
import { AWAITING_INPUT_STATUSES, ISSUE_STATUS_LABELS, statusForCaller } from './status-sets.js';

export const REASON_REQUIRED_STATUSES = new Set<IssueStatus>([
  'reopen',
  'waiting',
  'needs_info',
  'on_hold',
]);

/**
 * Statuses whose reason a trusted writer's `skip` does not waive. An entry into one is announced on
 * the thread whoever wrote it, because the announcement is what a reader pairs a hold with, and an
 * entry that wrote none is one nothing can be paired to.
 */
const REASON_NEVER_WAIVED = new Set<IssueStatus>(['on_hold']);

/** Whether this writer's `skip` waives the reason the move into `to` would otherwise owe. */
export function reasonWaived(to: IssueStatus, skip: boolean | undefined): boolean {
  return skip === true && !REASON_NEVER_WAIVED.has(to);
}

/**
 * Does this transition need an authored reason?
 */
export function requiresAuthoredReason(from: IssueStatus, to: IssueStatus): boolean {
  if (!REASON_REQUIRED_STATUSES.has(to) || from === to) return false;
  if (to === 'reopen' && from === 'in_progress') return false;
  return true;
}

const HEADINGS: Record<string, (from: IssueStatus, kind?: WaitingKind | null) => string> = {
  reopen: (from) => `🔁 **Reopened from ${ISSUE_STATUS_LABELS[from]}**`,
  needs_info: (from) => `❓ **Needs info** — moved from \`${from}\``,
  waiting: (from, kind) =>
    kind === 'needs_resource'
      ? `⏸ **Waiting on a person to supply something** — moved from \`${from}\``
      : `⏸ **Waiting on a human decision** — moved from \`${from}\``,
  on_hold: (from) => `⏸ **On hold** — moved from \`${from}\``,
};

/**
 * The first line of every announcement this module writes: a move into a park, or a person leaving one.
 * A leave names its statuses by label; the stored names are still read, for the ones written before that.
 */
const ANNOUNCES_A_MOVE =
  /(?:— moved from `[a-z_]+`|^↩ \*\*Left (?:`[a-z_]+`|[A-Z][A-Za-z ]*) for (?:`[a-z_]+`|[A-Z][A-Za-z ]*)\*\*)$/u;

/** Whether a comment is one of this module's move announcements rather than something a person wrote. */
export function announcesAMove(body: string): boolean {
  return ANNOUNCES_A_MOVE.test(body.split('\n')[0]?.trim() ?? '');
}

export function buildTransitionReasonBody(
  toStatus: IssueStatus,
  fromStatus: IssueStatus,
  reason: string,
  waitingKind?: WaitingKind | null,
): string {
  const heading = HEADINGS[toStatus]?.(fromStatus, waitingKind) ?? `**→ \`${toStatus}\`**`;
  return [heading, '', reason].join('\n');
}

/**
 * Whether this move out of a park — a status a person is stopped at — carries a person's reason the thread has not already got: the
 * next run reads the thread, and a park undone with no word there is one it puts back.
 */
export function announcesLeave(
  from: IssueStatus,
  to: IssueStatus,
  reason: string | undefined,
  agency: 'human' | 'agent',
): boolean {
  if (!AWAITING_INPUT_STATUSES.includes(from) || from === to || agency !== 'human') return false;
  return !requiresAuthoredReason(from, to) && Boolean(reason?.trim());
}

export function buildLeaveBody(from: IssueStatus, to: IssueStatus, reason: string): string {
  return [
    `↩ **Left ${ISSUE_STATUS_LABELS[from]} for ${ISSUE_STATUS_LABELS[to]}**`,
    '',
    reason.trim(),
  ].join('\n');
}

/** Post a person's reason for leaving a park, in the transition's own transaction. */
export async function postLeaveComment(
  args: {
    issue: { id: string };
    fromStatus: IssueStatus;
    toStatus: IssueStatus;
    actor: TransitionActor;
    options: { transitionReason?: string | undefined };
  },
  executor: Tx,
): Promise<void> {
  const reason = args.options.transitionReason ?? '';
  if (!announcesLeave(args.fromStatus, args.toStatus, reason, actorAgency(args.actor))) return;
  await postSystemComment(
    {
      issueId: args.issue.id,
      authorId: args.actor.type === 'user' ? args.actor.id : args.actor.ownerId,
      body: buildLeaveBody(args.fromStatus, args.toStatus, reason),
      parentId: null,
    },
    executor,
  );
}

/**
 * Post the reason. Throws on failure — the caller must let the transition fail
 * with it.
 */
export async function postTransitionReasonComment(
  args: {
    issueId: string;
    authorId: string | null;
    fromStatus: IssueStatus;
    toStatus: IssueStatus;
    reason: string;
    waitingKind?: WaitingKind | null;
    /** True when a device actor wrote it — an agent's rationale is still an agent's. */
  },
  executor: Tx = db,
): Promise<void> {
  if (!args.authorId) return;
  await postSystemComment(
    {
      issueId: args.issueId,
      authorId: args.authorId,
      body: buildTransitionReasonBody(
        args.toStatus,
        args.fromStatus,
        args.reason,
        args.waitingKind ?? null,
      ),
      parentId: null,
    },
    executor,
  );
}

/** What the reason must say, for a status whose question is not "what is needed or what is wrong". */
const REASON_SAYS: Partial<Record<IssueStatus, string>> = {
  on_hold: 'why the work is being paused',
};

/**
 * What is missing from a park's own account of itself, or `null`.
 */
export function parkReasonFault(
  fromStatus: IssueStatus,
  requestedStatus: IssueStatus,
  options: {
    transitionReason?: string | undefined;
    waitingKind?: WaitingKind | undefined;
    skip?: boolean | undefined;
  },
): { code: 'TRANSITION_REASON_REQUIRED' | 'WAITING_KIND_REQUIRED'; detail: string } | null {
  if (
    !requiresAuthoredReason(fromStatus, requestedStatus) ||
    reasonWaived(requestedStatus, options.skip)
  )
    return null;
  if (!options.transitionReason?.trim()) {
    return {
      code: 'TRANSITION_REASON_REQUIRED',
      detail: `a transition to ${statusForCaller(requestedStatus)} must carry a reason saying ${REASON_SAYS[requestedStatus] ?? 'what is needed or what is wrong'}, sent as \`reason\` (REST body, or \`data.reason\` / \`data.note\` on \`forge_issues\`)`,
    };
  }
  if (requestedStatus === 'waiting' && !options.waitingKind) {
    return {
      code: 'WAITING_KIND_REQUIRED',
      detail:
        'a Waiting (waiting) park must say which kind it is: `needs_decision` or `needs_resource`',
    };
  }
  return null;
}
