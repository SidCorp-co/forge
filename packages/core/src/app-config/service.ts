import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { appConfig } from '../db/schema.js';

type AppConfigValues = Partial<typeof appConfig.$inferInsert>;

/** A project's app config takes these values, created where it has none; answers its id. */
export async function upsertAppConfig(
  tx: Tx,
  projectId: string,
  values: AppConfigValues,
): Promise<string> {
  const [row] = await tx
    .insert(appConfig)
    .values({ ...values, projectId })
    .onConflictDoUpdate({
      target: appConfig.projectId,
      set: { ...values, updatedAt: sql`now()` },
    })
    .returning({ id: appConfig.id });
  if (!row) throw new Error('app_config: upsert returned no row');
  return row.id;
}

/** Merge keys into the project's memory reindex progress. */
export async function mergeMemoryReindex(
  projectId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db
    .update(appConfig)
    .set({
      memoryReindex: sql`${appConfig.memoryReindex} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: sql`now()`,
    })
    .where(eq(appConfig.projectId, projectId));
}

/** When the project's memory was last backfilled. */
export async function stampLastBackfill(projectId: string): Promise<void> {
  await db
    .update(appConfig)
    .set({ lastBackfillAt: sql`now()` })
    .where(eq(appConfig.projectId, projectId));
}
