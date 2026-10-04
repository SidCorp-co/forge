import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { schedules } from '../db/schema.js';

/** A project's schedules made from an improvement-message template. */
export async function templateSchedulesOf(projectId: string) {
  return db
    .select({
      id: schedules.id,
      templateKey: schedules.templateKey,
      mode: schedules.mode,
      cron: schedules.cron,
      enabled: schedules.enabled,
    })
    .from(schedules)
    .where(and(eq(schedules.projectId, projectId), isNotNull(schedules.templateKey)))
    .limit(1000);
}
