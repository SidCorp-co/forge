/**
 * The project's live master session whose box spoke last, read for every project a person's read
 * asks before its quiet point in one statement (`db/read-memo.ts:onePerId`, ISS-1070 r6).
 */

import { MASTER_SESSION_KIND } from '@forge/contracts/agent-sessions';
import type { MasterPaneDialog } from '@forge/contracts/master-standing';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { onePerId } from '../db/read-memo.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { masterLastBeatSql, masterSilentSql } from '../devices/index.js';

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];
const TERMINAL = sql.join(
  terminalAgentSessionStatuses.map((v) => sql`${v}`),
  sql`, `,
);

export interface MasterRow {
  id: string;
  title: string | null;
  device_id: string | null;
  device_name: string | null;
  max_job_panes: number | null;
  started_at: string | Date | null;
  last_beat: string | Date | null;
  silent: boolean;
  pane_dialog: MasterPaneDialog | null;
  pane: unknown;
  gate_report: unknown;
  outdated: unknown;
}

export async function liveMaster(projectId: string): Promise<MasterRow | null> {
  // every project's asks before the quiet point are one read (ISS-1070 r6)
  return (await onePerId('liveMaster', projectId, liveMastersOf)) ?? null;
}

async function liveMastersOf(projectIds: readonly string[]): Promise<Map<string, MasterRow>> {
  const rows = rowsOf<MasterRow & { project_id: string }>(
    await db.execute(sql`
      SELECT DISTINCT ON (m.project_id) m.*
        FROM (
          SELECT s.project_id, s.id, COALESCE(s.metadata ->> 'terminalName', s.title) AS title, s.device_id, d.name AS device_name, d.max_job_panes,
                 COALESCE(s.started_at, s.created_at) AS started_at,
                 ${masterLastBeatSql('s')} AS last_beat,
                 ${masterSilentSql('s')} AS silent,
                 s.metadata -> 'paneDialog' AS pane_dialog,
                 s.metadata -> 'pane' AS pane,
                 s.metadata -> 'outdated' AS outdated,
                 d.gate_report
            FROM agent_sessions s
            LEFT JOIN devices d ON d.id = s.device_id
           WHERE s.project_id IN (${sql.join(
             projectIds.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
             AND s.kind = ${MASTER_SESSION_KIND}
             AND s.status NOT IN (${TERMINAL})
        ) m
       ORDER BY m.project_id, m.last_beat DESC NULLS LAST`),
  );
  return new Map(rows.map(({ project_id, ...m }) => [project_id, m]));
}
