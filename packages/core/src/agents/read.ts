import { and, asc, count, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents } from '../db/schema.js';

export type AgentRow = typeof agents.$inferSelect;

/** A project's agents, oldest first, with the filtered total. */
export async function listAgents(
  projectId: string,
  filters: { type?: string | undefined; enabled?: boolean | undefined },
): Promise<{ rows: AgentRow[]; total: number }> {
  const conditions = [eq(agents.projectId, projectId)];
  if (filters.type) conditions.push(eq(agents.type, filters.type));
  if (filters.enabled !== undefined) conditions.push(eq(agents.enabled, filters.enabled));
  const where = and(...conditions);
  const [totalRow] = await db.select({ n: count() }).from(agents).where(where);
  const rows = await db.select().from(agents).where(where).orderBy(asc(agents.createdAt));
  return { rows, total: totalRow?.n ?? 0 };
}

/** One agent by id, or null. */
export async function agentById(id: string): Promise<AgentRow | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return row ?? null;
}
