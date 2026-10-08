/**
 * One simulation over a project's open work: the queue off the issue standing read model (who each
 * issue waits on, its live `blocks` edges) in the admissible list's own order
 * (`devices/admissible.ts`: priority first, then oldest), through `model.ts`. Computed on each read, so a
 * transition moves the next answer with no projection to keep.
 */

import { FORECAST_LABEL, type Forecast, type ProjectForecast } from '@forge/contracts/forecast';
import { activeIssuePrefix, compareDispatchOrder, listIssueStanding } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { readMasterStanding } from '../masters/index.js';
import { holderNames } from '../permissions/index.js';
import { AUTONOMOUS_ENTRY_STATUS, isEntryGateClosed } from '../pipeline/index.js';
import { readEffectivePolicy } from '../project-config/index.js';
import {
  type Anchor,
  type IssueRow,
  intakeWaitOf,
  issueRowsBySeq,
  LANDED_STATUSES,
  projectWaitOf,
  readAnchor,
  readHistory,
  readWork,
  settledForecast,
  waitOf,
} from './facts.js';
import {
  type ForecastRun,
  pausedOf,
  runForecast,
  seedOf,
  type Wait,
  type WorkItem,
} from './model.js';
import type { ForecastViewer } from './release.js';

export interface Facts {
  /** The simulation's clock: the anchor's moment (`facts.ts:readAnchor`). */
  now: Date;
  /** When it was read. */
  readAt: Date;
  anchor: Anchor;
  run: ForecastRun;
  keyOf: Map<string, string>;
  projectWait: Wait | null;
  prefix: string | null;
}

/** The simulation's clocks: dates run from the anchor's moment, lateness from the read's. */
export const clockOf = (anchor: Pick<Anchor, 'at'>, readAt: Date) => ({
  now: anchor.at,
  readAt,
});

/**
 * One simulation over the project's open work, every issue's forecast read from it, anchored on the
 * last event its facts moved on: the landing window, the run peak and each in-flight item's age are
 * read as of the anchor, so a read with no event since answers the same dates; lateness is measured
 * against `now`, so an item still grows late while nothing happens.
 */
export async function simulate(
  projectId: string,
  now: Date,
  viewer: ForecastViewer | null,
  anchored?: Anchor,
): Promise<Facts> {
  const [anchor, master] = await Promise.all([
    anchored ? Promise.resolve(anchored) : readAnchor(projectId, now),
    readMasterStanding(projectId),
  ]);
  const clock = clockOf(anchor, now);
  const at = clock.now;
  const [standing, history, projectWait, prefix, policy, writers] = await Promise.all([
    listIssueStanding(projectId, 'open', viewer ? { userId: viewer.userId } : null, now),
    readHistory(projectId, at, master.slots?.max ?? null),
    projectWaitOf(projectId),
    activeIssuePrefix(projectId),
    readEffectivePolicy(projectId),
    holderNames('project.write', projectId),
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
    // landed by status alone: a merged mark on an open issue is a claim its run still judges, and a
    // design approval's evidence is no mark at all (docs/modules/issues/merge-mark.md)
    const landed = LANDED_STATUSES.includes(row.status);
    const inFlight = row.status === 'in_progress' || s.standing.inFlight;
    const intakeHeld =
      manualIntake && row.status === AUTONOMOUS_ENTRY_STATUS && !row.released && !inFlight;
    items.push({
      id: s.id,
      key: s.key,
      complexity: row.complexity,
      landed,
      landedAt: landed && row.merged_at ? new Date(row.merged_at) : null,
      ended: row.status === 'dropped' ? row.status : null,
      startedAt: inFlight ? new Date(row.started_at ?? at) : null,
      rank: rankOf.get(s.id) ?? queue.length,
      // a blocker that landed frees its dependent's run, and a dropped one no longer holds it
      blockedBy: s.standing.blockedBy
        .filter((b) => !LANDED_STATUSES.includes(b.status) && b.status !== 'dropped')
        .map((b) => b.key),
      wait: waitOf(s) ?? (intakeHeld ? intakeWaitOf(writers) : null),
    });
  }
  const run = runForecast({
    ...clock,
    items,
    history,
    projectWait,
    writers,
    seed: seedOf(projectId),
  });
  return {
    ...clock,
    anchor,
    run,
    keyOf: new Map(items.map((i) => [i.id, i.key])),
    projectWait,
    prefix,
  };
}

export const stamp = (asOf: string) => ({ label: FORECAST_LABEL, asOf });

export { pausedOf };

export async function readProjectForecast(
  projectId: string,
  viewer: ForecastViewer | null,
  now: Date = new Date(),
): Promise<ProjectForecast> {
  const f = await simulate(projectId, now, viewer);
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
  viewer: ForecastViewer | null,
  now: Date = new Date(),
): Promise<{ issueId: string; key: string; forecast: Forecast } | null> {
  const [row] = await issueRowsBySeq(projectId, issSeq);
  if (!row) return null;
  const f = await simulate(projectId, now, viewer);
  return {
    issueId: row.id,
    key: f.keyOf.get(row.id) ?? formatIssueRef(f.prefix, row.iss_seq),
    forecast: forecastOf(f, row),
  };
}
