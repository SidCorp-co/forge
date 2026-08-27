// The people a cross-tenant ops alert (ISS-652) must reach. Distinct from
// `project-admins.ts`: A1-A5 describe platform-wide conditions (an orphaned
// job, a starved runner pool) that no single project's admins can act on and
// must not be told about — the recipients are the ADMIN_EMAILS allow-list,
// the same set `requireAdmin()` gates the GET behind.

import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { parseAdminList } from '../middleware/require-admin.js';

// cm:guard mirrors requireAdmin's ADMIN_EMAILS allow-list AND the GET route's assertEmailVerified() gate — an unverified address on the allow-list must not receive cross-tenant alert details
export async function platformAdminUserIds(): Promise<string[]> {
  const allowed = parseAdminList();
  if (allowed.length === 0) return [];

  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(sql`lower(${users.email})`, allowed), isNotNull(users.emailVerifiedAt)));
  return rows.map((r) => r.id);
}
