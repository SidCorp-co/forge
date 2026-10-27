import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { emitPipelineWedge } from '../pipeline/wedge.js';
import { readAbortStamp } from './abort-stamp.js';
import { BOUND_DEFAULTS, readBounds, type StallOrigin, stallOrigin } from './bounds.js';
import { ReleaseBatchNotAbortableError } from './errors.js';
import { RELEASE_JOB_TYPE } from './job-start.js';
import { listAttempts } from './ledger.js';
import { abortReleaseBatch } from './service.js';

export interface ReleaseSilentRecoveryResult {
  /** Batches whose run was cancelled by this pass. */
  recovered: number;
  /** Of those, the ones that had declared a promotion: their roster is held, not handed back. */
  held: number;
}

interface TakenRow extends Record<string, unknown> {
  run_id: string;
  project_id: string;
  job_id: string;
  taken_at: Date;
}

/**
 * An abort stamp this sweep wrote and never took the run past: it names no person, and the run is
 * still running. Whatever the stamp says of the roster, the pass that wrote it died before the run
 * was cancelled, and the next pass resumes it instead of excluding it.
 */
const INTERRUPTED_SWEEP = sql`(metadata -> 'abort' ->> 'by' = '')`;

/** What the sweep may stamp, checked on the row at the write: still running, no finish, no other abort. */
export const SWEEP_MAY_ABORT: SQL = sql`(status = 'running' AND metadata -> 'finish' IS NULL AND (metadata -> 'abort' IS NULL OR ${INTERRUPTED_SWEEP}))`;

/**
 * Every running release batch whose job a box took and that nothing else is already settling: no
 * finish record, no abort stamp. A queued or held job is waiting for a box or a person, and the
 * unstarted sweep answers the first; only a job that was taken and went quiet is read here.
 */
async function takenBatches(): Promise<TakenRow[]> {
  return (await db.execute<TakenRow>(sql`
    SELECT r.id AS run_id, r.project_id, j.id AS job_id, j.dispatched_at AS taken_at
    FROM pipeline_runs r
    JOIN LATERAL (
      SELECT id, status, dispatched_at FROM jobs
      WHERE pipeline_run_id = r.id AND type = ${RELEASE_JOB_TYPE}
      ORDER BY queued_at DESC LIMIT 1
    ) j ON true
    WHERE r.kind = 'system'
      AND r.status = 'running'
      AND (r.metadata->>'source') = 'release-batch'
      AND r.metadata -> 'finish' IS NULL
      AND (r.metadata -> 'abort' IS NULL OR ${INTERRUPTED_SWEEP})
      AND j.dispatched_at IS NOT NULL
      AND j.status IN ('dispatched', 'running', 'done', 'failed')
  `)) as unknown as TakenRow[];
}

type Verdict = { act: false } | { act: true; reason: string; promoted: boolean };

/**
 * Read the batch again, right before acting on it: what the candidate list saw can be a minute old.
 * One this sweep began to abort and never finished is resumed on the reason it stamped. Otherwise
 * the one threshold is the ledger's own `stall` bound; `total` and `regression` describe a live
 * batch a person should look at, which is not what a silent one is. The stamp itself is written
 * under `SWEEP_MAY_ABORT`, so a pause or a finish landing after this read still stops it.
 */
async function judge(row: TakenRow, now: number): Promise<Verdict> {
  const [fresh] = (await db.execute<{ metadata: Record<string, unknown> | null; status: string }>(
    sql`SELECT status, metadata FROM pipeline_runs WHERE id = ${row.run_id}`,
  )) as unknown as Array<{ metadata: Record<string, unknown> | null; status: string }>;
  if (fresh?.status !== 'running' || fresh.metadata?.finish != null) return { act: false };

  const attempts = await listAttempts(row.run_id);
  const promotes = attempts.filter((a) => a.stage === 'promote');
  const stamp = readAbortStamp(fresh.metadata);
  if (stamp !== null) {
    return stamp.by === ''
      ? { act: true, reason: stamp.reason, promoted: promotes.length > 0 }
      : { act: false };
  }

  const takenAt = new Date(row.taken_at);
  const reading = readBounds(attempts, { now, takenAt });
  const stall = reading.bounds.find((b) => b.name === 'stall');
  const origin = stallOrigin(attempts, takenAt);
  if (!reading.crossedNames.includes('stall') || stall?.measuredMs == null || origin === null) {
    return { act: false };
  }
  if (promotes.some((a) => a.settledAt !== null)) return { act: false };
  return {
    act: true,
    reason: reasonFor(stall.measuredMs, origin.from),
    promoted: promotes.length > 0,
  };
}

