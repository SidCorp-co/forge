// RFC 0002 INV-8 — a reopen carries its rationale as a comment, written before
// the status flips.
//
// The fix step scopes its patch against the newest comment on the issue. Three
// deleted guards (bounce-replay, empty-reopen, unexplained-reopen) all existed
// to notice AFTERWARDS that this comment was missing, and all three noticed it
// by stranding the issue at `needs_info`. Requiring it up front removes the
// class instead of detecting it.

import { db } from '../db/client.js';
import { comments } from '../db/schema.js';

export function buildReopenReasonBody(fromStatus: string, reason: string): string {
  return [`🔁 **Reopened from \`${fromStatus}\`**`, '', reason].join('\n');
}

/**
 * Post the reopen rationale. Throws on failure — the caller must let the
 * transition fail with it.
 */
// cm:guard this MUST NOT swallow its error, unlike every other comment helper in this repo — the comment IS the reason the transition was allowed, so a reopen that commits without it is the unexplained reopen the requirement exists to prevent
export async function postReopenReasonComment(args: {
  issueId: string;
  authorId: string | null;
  fromStatus: string;
  reason: string;
  /** True when a device actor wrote it — an agent's rationale is still an agent's. */
  isAi: boolean;
}): Promise<void> {
  if (!args.authorId) return;
  await db.insert(comments).values({
    issueId: args.issueId,
    authorId: args.authorId,
    body: buildReopenReasonBody(args.fromStatus, args.reason),
    parentId: null,
    isAi: args.isAi,
  });
}
