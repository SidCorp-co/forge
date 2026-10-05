import {
  JOB_MACHINE,
  LIVE_JOB_STATUSES,
  OCCUPYING_JOB_STATUSES,
} from '@forge/contracts/job-machine';
import { RUN_MACHINE } from '@forge/contracts/run-machine';
import { LIVE_SESSION_STATUSES } from '@forge/contracts/session-machine';
import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentSessions, jobs, pipelineRuns } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { RefusalError } from '../lib/refusal.js';
import {
  type KernelActor,
  type TransitionArgs,
  type TransitionResult,
  transition,
} from '../lifecycle/index.js';
import { requestJobKill, transitionSessions } from './ports.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type JobRow = typeof jobs.$inferSelect;
type RunRow = typeof pipelineRuns.$inferSelect;

type CascadeReason = 'pipeline_cancelled' | 'pipeline_completed' | 'pipeline_failed';

export interface CascadeResult {
  cancelledJobIds: string[];
  abortedSessionIds: string[];
  deviceBySession: Map<string, string>;
  /** ISS-785 — the terminal-flipped job rows that have a device to kill on.
   *  Pass to `requestKillsForCascade` AFTER the transaction commits (same
   *  "never publish/act on a rolled-back write" contract the old
   *  `agent:abort` fan-out had). */
  killableJobs: JobRow[];
}

/** A move the close cannot take is the close's failure: the transaction rolls back with it. */
function settled<R>(result: TransitionResult<R>): R[] {
  const [lead] = result.refusals;
  if (lead) throw new RefusalError(result.refusals, lead.code);
  return result.rows;
}

/**
 * Lock a run for a close the caller is about to make in this transaction, taken before the write
 * that decides the close so the run is locked before its children (ISS-219).
 */
export async function lockRunForClose(tx: Tx | Db, runId: string): Promise<void> {
  await tx
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .for('update');
}

export interface RunClose {
  to: 'completed' | 'failed' | 'cancelled';
  /** Which runs, and the statuses each may close from. */
  where: SQL | undefined;
  /** Columns written beside `finishedAt` and `updatedAt`. */
  set?: TransitionArgs<'run', never>['set'];
  reason: CascadeReason;
  actor: KernelActor;
  source: string;
}

/**
 * The one way a run reaches a terminal status (ISS-219). The runs are locked `FOR UPDATE` before
 * the move, so a writer checking that a run takes work waits for this close and then reads it
 * closed; the move and the cascade over every child it leaves are one transaction with it.
 * Answers the runs it closed with each one's cascade, whose kills are the caller's to request once
 * the transaction commits.
 */
export async function closeRunsInTx(
  tx: Tx | Db,
  close: RunClose,
): Promise<{ rows: RunRow[]; cascades: Array<{ runId: string; result: CascadeResult }> }> {
  // An absent predicate would lock and close every open run.
  if (!close.where) throw new Error(`closeRunsInTx: ${close.source} named no runs to close`);
  const locked = await tx
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(close.where)
    .for('update');
  if (locked.length === 0) return { rows: [], cascades: [] };
  const now = new Date();
  const rows = settled(
    await transition(tx, RUN_MACHINE, {
      to: close.to,
      set: { finishedAt: now, updatedAt: now, ...close.set },
      where: and(
        inArray(
          pipelineRuns.id,
          locked.map((r) => r.id),
        ),
        close.where,
      ),
      reason: close.reason,
      actor: close.actor,
      source: close.source,
    }),
  );
  const cascades: Array<{ runId: string; result: CascadeResult }> = [];
  for (const row of rows) {
    cascades.push({
      runId: row.id,
      result: await cascadeCancelChildJobs(tx, row.id, close.reason),
    });
  }
  return { rows, cascades };
}

