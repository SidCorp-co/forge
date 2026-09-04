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

// cm:guard adding a status here makes the reason MANDATORY for every writer of it — core's own system writers included, so add the argument at those call sites in the same change or the transition throws at runtime with the tests green
export const REASON_REQUIRED_STATUSES = new Set<IssueStatus>(['reopen', 'waiting', 'needs_info']);

/**
 * Does this transition need an authored reason?
 */
// cm:guard the `in_progress → reopen` carve-out is reopen-ONLY and must stay that way — that pair is the system's own mechanical revert (finalize-failure reverting a `fix` job to its entry status), whereas `in_progress → waiting` is the commonest genuine park there is, and exempting it would let the most frequent case skip the requirement entirely
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
// cm:guard this MUST NOT swallow its error, unlike every other comment helper in this repo — the comment IS the reason the transition was allowed, so a park that commits without it is the unexplained park the requirement exists to prevent
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
