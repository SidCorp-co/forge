import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { appConfig } from '../db/schema.js';

/** A project's memory model; `flat` where no config row exists. */
export async function memoryModelOf(projectId: string) {
  const [cfg] = await db
    .select({ model: appConfig.memoryModel })
    .from(appConfig)
    .where(eq(appConfig.projectId, projectId))
    .limit(1);
  return cfg?.model ?? 'flat';
}
