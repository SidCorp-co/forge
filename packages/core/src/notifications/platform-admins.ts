import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { parseAdminList } from '../middleware/require-admin.js';

export async function platformAdminUserIds(): Promise<string[]> {
  const allowed = parseAdminList();
  if (allowed.length === 0) return [];

  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(sql`lower(${users.email})`, allowed), isNotNull(users.emailVerifiedAt)));
  return rows.map((r) => r.id);
}
