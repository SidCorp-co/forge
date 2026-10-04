import { eq } from 'drizzle-orm';
import { assertNotAgent } from '../credentials/agent-account.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';

export async function assertNotAgentUser(userId: string): Promise<void> {
  const [row] = await db
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  assertNotAgent(row?.kind, userId);
}
