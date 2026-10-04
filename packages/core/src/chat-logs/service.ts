import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { chatLogs } from '../db/schema.js';

/** One assistant turn's audit line. */
export async function insertChatLog(
  values: typeof chatLogs.$inferInsert,
  dbi: Pick<Tx, 'insert'> = db,
): Promise<void> {
  await dbi.insert(chatLogs).values(values);
}

/** A chat log's QA rating and notes, set; answers the row, or null when it is gone. */
export async function rateChatLog(
  id: string,
  values: Pick<Partial<typeof chatLogs.$inferInsert>, 'qaRating' | 'qaNotes'>,
): Promise<typeof chatLogs.$inferSelect | null> {
  const [updated] = await db.update(chatLogs).set(values).where(eq(chatLogs.id, id)).returning();
  return updated ?? null;
}
