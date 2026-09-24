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
import { and, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { logger } from '../logger.js';
import { closeRunIfOneShot } from '../pipeline/runs.js';
import {
  ReleaseFinishFenceLostError,
  ReleaseFinishInFlightError,
  ReleaseNotVerifiedError,
} from './errors.js';
import { finishRefusal } from './refusals.js';
import { assertFinishable, finishReleaseBatch, readReleaseRun } from './service.js';
import { claimedCommit, notAWholeCommit } from './verify.js';

export type FinishState = 'accepted' | 'verifying' | 'closing' | 'finished' | 'failed';

const IN_FLIGHT: ReadonlySet<FinishState> = new Set(['accepted', 'verifying', 'closing']);
const STATES: ReadonlySet<string> = new Set([...IN_FLIGHT, 'finished', 'failed']);

/** Why an attempt ended red, in the vocabulary the door answers with. */
export interface FinishRefusal {
  code: string;
  reason: string;
  live: string | null;
}

export interface ReleaseFinishRecord {
  /** One per accepted attempt. A retry of the same attempt answers the same id. */
  requestId: string;
  state: FinishState;
  /** The whole sha the caller claims was pushed, or `null` to ask only that the deploy arrived. */
  commit: string | null;
  requestedBy: TransitionActor;
  acceptedAt: string;
  updatedAt: string;
  /** Bumped by every write; the compare-and-set token. */
  version: number;
  /** The worker holding this attempt, while one does. */
  owner: string | null;
  leaseUntil: string | null;
  workerStarts: number;
  closed: string[] | null;
  failed: Array<{ id: string; reason: string }> | null;
  refusal: FinishRefusal | null;
  finishedAt: string | null;
}

/** How long a worker's claim on an attempt stands without a renewal. */
export const FINISH_LEASE_MS = 120_000;
const HEARTBEAT_MS = 30_000;
/** An accepted attempt no worker took in this long was never woken, so the sweep wakes it. */
export const FINISH_UNTAKEN_MS = 60_000;

export const RELEASE_FINISH_QUEUE = 'release-batch-finish';
const RESUME_QUEUE = 'release-batch-finish-resume';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function actorOf(v: unknown): TransitionActor | null {
  if (typeof v !== 'object' || v === null) return null;
  const a = v as Record<string, unknown>;
  const id = str(a.id);
  if (!id) return null;
  if (a.type === 'user')
    return { type: 'user', id, ...(a.agency ? { agency: a.agency } : {}) } as TransitionActor;
  const ownerId = str(a.ownerId);
  if (a.type === 'device' && ownerId) return { type: 'device', id, ownerId };
  return null;
}

/**
 * The finish record a run carries, or `null` when it carries none. A record this
 * code cannot read is `null` too, and logged: it is never guessed into a state.
 */
export function readFinishRecord(metadata: unknown): ReleaseFinishRecord | null {
  const raw = (metadata as { finish?: unknown } | null)?.finish;
  if (raw === undefined || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const requestId = str(r.requestId);
  const state = str(r.state);
  const requestedBy = actorOf(r.requestedBy);
  if (!requestId || !state || !STATES.has(state) || !requestedBy || typeof r.version !== 'number') {
    logger.error({ finish: raw }, 'release-batch: a finish record this code cannot read');
    return null;
  }
  const refusal = r.refusal as Record<string, unknown> | null | undefined;
  return {
    requestId,
    state: state as FinishState,
    commit: str(r.commit),
    requestedBy,
    acceptedAt: str(r.acceptedAt) ?? '',
    updatedAt: str(r.updatedAt) ?? '',
    version: r.version,
    owner: str(r.owner),
    leaseUntil: str(r.leaseUntil),
    workerStarts: typeof r.workerStarts === 'number' ? r.workerStarts : 0,
    closed: Array.isArray(r.closed) ? (r.closed as string[]) : null,
    failed: Array.isArray(r.failed) ? (r.failed as Array<{ id: string; reason: string }>) : null,
    refusal:
      refusal && typeof refusal === 'object'
        ? {
            code: str(refusal.code) ?? 'RELEASE_FINISH_ERRORED',
            reason: str(refusal.reason) ?? '',
            live: str(refusal.live),
          }
        : null,
    finishedAt: str(r.finishedAt),
  };
}

export function isInFlight(record: ReleaseFinishRecord | null): boolean {
  return record !== null && IN_FLIGHT.has(record.state);
}

/**
 * Write `next` over the record whose version was `expected` (`null` = the run
 * carries no record). `false` when somebody else wrote in between.
 */
async function compareAndSet(
  runId: string,
  expected: number | null,
  next: ReleaseFinishRecord,
): Promise<boolean> {
  const guard =
    expected === null
      ? sql`${pipelineRuns.metadata} -> 'finish' IS NULL`
      : sql`(${pipelineRuns.metadata} -> 'finish' ->> 'version')::int = ${expected}`;
  const rows = await db
    .update(pipelineRuns)
    .set({
      metadata: sql`coalesce(${pipelineRuns.metadata}, '{}'::jsonb) || ${JSON.stringify({ finish: next })}::jsonb`,
    })
    .where(and(eq(pipelineRuns.id, runId), guard))
    .returning({ id: pipelineRuns.id });
  return rows.length > 0;
}

function stamp(
  prev: ReleaseFinishRecord,
  patch: Partial<ReleaseFinishRecord>,
): ReleaseFinishRecord {
  return { ...prev, ...patch, version: prev.version + 1, updatedAt: new Date().toISOString() };
}

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
      closed: null,
      failed: null,
      refusal: null,
      finishedAt: null,
    };
    if (await compareAndSet(runId, current?.version ?? null, record)) {
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
    const rows = await tx.execute<{ owner: string | null }>(sql`
      SELECT ${pipelineRuns.metadata} -> 'finish' ->> 'owner' AS owner
      FROM ${pipelineRuns} WHERE ${pipelineRuns.id} = ${runId}
      FOR UPDATE
    `);
    if (rows[0]?.owner !== current.owner) {
      lost = true;
      throw new ReleaseFinishFenceLostError();
    }
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
        await hold.commit(() => ({ state: 'closing' }));
        await hooks.afterVerified?.();
      },
      fence: hold.fence,
      onRosterClosed: async (result) => {
        await hold.commit((r) => mergeOutcome(r, result));
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
    const refusal = refusalOf(err);
    if (refusal.code === 'RELEASE_FINISH_ERRORED') {
      logger.error({ err, runId }, 'release-batch: a finish stopped on an unexpected error');
    }
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
