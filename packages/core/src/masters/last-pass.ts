import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * When the project's last finished master pass began: an answer after it was not in front of that
 * pass, and is named until a pass that began after it has ended. A project whose master never
 * finished a pass has nothing to measure "since" against, so its first pass reads the board whole.
 */
export async function lastFinishedPassStart(projectId: string): Promise<Date | null> {
  const rows = (await db.execute(sql`
    SELECT max(started_at) AS started_at FROM master_passes
     WHERE project_id = ${projectId} AND ended_at IS NOT NULL
  `)) as unknown as Array<{ started_at: string | Date | null }>;
  const at = rows[0]?.started_at;
  return at ? new Date(at) : null;
}
