// The people a cross-tenant ops alert (ISS-652) must reach. Distinct from
// `project-admins.ts`: A1-A5 describe platform-wide conditions (an orphaned
// job, a starved runner pool) that no single project's admins can act on and
// must not be told about — the recipients are the ADMIN_EMAILS allow-list,
// the same set `requireAdmin()` gates the GET behind.

import { inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { parseAdminList } from '../middleware/require-admin.js';

// cm:guard mirrors requireAdmin's ADMIN_EMAILS allow-list — the people who can act on an ops alert are exactly the people who can open the ops console
export async function platformAdminUserIds(): Promise<string[]> {
  const allowed = parseAdminList();
  if (allowed.length === 0) return [];

  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(sql`lower(${users.email})`, allowed));
  return rows.map((r) => r.id);
}
