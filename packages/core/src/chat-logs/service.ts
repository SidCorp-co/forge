import { db, type Tx } from '../db/client.js';
import { chatLogs } from '../db/schema.js';

/** One assistant turn's audit line. */
export async function insertChatLog(
  values: typeof chatLogs.$inferInsert,
  dbi: Pick<Tx, 'insert'> = db,
): Promise<void> {
  await dbi.insert(chatLogs).values(values);
}
