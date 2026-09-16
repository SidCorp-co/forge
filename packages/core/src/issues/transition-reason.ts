// RFC 0002 INV-8, generalised — the three statuses that STOP the pipeline each
// carry the reason they stopped it, written before the status flips.
//
// `reopen` needs one because the fix step scopes its patch against it.
// `waiting` and `needs_info` need one for a blunter reason: both mean "a human
// is needed", and a park that does not say what is needed is a question nobody
// can answer. Measured on forge-beta 2026-08-14: all 43 issues sitting at
// `waiting` had `waiting_kind` NULL and no machine-readable ask between them.
//
// This replaces policing WHO answers. The deleted `hasHumanAnswerSince` guard
// existed because the question was invisible, so the only available check was
// on the answer's author. A question that is on the record needs no such check.

import { type Db, db } from '../db/client.js';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
import { comments } from '../db/schema.js';

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
