/**
 * The agent refusal for a login entrance that holds only a user id (ISS-932).
 *
 * Split from `agent-account.ts` so that module stays free of the database: it
 * is the pure half — the address shape and the refusal itself — and is imported
 * by callers that have the row already.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { assertNotAgent } from './agent-account.js';

export async function assertNotAgentUser(userId: string): Promise<void> {
  const [row] = await db
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  assertNotAgent(row?.kind, userId);
}
