// A release batch's finish, accepted at the door and done by a job.
//
// The door checks what the database can answer and writes a finish record onto
// the run (`pipeline_runs.metadata.finish`); the job verifies the probes and
// closes the roster. Nothing the caller does after the door answers — hanging
// up included — changes what happens to the batch, and the verdict is read off
// the record rather than off a response that may never arrive.
//
// The record is the truth and the queue is only the wake-up. A worker owns an
// attempt by a lease it renews while it works; every write is a compare-and-set
// on the record's `version`, so a worker whose lease was taken over writes
// nothing more. A sweep wakes any attempt whose owner stopped renewing.

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { logger } from '../logger.js';
import { closeRunIfOneShot } from '../pipeline/runs.js';
import {
  ReleaseBatchAbortedError,
  ReleaseFinishFenceLostError,
  ReleaseFinishInFlightError,
  ReleaseNotVerifiedError,
} from './errors.js';
import {
  compareAndSet,
  type FinishRefusal,
  IN_FLIGHT,
  isInFlight,
  type ReleaseFinishRecord,
  readFinishRecord,
  stamp,
} from './finish-record.js';
import { finishRefusal } from './refusals.js';
import { assertFinishable, finishReleaseBatch, readReleaseRun } from './service.js';
import { claimedCommit, notAWholeCommit } from './verify.js';

/** How long a worker's claim on an attempt stands without a renewal. */
export const FINISH_LEASE_MS = 120_000;
const HEARTBEAT_MS = 30_000;
/** An accepted attempt no worker took in this long was never woken, so the sweep wakes it. */
export const FINISH_UNTAKEN_MS = 60_000;

export const RELEASE_FINISH_QUEUE = 'release-batch-finish';
const RESUME_QUEUE = 'release-batch-finish-resume';

export {
  type FinishRefusal,
  type FinishState,
  isInFlight,
  type ReleaseFinishRecord,
  readFinishRecord,
} from './finish-record.js';

// ── The door ────────────────────────────────────────────────────────────────

export interface AcceptFinishOptions {
  commit?: string | undefined;
}

export interface AcceptFinishResult {
  runId: string;
  finish: ReleaseFinishRecord;
  /** True when this call started the attempt; false when it answered one already standing. */
  started: boolean;
}

type Enqueue = (runId: string) => Promise<void>;

/**
 * Take a finish: refuse what the database can refuse, write the attempt, wake
 * the job, and answer. Its cost is a handful of reads and one write whatever
 * the roster holds and however long the probes take to agree.
 */
export async function acceptReleaseBatchFinish(
  runId: string,
  actor: TransitionActor,
  options: AcceptFinishOptions = {},
  enqueue: Enqueue = enqueueReleaseBatchFinish,
): Promise<AcceptFinishResult> {
  const commit = options.commit === undefined ? null : claimedCommit(options.commit);
  if (options.commit !== undefined && commit === null) {
    throw new ReleaseNotVerifiedError(notAWholeCommit(options.commit, null), null);
  }

  for (let round = 0; round < 3; round++) {
    const run = await readReleaseRun(runId);
    if (!run) throw new Error(`release batch ${runId} not found`);
    // Before any record is answered: an aborted batch answers as aborted whatever its last
    // attempt wrote, so a record cannot stand in for the abort.
    if (run.status === 'cancelled') throw new ReleaseBatchAbortedError();
    const current = readFinishRecord(run.metadata);

    if (current && isInFlight(current)) {
      if (current.commit !== commit) {
        throw new ReleaseFinishInFlightError(current.requestId, current.commit, commit);
      }
      return { runId, finish: current, started: false };
    }
    if (current?.state === 'finished') {
      if (run.status === 'running' || run.status === 'paused') await enqueue(runId);
      return { runId, finish: current, started: false };
    }

    // A run that went `completed` with nothing left claimed has nothing to verify; every other
    // run is held to what the work itself would refuse, here, before anything is written.
    const [left] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(issues)
      .where(eq(issues.releaseBatchRunId, runId));
    if (!(run.status === 'completed' && (left?.n ?? 0) === 0)) await assertFinishable(runId, run);

    const now = new Date().toISOString();
    const record: ReleaseFinishRecord = {
      requestId: randomUUID(),
      state: 'accepted',
      commit,
      requestedBy: actor,
      acceptedAt: now,
      updatedAt: now,
      version: (current?.version ?? 0) + 1,
      owner: null,
      leaseUntil: null,
      workerStarts: 0,
      // What an earlier attempt already closed stays this batch's outcome: its claims are gone.
      closed: current?.closed ?? null,
      failed: current?.failed ?? null,
      refusal: null,
      finishedAt: null,
    };
    // Conditioned on the run too: an abort landing after the read above refuses on the next round.
    if (await compareAndSet(runId, current?.version ?? null, record, { runOpen: true })) {
      await enqueue(runId);
      return { runId, finish: record, started: true };
    }
  }
  throw new Error(`release batch ${runId}: its finish record kept moving under three reads`);
}

