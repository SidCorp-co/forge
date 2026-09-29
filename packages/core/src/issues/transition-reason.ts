import { type Db, db } from '../db/client.js';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
import { comments } from '../db/schema.js';
import { actorAgency, type TransitionActor } from './actor-agency.js';
import { AWAITING_INPUT_STATUSES } from './status-sets.js';

export const REASON_REQUIRED_STATUSES = new Set<IssueStatus>(['reopen', 'waiting', 'needs_info']);

/**
 * Does this transition need an authored reason?
 */
export function requiresAuthoredReason(from: IssueStatus, to: IssueStatus): boolean {
  if (!REASON_REQUIRED_STATUSES.has(to) || from === to) return false;
  if (to === 'reopen' && from === 'in_progress') return false;
  return true;
}

const HEADINGS: Record<string, (from: IssueStatus, kind?: WaitingKind | null) => string> = {
  reopen: (from) => `🔁 **Reopened from \`${from}\`**`,
  needs_info: (from) => `❓ **Needs info** — moved from \`${from}\``,
  waiting: (from, kind) =>
    kind === 'needs_resource'
      ? `⏸ **Waiting on a person to supply something** — moved from \`${from}\``
      : `⏸ **Waiting on a human decision** — moved from \`${from}\``,
};

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
  return [`↩ **Left \`${from}\` for \`${to}\`**`, '', reason.trim()].join('\n');
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
  executor: Pick<Db, 'insert'>,
): Promise<void> {
  const reason = args.options.transitionReason ?? '';
  if (!announcesLeave(args.fromStatus, args.toStatus, reason, actorAgency(args.actor))) return;
  await executor.insert(comments).values({
    issueId: args.issue.id,
    authorId: args.actor.type === 'user' ? args.actor.id : args.actor.ownerId,
    body: buildLeaveBody(args.fromStatus, args.toStatus, reason),
    parentId: null,
  });
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
  executor: Pick<Db, 'insert'> = db,
): Promise<void> {
  if (!args.authorId) return;
  await executor.insert(comments).values({
    issueId: args.issueId,
    authorId: args.authorId,
    body: buildTransitionReasonBody(
      args.toStatus,
      args.fromStatus,
      args.reason,
      args.waitingKind ?? null,
    ),
    parentId: null,
  });
}

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
  if (!requiresAuthoredReason(fromStatus, requestedStatus) || options.skip === true) return null;
  if (!options.transitionReason?.trim()) {
    return {
      code: 'TRANSITION_REASON_REQUIRED',
      detail: `a transition to \`${requestedStatus}\` must carry a reason saying what is needed or what is wrong`,
    };
  }
  if (requestedStatus === 'waiting' && !options.waitingKind) {
    return {
      code: 'WAITING_KIND_REQUIRED',
      detail: 'a `waiting` park must say which kind it is: `needs_decision` or `needs_resource`',
    };
  }
  return null;
}
