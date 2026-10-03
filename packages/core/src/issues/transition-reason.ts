import { type Db, db } from '../db/client.js';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
import { comments } from '../db/schema.js';
import { actorAgency, type TransitionActor } from './actor-agency.js';
import { AWAITING_INPUT_STATUSES } from './status-sets.js';

/** The moves that carry the actor's reason, posted as a comment (`transition-guards.ts:reasonFault`). */
export const REASON_REQUIRED_STATUSES = new Set<IssueStatus>([
  'reopen',
  'needs_info',
  'on_hold',
  'dropped',
]);

/**
 * Does this transition need an authored reason?
 */
export function requiresAuthoredReason(from: IssueStatus, to: IssueStatus): boolean {
  return REASON_REQUIRED_STATUSES.has(to) && from !== to;
}

const NEEDS_INFO_HEADINGS: Record<WaitingKind, string> = {
  needs_answer: '❓ **Needs info**',
  needs_decision: '⏸ **Waiting on a human decision**',
  needs_resource: '⏸ **Waiting on a person to supply something**',
};

const HEADINGS: Record<string, (from: IssueStatus, kind?: WaitingKind | null) => string> = {
  // One shape for every announcement, so `announcesAMove` never reads a reopen as a person's reply.
  reopen: (from) => `🔁 **Reopened** — moved from \`${from}\``,
  needs_info: (from, kind) =>
    `${NEEDS_INFO_HEADINGS[kind ?? 'needs_answer']} — moved from \`${from}\``,
  on_hold: (from) => `⏸ **On hold** — moved from \`${from}\``,
  dropped: (from) => `🗑 **Dropped** — moved from \`${from}\``,
};

/** The first line of every announcement this module writes: a move into a park, or a person leaving one. */
const ANNOUNCES_A_MOVE = /(?:— moved from `[a-z_]+`|^↩ \*\*Left `[a-z_]+` for `[a-z_]+`\*\*)$/u;

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
    // A person's word on leaving a park is owed a reply, as every person's comment was (ISS-56).
    intent: actorAgency(args.actor) === 'human' ? 'question' : 'note',
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
