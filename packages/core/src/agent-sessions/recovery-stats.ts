/**
 * Recovery-stats writer (ISS-197).
 *
 * The L1 dispatch gate serialises sessions per-issue (no two sessions share
 * an issue_id), so an unconditional read-modify-write of the
 * `agent_sessions.pipeline_health` jsonb is safe — there is no second
 * writer for the same row. A future refactor that breaks that invariant
 * must replace this module with a SQL-side `jsonb_set` UPDATE, or a row
 * lock.
 *
 * The retry engine calls `incrementRecoveryStats` ONCE per failure (even
 * when the failure is non-retryable, so the operator still sees the count)
 * and `incrementAutoRetryCount` ONCE per scheduled retry. `markSessionTerminal`
 * is called when the verifier decides the retry would be wasted; it writes
 * the non-failure terminal status without touching `failureReason`.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import type { FailureKind } from '../pipeline/failure-classifier.js';
import {
  DEFAULT_RECOVERY_STATS,
  type PipelineHealth,
  type RecoveryStats,
  normaliseRecoveryStats,
} from './pipeline-control-types.js';

/** Failure kinds that have a `byKind` bucket. `unknown` is counted in
 * `totalFailures` and `lastFailureKind` but not in `byKind`. */
const BUCKETED_KINDS: ReadonlyArray<FailureKind> = [
  'transient',
  'permission',
  'permanent',
  'timeout',
];

async function loadHealth(sessionId: string): Promise<PipelineHealth | null> {
  const [row] = await db
    .select({ pipelineHealth: agentSessions.pipelineHealth })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return (row?.pipelineHealth ?? null) as PipelineHealth | null;
}

function emptyHealth(): PipelineHealth {
  return {
    retryCount: 0,
    recoveryStats: { ...DEFAULT_RECOVERY_STATS, byKind: { ...DEFAULT_RECOVERY_STATS.byKind } },
    lastError: null,
    updatedAt: new Date(0).toISOString(),
  };
}

export async function incrementRecoveryStats(
  sessionId: string,
  kind: FailureKind,
  occurredAt: Date = new Date(),
): Promise<RecoveryStats> {
  const existing = await loadHealth(sessionId);
  const baseHealth: PipelineHealth = existing ?? emptyHealth();
  const baseStats = normaliseRecoveryStats(baseHealth.recoveryStats);

  const byKind = { ...baseStats.byKind };
  if (BUCKETED_KINDS.includes(kind)) {
    byKind[kind as Exclude<FailureKind, 'unknown'>] += 1;
  }

  const next: RecoveryStats = {
    totalFailures: baseStats.totalFailures + 1,
    byKind,
    lastFailureAt: occurredAt.toISOString(),
    lastFailureKind: kind,
    autoRetries: baseStats.autoRetries,
  };

  await db
    .update(agentSessions)
    .set({
      pipelineHealth: {
        ...baseHealth,
        recoveryStats: next,
        updatedAt: new Date().toISOString(),
      },
    })
    .where(eq(agentSessions.id, sessionId));

  return next;
}

export async function incrementAutoRetryCount(sessionId: string): Promise<RecoveryStats> {
  const existing = await loadHealth(sessionId);
  const baseHealth: PipelineHealth = existing ?? emptyHealth();
  const baseStats = normaliseRecoveryStats(baseHealth.recoveryStats);

  const next: RecoveryStats = {
    ...baseStats,
    autoRetries: baseStats.autoRetries + 1,
  };

  await db
    .update(agentSessions)
    .set({
      pipelineHealth: {
        ...baseHealth,
        recoveryStats: next,
        updatedAt: new Date().toISOString(),
      },
    })
    .where(eq(agentSessions.id, sessionId));

  return next;
}

export async function markSessionTerminal(
  sessionId: string,
  terminal: 'completed_via_recovery' | 'cancelled_stale',
): Promise<void> {
  await db
    .update(agentSessions)
    .set({
      status: terminal,
      updatedAt: new Date(),
    })
    .where(eq(agentSessions.id, sessionId));
}
