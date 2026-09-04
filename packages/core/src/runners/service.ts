/**
 * Runner rows and their lifecycle, for whichever transport asks.
 *
 * The in-flight count these pair with is `jobs/in-flight.ts`'s — it is a fact
 * about jobs, not about runners, and four surfaces had grown their own.
 */

import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type RunnerStatus, type RunnerType, runners } from '../db/schema.js';

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

export async function insertRunner(input: NewRunner) {
  const [row] = await db
    .insert(runners)
    .values({ ...input, status: 'offline' })
    .returning();
  if (!row) throw new Error('runners: insert returned no row');
  return row;
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
