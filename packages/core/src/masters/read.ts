import { MASTER_SESSION_KIND, RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import type {
  MasterClosedPass,
  MasterOpenPass,
  MasterOutdated,
  MasterPaneDialog,
  MasterPassCloseReason,
  MasterPassList,
  MasterPassRecovery,
  MasterPassRefusal,
  MasterPassSkip,
  MasterPassTrigger,
  MasterPassView,
  MasterStanding,
  MasterVerb,
  MasterWaitingOn,
} from '@forge/contracts/master-standing';
import { say, sayEn } from '@forge/contracts/said';
import { LIVE_SESSION_STATUSES } from '@forge/contracts/session-machine';
import { type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import {
  masterLastBeatSql,
  masterSilentSql,
  OCCUPYING,
  readDialogsAnswered,
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
  trigger: MasterPassTrigger;
  started_at: string | Date;
  ended_at: string | Date | null;
  dispatched: string[];
  skipped: MasterPassSkip[];
  parked: string[];
  refusal: MasterPassRefusal | null;
  close_reason: MasterPassCloseReason | null;
  /** Read only through {@link RECOVERY_JOIN}; absent on a row an UPDATE returned. */
  recovers_since?: string | Date | null;
  recovers_passes?: number | null;
  recovers_reason?: MasterPassRecovery['reason'] | null;
}

export const PASS_COLUMNS = sql`id, master_session_id, verb, issue_key, trigger, started_at, ended_at, dispatched, skipped, parked, refusal, close_reason`;

// ISS-276 / FB-87: the account printed 19:30Z and answered at 16:42Z. The first pass that ran after
// refused passes on the same box is the recovery: the refused passes of this project on that box
// started before it with no pass that ran between. Read from the stored passes, never stored twice.
// Takes the pass as `p`.
const RECOVERY_JOIN = sql`LEFT JOIN LATERAL (
  SELECT min(q.started_at) AS since, count(*)::int AS passes,
         (array_agg(q.refusal ->> 'reason' ORDER BY q.started_at DESC))[1] AS reason
    FROM agent_sessions ps
    JOIN master_passes q
      ON q.project_id = p.project_id AND q.refusal IS NOT NULL AND q.started_at < p.started_at
    JOIN agent_sessions qs ON qs.id = q.master_session_id AND qs.device_id = ps.device_id
   WHERE ps.id = p.master_session_id
     AND p.ended_at IS NOT NULL AND p.refusal IS NULL AND p.close_reason = 'turn_ended'
     AND NOT EXISTS (
       SELECT 1 FROM master_passes o
         JOIN agent_sessions os ON os.id = o.master_session_id AND os.device_id = ps.device_id
        WHERE o.project_id = p.project_id AND o.refusal IS NULL AND o.close_reason = 'turn_ended'
          AND o.started_at > q.started_at AND o.started_at < p.started_at)
  HAVING count(*) > 0
) rec ON true`;
const RECOVERY_COLUMNS = sql`rec.since AS recovers_since, rec.passes AS recovers_passes, rec.reason AS recovers_reason`;

function recoveryOf(row: PassRow): MasterPassRecovery | null {
  if (!row.recovers_since || !row.recovers_passes || !row.recovers_reason) return null;
  return {
    refusedSince: iso(row.recovers_since),
    refusedPasses: row.recovers_passes,
    reason: row.recovers_reason,
  };
}

export function openPassOf(row: PassRow): MasterOpenPass {
  return {
    id: row.id,
    sessionId: row.master_session_id,
    verb: row.verb,
    startedAt: iso(row.started_at),
    issueKey: row.issue_key,
    trigger: row.trigger,
  };
}

function closedPassOf(row: PassRow & { ended_at: string | Date }): MasterClosedPass {
  return {
    ...openPassOf(row),
    endedAt: iso(row.ended_at),
    dispatched: row.dispatched,
    skipped: row.skipped,
    parked: row.parked,
    refused: row.refusal,
    recovers: recoveryOf(row),
    closeReason: row.close_reason,
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
      SELECT ${PASS_COLUMNS}, ${RECOVERY_COLUMNS} FROM master_passes p ${RECOVERY_JOIN}
       WHERE ${where} AND ended_at IS NOT NULL
       ORDER BY ended_at DESC, started_at DESC
       LIMIT 1`),
  );
  return row ? closedPassOf(row) : null;
}

function readLastPass(executor: Tx, projectId: string): Promise<MasterClosedPass | null> {
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

async function slotsHeld(deviceId: string): Promise<{ jobPanes: number; runs: number }> {
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
  return { jobPanes: row?.jobs ?? 0, runs: row?.runs ?? 0 };
}

// the runs this project's master declared and still has out: live run sessions of this project on
// its box, the same predicate `slotsHeld` counts box-wide, so a master between passes with its own run
// out never reads idle
async function runsOutOf(projectId: string, deviceId: string): Promise<number> {
  const [row] = rowsOf<{ runs: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS runs FROM agent_sessions s
       WHERE s.device_id = ${deviceId}
         AND s.project_id = ${projectId}
         AND s.kind = ${RUN_SESSION_KIND}
         AND s.status IN (${list(LIVE_SESSION_STATUSES)})
         AND ${NOT_PARKED}`),
  );
  return row?.runs ?? 0;
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
  pane_dialog: MasterPaneDialog | null;
  gate_report: unknown;
  outdated: unknown;
}

async function liveMaster(projectId: string): Promise<MasterRow | null> {
  const [row] = rowsOf<MasterRow>(
    await db.execute(sql`
      SELECT m.*
        FROM (
          SELECT s.id, COALESCE(s.metadata ->> 'terminalName', s.title) AS title, s.device_id, d.name AS device_name, d.max_job_panes,
                 COALESCE(s.started_at, s.created_at) AS started_at,
                 ${masterLastBeatSql('s')} AS last_beat,
                 ${masterSilentSql('s')} AS silent,
                 s.metadata -> 'paneDialog' AS pane_dialog,
                 s.metadata -> 'outdated' AS outdated,
                 d.gate_report
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

// the project master is the live master session whose box spoke last; silent is the reaper's own
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
      runsOut: 0,
      lastBeatAt: null,
      waitingOn: null,
      dialogsAnswered: null,
      outdated: null,
    };
  }
  const device =
    master.device_id && master.device_name !== null
      ? { id: master.device_id, name: master.device_name }
      : null;
  const [pass, held, runsOut] = await Promise.all([
    readOpenPass(db, master.id),
    device ? slotsHeld(device.id) : Promise.resolve({ jobPanes: 0, runs: 0 }),
    master.device_id ? runsOutOf(projectId, master.device_id) : Promise.resolve(0),
  ]);
  const waitingOn = master.silent ? null : waitingOnDialog(master, device?.name ?? null);
  return {
    ...base,
    state: master.silent
      ? 'silent'
      : waitingOn
        ? 'waiting_person'
        : pass
          ? 'in_pass'
          : runsOut > 0
            ? 'runs_out'
            : 'idle',
    runsOut,
    waitingOn,
    dialogsAnswered: readDialogsAnswered(master.gate_report, projectId),
    outdated: storedOutdated(master.outdated),
    sessionId: master.id,
    name: master.title,
    device,
    since: master.started_at ? iso(master.started_at) : null,
    pass,
    slots: device ? slotsOf({ name: device.name, maxJobPanes: master.max_job_panes }, held) : null,
    lastBeatAt: master.last_beat ? iso(master.last_beat) : null,
  };
}

// A pane stopped on a dialog runs no turn and takes no nudge until a person answers it, whatever pass is
// open: the runner reports the dialog it read (agent-run-standing, waiting_person) and clears it once gone.
function waitingOnDialog(master: MasterRow, deviceName: string | null): MasterWaitingOn | null {
  const dialog = master.pane_dialog;
  if (!dialog) return null;
  const says = {
    who: deviceName
      ? say('forecast.who.whoeverReaches', { device: deviceName })
      : say('masters.who.whoeverReachesPane'),
    act: say('masters.act.answerDialog', {
      pane: master.title
        ? say('standing.who.named', { name: master.title })
        : say('masters.act.theMasterPane'),
      text: dialog.text,
    }),
  };
  return {
    kind: 'person',
    who: sayEn(says.who),
    act: sayEn(says.act),
    rule: 'MASTER_PANE_DIALOG',
    since: dialog.seenAt,
    says,
  };
}

// a pass history page reads newest first by start, `before` the last start a page served, so a pass
// opened between two reads never shifts a page the way an offset would
export async function listMasterPasses(
  projectId: string,
  opts: { limit: number; before: string | null; sessionId: string | null },
): Promise<MasterPassList> {
  const rows = rowsOf<PassRow>(
    await db.execute(sql`
      SELECT ${PASS_COLUMNS}, ${RECOVERY_COLUMNS}
        FROM master_passes p ${RECOVERY_JOIN}
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

/**
 * A master's outdated record as judgeMaster (service.ts) wrote it on a keep verdict, or null where
 * none is stored or what is stored is not that shape.
 */
export function storedOutdated(stored: unknown): MasterOutdated | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const o = stored as Record<string, unknown>;
  if (
    typeof o.since !== 'string' ||
    typeof o.why !== 'string' ||
    !Array.isArray(o.heldBy) ||
    !o.heldBy.every((h) => typeof h === 'string') ||
    typeof o.draining !== 'boolean'
  ) {
    return null;
  }
  return { since: o.since, why: o.why, heldBy: o.heldBy as string[], draining: o.draining };
}