// cm:flow release/reap after:close — closing the run reaps its child jobs, and on a `pipeline_completed` close the release job that is still running flips to done, NOT cancelled; that sentinel is why a successful release does not look like a cancelled one
export async function cascadeCancelChildJobs(
  tx: Tx | Db,
  runId: string,
  reason: CascadeReason,
): Promise<CascadeResult> {
  const now = new Date();

  // ISS-444 amendment 2 — the JOB axis mirrors the ISS-352 session branch
  // below: a run closing as `pipeline_completed` is the cascade's SUCCESS
  // sentinel, so the step's own still-active job resolves to `done` (NOT
  // cancelled). Genuine cancel/fail closes still cancel their active children.
  const completedSuccess = reason === 'pipeline_completed';
  const doneJobs = completedSuccess
    ? settled(
        await transition(tx, JOB_MACHINE, {
          to: 'done',
          set: {
            finishedAt: now,
            exitCode: 0,
            error: null,
            failureKind: null,
            failureReason: null,
          },
          where: and(
            eq(jobs.pipelineRunId, runId),
            inArray(jobs.status, [...OCCUPYING_JOB_STATUSES]),
          ),
          reason,
          actor: { type: 'system' },
          source: 'cascade',
        }),
      )
    : [];
  // A job the success close cannot finish never ran (queued, or held), so it is cancelled with the
  // rest: no close leaves a live child behind it.
  const stoppedJobs = settled(
    await transition(tx, JOB_MACHINE, {
      to: 'cancelled',
      set: {
        finishedAt: now,
        cancellationRequested: true,
        failureKind: 'infra',
        failureReason: reason,
      },
      where: and(eq(jobs.pipelineRunId, runId), inArray(jobs.status, [...LIVE_JOB_STATUSES])),
      reason,
      actor: { type: 'system' },
      source: 'cascade',
    }),
  );
  const cancelledJobs = [...doneJobs, ...stoppedJobs];

  const cancelledJobIds = cancelledJobs.map((j) => j.id);
  const abortedSessionIds = cancelledJobs
    .map((j) => j.agentSessionId)
    .filter((id): id is string => typeof id === 'string');
  const deviceBySession = new Map<string, string>();
  for (const j of cancelledJobs) {
    if (j.agentSessionId && j.deviceId) deviceBySession.set(j.agentSessionId, j.deviceId);
  }

  // ISS-352 — a run that closed as `pipeline_completed` did NOT fail. The
  // terminal pipeline step (forge-test → released, forge-release → closed)
  // sets the issue to a terminal status as its LAST action while its own
  // job/session is still `running`; the cascade then reaps that very session.
  // Mapping a success-close to `failed` produced the false-failed badge the
  // reporter saw on ISS-351's forge-test / forge-release sessions. Only
  // genuine failure/cancel closes should mark the leftover sessions failed.
  //
  // ISS-219 — every live session of the run, not only those of the jobs just
  // stopped: a run session, a chat session, and the session of a job that
  // already ended are the run's children as much.
  const sessionTarget: 'completed' | 'failed' = completedSuccess ? 'completed' : 'failed';
  settled(
    await transitionSessions(tx, {
      to: sessionTarget,
      set: completedSuccess
        ? { failureReason: null, failureDetail: null, updatedAt: now }
        : { failureReason: reason, updatedAt: now },
      where: and(
        or(
          eq(agentSessions.pipelineRunId, runId),
          inArray(
            agentSessions.id,
            tx.select({ id: jobs.agentSessionId }).from(jobs).where(eq(jobs.pipelineRunId, runId)),
          ),
        ),
        inArray(agentSessions.status, [...LIVE_SESSION_STATUSES]),
      ),
      returning: ['id'],
      reason,
      actor: { type: 'system' },
      source: 'cascade',
    }),
  );
  await refuseActiveChildLeft(tx, runId);

  const killableJobs = cancelledJobs.filter((j) => j.deviceId);

  return { cancelledJobIds, abortedSessionIds, deviceBySession, killableJobs };
}

/**
 * A child no machine edge could stop would fail its next write for ever under migration 0403's
 * trigger, which refuses these statuses under a closed run; it fails the close now instead.
 */
async function refuseActiveChildLeft(tx: Tx | Db, runId: string): Promise<void> {
  const [job] = await tx
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.pipelineRunId, runId), inArray(jobs.status, [...LIVE_JOB_STATUSES])))
    .limit(1);
  const [session] = job
    ? []
    : await tx
        .select({ id: agentSessions.id, status: agentSessions.status })
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.pipelineRunId, runId),
            inArray(agentSessions.status, [...LIVE_SESSION_STATUSES]),
          ),
        )
        .limit(1);
  const left = job ? { table: 'job', ...job } : session ? { table: 'session', ...session } : null;
  if (!left) return;
  throw new Error(
    `run close: ${left.table} ${left.id} is still \`${left.status}\` under pipeline_run ${runId} after the cascade, and no machine edge stops it; the close is refused rather than leave an active child under a terminal run`,
  );
}

export async function requestKillsForCascade(
  killableJobs: JobRow[],
  reason: CascadeReason,
): Promise<string[]> {
  if (killableJobs.length === 0) return [];
  const notified = new Set<string>();
  for (const job of killableJobs) {
    try {
      const outcome = await requestJobKill(job, reason);
      if (outcome === 'requested' && job.deviceId) notified.add(job.deviceId);
    } catch (err) {
      logger.error(
        { err, jobId: job.id, deviceId: job.deviceId },
        'cascadeCancelChildJobs: job.cancel kill request failed',
      );
    }
  }
  return Array.from(notified);
}

export function reasonForOutcome(outcome: 'completed' | 'failed' | 'cancelled'): CascadeReason {
  if (outcome === 'completed') return 'pipeline_completed';
  if (outcome === 'failed') return 'pipeline_failed';
  return 'pipeline_cancelled';
}
