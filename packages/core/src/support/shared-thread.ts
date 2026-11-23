// Where a project posts in a shared operations room another project binds (ISS-1242, ISS-1439): its
// own recorded thread, or a thread it has standing in; any other is refused by name.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportMasterAsks } from '../db/schema-support-asks.js';
import { findBindingWithConnectionById } from '../integrations/index.js';
import type { RocketChatBindingConfig } from '../integrations/rocketchat/index.js';
import { no, type Outcome } from './outcome.js';
import { type RoomRow, threadMembers } from './store.js';
import { topLevelThreadOf } from './thread.js';

/**
 * Whether `projectId` has standing in `thread` of a shared operations room (ISS-1439): a master-ask
 * of this project came from it, or a member wrote in it and no project's own thread recorded on the
 * room's binding is it. A recorded thread is its project's alone (ISS-1242), so the others' stay theirs.
 */
export async function standingIn(
  projectId: string,
  room: RoomRow,
  thread: string,
): Promise<boolean> {
  const [ask] = await db
    .select({ id: supportMasterAsks.id })
    .from(supportMasterAsks)
    .where(
      and(
        eq(supportMasterAsks.roomId, room.id),
        eq(supportMasterAsks.thread, thread),
        eq(supportMasterAsks.projectId, projectId),
      ),
    )
    .limit(1);
  if (ask) return true;
  if ((await threadMembers(room.id, thread)).length === 0) return false;
  const pair = await findBindingWithConnectionById(room.bindingId);
  const config = pair?.binding.config as RocketChatBindingConfig | null;
  const recorded = Object.values(config?.operations?.threads?.[room.rid] ?? {});
  return !recorded.includes(thread);
}

/**
 * Why a shared operations room another project binds takes no post in `thread`: a project posts
 * there only in its own recorded thread (ISS-1242) or one it has standing in (`standingIn`), so the
 * others' threads stay theirs.
 */
export async function sharedThreadRefusal(
  projectId: string,
  room: RoomRow,
  thread: string,
): Promise<Outcome<never>> {
  const own = await topLevelThreadOf(room, projectId, true);
  if (!own.ok) {
    return no(
      'SUPPORT_THREAD_UNKNOWN',
      '/thread',
      `${room.rid} is an operations room every project of the organization shares, one thread per project: its binding records no thread for this project, and no member wrote in thread ${thread} nor did a master-ask of this project come from it, so this project has no standing there. Name a thread one of those holds as \`thread\`, or a project admin records this project's own as \`document.target.operations.threads["${room.rid}"]["<project slug>"]\` on binding ${room.bindingId}. Nothing was posted.`,
    );
  }
  return no(
    'SUPPORT_THREAD_UNKNOWN',
    '/thread',
    `${room.rid} is an operations room every project of the organization shares, one thread per project, and this project's own there is ${own.value}, not ${thread}: name it as \`thread\`, name none, or name a thread a member wrote in or a master-ask of this project came from. Nothing was posted.`,
  );
}
