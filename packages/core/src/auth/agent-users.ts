import { eq } from 'drizzle-orm';
import { agentAccountRow } from '../credentials/agent-account.js';
import { db, type Tx } from '../db/client.js';
import { users } from '../db/schema.js';

/** The one insert of an agent account, inside the caller's transaction. */
export async function insertAgentAccount(
  tx: Tx,
  handle: string,
  id?: string,
): Promise<{ id: string; email: string; createdAt: Date }> {
  const [row] = await tx
    .insert(users)
    .values(agentAccountRow(handle, id))
    .returning({ id: users.id, email: users.email, createdAt: users.createdAt });
  if (!row) throw new Error('agent account: user insert returned no row');
  return row;
}

/** The label an agent is read by; `null` clears it. Undefined when the account is gone. */
export async function setUserDisplayName(
  userId: string,
  displayName: string | null,
): Promise<string | null | undefined> {
  const [row] = await db
    .update(users)
    .set({ displayName })
    .where(eq(users.id, userId))
    .returning({ displayName: users.displayName });
  return row ? row.displayName : undefined;
}
