/**
 * A steward decision on a feedback item, carried out as the person who answered it, inside the
 * answer's transaction (REQ-48 BC-5): a decline holds the triager's permission and takes the reason
 * the reporter reads; a verify or a reopen holds the rules the reporter's own door holds. Each is
 * refused by name exactly as its own door refuses it, so a refused act refuses the answer and the
 * question stays open.
 */

import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import type { Refusal } from '../lib/refusal.js';
import type { FeedbackActor } from './read.js';
import { rowIn } from './read.js';
import { decideActRefusal, personalActRefusal } from './rules.js';
import { declineIn, lockFeedback, personalActIn, roleFacts } from './service.js';

export type StewardFeedbackAct = 'declined' | 'verified' | 'reopened';

/** Decline, verify or reopen one item as `actor` in `tx`; a refusal, or null where it moved. */
export async function stewardSettleFeedbackIn(
  tx: Tx,
  input: {
    projectId: string;
    feedbackId: string;
    actor: FeedbackActor;
    act: StewardFeedbackAct;
    note: string | null;
  },
): Promise<Refusal | null> {
  await lockFeedback(tx, input.projectId);
  const row = await rowIn(tx, input.projectId, input.feedbackId, true);
  const facts = await roleFacts(input.actor, input.projectId);
  const note = input.note ?? undefined;
  if (input.act === 'declined') {
    return decideActRefusal(facts, 'declining feedback') ?? declineIn(tx, row, input.actor, note);
  }
  const forbidden = personalActRefusal(facts, input.act, input.actor.userId === row.reportedBy);
  return forbidden ?? personalActIn(tx, row, input.actor, input.act, note);
}

/** The feedback items an issue carries, by key: what a merge that drops the issue would strand. */
export async function feedbackCarriedBy(issueId: string): Promise<string[]> {
  const rows = rowsOf<{ fb_seq: number }>(
    await db.execute(sql`
      SELECT f.fb_seq FROM feedback f
       WHERE f.issue_id = ${issueId}
          OR f.id IN (SELECT c.feedback_id FROM feedback_route_issues c WHERE c.issue_id = ${issueId})
       ORDER BY f.fb_seq`),
  );
  return rows.map((r) => `FB-${r.fb_seq}`);
}
