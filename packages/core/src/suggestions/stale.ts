/**
 * The two ways a proposed suggestion goes stale without anybody deciding it (workflow
 * `suggestion-lifecycle`, edge proposed → stale): its target moved past its base, set in the
 * transaction that moved it; or it stayed proposed past 30 days, set by the retention sweep, which
 * also purges the payload of a rejected, stale or withdrawn row 90 days after its decision.
 */

import { and, eq, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { suggestions } from '../db/schema-suggestions.js';
import { PURGE_PAYLOAD_AFTER_DAYS, STALE_AFTER_DAYS } from './rules.js';

// cm:guard a newer revision of the target is written → every proposed suggestion whose base is not
// that revision is stale, in the same transaction, so no accept can apply it on a moved head
export async function staleOnTargetRevised(
  tx: Tx,
  requirementId: string,
  head: number,
): Promise<number> {
  const rows = await tx
    .update(suggestions)
    .set({
      status: 'stale',
      decidedAt: new Date(),
      reason: `the requirement moved to revision ${head}`,
    })
    .where(
      and(
        eq(suggestions.requirementId, requirementId),
        eq(suggestions.status, 'proposed'),
        or(sql`${suggestions.baseRevision} IS NULL`, ne(suggestions.baseRevision, head)),
      ),
    )
    .returning({ id: suggestions.id });
  return rows.length;
}

export interface SuggestionSweepResult {
  /** Proposed past STALE_AFTER_DAYS, marked stale this tick. */
  staled: number;
  /** Payloads cleared this tick; the row keeps kind, model, status and decided_at for the metric. */
  purged: number;
}

export async function sweepSuggestions(now: Date = new Date()): Promise<SuggestionSweepResult> {
  const day = 86_400_000;
  const staleBefore = new Date(now.getTime() - STALE_AFTER_DAYS * day);
  const purgeBefore = new Date(now.getTime() - PURGE_PAYLOAD_AFTER_DAYS * day);
  const staled = await db
    .update(suggestions)
    .set({ status: 'stale', decidedAt: now, reason: `undecided for ${STALE_AFTER_DAYS} days` })
    .where(and(eq(suggestions.status, 'proposed'), lt(suggestions.createdAt, staleBefore)))
    .returning({ id: suggestions.id });
  const purged = await db
    .update(suggestions)
    .set({ payload: null, payloadPurgedAt: now })
    .where(
      and(
        sql`${suggestions.status} IN ('rejected', 'stale', 'withdrawn')`,
        isNotNull(suggestions.payload),
        lt(suggestions.decidedAt, purgeBefore),
      ),
    )
    .returning({ id: suggestions.id });
  return { staled: staled.length, purged: purged.length };
}
