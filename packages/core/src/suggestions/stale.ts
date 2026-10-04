/**
 * The two ways a proposed suggestion goes stale without anybody deciding it (workflow
 * `suggestion-lifecycle`, edge proposed → stale): its target moved past its base, set in the
 * transaction that moved it; or it stayed proposed past 30 days, set by the retention sweep, which
 * also purges the payload of a rejected, stale or withdrawn row 90 days after its decision.
 */

import { SUGGESTION_MACHINE } from '@forge/contracts/suggestion-machine';
import {
  SUGGESTION_PURGE_PAYLOAD_AFTER_DAYS as PURGE_PAYLOAD_AFTER_DAYS,
  SUGGESTION_STALE_AFTER_DAYS as STALE_AFTER_DAYS,
} from '@forge/contracts/suggestions';
import { and, eq, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { suggestions } from '../db/schema-suggestions.js';
import { transition } from '../lifecycle/index.js';

// cm:guard a newer revision of the target is written → every proposed suggestion whose base is not
// that revision is stale, in the same transaction, so no accept can apply it on a moved head
export async function staleOnTargetRevised(
  tx: Tx,
  requirementId: string,
  head: number,
): Promise<number> {
  const why = `the requirement moved to revision ${head}`;
  const { rows } = await transition(tx, SUGGESTION_MACHINE, {
    to: 'stale',
    from: 'proposed',
    set: { decidedAt: new Date(), reason: why },
    where: and(
      eq(suggestions.requirementId, requirementId),
      or(sql`${suggestions.baseRevision} IS NULL`, ne(suggestions.baseRevision, head)),
    ),
    reason: why,
    actor: { type: 'system' },
    source: 'suggestions-stale',
    returning: ['id'],
  });
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
  const undecided = `undecided for ${STALE_AFTER_DAYS} days`;
  const { rows: staled } = await transition(db, SUGGESTION_MACHINE, {
    to: 'stale',
    from: 'proposed',
    set: { decidedAt: now, reason: undecided },
    where: lt(suggestions.createdAt, staleBefore),
    reason: undecided,
    actor: { type: 'sweeper' },
    source: 'suggestions-sweep',
    returning: ['id'],
  });
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
