import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { resolveNotifications } from '../notifications/auto-resolve.js';

/**
 * An archived project is put away, and archiving one with live issues is allowed: judges archive
 * their scratch projects that way. So a stuck-issue sweep reads no issue of an archived project,
 * and the notices one already raised there are resolved rather than left firing (ISS-1229 r10,
 * the forge-dev decider's ruling after judge-22's archived `qa-j22o` kept notifying).
 */

/**
 * Resolve every open stuck-issue notice under `issue:<id><keySuffix>` whose issue belongs to an
 * archived project. Each sweep passes its own suffix, so it resolves only what it raised.
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
