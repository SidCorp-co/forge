import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';

/** Every personal access token a user holds, revoked ones included, newest first. */
export async function listPatsOf(userId: string) {
  return db
    .select()
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.userId, userId))
    .orderBy(desc(personalAccessTokens.createdAt));
}

/** Whether the user holds a live token with this name. */
export async function hasLivePatNamed(userId: string, name: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: personalAccessTokens.id })
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.userId, userId),
        eq(personalAccessTokens.name, name),
        isNull(personalAccessTokens.revokedAt),
      ),
    )
    .limit(1);
  return existing !== undefined;
}
