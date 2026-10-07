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
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
import { readMasterStanding } from '../masters/index.js';
import { onlineCapableDeviceIds, releaseIneligibleRunners } from '../runners/index.js';
import { type CycleSample, type History, peakOf, type Wait } from './model.js';

const DAY_MS = 86_400_000;
export const LANDED_STATUSES: readonly IssueStatus[] = ISSUE_RESOLVED_STATUSES;

interface SampleRow {
  complexity: string | null;
  landed_at: string;
  minutes: number;
}

export async function readHistory(projectId: string, now: Date): Promise<History> {
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
  return { samples, spanDays, peak };
}

async function landedRows(projectId: string, now: Date): Promise<SampleRow[]> {
  return rowsOf<SampleRow>(
    await db.execute(sql`
      SELECT i.complexity, i.merged_at AS landed_at,
             EXTRACT(EPOCH FROM (i.merged_at - s.started_at)) / 60 AS minutes
        FROM issues i
        JOIN LATERAL (
          SELECT min(al.created_at) AS started_at
            FROM activity_log al
           WHERE al.issue_id = i.id
             AND al.action = 'issue.statusChanged'
             AND al.payload ->> 'to' = 'in_progress'
        ) s ON s.started_at IS NOT NULL AND s.started_at < i.merged_at
       WHERE i.project_id = ${projectId}
         AND i.status IN (${sql.join(
           LANDED_STATUSES.map((st) => sql`${st}`),
           sql`, `,
         )})
         AND i.merged_at IS NOT NULL
         AND i.merged_at >= ${now.toISOString()}::timestamptz - (${FORECAST_WINDOW_DAYS}::int * interval '1 day')
         AND i.merged_at <= ${now.toISOString()}::timestamptz`),
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
  const at = now.toISOString();
  const from = new Date(now.getTime() - FORECAST_PEAK_DAYS * DAY_MS).toISOString();
  const spells = rowsOf<SpellRow>(
    await db.execute(sql`
      SELECT greatest(s.started_at, ${from}::timestamptz) AS started_at,
             least(coalesce(r.finished_at, ${at}::timestamptz), ${at}::timestamptz) AS ended_at
        FROM agent_sessions s
        JOIN pipeline_runs r ON r.id = s.pipeline_run_id
       WHERE s.project_id = ${projectId}
         AND s.kind = ${RUN_SESSION_KIND}
         AND s.started_at IS NOT NULL
         AND s.started_at <= ${at}::timestamptz
         AND coalesce(r.finished_at, ${at}::timestamptz) > ${from}::timestamptz`),
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

export async function readWork(projectId: string, ids: readonly string[]): Promise<WorkRow[]> {
  if (ids.length === 0) return [];
  return rowsOf<WorkRow>(
    await db.execute(sql`
      SELECT i.id, i.iss_seq, i.status, i.complexity, i.created_at, i.merged_at,
             (SELECT min(al.created_at) FROM activity_log al
               WHERE al.issue_id = i.id AND al.action = 'issue.statusChanged'
                 AND al.payload ->> 'to' = 'in_progress') AS started_at,
             coalesce(i.session_context ? 'runRelease', false) AS released
        FROM issues i
       WHERE i.project_id = ${projectId}
         AND i.id IN (${sql.join(
           ids.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})`),
  );
}

const HOLD_ACT: Record<string, string> = {
  'device-disabled': 'turn the box back on',
  retired: 'return the runner to service',
  'never-connected': 'start the runner',
  disconnected: 'bring the runner back online',
  stale: 'bring the runner back online',
  auth: 'sign the box in again',
  'rate-limited': 'wait for the usage limit to reset',
  quarantined: 'wait out the quarantine or clear it',
  provisioning: 'finish provisioning the checkout',
  'below-floor': 'update the runner',
};

/** A wait that holds every issue: nothing can take work, or the master that takes it cannot. */
export async function projectWaitOf(projectId: string): Promise<Wait | null> {
  const live = await onlineCapableDeviceIds(projectId, {});
  if (live.length === 0) {
    const held = await releaseIneligibleRunners(projectId);
    const [first] = held;
    if (!first) {
      return {
        who: 'A project admin',
        act: 'pair a runner',
        reason: 'no runner is registered for this project, so nothing can take its work',
        ref: null,
      };
    }
    const said = held
      .map((h) => `${h.deviceName} is ${h.reason}${h.detail ? ` (${h.detail})` : ''}`)
      .join('; ');
    return {
      who: `Whoever can reach ${first.deviceName}`,
      act: HOLD_ACT[first.reason] ?? 'bring a runner back',
      reason: `no runner can take this project's work: ${said}`,
      ref: first.deviceName,
    };
  }
  const master = await readMasterStanding(projectId);
  if (master.state === 'silent') {
    return {
      who: master.device ? `Whoever can reach ${master.device.name}` : 'A project admin',
      act: 'restart the master',
      reason: `the project's master has been silent since ${master.lastBeatAt ?? 'it started'}, so nothing is dispatched`,
      ref: master.device?.name ?? null,
    };
  }
  if (master.state === 'waiting_person' && master.waitingOn) {
    return {
      who: master.waitingOn.who,
      act: master.waitingOn.act,
      reason: `the project's master is stopped on a dialog (${master.waitingOn.rule})`,
      ref: master.device?.name ?? null,
    };
  }
  const refused = master.state !== 'none' ? master.lastPass?.refused : null;
  if (refused) {
    return {
      who: 'Nobody',
      act: `wait out the ${refused.reason.replace('_', ' ')}`,
      reason: `the master's last pass was refused (${refused.reason}): ${refused.detail}`,
      ref: master.device?.name ?? null,
    };
  }
  return null;
}

/** Whom a row waits on where it is a person or a gate rather than a run, a master or a blocker. */
export function waitOf(row: IssueStandingRow): Wait | null {
  const { attentionGroup, waitingOn } = row.standing;
  const person = waitingOn.kind === 'you' || waitingOn.kind === 'person';
  if (attentionGroup === 'needs_you' || attentionGroup === 'paused' || person) {
    return { who: waitingOn.who, act: waitingOn.act, reason: waitingOn.rule, ref: waitingOn.ref };
  }
  return null;
}

export const INTAKE_WAIT: Wait = {
  who: 'A project writer',
  act: 'release it to the master',
  reason:
    "the project's intake is manual: an open issue reaches a master only once a person releases it",
  ref: null,
};

export interface IssueRow {
  id: string;
  iss_seq: number;
  status: IssueStatus;
  merged_at: string | null;
  requirement_id: string | null;
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
      SELECT i.id, i.iss_seq, i.status, i.merged_at, i.requirement_id
        FROM issues i
       WHERE i.project_id = ${projectId} AND i.archived_at IS NULL AND ${where}
       ORDER BY i.iss_seq`),
  );
}

export const issueRowsBySeq = (projectId: string, issSeq: number) =>
  issueRowsWhere(projectId, sql`i.iss_seq = ${issSeq}`);

export const issueRowsByIds = (projectId: string, ids: readonly string[]) =>
  ids.length === 0 ? Promise.resolve([]) : issueRowsWhere(projectId, sql`i.id IN (${idList(ids)})`);

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
  const rows = await issueRowsWhere(
    projectId,
    sql`i.requirement_id IN (${idList(requirementIds)})`,
  );
  for (const r of rows) if (r.requirement_id) out.get(r.requirement_id)?.push(r);
  return out;
}
