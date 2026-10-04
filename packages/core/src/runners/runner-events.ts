import { RUNNER_MACHINE } from '@forge/contracts/runner-machine';
import { eq } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import { type RunnerStatus, runnerEvents, runners } from '../db/schema.js';
import { type KernelActor, movedRow, transition } from '../lifecycle/index.js';

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
 * Single-row status move with audit: the move goes through the kernel transition on the runner
 * machine, a move it does not draw is refused by name, and a `runner_events` row is appended only
 * when the status changed. `updated_at` is bumped even on a no-op, as the stale detector reads it.
 */
export async function setRunnerStatus(input: {
  runnerId: string;
  newStatus: RunnerStatus;
  reason: string;
  actor: KernelActor;
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
    await tx.update(runners).set({ updatedAt: new Date() }).where(eq(runners.id, input.runnerId));
    if (oldStatus === input.newStatus) return { found: true, changed: false, oldStatus };

    const moved = await transition(tx, RUNNER_MACHINE, {
      to: input.newStatus,
      expect: oldStatus,
      where: eq(runners.id, input.runnerId),
      reason: input.reason,
      actor: input.actor,
      source: 'runners',
      returning: ['id'],
    });
    movedRow(moved);

    await insertRunnerEvent(tx, {
      runnerId: input.runnerId,
      projectId: existing.projectId,
      oldStatus,
      newStatus: input.newStatus,
      reason: input.reason,
    });
    return { found: true, changed: true, oldStatus };
  });
}
