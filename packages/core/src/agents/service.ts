import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
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
