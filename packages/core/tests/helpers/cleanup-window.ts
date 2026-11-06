import { CLEANUP_WINDOW_DEFAULT } from '@forge/contracts/cleanup';
import { db } from '../../src/db/client.js';
import { schedules } from '../../src/db/schema.js';
import { nextRunFor } from '../../src/schedules/index.js';

/**
 * A project's cleanup window turned on as a person turns one on (ISS-1049): its `cleanup` schedule at
 * the default end-of-day cron, owned by `ownerId`, enabled unless a test turns it off. Answers its id.
 */
export async function turnCleanupWindowOn(
  projectId: string,
  ownerId: string,
  opts: { enabled?: boolean } = {},
): Promise<string> {
  const { cron, timeZone, name } = CLEANUP_WINDOW_DEFAULT;
  const [row] = await db
    .insert(schedules)
    .values({
      projectId,
      name,
      cron,
      kind: 'cleanup',
      enabled: opts.enabled ?? true,
      nextRunAt: nextRunFor(cron, new Date(), timeZone),
      timeZone,
      ownerId,
    })
    .returning({ id: schedules.id });
  if (!row) throw new Error('no cleanup window was saved');
  return row.id;
}
