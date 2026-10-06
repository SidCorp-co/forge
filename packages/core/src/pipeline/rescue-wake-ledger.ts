/**
 * The reconciler's rescue wake recovers a LOST wake — one that reached no box — and is not a
 * heartbeat. Once a rescue has reached a box for an issue as it stands, it is redelivered on a
 * doubling delay and stops after a fixed count, the shape pg-boss gives a failed job
 * (`dist/plans.js` `failJobsBody`: `retry_delay * 2^retry_count` up to `retry_delay_max`, then
 * `retry_limit`). A change to the issue (its `updated_at`) starts a fresh count.
 *
 * Kept in memory: production runs one core instance (c-core-instances), and the wake itself is an
 * in-memory frame nothing buffers. A restart forgets the counts, which costs at most one more
 * bounded run of rescues per idle issue.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/** Delay before the first redelivery of a rescue that reached a box; each further one doubles it. */
const RESCUE_REDELIVERY_BASE_MS = 2 * 60_000;
/** Rescues that reach a box for one issue as it stands; the last waits 32 min after the one before. */
export const RESCUE_DELIVERY_LIMIT = 6;

interface Delivered {
  /** `issues.updated_at::text` the rescues were counted against. */
  changedAt: string;
  count: number;
  lastAt: number;
}

const ledger = new Map<string, Delivered>();

function nextDueAt(entry: Delivered): number {
  if (entry.count >= RESCUE_DELIVERY_LIMIT) return Number.POSITIVE_INFINITY;
  return entry.lastAt + RESCUE_REDELIVERY_BASE_MS * 2 ** (entry.count - 1);
}

/**
 * The issues whose rescue is not due at `now`, as a JSON row set the stuck-issue query excludes on
 * `(id, updated_at)`. Entries whose issue has changed or left `status` are dropped first.
 */
export async function rescuesNotDue(status: string, now: number): Promise<string> {
  if (ledger.size > 0) {
    const all = JSON.stringify([...ledger].map(([id, e]) => ({ id, at: e.changedAt })));
    const standing = (await db.execute(sql`
      SELECT w.id
        FROM jsonb_to_recordset(${all}::jsonb) AS w(id uuid, at text)
        JOIN issues i ON i.id = w.id AND i.status = ${status} AND i.updated_at = w.at::timestamptz
    `)) as unknown as Array<{ id: string }>;
    const keep = new Set(standing.map((r) => r.id));
    for (const id of ledger.keys()) if (!keep.has(id)) ledger.delete(id);
  }
  return JSON.stringify(
    [...ledger].filter(([, e]) => nextDueAt(e) > now).map(([id, e]) => ({ id, at: e.changedAt })),
  );
}

/** Count a rescue that reached a box. Returns true when it was the last one this change is owed. */
export function recordDeliveredRescue(issueId: string, changedAt: string, now: number): boolean {
  const prior = ledger.get(issueId);
  const count = prior && prior.changedAt === changedAt ? prior.count + 1 : 1;
  ledger.set(issueId, { changedAt, count, lastAt: now });
  return count >= RESCUE_DELIVERY_LIMIT;
}
