import { eq } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import { type RunnerStatus, runnerEvents, runners } from '../db/schema.js';

/**
 * ISS-381 (2.3) — runner status-change audit writer.
 *
 * Single choke point so every `runners.status` mutation site records the
 * transition consistently and CHANGE-GATED: an event row is written only when
 * the status actually changes. This matters because the device-heartbeat site
 * sets status='online' on every heartbeat (~30s); without change-gating the
 * `runner_events` table would flood with no-op rows and the uptime timeline
 * would be unreadable.
 *
 * Bulk sites (device heartbeat, stale-detector) keep their set-based UPDATE for
 * efficiency and call `insertRunnerEvent` per actually-changed row; single-row
 * sites (PATCH / exclude / include) use `setRunnerStatus`, which does the
 * read-compare-write atomically.
 */

/** A drizzle executor: the base `db` or a transaction handle. */
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface RunnerEventInput {
  runnerId: string;
  projectId: string;
  oldStatus: string | null;
  newStatus: string;
  reason: string;
}

/** Low-level append of one audit row. Caller decides whether the status changed. */
export async function insertRunnerEvent(
  executor: Executor,
  input: RunnerEventInput,
): Promise<void> {
  await executor.insert(runnerEvents).values({
    runnerId: input.runnerId,
    projectId: input.projectId,
    oldStatus: input.oldStatus,
    newStatus: input.newStatus,
    reason: input.reason,
  });
}

export interface SetRunnerStatusResult {
  /** false when the runner does not exist. */
  found: boolean;
  /** true when the status value actually changed (and an event was written). */
  changed: boolean;
  oldStatus: RunnerStatus | null;
}

/**
 * Single-row status mutation with audit. Reads the current status under a row
 * lock, writes the new status + bumps updated_at, and appends a `runner_events`
 * row ONLY when the value changed. Always bumps updated_at so the stale-detector
 * heartbeat semantics are preserved even on a no-op status write.
 */
export async function setRunnerStatus(input: {
  runnerId: string;
  newStatus: RunnerStatus;
  reason: string;
}): Promise<SetRunnerStatusResult> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ status: runners.status, projectId: runners.projectId })
      .from(runners)
      .where(eq(runners.id, input.runnerId))
      .for('update')
      .limit(1);

    if (!existing) return { found: false, changed: false, oldStatus: null };

    const oldStatus = existing.status;
    const changed = oldStatus !== input.newStatus;

    await tx
      .update(runners)
      .set({ status: input.newStatus, updatedAt: new Date() })
      .where(eq(runners.id, input.runnerId));

    if (changed) {
      await insertRunnerEvent(tx, {
        runnerId: input.runnerId,
        projectId: existing.projectId,
        oldStatus,
        newStatus: input.newStatus,
        reason: input.reason,
      });
    }

    return { found: true, changed, oldStatus };
  });
}
