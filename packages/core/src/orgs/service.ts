import { and, eq } from 'drizzle-orm';
import type { db } from '../db/client.js';
import { organizationMembers, organizations } from '../db/schema.js';

/**
 * Tx-compatible handle — both `db` and the `tx` inside `db.transaction`
 * satisfy this for the two inserts we need.
 */
type DbLike = Pick<typeof db, 'insert' | 'select'>;

/**
 * Idempotently provision the user's personal org (one per user, enforced by
 * the `organizations_personal_owner_uq` partial unique). Called at signup
 * (local register + OAuth first-login); existing users are covered by
 * migration 0106. Slug mirrors the migration: `personal-<userId>`.
 */
export async function ensurePersonalOrg(
  dbh: DbLike,
  userId: string,
  email: string,
): Promise<string> {
  const existing = await dbh
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.createdBy, userId), eq(organizations.isPersonal, true)))
    .limit(1);
  const found = existing.find(() => true);
  if (found) return found.id;

  const inserted = await dbh
    .insert(organizations)
    .values({
      slug: `personal-${userId}`,
      name: email.split('@')[0] || 'personal',
      isPersonal: true,
      createdBy: userId,
    })
    .onConflictDoNothing()
    .returning({ id: organizations.id });
  const org = inserted[0];
  if (!org) {
    // Lost a race — the partial unique swallowed our insert; re-read.
    const [row] = await dbh
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.createdBy, userId), eq(organizations.isPersonal, true)))
      .limit(1);
    if (!row) throw new Error('ensurePersonalOrg: insert and re-read both failed');
    return row.id;
  }

  await dbh
    .insert(organizationMembers)
    .values({ orgId: org.id, userId, role: 'owner' })
    .onConflictDoNothing();
  return org.id;
}
