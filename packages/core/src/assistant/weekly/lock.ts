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

// cm:guard the `_try_` form on purpose, the opposite of `lib/attachment-name-lock.ts`: a second run for the same week has nothing to wait for — the first one posts the report, and the published check would skip the second anyway — so it skips now and says why rather than holding a connection for the length of a judging pass
// cm:guard the lock lives on the TRANSACTION handle; `pg_try_advisory_xact_lock` through the pooled `db` would be released the instant the statement returned and lock nothing (ISS-963's lesson). The transaction carries no write of its own — the comment and its files are written through `db` inside `fn` — it is the lock's lifetime and nothing else
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
