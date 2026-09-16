/**
 * ISS-1056 — one run per project and window at a time, shared by the cron and the run-now door
 * (codex F1 on the route). The already-posted check is a read followed, minutes later, by a
 * write; two runs that both pass it post two reports. A transaction-scoped advisory lock keyed by
 * project and window makes the second run skip by name instead, and is gone the moment the first
 * ends — a failed run holds nothing, so the retry is still possible.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';

export type LockOutcome<T> = { acquired: false } | { acquired: true; value: T };

export type WeeklyLock = <T>(
  projectId: string,
  windowId: string,
  fn: () => Promise<T>,
) => Promise<LockOutcome<T>>;

export const withWeeklyLock: WeeklyLock = async (projectId, windowId, fn) =>
  db.transaction(async (tx) => {
    const rows = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`assistant-weekly:${projectId}:${windowId}`}, 0)) AS locked`,
    );
    const first = (Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0]) as
      | { locked: boolean }
      | undefined;
    if (!first?.locked) return { acquired: false };
    return { acquired: true, value: await fn() };
  });