// ── The worker ──────────────────────────────────────────────────────────────

/**
 * One worker's hold on one attempt. Every write goes through `commit`, one at a
 * time, and the first one that finds the record moved ends the hold for good.
 */
function holdAttempt(runId: string, start: ReleaseFinishRecord, hooks: FinishWorkerHooks = {}) {
  let current = start;
  let lost = false;
  let chain: Promise<unknown> = Promise.resolve();

  function commit(patch: (r: ReleaseFinishRecord) => Partial<ReleaseFinishRecord>) {
    const step = chain.then(async () => {
      if (lost) throw new ReleaseFinishFenceLostError();
      const next = stamp(current, patch(current));
      if (!(await compareAndSet(runId, current.version, next))) {
        lost = true;
        throw new ReleaseFinishFenceLostError();
      }
      current = next;
      return next;
    });
    chain = step.catch(() => {});
    return step;
  }

  /**
   * Inside a closing write's own transaction: hold the run row and refuse unless this worker still
   * owns the attempt. A takeover rewrites the owner, and its compare-and-set waits on this lock.
   */
  async function fence(tx: Tx): Promise<void> {
    if (lost) throw new ReleaseFinishFenceLostError();
    const rows = await tx.execute<{ owner: string | null; status: string }>(sql`
      SELECT ${pipelineRuns.metadata} -> 'finish' ->> 'owner' AS owner, ${pipelineRuns.status} AS status
      FROM ${pipelineRuns} WHERE ${pipelineRuns.id} = ${runId}
      FOR UPDATE
    `);
    if (rows[0]?.owner !== current.owner) {
      lost = true;
      throw new ReleaseFinishFenceLostError();
    }
    if (rows[0]?.status === 'cancelled') throw new ReleaseBatchAbortedError();
    await hooks.afterFence?.();
  }

  return {
    commit,
    fence,
    get state() {
      return current.state;
    },
    renew: () =>
      IN_FLIGHT.has(current.state)
        ? commit(() => ({ leaseUntil: new Date(Date.now() + FINISH_LEASE_MS).toISOString() }))
        : Promise.resolve(current),
    get lost() {
      return lost;
    },
  };
}

function leaseStands(record: ReleaseFinishRecord, now: number): boolean {
  return record.owner !== null && record.leaseUntil !== null && Date.parse(record.leaseUntil) > now;
}

function refusalOf(err: unknown): FinishRefusal {
  const http = finishRefusal(err);
  if (http) {
    const cause = (http.cause ?? {}) as { code?: string; details?: { live?: unknown } };
    return {
      code: cause.code ?? 'RELEASE_FINISH_REFUSED',
      reason: http.message,
      live: typeof cause.details?.live === 'string' ? cause.details.live : null,
    };
  }
  return {
    code: 'RELEASE_FINISH_ERRORED',
    reason: `the finish stopped on an error this code did not expect: ${err instanceof Error ? err.message : String(err)}. Nothing about the release is implied by it; call finish again to take a new attempt.`,
    live: null,
  };
}

/**
 * Do the work of the attempt the run carries, if no live worker holds it.
 * Always ends with the record terminal, unless its lease was taken over.
 */
