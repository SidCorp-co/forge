import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { assertNotAgent } from './agent-account.js';

async function kindOf(userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.kind;
}

export async function assertNotAgentUser(userId: string): Promise<void> {
  assertNotAgent(await kindOf(userId), userId);
}

/** Whether the account is an agent's, which holds no session (ISS-1421 r14). */
export async function isAgentUser(userId: string): Promise<boolean> {
  return (await kindOf(userId)) === 'agent';
}
