import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memories } from '../db/schema.js';

/** The project a memory belongs to; null when absent. */
export async function memoryProject(id: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: memories.projectId })
    .from(memories)
    .where(eq(memories.id, id))
    .limit(1);
  return row?.projectId ?? null;
}