export interface FinishWorkerHooks {
  /** Test seam: runs after the green verdict is committed and before the first close. */
  afterVerified?: () => Promise<void>;
  /** Test seam: runs inside a closing write's transaction, after the fence passed. */
  afterFence?: () => Promise<void>;
  /** Test seam: runs after the claims are released and before `finished` is written. */
  beforeFinishedWrite?: () => Promise<void>;
}

/**
 * The roster outcome so far: what an earlier pass of this attempt checkpointed, and what this
 * pass adds. A pass resumed after the claims were released finds none, and adds nothing.
 */
function mergeOutcome(
  prev: ReleaseFinishRecord,
  pass: { closed: string[]; failed: Array<{ id: string; reason: string }> },
): Pick<ReleaseFinishRecord, 'closed' | 'failed'> {
  const closed = [...new Set([...(prev.closed ?? []), ...pass.closed])];
  const failed = [...(prev.failed ?? []), ...pass.failed].filter(
    (f, i, all) => !closed.includes(f.id) && all.findIndex((g) => g.id === f.id) === i,
  );
  return { closed, failed };
}

/** Whether somebody aborted this attempt's batch while it worked. */
async function wasAborted(runId: string): Promise<boolean> {
  return (await readReleaseRun(runId))?.status === 'cancelled';
}

