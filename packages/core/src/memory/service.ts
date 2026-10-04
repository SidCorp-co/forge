import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memories } from '../db/schema.js';

/** One memory, deleted by id. */
export async function deleteMemoryById(id: string): Promise<void> {
  await db.delete(memories).where(eq(memories.id, id));
}
