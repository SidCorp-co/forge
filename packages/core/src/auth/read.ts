import { and, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { oauthAccounts, users } from '../db/schema.js';

/** The whole user row for a sign-in address, or undefined. */
export async function userByEmail(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return user;
}

/** A user's id and local password hash, or undefined when the account is gone. */
export async function passwordHashOf(userId: string) {
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user;
}
/** The signed-in user's own profile and linked OAuth providers, or null when the account is gone. */
export async function profileOf(userId: string) {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
      lastFreshAuthAt: users.lastFreshAuthAt,
      // Selected only to derive `hasPassword` — the hash itself is never serialized.
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;

  const oauthRows = await db
    .select({ provider: oauthAccounts.provider })
    .from(oauthAccounts)
    .where(eq(oauthAccounts.userId, userId));
  return { row, oauthProviders: Array.from(new Set(oauthRows.map((r) => r.provider))) };
}

/** Whether the user has an account linked at this OAuth provider. */
export async function hasOauthLink(userId: string, provider: string): Promise<boolean> {
  const [linked] = await db
    .select({ id: oauthAccounts.id })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)))
    .limit(1);
  return linked !== undefined;
}

/** Which of these accounts are agent accounts. */
export async function agentAccountsAmong(
  userIds: readonly string[],
  executor: Tx = db,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...new Set(userIds)]), eq(users.kind, 'agent')));
  return new Set(rows.map((r) => r.id));
}
