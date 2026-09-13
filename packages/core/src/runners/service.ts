/**
 * Runner rows and their lifecycle, for whichever transport asks.
 *
 * The in-flight count these pair with is `jobs/in-flight.ts`'s — it is a fact
 * about jobs, not about runners, and four surfaces had grown their own.
 */

import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type RunnerStatus, type RunnerType, runners } from '../db/schema.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/db-errors.js';

export type RunnerQuery = {
  visibleProjectIds: string[];
  projectId?: string | undefined;
  status?: RunnerStatus | undefined;
  type?: RunnerType | undefined;
};

export async function listRunners(q: RunnerQuery) {
  const filters: SQL[] = [inArray(runners.projectId, q.visibleProjectIds)];
  if (q.projectId) filters.push(eq(runners.projectId, q.projectId));
  if (q.status) filters.push(eq(runners.status, q.status));
  if (q.type) filters.push(eq(runners.type, q.type));

  return db
    .select()
    .from(runners)
    .where(and(...filters));
}

/** One runner row by id, for a caller that has just written it through an audited writer. */
export async function findRunnerById(runnerId: string) {
  const [row] = await db.select().from(runners).where(eq(runners.id, runnerId)).limit(1);
  return row ?? null;
}

/** Which project a runner belongs to, for a gate that runs before anything else. */
export async function findRunnerProjectId(runnerId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: runners.projectId })
    .from(runners)
    .where(eq(runners.id, runnerId))
    .limit(1);
  return row?.projectId ?? null;
}

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

// cm:edge contract -> packages/core/src/db/schema.ts — the key is the index NAME as `runnersProjectDeviceTypeUq` spells it; renamed there and not here, the violation stops being recognised and leaves as a 500 again.
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

// cm:guard registration REFUSES an existing binding by name, it does not resolve one — a retired runner is returned to the pool by `forge_runners restore` or the pool toggle, and re-registering was the way out the old copy named and the unique index has never allowed (ISS-990). The two paths that legitimately resolve a collision, `projects/runners-routes.ts` by upsert and `heartbeat-ws.ts` by re-select, do not come through here.
export async function insertRunner(input: NewRunner) {
  try {
    return await insertRunnerRow(input);
  } catch (err) {
    if (!isBindingCollision(err)) throw err;
    const collided = await readBinding(input);
    // cm:guard a collision whose row has since gone means the binding is FREE, so the answer is the insert, never a refusal naming a runner nobody can read — a fabricated id in that message is the state lying about which runner blocked the caller.
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

export async function setRunnerStatus(runnerId: string, status: RunnerStatus) {
  const [row] = await db
    .update(runners)
    .set({ status, updatedAt: new Date() })
    .where(eq(runners.id, runnerId))
    .returning();
  return row ?? null;
}

export async function setRunnerCapabilities(
  runnerId: string,
  capabilities: Record<string, unknown>,
) {
  const [row] = await db
    .update(runners)
    .set({ capabilities, updatedAt: new Date() })
    .where(eq(runners.id, runnerId))
    .returning();
  return row ?? null;
}
