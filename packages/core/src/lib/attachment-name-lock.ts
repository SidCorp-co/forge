import type { db } from '../db/client.js';
import { lockXact } from './advisory-lock.js';

export type NameCheckExecutor = Pick<typeof db, 'select'>;

type NameLockTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type NameLockScope = 'issue' | 'comment';

export async function lockAttachmentName(
  tx: NameLockTx,
  scope: NameLockScope,
  parentId: string,
  name: string,
): Promise<void> {
  await lockXact(tx, 'attachmentName', `${scope}:${parentId}:${name}`);
}
