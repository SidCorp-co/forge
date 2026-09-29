/**
 * A6 — releases waiting for a master to take them (ISS-1281).
 *
 * A release is owned by the run session its project's master opens over the roster, so a release
 * nobody has taken is the master-side twin of A3's job queued with no usable runner: work handed
 * to a session that has not moved. It is counted on the same grace, per project.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { AdminAlert } from './types.js';

const CRIT_WAITING_PROJECTS = 3;
const ENTITIES_SHOWN = 20;

interface WaitingRow extends Record<string, unknown> {
  project_id: string;
  slug: string;
  waiting: number;
  oldest: string | Date | null;
}

const iso = (v: string | Date | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

export async function alertReleaseUnowned(graceSeconds: number): Promise<AdminAlert> {
  const rows = (await db.execute<WaitingRow>(sql`
    SELECT r.project_id, p.slug, count(*)::int AS waiting,
           min((r.metadata -> 'owner' ->> 'since')::timestamptz) AS oldest
      FROM pipeline_runs r
      JOIN projects p ON p.id = r.project_id
     WHERE r.kind = 'system'
       AND r.status IN ('running', 'paused')
       AND r.metadata ->> 'source' = 'release-batch'
       AND r.metadata -> 'owner' ->> 'state' = 'awaiting'
       AND (r.metadata -> 'owner' ->> 'since')::timestamptz
             < now() - (${graceSeconds}::int * interval '1 second')
     GROUP BY r.project_id, p.slug
     ORDER BY oldest ASC
  `)) as unknown as WaitingRow[];

  const count = rows.length;
  return {
    id: 'A6',
    key: 'release_unowned',
    status: count >= CRIT_WAITING_PROJECTS ? 'crit' : count >= 1 ? 'warn' : 'ok',
    count,
    detail:
      count > 0
        ? `${count} project${count === 1 ? '' : 's'} with a release no master has taken`
        : 'No release waiting for a master',
    since: rows[0] ? iso(rows[0].oldest) : null,
    entities: rows.slice(0, ENTITIES_SHOWN).map((r) => ({
      ref: r.project_id,
      kind: 'project',
      label: `${r.slug} · ${r.waiting} waiting`,
    })),
  };
}
