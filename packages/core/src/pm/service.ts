import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pmConfig, pmPolicies } from '../db/schema.js';
import { policyColumns } from './read.js';

type PmConfigPatch = Partial<
  Pick<
    typeof pmConfig.$inferInsert,
    'enabled' | 'eventTriggers' | 'customInstructions' | 'modelOverride' | 'maxRunsPerHour'
  >
>;

/** The project's PM config, created with defaults on first read; null when the lazy create lost every race. */
export async function ensurePmConfig(projectId: string) {
  const [existing] = await db
    .select()
    .from(pmConfig)
    .where(eq(pmConfig.projectId, projectId))
    .limit(1);
  if (existing) return existing;

  const [inserted] = await db
    .insert(pmConfig)
    .values({ projectId })
    .onConflictDoNothing({ target: pmConfig.projectId })
    .returning();
  if (inserted) return inserted;

  const [row] = await db
    .select()
    .from(pmConfig)
    .where(eq(pmConfig.projectId, projectId))
    .limit(1);
  return row ?? null;
}

/** The project's PM config, created if absent and patched; null when the update returned nothing. */
export async function updatePmConfig(projectId: string, patch: PmConfigPatch) {
  await db.insert(pmConfig).values({ projectId }).onConflictDoNothing({ target: pmConfig.projectId });
  const [updated] = await db
    .update(pmConfig)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(pmConfig.projectId, projectId))
    .returning();
  return updated ?? null;
}

/** A PM policy, created on the project. */
export async function createPmPolicy(
  projectId: string,
  input: { name: string; body: string; enabled?: boolean | undefined; priority?: number | undefined },
) {
  const [inserted] = await db
    .insert(pmPolicies)
    .values({
      projectId,
      name: input.name,
      body: input.body,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 0,
    })
    .returning(policyColumns);
  return inserted ?? null;
}

/** One of the project's PM policies, patched; null when absent. */
export async function updatePmPolicy(
  projectId: string,
  id: string,
  patch: {
    name?: string | undefined;
    body?: string | undefined;
    enabled?: boolean | undefined;
    priority?: number | undefined;
  },
) {
  const [updated] = await db
    .update(pmPolicies)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(pmPolicies.id, id), eq(pmPolicies.projectId, projectId)))
    .returning(policyColumns);
  return updated ?? null;
}

/** One of the project's PM policies, deleted; false when absent. */
export async function deletePmPolicy(projectId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(pmPolicies)
    .where(and(eq(pmPolicies.id, id), eq(pmPolicies.projectId, projectId)))
    .returning({ id: pmPolicies.id });
  return deleted.length > 0;
}
