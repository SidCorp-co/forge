import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { resolveNotifications } from '../notifications/auto-resolve.js';

/**
 * A stuck-issue sweep reads no issue of an archived project, and resolves the notices it raised
 * there under `issue:<id><keySuffix>` (ISS-1229 r10). Archiving with live issues stays allowed.
 */
export async function resolveArchivedProjectNotices(keySuffix: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT n.resolution_key AS "key"
      FROM notifications n
      JOIN issues i ON i.id = n.issue_id
      JOIN projects p ON p.id = i.project_id
     WHERE n.resolved_at IS NULL
       AND p.archived_at IS NOT NULL
       AND n.resolution_key LIKE ${`issue:%${keySuffix}`}
  `)) as unknown as { key: string }[];
  let resolved = 0;
  for (const { key } of rows) resolved += await resolveNotifications(key);
  return resolved;
}
