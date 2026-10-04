import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { agents } from '../db/schema.js';

/** A project's agent, created; answers its id. */
export async function insertAgent(tx: Tx, values: typeof agents.$inferInsert): Promise<string> {
  const [row] = await tx.insert(agents).values(values).returning({ id: agents.id });
  if (!row) throw new Error('agents: insert returned no row');
  return row.id;
}

/** An agent takes these values; answers its id. */
export async function updateAgent(
  tx: Tx,
  agentId: string,
  values: Partial<typeof agents.$inferInsert>,
): Promise<string> {
  const [row] = await tx
    .update(agents)
    .set(values)
    .where(eq(agents.id, agentId))
    .returning({ id: agents.id });
  if (!row) throw new Error(`agents: agent ${agentId} vanished under its update`);
  return row.id;
}

/** A project's agent, created; answers the whole row. */
export async function createAgent(
  values: typeof agents.$inferInsert,
): Promise<typeof agents.$inferSelect> {
  const [inserted] = await db.insert(agents).values(values).returning();
  if (!inserted) throw new Error('agents: insert returned no row');
  return inserted;
}

/** An agent takes these values; answers the whole row, or null when it is gone. */
export async function patchAgent(
  agentId: string,
  values: Partial<typeof agents.$inferInsert>,
): Promise<typeof agents.$inferSelect | null> {
  const [updated] = await db.update(agents).set(values).where(eq(agents.id, agentId)).returning();
  return updated ?? null;
}

/** An agent, deleted. */
export async function deleteAgent(agentId: string): Promise<void> {
  await db.delete(agents).where(eq(agents.id, agentId));
}
