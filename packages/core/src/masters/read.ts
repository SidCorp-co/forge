import { MASTER_SESSION_KIND, RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import type {
  MasterClosedPass,
  MasterOpenPass,
  MasterPassList,
  MasterPassSkip,
  MasterPassView,
  MasterStanding,
  MasterVerb,
} from '@forge/contracts/master-standing';
import { LIVE_SESSION_STATUSES } from '@forge/contracts/session-machine';
import { type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import {
  masterLastBeatSql,
  masterSilentSql,
  OCCUPYING,
  SESSION_SILENCE_TIMEOUT_S,
} from '../devices/index.js';
import { NOT_PARKED } from '../jobs/index.js';
import { slotsOf } from './rules.js';

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];
const list = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
const TERMINAL = list(terminalAgentSessionStatuses);
const iso = (t: string | Date) => new Date(t).toISOString();

interface PassRow {
  id: string;
  master_session_id: string;
  verb: MasterVerb;
  issue_key: string | null;
  started_at: string | Date;
  ended_at: string | Date | null;
  dispatched: string[];
  skipped: MasterPassSkip[];
  parked: string[];
}

const PASS_COLUMNS = sql`id, master_session_id, verb, issue_key, started_at, ended_at, dispatched, skipped, parked`;

export function openPassOf(row: PassRow): MasterOpenPass {
  return {
    id: row.id,
    sessionId: row.master_session_id,
    verb: row.verb,
    startedAt: iso(row.started_at),
    issueKey: row.issue_key,
  };
}

export function closedPassOf(row: PassRow & { ended_at: string | Date }): MasterClosedPass {
  return {
    ...openPassOf(row),
    endedAt: iso(row.ended_at),
    dispatched: row.dispatched,
    skipped: row.skipped,
    parked: row.parked,
  };
}

export async function readOpenPass(
  executor: Tx,
  sessionId: string,
): Promise<MasterOpenPass | null> {
  const [row] = rowsOf<PassRow>(
    await executor.execute(sql`
      SELECT ${PASS_COLUMNS} FROM master_passes
       WHERE master_session_id = ${sessionId} AND ended_at IS NULL`),
  );
  return row ? openPassOf(row) : null;
}

async function closedPassWhere(executor: Tx, where: SQL): Promise<MasterClosedPass | null> {
  const [row] = rowsOf<PassRow & { ended_at: string | Date }>(
    await executor.execute(sql`
      SELECT ${PASS_COLUMNS} FROM master_passes
       WHERE ${where} AND ended_at IS NOT NULL
       ORDER BY ended_at DESC, started_at DESC
       LIMIT 1`),
  );
  return row ? closedPassOf(row) : null;
}

export function readLastPass(executor: Tx, projectId: string): Promise<MasterClosedPass | null> {
  return closedPassWhere(executor, sql`project_id = ${projectId}`);
}

export function readClosedPass(
  executor: Tx,
  args: { sessionId: string; passId: string },
): Promise<MasterClosedPass | null> {
  return closedPassWhere(
    executor,
    sql`id = ${args.passId} AND master_session_id = ${args.sessionId}`,
  );
}

export async function slotsInUse(deviceId: string): Promise<number> {
  const [row] = rowsOf<{ jobs: number; runs: number }>(
    await db.execute(sql`
      SELECT
        (SELECT count(*) FROM jobs j
           LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
          WHERE j.device_id = ${deviceId} AND ${OCCUPYING})::int AS jobs,
        (SELECT count(*) FROM agent_sessions s
          WHERE s.device_id = ${deviceId}
            AND s.kind = ${RUN_SESSION_KIND}
            AND s.status IN (${list(LIVE_SESSION_STATUSES)})
            AND ${NOT_PARKED})::int AS runs`),
  );
  return (row?.jobs ?? 0) + (row?.runs ?? 0);
}

interface MasterRow {
  id: string;
  title: string | null;
  device_id: string | null;
  device_name: string | null;
  max_job_panes: number | null;
  started_at: string | Date | null;
  last_beat: string | Date | null;
  silent: boolean;
}

async function liveMaster(projectId: string): Promise<MasterRow | null> {
  const [row] = rowsOf<MasterRow>(
    await db.execute(sql`
      SELECT m.*
        FROM (
          SELECT s.id, COALESCE(s.metadata ->> 'terminalName', s.title) AS title, s.device_id, d.name AS device_name, d.max_job_panes,
                 COALESCE(s.started_at, s.created_at) AS started_at,
                 ${masterLastBeatSql('s')} AS last_beat,
                 ${masterSilentSql('s')} AS silent
            FROM agent_sessions s
            LEFT JOIN devices d ON d.id = s.device_id
           WHERE s.project_id = ${projectId}
             AND s.kind = ${MASTER_SESSION_KIND}
             AND s.status NOT IN (${TERMINAL})
        ) m
       ORDER BY m.last_beat DESC NULLS LAST
       LIMIT 1`),
  );
  return row ?? null;
}

// cm:why the project master is the live master session whose box spoke last; silent is the reaper's own
// predicate (devices/master-silence.ts), so the board says silent exactly when the reaper will fail it
export async function readMasterStanding(projectId: string): Promise<MasterStanding> {
  const [master, lastPass] = await Promise.all([
    liveMaster(projectId),
    readLastPass(db, projectId),
  ]);
  const base = {
    generatedAt: new Date().toISOString(),
    projectId,
    lastPass,
    silentAfterSeconds: SESSION_SILENCE_TIMEOUT_S,
  };
  if (!master) {
    return {
      ...base,
      state: 'none',
      sessionId: null,
      name: null,
      device: null,
      since: null,
      pass: null,
      slots: null,
      lastBeatAt: null,
    };
  }
  const device =
    master.device_id && master.device_name !== null
      ? { id: master.device_id, name: master.device_name }
      : null;
  const [pass, inUse] = await Promise.all([
    readOpenPass(db, master.id),
    device ? slotsInUse(device.id) : Promise.resolve(0),
  ]);
  return {
    ...base,
    state: master.silent ? 'silent' : pass ? 'in_pass' : 'idle',
    sessionId: master.id,
    name: master.title,
    device,
    since: master.started_at ? iso(master.started_at) : null,
    pass,
    slots: device ? slotsOf({ name: device.name, maxJobPanes: master.max_job_panes }, inUse) : null,
    lastBeatAt: master.last_beat ? iso(master.last_beat) : null,
  };
}

// cm:why a pass history page reads newest first by start, `before` the last start a page served, so a pass
// opened between two reads never shifts a page the way an offset would
export async function listMasterPasses(
  projectId: string,
  opts: { limit: number; before: string | null; sessionId: string | null },
): Promise<MasterPassList> {
  const rows = rowsOf<PassRow>(
    await db.execute(sql`
      SELECT ${PASS_COLUMNS}
        FROM master_passes
       WHERE project_id = ${projectId}
         ${opts.before ? sql`AND started_at < ${opts.before}::timestamptz` : sql``}
         ${opts.sessionId ? sql`AND master_session_id = ${opts.sessionId}::uuid` : sql``}
       ORDER BY started_at DESC, id
       LIMIT ${opts.limit + 1}`),
  );
  const page = rows.slice(0, opts.limit);
  const items: MasterPassView[] = page.map((r) =>
    r.ended_at === null ? openPassOf(r) : closedPassOf({ ...r, ended_at: r.ended_at }),
  );
  const last = items[items.length - 1];
  return {
    generatedAt: new Date().toISOString(),
    projectId,
    items,
    limit: opts.limit,
    hasMore: rows.length > opts.limit,
    next: rows.length > opts.limit && last ? last.startedAt : null,
  };
}
