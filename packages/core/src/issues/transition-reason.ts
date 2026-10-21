import { AWAITING_INPUT_STATUSES, ISSUE_MACHINE } from '@forge/contracts/issue-machine';
import { db, type Tx } from '../db/client.js';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
import { actorAgency, type TransitionActor } from './actor-agency.js';
import { postIssueNotice } from './ports.js';

/** Does this move carry the actor's reason, posted as a comment (`transition-guards.ts:reasonFault`)? */
export function requiresAuthoredReason(from: IssueStatus, to: IssueStatus): boolean {
  return ISSUE_MACHINE.reasonRequired.includes(to) && from !== to;
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

/** The first line of every announcement this module writes: a move into a park, or a person leaving
 *  one; and of a park's re-point (`park-repoint.ts:REPOINT_HEADING`), which moves nothing either. */
const ANNOUNCES_A_MOVE =
  /(?:— moved from `[a-z_]+`|^↩ \*\*Left `[a-z_]+` for `[a-z_]+`\*\*|^↪ \*\*Re-pointed `[a-z_]+`\*\*)$/u;

/** Whether a comment is one of this module's move announcements rather than something a person wrote. */
export function announcesAMove(body: string): boolean {
  return ANNOUNCES_A_MOVE.test(body.split('\n')[0]?.trim() ?? '');
}

function buildTransitionReasonBody(
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
function announcesLeave(
  from: IssueStatus,
  to: IssueStatus,
  reason: string | undefined,
  agency: 'human' | 'agent',
): boolean {
  if (!AWAITING_INPUT_STATUSES.includes(from) || from === to || agency !== 'human') return false;
  return !requiresAuthoredReason(from, to) && Boolean(reason?.trim());
}

function buildLeaveBody(from: IssueStatus, to: IssueStatus, reason: string): string {
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
  tx: Tx,
): Promise<void> {
  const reason = args.options.transitionReason ?? '';
  if (!announcesLeave(args.fromStatus, args.toStatus, reason, actorAgency(args.actor))) return;
  await postIssueNotice(
    {
      issueId: args.issue.id,
      authorId: args.actor.type === 'user' ? args.actor.id : args.actor.ownerId,
      body: buildLeaveBody(args.fromStatus, args.toStatus, reason),
      // A person's word on leaving a park is marked a question: the agent owes it a reply (ISS-56).
      intent: actorAgency(args.actor) === 'human' ? 'question' : 'note',
      authorsWords: true,
      screenedAt: '/reason',
    },
    tx,
  );
}

/**
 * Whether this move is a hand-back of an issue nothing holds, along a recovery edge, to a status that
 * posts no reason of its own (`requiresAuthoredReason`): its reason is otherwise only on the audit
 * row, and the thread reads an issue moved back with no word of why. The kernel's carries its reason;
 * a person's must (`transition-faults.ts:reasonFault`). The reconciler's wedge reset, which posts its
 * own notice, gives no `transitionReason` and is not this.
 */
function announcesRecovery(
  from: IssueStatus,
  to: IssueStatus,
  reason: string | undefined,
  recovering: boolean,
): boolean {
  if (!recovering || from === to) return false;
  return !requiresAuthoredReason(from, to) && Boolean(reason?.trim());
}

function buildRecoveryBody(
  from: IssueStatus,
  to: IssueStatus,
  reason: string,
  agency: 'human' | 'agent',
): string {
  const heading = `↩ **Handed back — moved from \`${from}\` to \`${to}\`**`;
  if (agency === 'human') return [heading, '', reason.trim()].join('\n');
  return [
    heading,
    '',
    `Forge made this move, not a person: ${reason.trim()}. Nothing holds the issue any more, so it is back at the status its run took it from.`,
  ].join('\n');
}

/** Post why an issue was handed back (`announcesRecovery`), the kernel's or a person's, in the transition's own transaction. */
export async function postRecoveryNotice(
  args: {
    issue: { id: string };
    fromStatus: IssueStatus;
    toStatus: IssueStatus;
    actor: TransitionActor;
    recovering: boolean;
    options: { transitionReason?: string | undefined };
  },
  tx: Tx,
): Promise<void> {
  const reason = args.options.transitionReason ?? '';
  const agency = actorAgency(args.actor);
  if (!announcesRecovery(args.fromStatus, args.toStatus, reason, args.recovering)) return;
  await postIssueNotice(
    {
      issueId: args.issue.id,
      authorId: args.actor.type === 'user' ? args.actor.id : args.actor.ownerId,
      body: buildRecoveryBody(args.fromStatus, args.toStatus, reason, agency),
      intent: 'note',
      // a person's reason is their own words, screened as every person's comment is
      ...(agency === 'human' ? { authorsWords: true, screenedAt: '/reason' } : {}),
    },
    tx,
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
  tx: Tx = db,
): Promise<void> {
  if (!args.authorId) return;
  await postIssueNotice(
    {
      issueId: args.issueId,
      authorId: args.authorId,
      body: buildTransitionReasonBody(
        args.toStatus,
        args.fromStatus,
        args.reason,
        args.waitingKind ?? null,
      ),
      authorsWords: true,
      screenedAt: '/reason',
    },
    tx,
  );
}
