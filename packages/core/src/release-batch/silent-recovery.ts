import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { emitPipelineWedge } from '../pipeline/wedge.js';
import { BOUND_DEFAULTS, readBounds } from './bounds.js';
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
  created_by: string | null;
}

/**
 * Every running release batch whose job a box took and that nothing else is already settling: no
 * finish record, no abort stamp. A queued or held job is waiting for a box or a person, and the
 * unstarted sweep answers the first; only a job that was taken and went quiet is read here.
 */
async function takenBatches(): Promise<TakenRow[]> {
  return (await db.execute<TakenRow>(sql`
    SELECT r.id AS run_id, r.project_id, j.id AS job_id, j.dispatched_at AS taken_at,
           p.created_by
    FROM pipeline_runs r
    JOIN projects p ON p.id = r.project_id
    JOIN LATERAL (
      SELECT id, status, dispatched_at FROM jobs
      WHERE pipeline_run_id = r.id AND type = ${RELEASE_JOB_TYPE}
      ORDER BY queued_at DESC LIMIT 1
    ) j ON true
    WHERE r.kind = 'system'
      AND r.status = 'running'
      AND (r.metadata->>'source') = 'release-batch'
      AND r.metadata -> 'finish' IS NULL
      AND r.metadata -> 'abort' IS NULL
      AND j.dispatched_at IS NOT NULL
      AND j.status IN ('dispatched', 'running', 'done', 'failed')
  `)) as unknown as TakenRow[];
}

type Verdict = { act: false } | { act: true; silentMs: number; promoted: boolean };

/**
 * Read the batch again, right before acting on it: what the candidate list saw can be a minute old,
 * and a finish or an abort that began since is not this pass's to undo. The one threshold is the
 * ledger's own `stall` bound; `total` and `regression` describe a live batch a person should look
 * at, which is not what a silent one is.
 */
async function judge(row: TakenRow, now: number): Promise<Verdict> {
  const [fresh] = (await db.execute<{ metadata: Record<string, unknown> | null; status: string }>(
    sql`SELECT status, metadata FROM pipeline_runs WHERE id = ${row.run_id}`,
  )) as unknown as Array<{ metadata: Record<string, unknown> | null; status: string }>;
  if (fresh?.status !== 'running') return { act: false };
  if (fresh.metadata?.finish != null || fresh.metadata?.abort != null) return { act: false };

  const attempts = await listAttempts(row.run_id);
  const reading = readBounds(attempts, { now, takenAt: new Date(row.taken_at) });
  const stall = reading.bounds.find((b) => b.name === 'stall');
  if (!reading.crossedNames.includes('stall') || stall?.measuredMs == null) return { act: false };

  const promotes = attempts.filter((a) => a.stage === 'promote');
  if (promotes.some((a) => a.settledAt !== null)) return { act: false };
  return { act: true, silentMs: stall.measuredMs, promoted: promotes.length > 0 };
}

function reasonFor(silentMs: number): string {
  const minutes = Math.floor(silentMs / 60_000);
  const bound = BOUND_DEFAULTS.stall / 60_000;
  return `nothing was written to this release's ledger for ${minutes} minutes after a box took its job (the bound is ${bound}), so nothing is running it`;
}

/**
 * Recover every release batch whose box took the job and then went quiet for longer than the
 * ledger's stall bound: the roster goes back to the release gate, the run is cancelled and a wedge
 * says so. A batch that declared a promotion keeps its roster at `releasing`, because that act may
 * have landed; one whose promotion settled is a person's to read and is left whole.
 */
export async function recoverSilentReleaseBatches(
  now: Date = new Date(),
): Promise<ReleaseSilentRecoveryResult> {
  let recovered = 0;
  let held = 0;
  for (const row of await takenBatches()) {
    const verdict = await judge(row, now.getTime());
    if (!verdict.act) continue;
    const reason = reasonFor(verdict.silentMs);
    const result = await abortReleaseBatch(row.run_id, reason, null, {
      ...(row.created_by ? { commentAs: row.created_by } : {}),
    });
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
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(RECOVERY_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(RECOVERY_QUEUE, async () => {
    await recoverSilentReleaseBatches();
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(RECOVERY_QUEUE, '* * * * *');
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
      ? 'Check what production is serving, then settle the issues the release left at releasing.'
      : 'Check that the machine that does this project`s releases is healthy, then cut the batch again.',
    title: 'A release stopped reporting and was cancelled',
    summary: promoted
      ? 'The release had started putting code on production and then stopped reporting. It was cancelled, and its issues stay marked as releasing, because the code may have landed.'
      : 'The machine running this release took it and then stopped reporting. It was cancelled, and every issue in it has been put back where it was, so nothing is lost and nothing is half-released.',
    nextStep: promoted
      ? 'Look at what production is serving. If the release landed, record it against the commit production serves; if it did not, return its issues to the release gate.'
      : 'Make sure the machine that does this project`s releases is switched on and healthy, then start the release again.',
  });
}
