/**
 * Every fold the pulse response is assembled by, and nothing that reaches the
 * database.
 */
// cm:guard every function here stays PURE — no db, no clock of its own, no I/O — because each one is a rule this surface is judged on (which bucket a status lands in, whether a backlog walk reads both directions, which lane a run kind belongs to) and one impure helper takes the whole module out of the reach of a test that needs no Postgres.

import {
  PULSE_AWAITING_RELEASE_STATUSES,
  PULSE_FLOW_WEEKS,
  PULSE_HEARTBEAT_DAYS,
  PULSE_HUMAN_BLOCKED_STATUSES,
  PULSE_IN_PROGRESS_STATUSES,
  PULSE_OPEN_STATUSES,
  type PulseFlowWeek,
  type PulseHeartbeatDay,
  type PulseLane,
  type PulseQuality,
  type PulseWorkBuckets,
} from './pulse-types.js';

/** Whole seconds between `then` and `now`, never negative. */
// cm:guard clamped at zero because a runner's clock can stamp ahead of the tracker's — this issue's own lease carried a renew time the CLI refused to place against the server's. A negative age renders as an outage in the future (ISS-988 criterion 7).
export function ageSeconds(then: Date | string | null | undefined, now: Date): number | null {
  if (then == null) return null;
  const ms = now.getTime() - new Date(then).getTime();
  return Math.max(0, Math.floor(ms / 1000));
}

/** The middle value by nearest rank, or null over an empty series. */
export function medianSeconds(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

const BUCKET_OF = new Map<string, keyof PulseWorkBuckets>();
for (const s of PULSE_OPEN_STATUSES) BUCKET_OF.set(s, 'open');
for (const s of PULSE_IN_PROGRESS_STATUSES) BUCKET_OF.set(s, 'inProgress');
for (const s of PULSE_AWAITING_RELEASE_STATUSES) BUCKET_OF.set(s, 'awaitingRelease');
for (const s of PULSE_HUMAN_BLOCKED_STATUSES) BUCKET_OF.set(s, 'humanBlocked');

/** Which of the four buckets a status belongs to, or null where it is finished. */
export const bucketOfStatus = (status: string): keyof PulseWorkBuckets | null =>
  BUCKET_OF.get(status) ?? null;

export const emptyBuckets = (): PulseWorkBuckets => ({
  open: 0,
  inProgress: 0,
  awaitingRelease: 0,
  humanBlocked: 0,
});

/** Fold `(projectId, status, n)` rows into per-project and workspace buckets. */
export function foldBuckets(rows: Array<{ projectId: string; status: string; n: number }>): {
  total: PulseWorkBuckets;
  byProject: Map<string, PulseWorkBuckets>;
} {
  const total = emptyBuckets();
  const byProject = new Map<string, PulseWorkBuckets>();
  for (const r of rows) {
    const bucket = bucketOfStatus(r.status);
    if (!bucket) continue;
    const per = byProject.get(r.projectId) ?? emptyBuckets();
    per[bucket] += r.n;
    total[bucket] += r.n;
    byProject.set(r.projectId, per);
  }
  return { total, byProject };
}

/** Issue-run starts per UTC day, every day of the window present. */
export function fillHeartbeat(
  counts: Map<string, number>,
  now: Date,
  days = PULSE_HEARTBEAT_DAYS,
): PulseHeartbeatDay[] {
  const out: PulseHeartbeatDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push({
      date: d.toISOString().slice(0, 10),
      issueRuns: counts.get(d.toISOString().slice(0, 10)) ?? 0,
    });
  }
  return out;
}

/** The `n` most recent UTC week starts, oldest first, weeks beginning Monday. */
export function weekStartsEnding(now: Date, weeks = PULSE_FLOW_WEEKS): string[] {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (isoDay - 1));
  const out: string[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const w = new Date(d);
    w.setUTCDate(w.getUTCDate() - i * 7);
    out.push(w.toISOString().slice(0, 10));
  }
  return out;
}

export interface FlowEventCounts {
  created: Map<string, number>;
  closed: Map<string, number>;
  reopened: Map<string, number>;
}

/** Walk the backlog forward from what stood before the window opened. */
// cm:guard the walk reads BOTH directions: an issue that closes in one week and reopens in a later one is subtracted once and added back once, and counting only entries into terminal leaves it out of every later backlog for good (ISS-988 criterion 16).
export function walkFlow(
  weekStarts: readonly string[],
  counts: FlowEventCounts,
  backlogBeforeWindow: number,
): PulseFlowWeek[] {
  let backlog = backlogBeforeWindow;
  return weekStarts.map((weekStart) => {
    const created = counts.created.get(weekStart) ?? 0;
    const closed = counts.closed.get(weekStart) ?? 0;
    const reopened = counts.reopened.get(weekStart) ?? 0;
    backlog += created - closed + reopened;
    return { weekStart, created, closed, reopened, backlog };
  });
}

const LANE_OF: Record<string, keyof PulseQuality['runFailure']> = {
  issue: 'pipeline',
  system: 'scheduler',
};

const emptyLane = (): PulseLane => ({ failed: 0, total: 0 });

/** Failed-against-total per lane, by the run kind that wrote the row. */
// cm:guard `pm` and `interactive` fall to `other` rather than into `scheduler`: `pm` is the coordinator and `interactive` is a person chatting, and folding either into the machinery lane prices someone closing a chat window as a scheduler failure (ISS-988 criterion 18).
export function foldLanes(
  rows: Array<{ kind: string; failed: number; total: number }>,
): PulseQuality['runFailure'] {
  const out = { pipeline: emptyLane(), scheduler: emptyLane(), other: emptyLane() };
  for (const r of rows) {
    const lane = LANE_OF[r.kind] ?? 'other';
    out[lane].failed += r.failed;
    out[lane].total += r.total;
  }
  return out;
}
