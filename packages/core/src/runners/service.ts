/**
 * Runner rows and their lifecycle, for whichever transport asks.
 *
 * The in-flight count these pair with is `jobs/in-flight.ts`'s — it is a fact
 * about jobs, not about runners, and four surfaces had grown their own.
 */

import type { RunnerRefusalCode } from '@forge/contracts/runners';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type RunnerStatus, type RunnerType, runners } from '../db/schema.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/db-errors.js';
import { type RefusalError, refuser } from '../lib/refusal.js';
import type { QuotaResult } from './types.js';

export type NewRunner = {
  projectId: string;
  type: RunnerType;
  deviceId: string;
  name: string;
  labels: string[];
  capabilities: Record<string, unknown>;
  config: Record<string, unknown>;
};

const refuse = refuser<RunnerRefusalCode>('RUNNER_REFUSED');

/** One device already binds this project on this type; `collided` is the row holding the binding, when it could be read. */
function alreadyBound(
  collided: { id: string; name: string; status: RunnerStatus } | null,
  wayBack: string,
): RefusalError {
  return refuse(
    'RUNNER_ALREADY_BOUND',
    collided
      ? `runner ${collided.id} (${collided.name}) already binds this device to this project as this type, status ${collided.status}. ${wayBack}`
      : `this device already binds this project as this type, and the runner holding it could not be read back. ${wayBack}`,
    '/deviceId',
  );
}

const PROJECT_DEVICE_TYPE_UQ = 'runners_project_device_type_uq';

const isBindingCollision = (err: unknown) =>
  isUniqueViolation(err) && uniqueViolationConstraint(err) === PROJECT_DEVICE_TYPE_UQ;

async function insertRunnerRow(input: NewRunner) {
  const [row] = await db
    .insert(runners)
    .values({ ...input, status: 'offline' })
    .returning();
  if (!row) throw new Error('runners: insert returned no row');
  return row;
}

export async function insertRunner(input: NewRunner) {
  try {
    return await insertRunnerRow(input);
  } catch (err) {
    if (!isBindingCollision(err)) throw err;
    const collided = await readBinding(input);
    if (!collided) return await retryAfterVanishedBinding(input);
    throw alreadyBound(
      collided,
      collided.status === 'disabled'
        ? 'It was retired, not removed: restore it rather than registering a second row.'
        : 'Unassign it first if you mean to replace it.',
    );
  }
}

async function retryAfterVanishedBinding(input: NewRunner) {
  try {
    return await insertRunnerRow(input);
  } catch (err) {
    if (!isBindingCollision(err)) throw err;
    throw alreadyBound(null, "Read the project's runners to find it.");
  }
}

async function readBinding(input: NewRunner) {
  const [row] = await db
    .select({ id: runners.id, name: runners.name, status: runners.status })
    .from(runners)
    .where(
      and(
        eq(runners.projectId, input.projectId),
        eq(runners.deviceId, input.deviceId),
        eq(runners.type, input.type),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** A runner takes these values; null when it is gone. */
export async function updateRunner(id: string, update: Partial<typeof runners.$inferInsert>) {
  const [row] = await db
    .update(runners)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(runners.id, id))
    .returning();
  return row ?? null;
}

/** A runner is removed. */
export async function deleteRunner(id: string): Promise<void> {
  await db.delete(runners).where(eq(runners.id, id));
}

/** A refreshed quota reading is merged into the runner's config. */
export async function storeRunnerQuota(
  id: string,
  config: Record<string, unknown>,
  quota: QuotaResult,
): Promise<void> {
  const next = {
    ...config,
    quota: {
      ...(config.quota as object | undefined),
      ...quota,
      refreshedAt: new Date().toISOString(),
    },
  };
  await db.update(runners).set({ config: next, updatedAt: new Date() }).where(eq(runners.id, id));
}