const SILENT_SINCE: Record<StallOrigin['from'], string> = {
  taken: 'a box took its job',
  ledger: 'its newest write',
};

function reasonFor(silentMs: number, from: StallOrigin['from']): string {
  const minutes = Math.floor(silentMs / 60_000);
  const bound = BOUND_DEFAULTS.stall / 60_000;
  return `nothing was written to this release's ledger in the ${minutes} minutes since ${SILENT_SINCE[from]} (the limit is ${bound}), so nothing is running it`;
}

/**
 * Recover every release batch whose box took the job and then went quiet for longer than the
 * ledger's stall bound: the roster goes back to the release gate, the run is cancelled and a wedge
 * says so. A batch that declared a promotion keeps its roster at `releasing` until its run is
 * cancelled, because that act may have landed; the releasing sweep then settles each issue against
 * what production serves (ISS-1421). One whose promotion settled is left whole.
 */
export async function recoverSilentReleaseBatches(
  now: Date = new Date(),
): Promise<ReleaseSilentRecoveryResult> {
  let recovered = 0;
  let held = 0;
  for (const row of await takenBatches()) {
    const verdict = await judge(row, now.getTime());
    if (!verdict.act) continue;
    const result = await abortReleaseBatch(row.run_id, verdict.reason, null, {
      onlyWhen: SWEEP_MAY_ABORT,
    }).catch((err: unknown) => {
      if (err instanceof ReleaseBatchNotAbortableError) return null;
      throw err;
    });
    if (result === null) continue;
    await emitWedge(row, verdict.promoted);
    recovered++;
    if (result.promoted) held++;
  }
  if (recovered > 0) {
    logger.warn({ recovered, held }, 'release-batch: batches recovered after a box went silent');
  }
  return { recovered, held };
}

const RECOVERY_QUEUE = 'release-batch-silent-recovery';
let registered = false;

/**
 * Run the pass on a schedule of its own.
 */
export async function registerReleaseSilentRecovery(): Promise<void> {
  if (registered) return;
  const { boss } = await import('../queue/boss.js');
  await boss.createQueue(RECOVERY_QUEUE);
  await boss.work(RECOVERY_QUEUE, async () => {
    await recoverSilentReleaseBatches();
  });
  await boss.schedule(RECOVERY_QUEUE, '* * * * *');
  registered = true;
}

export function resetReleaseSilentRecoveryForTest(): void {
  registered = false;
}

async function emitWedge(row: TakenRow, promoted: boolean): Promise<void> {
  await emitPipelineWedge({
    projectId: row.project_id,
    hop: 'heartbeat',
    entity: 'job',
    entityId: row.job_id,
    reason: 'a release batch went silent after a box took its job',
    action: promoted
      ? 'Nothing to settle by hand: the releasing sweep reads what production is serving and closes or returns each issue the release left at releasing.'
      : 'Check that the machine that does this project`s releases is healthy, then cut the batch again.',
    title: 'A release stopped reporting and was cancelled',
    summary: promoted
      ? 'The release had started putting code on production and then stopped reporting. It was cancelled; its issues were left at releasing because the code may have landed, and Forge now settles each one against what production serves.'
      : 'The machine running this release took it and then stopped reporting. It was cancelled, and every issue in it has been put back where it was, so nothing is lost and nothing is half-released.',
    nextStep: promoted
      ? "Read the releasing sweep's comment on each issue: one whose code production carries is closed by a release record, and the rest are back at the release gate to release again."
      : 'Make sure the machine that does this project`s releases is switched on and healthy, then start the release again.',
  });
}
