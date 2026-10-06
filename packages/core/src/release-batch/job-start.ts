/**
 * Whether a box has started a release batch's job, read off the job row (ISS-1323). A batch whose
 * job is still queued reads `running` with no attempt and no method, exactly like one whose agent
 * is working and has not written yet; this is the reading that tells the two apart.
 *
 * The one classification of a `release_batch` job row lives here, and `unstarted-recovery.ts`
 * takes its predicate and its reason from it, so the recovery and the state never disagree.
 */

import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, type JobStatus, jobs } from '../db/schema.js';
import { releaseIneligibleRunners } from '../runners/ineligible.js';
import { onlineCapableDeviceIds } from '../runners/select.js';
import { runnerHoldClause } from './blocker-sentences.js';
import { projectRunnerDeviceIds } from './channel.js';

export const RELEASE_JOB_TYPE = 'release_batch';

/** What the unstarted recovery writes on a job it fences, and what the state names it by. */
export const UNSTARTED_HANDBACK_REASON =
  'no box took this release batch before its deadline, so it never started';

/**
 * How long a release batch may wait for a box to take its job.
 */
export const RELEASE_UNSTARTED_DEADLINE_MS = (() => {
  const raw = Number(process.env.FORGE_RELEASE_UNSTARTED_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60_000;
})();

/** A job no box and no session has picked up, on the row aliased `alias`. */
export function unpickedJobSql(alias: string): SQL {
  const j = sql.raw(alias);
  return sql`${j}.held_by IS NULL AND ${j}.dispatched_at IS NULL`;
}

export type WaitingReason = 'no-eligible-box' | 'no-box' | 'eligible-not-taken';

export type ReleaseStart =
  | { kind: 'taken'; at: string; device: string | null }
  | {
      kind: 'waiting';
      since: string;
      handedBackAt: string;
      reason: WaitingReason;
      why: string;
    }
  | { kind: 'claimed'; since: string; why: string }
  | { kind: 'handed-back'; at: string; why: string }
  | { kind: 'ended'; status: JobStatus; at: string | null; why: string }
  | { kind: 'none'; why: string };

export interface ReleaseJobRow {
  status: JobStatus;
  queuedAt: Date;
  dispatchedAt: Date | null;
  finishedAt: Date | null;
  heldBy: string | null;
  error: string | null;
  deviceName: string | null;
}

const TAKEN_STATUSES: ReadonlySet<JobStatus> = new Set(['dispatched', 'running', 'done']);

/** Which of the six a row is, before any fleet read: `waiting` is resolved by `readReleaseStart`. */
export function classifyReleaseJob(row: ReleaseJobRow): Exclude<ReleaseStart['kind'], 'none'> {
  if (row.dispatchedAt !== null || TAKEN_STATUSES.has(row.status)) return 'taken';
  if (row.status === 'held' || (row.status === 'queued' && row.heldBy !== null)) return 'claimed';
  if (row.status === 'queued') return 'waiting';
  if (row.status === 'cancelled' && row.error === UNSTARTED_HANDBACK_REASON) return 'handed-back';
  return 'ended';
}

async function deviceNames(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ name: devices.name })
    .from(devices)
    .where(inArray(devices.id, ids))
    .orderBy(devices.name);
  return rows.map((r) => r.name);
}

/** Why no box has taken a queued release job: the same readings the batch door refuses on. */
async function whyWaiting(
  projectId: string,
  handedBackAt: string,
): Promise<{ reason: WaitingReason; why: string }> {
  const back = `If none takes it by ${handedBackAt}, the batch is handed back and its issues return to the release gate.`;
  const eligible = await onlineCapableDeviceIds(projectId, {});
  if (eligible.length > 0) {
    const names = (await deviceNames(eligible)).map((n) => `\`${n}\``).join(', ');
    return {
      reason: 'eligible-not-taken',
      why: `No box has started this release yet. ${names} can take it and none has claimed it: a box takes a pool job when it next asks for work with a slot free. ${back}`,
    };
  }
  if ((await projectRunnerDeviceIds(projectId)).length === 0) {
    return {
      reason: 'no-box',
      why: `No box has started this release, and this project has no runner registered, so none can. Pair a box to this project. ${back}`,
    };
  }
  const holds = await releaseIneligibleRunners(projectId);
  return {
    reason: 'no-eligible-box',
    why: `No box has started this release, and none of this project's boxes can take it now. ${holds.map(runnerHoldClause).join(' ')} ${back}`,
  };
}

/** The newest `release_batch` job under the run, with the name of the device that took it. */
async function readReleaseJob(runId: string): Promise<ReleaseJobRow | null> {
  const [row] = await db
    .select({
      status: jobs.status,
      queuedAt: jobs.queuedAt,
      dispatchedAt: jobs.dispatchedAt,
      finishedAt: jobs.finishedAt,
      heldBy: jobs.heldBy,
      error: jobs.error,
      deviceName: devices.name,
    })
    .from(jobs)
    .leftJoin(devices, eq(devices.id, jobs.deviceId))
    .where(and(eq(jobs.pipelineRunId, runId), eq(jobs.type, RELEASE_JOB_TYPE)))
    .orderBy(desc(jobs.queuedAt))
    .limit(1);
  return row ?? null;
}

export async function readReleaseStart(runId: string, projectId: string): Promise<ReleaseStart> {
  const row = await readReleaseJob(runId);
  if (!row) {
    return {
      kind: 'none',
      why: 'This release run holds no release job, so no box was ever asked to start it.',
    };
  }
  const since = row.queuedAt.toISOString();
  switch (classifyReleaseJob(row)) {
    case 'taken':
      return {
        kind: 'taken',
        at: (row.dispatchedAt ?? row.queuedAt).toISOString(),
        device: row.deviceName,
      };
    case 'claimed':
      return {
        kind: 'claimed',
        since,
        why: 'A session holds this release job and has not started it on a box yet.',
      };
    case 'waiting': {
      const handedBackAt = new Date(
        row.queuedAt.getTime() + RELEASE_UNSTARTED_DEADLINE_MS,
      ).toISOString();
      return {
        kind: 'waiting',
        since,
        handedBackAt,
        ...(await whyWaiting(projectId, handedBackAt)),
      };
    }
    case 'handed-back':
      return {
        kind: 'handed-back',
        at: (row.finishedAt ?? row.queuedAt).toISOString(),
        why: `This release never started: ${UNSTARTED_HANDBACK_REASON}, and its issues went back to the release gate.`,
      };
    case 'ended':
      return {
        kind: 'ended',
        status: row.status,
        at: row.finishedAt?.toISOString() ?? null,
        why: `This release never started: its job ended \`${row.status}\` before any box took it${row.error ? `, with: ${row.error}` : ''}.`,
      };
  }
}
