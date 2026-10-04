import { JOB_MACHINE } from '@forge/contracts/job-machine';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { jobs } from '../db/schema.js';
import { transition } from '../lifecycle/index.js';
import { logger } from '../observability/logger.js';
import { CLASSIFIER_VERSION, emitPipelineWedge, type WedgeHop } from '../pipeline/index.js';
import { finalizeFailedJob } from './finalize-failure.js';
import { reportHopPage } from './hop-bounds.js';
import {
  isKillEpisodeLive,
  type KillableJobRef,
  killGraceMs,
  requestJobKill,
  resolveKillConfirmation,
} from './kill-gate.js';
import type { SessionLostCause } from './session-lost-cause.js';

type JobRow = typeof jobs.$inferSelect;

export interface JobAxisReapResult {
  reaped: number;
  killRequested: number;
  awaitingKill: number;
}

/** Raw-execute candidate row shared by every job-axis hop — the columns the
 *  kill gate needs (`toKillableRef`) plus the identifiers a wedge needs.
 *  A `type` (not `interface`) — `db.execute<T>`'s `T extends Record<string,
 *  unknown>` constraint only structurally matches object-literal types. */
export type KillGateCandidateRow = {
  id: string;
  project_id: string;
  issue_id: string | null;
  device_id: string | null;
  runner_id: string | null;
  kill_requested_at: Date | string | null;
  kill_confirmed_at: Date | string | null;
  kill_outcome: JobRow['killOutcome'];
  failure_reason: string | null;
};

export const KILL_GATE_CANDIDATE_COLUMNS = sql`j.id, j.project_id, j.issue_id, j.device_id, j.runner_id,
           j.kill_requested_at, j.kill_confirmed_at, j.kill_outcome`;

function toKillableRef(row: KillGateCandidateRow): KillableJobRef {
  return {
    id: row.id,
    deviceId: row.device_id,
    runnerId: row.runner_id,
    killRequestedAt: row.kill_requested_at ? new Date(row.kill_requested_at) : null,
    killConfirmedAt: row.kill_confirmed_at ? new Date(row.kill_confirmed_at) : null,
    killOutcome: row.kill_outcome,
  };
}

type KillGateReapDecision =
  | { phase: 'kill_requested' }
  | { phase: 'awaiting_kill' }
  | { phase: 'lost_race' }
  | { phase: 'reaped'; updated: JobRow; confirmed: boolean };

export interface KillGateReapConfig {
  hop: WedgeHop;
  /** CAS predicate for the terminal flip — MUST include the same status
   *  guard the candidate SELECT used. */
  where: SQL | undefined;
  fromStatus: string;
  /** Written to `jobs.error` — also the SYNTHETIC_REAP_ERRORS marker the
   *  late-`/complete` reconciler matches on, so keep it the short form. */
  error: string;
  /** Passed to `finalizeFailedJob`'s `error` option (logging / classifier
   *  fallback only). Defaults to `error` when the hop has no longer text. */
  finalizeError?: string;
  failureKind: SessionLostCause['failureKind'];
  failureReason: string;
  /** What tripped the hop — true on both the confirmed and unconfirmed
   *  branch, so the unconfirmed wedge extends it rather than replacing it. */
  wedgeReason: string;
  /** Action text for the CONFIRMED branch only (a retry is in flight). The
   *  unconfirmed branch owns `UNCONFIRMED_WEDGE_ACTION`. */
  confirmedWedgeAction: string;
  forceConfirmAfterGrace?: boolean;
}

async function resolveKillGateDecision(
  row: KillGateCandidateRow,
  cfg: KillGateReapConfig,
): Promise<KillGateReapDecision> {
  const ref = toKillableRef(row);

  const requestedAt = ref.killRequestedAt;
  if (!requestedAt || !isKillEpisodeLive(ref)) {
    await requestJobKill(ref, cfg.error);
    return { phase: 'kill_requested' };
  }

  if (Date.now() - requestedAt.getTime() < killGraceMs()) {
    await requestJobKill(ref, cfg.error);
    return { phase: 'awaiting_kill' };
  }

  const { confirmed, outcome } = cfg.forceConfirmAfterGrace
    ? { confirmed: true, outcome: ref.killOutcome ?? ('never_claimed' as const) }
    : await resolveKillConfirmation(ref);

  const set: Partial<Omit<JobRow, 'id' | 'status'>> = {
    error: cfg.error,
    finishedAt: new Date(),
    failureKind: cfg.failureKind,
    failureReason: cfg.failureReason,
    classifierVersion: CLASSIFIER_VERSION,
  };
  if (confirmed) set.killConfirmedAt = new Date();
  if (outcome) set.killOutcome = outcome;

  const [updated] = (
    await transition(db, JOB_MACHINE, {
      to: 'failed',
      set,
      where: cfg.where,
      reason: cfg.error,
      actor: { type: 'sweeper' },
      source: 'loop-monitor',
    })
  ).rows;
  if (!updated) return { phase: 'lost_race' };

  return { phase: 'reaped', updated, confirmed };
}

const UNCONFIRMED_WEDGE_ACTION =
  'NO retry was scheduled and the job is held. Before resuming it, check the assigned device and kill any agent process still running for this job — resuming while it lives puts two agents on the same worktree.';

async function finalizeKillGateReap(
  updated: JobRow,
  confirmed: boolean,
  cfg: Pick<
    KillGateReapConfig,
    'hop' | 'error' | 'finalizeError' | 'wedgeReason' | 'confirmedWedgeAction'
  >,
): Promise<void> {
  await emitPipelineWedge({
    projectId: updated.projectId,
    issueId: updated.issueId,
    hop: cfg.hop,
    entity: 'job',
    entityId: updated.id,
    reason: confirmed
      ? cfg.wedgeReason
      : `${cfg.wedgeReason} — and the runner never confirmed the kill, so its agent process may still be running on the device`,
    action: confirmed ? cfg.confirmedWedgeAction : UNCONFIRMED_WEDGE_ACTION,
  });
  const finalizeError = cfg.finalizeError ?? cfg.error;
  await finalizeFailedJob(
    updated,
    confirmed
      ? { error: finalizeError }
      : {
          error: finalizeError,
          precomputedRetry: { scheduled: false, reason: 'kill_unconfirmed' },
        },
  );
}

/**
 * Every job-axis hop's pass over its candidates: request the kill, wait out the
 * grace, then fail the job and route it through the shared finalize tail. A row
 * that throws is logged and skipped so one bad job never stops the sweep.
 */
export async function reapJobAxis(
  hop: string,
  candidates: readonly KillGateCandidateRow[],
  cfgFor: (row: KillGateCandidateRow) => KillGateReapConfig,
  log: { skipped: string; reaped: string },
): Promise<JobAxisReapResult> {
  const result: JobAxisReapResult = { reaped: 0, killRequested: 0, awaitingKill: 0 };
  for (const row of candidates) {
    try {
      const cfg = cfgFor(row);
      const decision = await resolveKillGateDecision(row, cfg);
      if (decision.phase === 'kill_requested') result.killRequested++;
      else if (decision.phase === 'awaiting_kill') result.awaitingKill++;
      else if (decision.phase === 'reaped') {
        result.reaped++;
        await finalizeKillGateReap(decision.updated, decision.confirmed, cfg);
      }
    } catch (err) {
      logger.error({ err, jobId: row.id }, log.skipped);
    }
  }
  if (result.reaped > 0) logger.info({ reaped: result.reaped }, log.reaped);
  return reportHopPage(hop, candidates.length, result);
}
