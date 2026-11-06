/**
 * What reads a confirm wait (ISS-902): whether the fix it stands on was withdrawn since it was set, and
 * the wait still holding on each item, for the doors that read items by summary.
 *
 * A wait stands on a shipped fix. When an issue carrying the item's fix leaves \`closed\` after the wait
 * was set (a reopen), its premise is gone, and the wait ends at once: hiding the item until its date
 * would be a silence. The kernel writes that move's \`kernel_transitions\` row in the reopen's own
 * transaction (\`lifecycle/transition.ts:transition\`), so the read that derives the end from it sees it
 * the moment the reopen commits, with no consumer between, and the end stands when the fix ships again.
 */

import type {
  FeedbackConfirmWaitMetView,
  FeedbackConfirmWaitView,
} from '@forge/contracts/feedback';
import { inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { confirmWaitMetOf, confirmWaitOf } from './confirm-wait-facts.js';

/**
 * Whether an issue carrying the item's fix, or its duplicate root's, left \`closed\` after the wait was
 * set. Spelled with its table names, as \`owed-verify.ts:reportedFromSql\` is, for the same reason.
 */
export const withdrawnSql = sql<boolean>`(feedback.confirm_wait_set_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM kernel_transitions kt
    JOIN feedback_route_issues ri ON ri.issue_id = kt.entity_id
   WHERE ri.feedback_id IN (feedback.id, feedback.duplicate_of)
     AND kt.entity = 'issue' AND kt.from_status = 'closed'
     AND kt.created_at > feedback.confirm_wait_set_at
))`;

/** The wait still holding on each of \`ids\`, read with whether its fix was withdrawn since. */
export async function confirmWaitsOf(
  ids: readonly string[],
  withhold: boolean,
  now: Date = new Date(),
): Promise<Map<string, FeedbackConfirmWaitView | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: feedback.id,
      confirmWaitUntil: feedback.confirmWaitUntil,
      confirmWaitOn: feedback.confirmWaitOn,
      confirmWaitReason: feedback.confirmWaitReason,
      confirmWaitSetAt: feedback.confirmWaitSetAt,
      confirmWaitSetBy: feedback.confirmWaitSetBy,
      confirmWaitRid: feedback.confirmWaitRid,
      confirmWaitThread: feedback.confirmWaitThread,
      confirmWaitMetAt: feedback.confirmWaitMetAt,
      withdrawn: withdrawnSql,
    })
    .from(feedback)
    .where(inArray(feedback.id, [...ids]));
  return new Map(rows.map((r) => [r.id, confirmWaitOf(r, now, withhold, r.withdrawn)]));
}

/** The room message that ended the wait on each of `ids` (ISS-1038), where one did. */
export async function confirmWaitMetsOf(
  ids: readonly string[],
  withhold: boolean,
): Promise<Map<string, FeedbackConfirmWaitMetView | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: feedback.id,
      confirmWaitMetAt: feedback.confirmWaitMetAt,
      confirmWaitMetBy: feedback.confirmWaitMetBy,
    })
    .from(feedback)
    .where(inArray(feedback.id, [...ids]));
  return new Map(rows.map((r) => [r.id, confirmWaitMetOf(r, withhold)]));
}
