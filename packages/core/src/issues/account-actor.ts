import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { TransitionActor } from './actor-agency.js';

/**
 * The actor for a write made on an account's behalf with no credential in hand (a resume an answer
 * set off, a release step a run carries on): that account, with its own `users.kind`.
 */
export async function accountActor(userId: string): Promise<TransitionActor> {
  const [row] = await db
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) {
    throw new Error(
      `user ${userId} is not an account, so a write attributed to it cannot record whether a person or an agent acted`,
    );
  }
  return { type: 'user', id: userId, agency: row.kind };
}
