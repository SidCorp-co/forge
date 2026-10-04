import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { oauthAccounts } from '../db/schema.js';

/** Whether the user has an account linked at this OAuth provider. */
export async function hasOauthLink(userId: string, provider: string): Promise<boolean> {
  const [linked] = await db
    .select({ id: oauthAccounts.id })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)))
    .limit(1);
  return linked !== undefined;
}
