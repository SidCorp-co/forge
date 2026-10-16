/**
 * What a box last reported about a session (ISS-1228): the newest `device_run_ledger` entry whose run
 * names that session. The agent-session reads and the pipeline's sessions-and-holds read both take it
 * from here, so no two screens can tell one session two ways.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';

/** The box's own words about a session, `null` where it reported nothing. */
export interface SessionReport {
  incarnation: string;
  work: string;
  blockerKind: string | null;
  waitingOn: string | null;
  observedAt: string;
  /** When the box first reported this work, blocker and wait: how long the session has waited is
   *  counted from here, never from `observedAt`, which every report restamps. */
  since: string;
}

export const sessionReportSchema = z
  .object({
    incarnation: z.string(),
    work: z.string(),
    blockerKind: z.string().nullable(),
    waitingOn: z.string().nullable(),
    observedAt: z.string(),
    since: z.string(),
  })
  .nullable();

export interface LedgerRow {
  session_id: string;
  incarnation: string;
  work: string;
  blocker_kind: string | null;
  waiting_on: string | null;
  observed_at: Date | string;
  work_since: Date | string;
}

const isoOf = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

/** Pure: each session's newest entry. A session several runs name answers with the one seen last. */
export function newestReports(rows: readonly LedgerRow[]): Map<string, SessionReport> {
  const out = new Map<string, SessionReport>();
  for (const row of rows) {
    const observedAt = isoOf(row.observed_at);
    const seen = out.get(row.session_id);
    if (seen && seen.observedAt >= observedAt) continue;
    out.set(row.session_id, {
      incarnation: row.incarnation,
      work: row.work,
      blockerKind: row.blocker_kind,
      waitingOn: row.waiting_on,
      observedAt,
      since: isoOf(row.work_since),
    });
  }
  return out;
}

/** The ledger rows naming these sessions, in one bounded read. An entry filed under a project other
 *  than its session's is no report on that session. */
export async function loadLedgerRows(sessionIds: readonly string[]): Promise<LedgerRow[]> {
  if (sessionIds.length === 0) return [];
  return (await db.execute(sql`
    SELECT l.session_id, l.incarnation, l.work, l.blocker_kind, l.waiting_on, l.observed_at,
           l.work_since
      FROM device_run_ledger l
      JOIN agent_sessions s ON s.id = l.session_id AND s.project_id = l.project_id
     WHERE l.session_id IN (${sql.join(
       sessionIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
  `)) as unknown as LedgerRow[];
}

export async function loadSessionReports(
  sessionIds: readonly string[],
): Promise<Map<string, SessionReport>> {
  return newestReports(await loadLedgerRows(sessionIds));
}
