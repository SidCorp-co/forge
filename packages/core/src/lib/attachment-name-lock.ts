import { sql } from 'drizzle-orm';
import type { db } from '../db/client.js';

export type NameCheckExecutor = Pick<typeof db, 'select'>;

export type NameLockTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type NameLockScope = 'issue' | 'comment';

export async function lockAttachmentName(
  tx: NameLockTx,
  scope: NameLockScope,
  parentId: string,
  name: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope}:${parentId}:${name}`}, 0))`,
  );
}
