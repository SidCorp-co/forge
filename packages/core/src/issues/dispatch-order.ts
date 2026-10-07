/**
 * The order a master is handed takeable work in, one definition for every reader: the admissible
 * list's SQL (`devices/admissible.ts`) and the forecast's queue (`forecast/read.ts`). Priority
 * first, critical to none as `issuePriorities` lists them, then the oldest first, so a priority a
 * person sets moves the issue up the queue the masters take top-down.
 */

import { type SQL, sql } from 'drizzle-orm';
import { issuePriorities } from '../db/schema-issues.js';

const UNRANKED = issuePriorities.length;

export function dispatchPriorityRank(priority: string | null | undefined): number {
  const at = (issuePriorities as readonly string[]).indexOf(priority ?? '');
  return at < 0 ? UNRANKED : at;
}

/** `ORDER BY` over the issues table under `alias`, in dispatch order. */
export function dispatchOrderSql(alias: string): SQL {
  const col = (name: string) => sql.raw(`${alias}.${name}`);
  const ranks = issuePriorities.map((p, i) => sql`WHEN ${p} THEN ${sql.raw(String(i))}`);
  return sql`CASE ${col('priority')} ${sql.join(ranks, sql` `)} ELSE ${sql.raw(String(UNRANKED))} END ASC, ${col('created_at')} ASC`;
}

export function compareDispatchOrder(
  a: { priority: string | null; createdAt: string | Date },
  b: { priority: string | null; createdAt: string | Date },
): number {
  return (
    dispatchPriorityRank(a.priority) - dispatchPriorityRank(b.priority) ||
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}
