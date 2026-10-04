/**
 * Runner rows and their lifecycle, for whichever transport asks.
 *
 * The in-flight count these pair with is `jobs/in-flight.ts`'s — it is a fact
 * about jobs, not about runners, and four surfaces had grown their own.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type RunnerStatus, type RunnerType, runners } from '../db/schema.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/db-errors.js';

export type NewRunner = {
  projectId: string;
  type: RunnerType;
  deviceId: string;
  name: string;
  labels: string[];
  capabilities: Record<string, unknown>;
  config: Record<string, unknown>;
};

/**
 * One device already binds this project on this type. Each transport maps this
 * to its own status; `collided` is the row that holds the binding, or null when
 * the binding outlived two reads and could not be named.
 */
export class RunnerAlreadyBoundError extends Error {
  constructor(
    readonly collided: { id: string; name: string; status: RunnerStatus } | null,
    readonly wayBack: string,
  ) {
    super(
      collided
        ? `runner ${collided.id} (${collided.name}) already binds this device to this project as this type, status ${collided.status}. ${wayBack}`
        : `this device already binds this project as this type, and the runner holding it could not be read back. ${wayBack}`,
    );
    this.name = 'RunnerAlreadyBoundError';
  }
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
    throw new RunnerAlreadyBoundError(
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
    throw new RunnerAlreadyBoundError(null, "Read the project's runners to find it.");
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
