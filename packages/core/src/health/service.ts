/**
 * The liveness probe, answered once for both transports.
 *
 * `GET /health` and the `forge_health` MCP tool each carried their own copy of
 * the same three checks. The tool's doc comment already said it "wraps the same
 * three checks as `app.get('/health')`" — a sentence that only stays true by
 * hand.
 */

import { count, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { isBossStarted } from '../queue/boss.js';
import { isWsListening } from '../ws/server.js';

// cm:why `held` counts as active (RFC 0002) — it is a live job that runs once its mechanical condition clears, so an operator asking "what is in flight" must see it; the stuck-job scan keys on dispatchedAt age instead and so can never flag one
const ACTIVE_JOB_STATUSES = ['queued', 'dispatched', 'running', 'held'] as const;

export type LivenessSnapshot = {
  ok: boolean;
  dbOk: boolean;
  queueOk: boolean;
  wsOk: boolean;
};

/** Can the process reach its database, its queue, and its websocket listener? */
// cm:guard every probe here SWALLOWS its own failure and reports false. A health endpoint that throws is indistinguishable from a process that is down, and the whole point of the payload is to say WHICH leg is broken.
export async function readLiveness(): Promise<LivenessSnapshot> {
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const queueOk = isBossStarted();
  const wsOk = isWsListening();
  return { ok: dbOk && queueOk && wsOk, dbOk, queueOk, wsOk };
}

/** How many jobs are in flight right now; `0` when the database is unreachable. */
export async function countActiveJobs(): Promise<number> {
  try {
    const [row] = await db
      .select({ n: count() })
      .from(jobs)
      .where(inArray(jobs.status, [...ACTIVE_JOB_STATUSES]));
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}
