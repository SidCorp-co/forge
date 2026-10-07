/**
 * One simulation over a project's open work: the queue off the issue standing read model (who each
 * issue waits on, its live `blocks` edges) in the admissible list's own order
 * (`devices/admissible.ts`: priority first, then oldest), through `model.ts`. Computed on each read, so a
 * transition moves the next answer with no projection to keep.
 */

import {
  FORECAST_LABEL,
  type Forecast,
  type ForecastPaused,
  type ProjectForecast,
} from '@forge/contracts/forecast';
import { activeIssuePrefix, compareDispatchOrder, listIssueStanding } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { AUTONOMOUS_ENTRY_STATUS, isEntryGateClosed } from '../pipeline/index.js';
import { readEffectivePolicy } from '../project-config/index.js';
import {
  INTAKE_WAIT,
  type IssueRow,
  issueRowsBySeq,
  LANDED_STATUSES,
  projectWaitOf,
  readHistory,
  readWork,
  settledForecast,
  waitOf,
} from './facts.js';
import { type ForecastRun, runForecast, seedOf, type Wait, type WorkItem } from './model.js';

export interface Facts {
  now: Date;
  run: ForecastRun;
  keyOf: Map<string, string>;
  projectWait: Wait | null;
  prefix: string | null;
}

/** One simulation over the project's open work, every issue's forecast read from it. */
export async function simulate(projectId: string, now: Date): Promise<Facts> {
  const [standing, history, projectWait, prefix, policy] = await Promise.all([
    listIssueStanding(projectId, 'open', null, now),
    readHistory(projectId, now),
    projectWaitOf(projectId),
    activeIssuePrefix(projectId),
    readEffectivePolicy(projectId),
  ]);
  const manualIntake = policy
    ? isEntryGateClosed(policy.document as Parameters<typeof isEntryGateClosed>[0])
    : false;
  const rows = await readWork(
    projectId,
    standing.issues.map((r) => r.id),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  // the admissible list's own order, from the one comparator both read (issues/dispatch-order.ts)
  const queue = [...standing.issues].sort(compareDispatchOrder);
  const rankOf = new Map(queue.map((r, at) => [r.id, at]));
  const items: WorkItem[] = [];
  for (const s of standing.issues) {
    const row = byId.get(s.id);
    if (!row) continue;
    const landed = row.merged_at !== null || LANDED_STATUSES.includes(row.status);
    const inFlight = row.status === 'in_progress' || s.standing.inFlight;
    const intakeHeld =
      manualIntake && row.status === AUTONOMOUS_ENTRY_STATUS && !row.released && !inFlight;
    items.push({
      id: s.id,
      key: s.key,
      complexity: row.complexity,
      landed,
      landedAt: row.merged_at ? new Date(row.merged_at) : null,
      ended: row.status === 'dropped' ? row.status : null,
      startedAt: inFlight ? new Date(row.started_at ?? now) : null,
      rank: rankOf.get(s.id) ?? queue.length,
      // a blocker that landed frees its dependent's run, and a dropped one no longer holds it
      blockedBy: s.standing.blockedBy
        .filter((b) => !b.landed && !LANDED_STATUSES.includes(b.status) && b.status !== 'dropped')
        .map((b) => b.key),
      wait: waitOf(s) ?? (intakeHeld ? INTAKE_WAIT : null),
    });
  }
  const run = runForecast({ now, items, history, projectWait, seed: seedOf(projectId) });
  return {
    now,
    run,
    keyOf: new Map(items.map((i) => [i.id, i.key])),
    projectWait,
    prefix,
  };
}

export const stamp = (asOf: string) => ({ label: FORECAST_LABEL, asOf });

export const pausedOf = (asOf: string, wait: Wait): ForecastPaused => ({
  ...stamp(asOf),
  kind: 'paused',
  ...wait,
});

export async function readProjectForecast(
  projectId: string,
  now: Date = new Date(),
): Promise<ProjectForecast> {
  const f = await simulate(projectId, now);
  return {
    ...stamp(f.run.asOf),
    projectId,
    pause: f.projectWait ? pausedOf(f.run.asOf, f.projectWait) : null,
    issues: [...f.keyOf].flatMap(([issueId, key]) => {
      const forecast = f.run.forecasts.get(key);
      return forecast ? [{ issueId, key, forecast }] : [];
    }),
  };
}

export function forecastOf(f: Facts, row: IssueRow): Forecast {
  const key = f.keyOf.get(row.id);
  const held = key ? f.run.forecasts.get(key) : undefined;
  return held ?? settledForecast(f.run.asOf, row);
}

export async function readIssueForecast(
  projectId: string,
  issSeq: number,
  now: Date = new Date(),
): Promise<{ issueId: string; key: string; forecast: Forecast } | null> {
  const [row] = await issueRowsBySeq(projectId, issSeq);
  if (!row) return null;
  const f = await simulate(projectId, now);
  return {
    issueId: row.id,
    key: f.keyOf.get(row.id) ?? formatIssueRef(f.prefix, row.iss_seq),
    forecast: forecastOf(f, row),
  };
}
