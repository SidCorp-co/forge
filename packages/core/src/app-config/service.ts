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

/** A project's app config takes these values, created where it has none; answers the whole row. */
export async function saveAppConfig(projectId: string, values: AppConfigValues) {
  const [row] = await db
    .insert(appConfig)
    .values({ projectId, ...values })
    .onConflictDoUpdate({
      target: appConfig.projectId,
      set: { ...values, updatedAt: sql`now()` },
    })
    .returning();
  if (!row) throw new Error('app_config: upsert returned no row');
  return row;
}