export async function runReleaseBatchFinish(
  runId: string,
  hooks: FinishWorkerHooks = {},
): Promise<void> {
  const run = await readReleaseRun(runId);
  const record = run ? readFinishRecord(run.metadata) : null;
  if (!run || !record) return;

  if (record.state === 'finished') {
    // The worker that wrote `finished` died before the run went terminal.
    if (run.status === 'running' || run.status === 'paused') {
      await closeRunIfOneShot(runId, 'completed');
    }
    return;
  }
  if (!isInFlight(record) || leaseStands(record, Date.now())) return;

  const owner = randomUUID();
  const hold = holdAttempt(runId, record, hooks);
  try {
    await hold.commit((r) => ({
      owner,
      leaseUntil: new Date(Date.now() + FINISH_LEASE_MS).toISOString(),
      workerStarts: r.workerStarts + 1,
      state: r.state === 'accepted' ? 'verifying' : r.state,
    }));
  } catch {
    return;
  }

  const heartbeat = setInterval(() => {
    hold.renew().catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    await finishReleaseBatch(runId, record.requestedBy, {
      commit: record.commit ?? undefined,
      alreadyVerified: record.state === 'closing',
      onVerified: async () => {
        if (await wasAborted(runId)) throw new ReleaseBatchAbortedError();
        await hold.commit(() => ({ state: 'closing' }));
        await hooks.afterVerified?.();
      },
      fence: hold.fence,
      onRosterClosed: async (result) => {
        const aborted = await wasAborted(runId);
        // On an aborted batch the issues this pass could not close are where the abort put them,
        // not failures of the release, so only what truly closed is kept.
        await hold.commit((r) => mergeOutcome(r, aborted ? { ...result, failed: [] } : result));
        if (aborted) throw new ReleaseBatchAbortedError();
      },
      onClosed: async (result) => {
        await hooks.beforeFinishedWrite?.();
        await hold.commit((r) => ({
          ...mergeOutcome(r, result),
          state: 'finished',
          owner: null,
          leaseUntil: null,
          finishedAt: new Date().toISOString(),
        }));
      },
    });
  } catch (err) {
    if (err instanceof ReleaseFinishFenceLostError || hold.lost) return;
    if (hold.state === 'finished') {
      // The roster is closed and recorded; only the run's close failed, which the sweep retries.
      logger.error({ err, runId }, 'release-batch: a finished release could not close its run');
      return;
    }
    const own = refusalOf(err);
    if (own.code === 'RELEASE_FINISH_ERRORED') {
      logger.error({ err, runId }, 'release-batch: a finish stopped on an unexpected error');
    }
    // An abort is why an aborted batch's attempt ended, whatever else it met first.
    const aborted = await wasAborted(runId).catch(() => false);
    const refusal = aborted ? refusalOf(new ReleaseBatchAbortedError()) : own;
    await hold
      .commit(() => ({
        state: 'failed',
        refusal,
        owner: null,
        leaseUntil: null,
        finishedAt: new Date().toISOString(),
      }))
      .catch(() => {});
  } finally {
    clearInterval(heartbeat);
  }
}

// ── The sweep ───────────────────────────────────────────────────────────────

interface SweepRow extends Record<string, unknown> {
  id: string;
  status: string;
  metadata: unknown;
}

/** Whether this record, on a run at this status, is owed a wake-up now. */
export function owedWakeUp(record: ReleaseFinishRecord, runStatus: string, now: number): boolean {
  if (record.state === 'finished') return runStatus === 'running' || runStatus === 'paused';
  if (!isInFlight(record)) return false;
  if (record.owner === null) return Date.parse(record.updatedAt) + FINISH_UNTAKEN_MS < now;
  return !leaseStands(record, now);
}

/**
 * Wake every attempt nobody is working: one whose owner stopped renewing, one
 * never taken, and one written `finished` whose run is still open.
 */
export async function resumeStrandedFinishes(
  now: Date = new Date(),
  enqueue: Enqueue = enqueueReleaseBatchFinish,
): Promise<{ woken: string[] }> {
  const rows = (await db.execute<SweepRow>(sql`
    SELECT id, status, metadata
    FROM pipeline_runs
    WHERE kind = 'system'
      AND metadata ->> 'source' = 'release-batch'
      AND metadata -> 'finish' ->> 'state' IN ('accepted', 'verifying', 'closing', 'finished')
      AND (metadata -> 'finish' ->> 'state' <> 'finished' OR status IN ('running', 'paused'))
  `)) as unknown as SweepRow[];

  const woken: string[] = [];
  for (const row of rows) {
    const record = readFinishRecord(row.metadata);
    if (!record || !owedWakeUp(record, row.status, now.getTime())) continue;
    await enqueue(row.id);
    woken.push(row.id);
  }
  if (woken.length > 0) {
    logger.warn({ woken }, 'release-batch: woke finish attempts nobody was working');
  }
  return { woken };
}

// ── The queue ───────────────────────────────────────────────────────────────

/**
 * Wake the job for this run. A failure to wake is logged, not thrown: the
 * attempt is already on the record, and the sweep wakes an untaken one.
 */
export async function enqueueReleaseBatchFinish(runId: string): Promise<void> {
  try {
    const { boss } = await import('../queue/boss.js');
    // biome-ignore lint/suspicious/noExplicitAny: pg-boss send signature varies
    await (boss as any).send(
      RELEASE_FINISH_QUEUE,
      { runId },
      { singletonKey: runId, retryLimit: 0 },
    );
  } catch (err) {
    logger.warn({ err, runId }, 'release-batch: could not wake the finish job; the sweep will');
  }
}

const running = new Set<string>();

/**
 * The job only starts the work and returns. The work is held by its lease, not
 * by the queue, so one long verification does not hold a queue slot that
 * another project's finish is waiting for.
 */
function startWork(runId: string): void {
  if (running.has(runId)) return;
  running.add(runId);
  runReleaseBatchFinish(runId)
    .catch((err) => logger.error({ err, runId }, 'release-batch: finish worker crashed'))
    .finally(() => running.delete(runId));
}

let registered = false;

export async function registerReleaseBatchFinish(): Promise<void> {
  if (registered) return;
  const { boss } = await import('../queue/boss.js');
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  const b = boss as any;
  await b.createQueue(RELEASE_FINISH_QUEUE, { policy: 'short' });
  await b.work(RELEASE_FINISH_QUEUE, { batchSize: 1 }, async (arg: unknown) => {
    for (const job of Array.isArray(arg) ? arg : [arg]) {
      const runId = (job as { data?: { runId?: unknown } })?.data?.runId;
      if (typeof runId === 'string') startWork(runId);
    }
  });
  await b.createQueue(RESUME_QUEUE);
  await b.work(RESUME_QUEUE, async () => {
    await resumeStrandedFinishes();
  });
  await b.schedule(RESUME_QUEUE, '* * * * *');
  registered = true;
}

export function resetReleaseBatchFinishForTest(): void {
  registered = false;
}
