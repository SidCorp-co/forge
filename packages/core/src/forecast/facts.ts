/**
 * The rows a forecast reads, each where it already lives: the landed history off `issues.merged_at`
 * on issues a landed status holds and the first `in_progress` move in `activity_log`, the most runs
 * live at once off the run sessions boxes declared, and whether anything can take the project's
 * work off the runners' dispatch liveness and its master's standing.
 */

import { RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import {
  FORECAST_LABEL,
  FORECAST_PEAK_DAYS,
  FORECAST_WINDOW_DAYS,
  type Forecast,
} from '@forge/contracts/forecast';
import { ISSUE_RESOLVED_STATUSES, type IssueStatus } from '@forge/contracts/issue-machine';
import type { IssueStandingRow } from '@forge/contracts/issue-standing';
import { type Said, say } from '@forge/contracts/said';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
import { idOfParts, memoizedRead, onePerProject, partsOf, rowsPerId } from '../db/read-memo.js';
import { activeIssuePrefix, designOnlyMarkSql } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { readMasterStanding } from '../masters/index.js';
import { holderNames } from '../permissions/index.js';
import { onlineCapableDeviceIds, releaseIneligibleRunners } from '../runners/index.js';
import { type CycleSample, type History, holdersWait, peakOf, type Wait, waitOn } from './model.js';

const DAY_MS = 86_400_000;
export const LANDED_STATUSES: readonly IssueStatus[] = ISSUE_RESOLVED_STATUSES;

interface SampleRow {
  complexity: string | null;
  landed_at: string;
  minutes: number;
}

export async function readHistory(
  projectId: string,
  now: Date,
  width: number | null = null,
): Promise<History> {
  const [rows, peak] = await Promise.all([
    landedRows(projectId, now),
    readPeakLiveRuns(projectId, now),
  ]);
  const samples: CycleSample[] = rows.map((r) => ({
    minutes: Number(r.minutes),
    complexity: r.complexity,
  }));
  const first = rows.reduce(
    (t, r) => Math.min(t, new Date(r.landed_at).getTime()),
    Number.POSITIVE_INFINITY,
  );
  const spanDays = Number.isFinite(first)
    ? Math.min(FORECAST_WINDOW_DAYS, Math.max(1, (now.getTime() - first) / DAY_MS))
    : 0;
  return { samples, spanDays, peak, width };
}

interface EventRow {
  kind: 'transition' | 'filed' | 'blocker_added' | 'blocker_ended' | 'run_started' | 'run_ended';
  at: string;
  seq: number | null;
  other: number | null;
  status: string | null;
}

/** The event a forecast is anchored on: its moment, and what happened, said by key. */
export interface Anchor {
  at: Date;
  event: Said;
}

/**
 * The last moment the facts a forecast reads moved, at or before `now`: an issue's status change, a
 * new issue, a `blocks` edge added or ended, a declared run started or a run finished. Every
 * time-varying input the simulation reads — the landing window, the run peak, an in-flight item's age
 * — is read as of this moment, so a read with no event since gives the same dates, and a date that
 * moves names the event that moved it (Jira Plans' "current vs new value" before a schedule is
 * accepted; Linear's prediction recomputed from velocity, not from the clock).
 */
export function readAnchor(projectId: string, now: Date): Promise<Anchor> {
  return memoizedRead(`forecast-anchor:${projectId}:${now.toISOString()}`, () =>
    readAnchorOnce(projectId, now),
  );
}

async function readAnchorOnce(projectId: string, now: Date): Promise<Anchor> {
  const at = now.toISOString();
  // every project's asks before the quiet point are one read (ISS-1070 r6)
  const row = await onePerProject(`forecastAnchor:${at}`, projectId, async (ids) => {
    const inIds = idList(ids);
    const rows = rowsOf<EventRow & { project_id: string }>(
      await db.execute(sql`
      SELECT DISTINCT ON (e.project_id) * FROM (
        SELECT i.project_id, 'transition' AS kind, al.created_at AS at, i.iss_seq AS seq,
               NULL::int AS other, al.payload ->> 'to' AS status
          FROM activity_log al JOIN issues i ON i.id = al.issue_id
         WHERE i.project_id IN (${inIds}) AND al.action = 'issue.statusChanged'
           AND al.created_at <= ${at}::timestamptz
        UNION ALL
        SELECT i.project_id, 'filed', i.created_at, i.iss_seq, NULL, NULL
          FROM issues i WHERE i.project_id IN (${inIds}) AND i.created_at <= ${at}::timestamptz
        UNION ALL
        SELECT d.project_id, 'blocker_added', d.created_at, t.iss_seq, f.iss_seq, NULL
          FROM issue_dependencies d
          JOIN issues f ON f.id = d.from_issue_id JOIN issues t ON t.id = d.to_issue_id
         WHERE d.project_id IN (${inIds}) AND d.kind = 'blocks' AND d.created_at <= ${at}::timestamptz
        UNION ALL
        SELECT d.project_id, 'blocker_ended', d.valid_until, t.iss_seq, f.iss_seq, NULL
          FROM issue_dependencies d
          JOIN issues f ON f.id = d.from_issue_id JOIN issues t ON t.id = d.to_issue_id
         WHERE d.project_id IN (${inIds}) AND d.kind = 'blocks' AND d.valid_until <= ${at}::timestamptz
        UNION ALL
        SELECT s.project_id, 'run_started', s.started_at, i.iss_seq, NULL, NULL
          FROM agent_sessions s JOIN pipeline_runs r ON r.id = s.pipeline_run_id
          LEFT JOIN issues i ON i.id = r.issue_id
         WHERE s.project_id IN (${inIds}) AND s.kind = ${RUN_SESSION_KIND}
           AND s.started_at <= ${at}::timestamptz
        UNION ALL
        SELECT r.project_id, 'run_ended', r.finished_at, i.iss_seq, NULL, NULL
          FROM pipeline_runs r JOIN agent_sessions s ON s.pipeline_run_id = r.id AND s.kind = ${RUN_SESSION_KIND}
          LEFT JOIN issues i ON i.id = r.issue_id
         WHERE r.project_id IN (${inIds}) AND r.finished_at <= ${at}::timestamptz
      ) e
      ORDER BY e.project_id, e.at DESC, e.kind`),
    );
    return new Map(rows.map((r) => [r.project_id, r]));
  });
  if (!row) return { at: now, event: say('forecast.event.none') };
  return { at: new Date(row.at), event: eventSaid(row, await activeIssuePrefix(projectId)) };
}

function eventSaid(e: EventRow, prefix: string | null): Said {
  const key = e.seq !== null ? formatIssueRef(prefix, e.seq) : null;
  const other = e.other !== null ? formatIssueRef(prefix, e.other) : null;
  switch (e.kind) {
    case 'transition':
      return key && e.status
        ? say('forecast.event.transition', { key, status: e.status })
        : say('forecast.event.none');
    case 'filed':
      return key ? say('forecast.event.filed', { key }) : say('forecast.event.none');
    case 'blocker_added':
      return say('forecast.event.blockerAdded', { key: key ?? '?', blocker: other ?? '?' });
    case 'blocker_ended':
      return say('forecast.event.blockerEnded', { key: key ?? '?', blocker: other ?? '?' });
    case 'run_started':
      return key ? say('forecast.event.runStarted', { key }) : say('forecast.event.runStartedAny');
    case 'run_ended':
      return key ? say('forecast.event.runEnded', { key }) : say('forecast.event.runEndedAny');
  }
}

/**
 * Each project and moment of `keys` (`idOfParts(project, at)`) as rows a statement joins: a read
 * of several projects, each as of its own anchor, sends one statement (ISS-1070 r6).
 */
const asOf = (keys: readonly string[]) =>
  sql`(VALUES ${sql.join(
    keys.map((k) => {
      const [project, at = ''] = partsOf(k);
      // the run peak's window opens FORECAST_PEAK_DAYS before, counted in days of the clock
      const peakFrom = new Date(new Date(at).getTime() - FORECAST_PEAK_DAYS * DAY_MS).toISOString();
      return sql`(${k}, ${project}::uuid, ${at}::timestamptz, ${peakFrom}::timestamptz)`;
    }),
    sql`, `,
  )}) AS w(key, project_id, at, peak_from)`;

function landedRows(projectId: string, now: Date): Promise<SampleRow[]> {
  // every project's asks before the quiet point are one read, each as of its own `now`
  return rowsPerId(
    'landedRows',
    [idOfParts(projectId, now.toISOString())],
    async (keys) =>
      rowsOf<SampleRow & { key: string }>(
        await db.execute(sql`
      SELECT w.key, i.complexity, i.merged_at AS landed_at,
             EXTRACT(EPOCH FROM (i.merged_at - s.started_at)) / 60 AS minutes
        FROM ${asOf(keys)}
        JOIN issues i ON i.project_id = w.project_id
        JOIN LATERAL (
          SELECT min(al.created_at) AS started_at
            FROM activity_log al
           WHERE al.issue_id = i.id
             AND al.action = 'issue.statusChanged'
             AND al.payload ->> 'to' = 'in_progress'
        ) s ON s.started_at IS NOT NULL AND s.started_at < i.merged_at
       WHERE i.status IN (${sql.join(
         LANDED_STATUSES.map((st) => sql`${st}`),
         sql`, `,
       )})
         AND i.merged_at IS NOT NULL
         AND i.merged_at >= w.at - (${FORECAST_WINDOW_DAYS}::int * interval '1 day')
         AND i.merged_at <= w.at`),
      ),
    (r) => r.key,
  );
}

interface SpellRow {
  started_at: string;
  ended_at: string;
}

/**
 * The most of the project's declared runs that were live at once over the last FORECAST_PEAK_DAYS
 * days: each runs from its run session's start to its run's finish, or to now where it is still
 * open. A run session is what a box declares when its master hands a subagent work, so this is the
 * work actually done at once, never issues parked at `in_progress` while nothing works them (HOP:
 * seven issues in progress at once, never more than four runs). A declaration core refused never
 * started and is not counted. Null where no run was live in the window.
 */
async function readPeakLiveRuns(projectId: string, now: Date): Promise<number | null> {
  // every project's asks before the quiet point are one read, each as of its own `now`
  const spells = await rowsPerId(
    'liveSpells',
    [idOfParts(projectId, now.toISOString())],
    async (keys) =>
      rowsOf<SpellRow & { key: string }>(
        await db.execute(sql`
      SELECT w.key,
             greatest(s.started_at, w.peak_from) AS started_at,
             least(coalesce(r.finished_at, w.at), w.at) AS ended_at
        FROM ${asOf(keys)}
        JOIN agent_sessions s ON s.project_id = w.project_id
        JOIN pipeline_runs r ON r.id = s.pipeline_run_id
       WHERE s.kind = ${RUN_SESSION_KIND}
         AND s.started_at IS NOT NULL
         AND s.started_at <= w.at
         AND coalesce(r.finished_at, w.at) > w.peak_from`),
      ),
    (r) => r.key,
  );
  if (spells.length === 0) return null;
  return peakOf(
    spells.map((s) => [new Date(s.started_at).getTime(), new Date(s.ended_at).getTime()]),
  );
}

interface WorkRow {
  id: string;
  iss_seq: number;
  status: IssueStatus;
  complexity: string | null;
  created_at: string;
  merged_at: string | null;
  started_at: string | null;
  released: boolean;
}

export async function readWork(projectId: string, issueIds: readonly string[]): Promise<WorkRow[]> {
  // an issue's work is its own: every project's asks are one read (ISS-1070 r6)
  const rows = await rowsPerId(
    'forecastWork',
    issueIds,
    async (ids) =>
      rowsOf<WorkRow & { project_id: string }>(
        await db.execute(sql`
      SELECT i.id, i.project_id, i.iss_seq, i.status, i.complexity, i.created_at, i.merged_at,
             (SELECT min(al.created_at) FROM activity_log al
               WHERE al.issue_id = i.id AND al.action = 'issue.statusChanged'
                 AND al.payload ->> 'to' = 'in_progress') AS started_at,
             coalesce(i.session_context ? 'runRelease', false) AS released
        FROM issues i
       WHERE i.id IN (${idList(ids)})`),
      ),
    (r) => r.id,
  );
  return rows.filter((r) => r.project_id === projectId).map(({ project_id: _p, ...r }) => r);
}

const HOLD_ACT: Record<string, Said> = {
  'device-disabled': say('forecast.act.turnBoxOn'),
  retired: say('forecast.act.unretire'),
  'never-connected': say('forecast.act.startRunner'),
  disconnected: say('forecast.act.runnerOnline'),
  stale: say('forecast.act.runnerOnline'),
  auth: say('forecast.act.signIn'),
  'rate-limited': say('forecast.act.waitUsage'),
  quarantined: say('forecast.act.quarantine'),
  provisioning: say('forecast.act.provision'),
  'below-floor': say('forecast.act.updateRunner'),
};

/** A wait that holds every issue: nothing can take work, or the master that takes it cannot. */
export async function projectWaitOf(projectId: string): Promise<Wait | null> {
  const live = await onlineCapableDeviceIds(projectId, {});
  if (live.length === 0) {
    const held = await releaseIneligibleRunners(projectId);
    const [first] = held;
    if (!first) {
      return holdersWait(
        await holderNames('project.admin', projectId),
        'project.admin',
        say('standing.act.pairRunner'),
        say('forecast.reason.noRunner'),
        null,
      );
    }
    const held_ = held.map((h) =>
      say('forecast.reason.heldDevice', {
        device: h.deviceName,
        reason: h.reason,
        detail: h.detail ? say('runs.rule.paren', { text: h.detail }) : null,
      }),
    );
    return waitOn(
      {
        who: say('forecast.who.whoeverReaches', { device: first.deviceName }),
        act: HOLD_ACT[first.reason] ?? say('forecast.act.bringRunnerBack'),
        reason: say('forecast.reason.runnersHeld', { held: held_ }),
      },
      first.deviceName,
    );
  }
  const master = await readMasterStanding(projectId);
  if (master.state === 'silent') {
    const reason = master.lastBeatAt
      ? say('forecast.reason.masterSilent', { at: master.lastBeatAt })
      : say('forecast.reason.masterSilentFromStart');
    const act = say('forecast.act.restartMaster');
    if (!master.device) {
      return holdersWait(
        await holderNames('project.admin', projectId),
        'project.admin',
        act,
        reason,
        null,
      );
    }
    return waitOn(
      { who: say('forecast.who.whoeverReaches', { device: master.device.name }), act, reason },
      master.device.name,
    );
  }
  if (master.state === 'waiting_person' && master.waitingOn) {
    return waitOn(
      {
        ...master.waitingOn.says,
        reason: say('forecast.reason.masterDialog', { rule: master.waitingOn.rule }),
      },
      master.device?.name ?? null,
    );
  }
  const refused = master.state !== 'none' ? master.lastPass?.refused : null;
  if (refused) {
    return waitOn(
      {
        who: say('standing.who.nobody'),
        act: say('forecast.act.waitOut', { reason: refused.reason.replace('_', ' ') }),
        reason: say('forecast.reason.passRefused', {
          reason: refused.reason,
          detail: refused.detail,
        }),
      },
      master.device?.name ?? null,
    );
  }
  return null;
}

/** What a row waits on where it is a person, an answer owed or a pause rather than a run, a master or a blocker. */
export function waitOf(row: IssueStandingRow): Wait | null {
  const { attentionGroup, waitingOn } = row.standing;
  if (attentionGroup === 'paused' || waitingOn.kind === 'person' || waitingOn.kind === 'answer') {
    return waitOn(
      { who: waitingOn.says.who, act: waitingOn.says.act, reason: waitingOn.says.rule },
      waitingOn.ref,
      row.standing.touchedAt,
    );
  }
  return null;
}

/** An open issue a manual intake holds: a writer releases it to the master. */
export function intakeWaitOf(writers: readonly string[]): Wait {
  return holdersWait(
    writers,
    'project.write',
    say('forecast.act.releaseToMaster'),
    say('forecast.reason.manualIntake'),
    null,
  );
}

export interface IssueRow {
  id: string;
  iss_seq: number;
  status: IssueStatus;
  merged_at: string | null;
  requirement_id: string | null;
  /** Its mark is a design approval's alone: no release carries it, so none says it is live. */
  design_only?: boolean;
}

/** An issue outside the open set: landed by its status, or ended without landing whatever mark it carries. */
export function settledForecast(asOf: string, row: IssueRow): Forecast {
  const stamp = { label: FORECAST_LABEL, asOf };
  if (LANDED_STATUSES.includes(row.status)) {
    return { ...stamp, kind: 'landed', landedAt: row.merged_at };
  }
  return { ...stamp, kind: 'ended', status: row.status };
}

async function issueRowsWhere(projectId: string, where: SQL): Promise<IssueRow[]> {
  return rowsOf<IssueRow>(
    await db.execute(sql`
      SELECT i.id, i.iss_seq, i.status, i.merged_at, i.requirement_id,
             ${designOnlyMarkSql(sql`i`)} AS design_only
        FROM issues i
       WHERE i.project_id = ${projectId} AND i.archived_at IS NULL AND ${where}
       ORDER BY i.iss_seq`),
  );
}

export const issueRowsBySeq = (projectId: string, issSeq: number) =>
  issueRowsWhere(projectId, sql`i.iss_seq = ${issSeq}`);

/** Each issue of `ids` in `projectId`, by number; every project's asks are one read (ISS-1070 r6). */
export const issueRowsByIds = async (projectId: string, ids: readonly string[]) =>
  (
    await rowsPerId(
      'forecastIssueRows',
      ids,
      (some) => issueRowsIn(sql`i.id IN (${idList(some)})`),
      (r) => r.id,
    )
  )
    .filter((r) => r.project_id === projectId)
    .sort((a, b) => a.iss_seq - b.iss_seq)
    .map(({ project_id: _p, ...r }) => r);

/** `issueRowsWhere` across projects, each row with its project. */
async function issueRowsIn(where: SQL): Promise<(IssueRow & { project_id: string })[]> {
  return rowsOf<IssueRow & { project_id: string }>(
    await db.execute(sql`
      SELECT i.id, i.project_id, i.iss_seq, i.status, i.merged_at, i.requirement_id,
             ${designOnlyMarkSql(sql`i`)} AS design_only
        FROM issues i
       WHERE i.archived_at IS NULL AND ${where}
       ORDER BY i.iss_seq`),
  );
}

export interface RequirementRow {
  id: string;
  req_seq: number;
  title: string;
}

/** A requirement by its REQ number; null where the project holds no such requirement. */
export async function requirementBySeq(
  projectId: string,
  reqSeq: number,
): Promise<RequirementRow | null> {
  const [req] = rowsOf<RequirementRow>(
    await db.execute(sql`
      SELECT id, req_seq, title FROM requirements WHERE project_id = ${projectId} AND req_seq = ${reqSeq}`),
  );
  return req ?? null;
}

/** Every requirement of the project not dropped, by REQ number. */
export async function liveRequirements(projectId: string): Promise<RequirementRow[]> {
  return rowsOf<RequirementRow>(
    await db.execute(sql`
      SELECT id, req_seq, title FROM requirements
       WHERE project_id = ${projectId} AND status <> 'dropped'
       ORDER BY req_seq`),
  );
}

/** The issues of each of `requirementIds`, keyed by requirement id. */
export async function issueRowsOfRequirements(
  projectId: string,
  requirementIds: readonly string[],
): Promise<Map<string, IssueRow[]>> {
  const out = new Map<string, IssueRow[]>(requirementIds.map((id) => [id, []]));
  if (requirementIds.length === 0) return out;
  // a requirement's issues are its own: every project's asks are one read (ISS-1070 r6)
  const rows = await rowsPerId(
    'forecastRequirementIssues',
    requirementIds,
    (some) => issueRowsIn(sql`i.requirement_id IN (${idList(some)})`),
    (r) => r.requirement_id as string,
  );
  for (const { project_id, ...r } of rows.sort((a, b) => a.iss_seq - b.iss_seq))
    if (r.requirement_id && project_id === projectId) out.get(r.requirement_id)?.push(r);
  return out;
}
