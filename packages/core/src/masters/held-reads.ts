// The few facts a project's master standing reads by its box, its project and its pass
// (`read.ts:readMasterStanding`), each read for every project a person's read asks before its quiet
// point in one statement (`db/read-memo.ts:onePerId`, ISS-1070 r12). Each was one statement a project
// with a live master, and the forecast and the runs ask the standing again: home sent each 18 times.

import { RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { LIVE_SESSION_STATUSES } from '@forge/contracts/session-machine';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf, uuidArray } from '../db/raw-sql.js';
import { idOfParts, onePerId, partsOf } from '../db/read-memo.js';
import { OCCUPYING } from '../devices/index.js';
import { NOT_PARKED } from '../jobs/index.js';

const list = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/** The job panes and run sessions each box holds now, every box a read asks in one statement (ISS-1070 r12). */
export async function slotsHeld(deviceId: string): Promise<{ jobPanes: number; runs: number }> {
  const held = await onePerId('masterSlotsHeld', deviceId, async (ids) => {
    const rows = rowsOf<{ device_id: string; jobs: number; runs: number }>(
      await db.execute(sql`
        SELECT d.id::text AS device_id,
          (SELECT count(*) FROM jobs j
             LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
            WHERE j.device_id = d.id AND ${OCCUPYING})::int AS jobs,
          (SELECT count(*) FROM agent_sessions s
            WHERE s.device_id = d.id
              AND s.kind = ${RUN_SESSION_KIND}
              AND s.status IN (${list(LIVE_SESSION_STATUSES)})
              AND ${NOT_PARKED})::int AS runs
          FROM unnest(${uuidArray(ids)}) AS d(id)`),
    );
    return new Map(rows.map((r) => [r.device_id, { jobPanes: r.jobs, runs: r.runs }]));
  });
  return held ?? { jobPanes: 0, runs: 0 };
}

// the runs this project's master declared and still has out: live run sessions of this project on
// its box, the same predicate `slotsHeld` counts box-wide, so a master between passes with its own run
// out never reads idle
// out never reads idle; every project and box a read asks before its quiet point in one statement (ISS-1070 r12)
export async function runsOutOf(projectId: string, deviceId: string): Promise<number> {
  const runs = await onePerId('masterRunsOut', idOfParts(projectId, deviceId), async (ids) => {
    const pairs = ids.map((id) => partsOf(id) as [string, string]);
    const rows = rowsOf<{ project_id: string; device_id: string; runs: number }>(
      await db.execute(sql`
        SELECT s.project_id::text AS project_id, s.device_id::text AS device_id, count(*)::int AS runs
          FROM agent_sessions s
         WHERE s.project_id = ANY(${uuidArray(pairs.map(([p]) => p))})
           AND s.device_id = ANY(${uuidArray(pairs.map(([, d]) => d))})
           AND s.kind = ${RUN_SESSION_KIND}
           AND s.status IN (${list(LIVE_SESSION_STATUSES)})
           AND ${NOT_PARKED}
         GROUP BY s.project_id, s.device_id`),
    );
    // the statement reads every project beside every box: each pair keeps its own count alone
    const asked = new Set(ids);
    return new Map(
      rows.flatMap((r) => {
        const id = idOfParts(r.project_id, r.device_id);
        return asked.has(id) ? [[id, r.runs] as const] : [];
      }),
    );
  });
  return runs ?? 0;
}

/**
 * The title of the project's issue a pass's key names by its number (`ISS-412`), or null where it
 * names none (ISS-864); every project's ask before the quiet point in one statement (ISS-1070 r12).
 */
export async function issueTitleOf(projectId: string, key: string): Promise<string | null> {
  const seq = /-(\d+)$/.exec(key)?.[1];
  if (!seq) return null;
  const title = await onePerId(
    'masterPassIssueTitle',
    idOfParts(projectId, String(Number(seq))),
    async (ids) => {
      const pairs = ids.map((id) => partsOf(id) as [string, string]);
      const rows = rowsOf<{ project_id: string; iss_seq: number; title: string }>(
        await db.execute(sql`
        SELECT i.project_id::text AS project_id, i.iss_seq, i.title
          FROM issues i
          JOIN unnest(${uuidArray(pairs.map(([p]) => p))}, ${sql.param(pairs.map(([, n]) => Number(n)))}::int[]) AS k(project_id, iss_seq)
            ON i.project_id = k.project_id AND i.iss_seq = k.iss_seq`),
      );
      return new Map(rows.map((r) => [idOfParts(r.project_id, String(r.iss_seq)), r.title]));
    },
  );
  return title ?? null;
}
