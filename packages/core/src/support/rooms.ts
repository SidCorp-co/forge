// A support group's declaration (REQ-75 BC-10): one room row per `rocketchat` binding that carries
// `support`, the agent account its session acts as, and the one `chat` session that answers it.
// Declared when the binding changes (`integration.changed`) and again on the room's first message,
// so a room is never answered without one.

import type { SupportRoomConfig } from '@forge/contracts/support';
import { createChatSessionRow } from '../agent-sessions/index.js';
import { insertAgentAccount, setUserDisplayName } from '../auth/index.js';
import { db } from '../db/client.js';
import { listActiveBindingsForProjectProvider } from '../integrations/index.js';
import type { RocketChatBindingConfig } from '../integrations/rocketchat/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { logger } from '../lib/logger.js';
import { insertRoom, type RoomRow, roomOfBinding, setRoomSession } from './store.js';

/** The metadata key a support session carries; its end hands the room's waiting messages on. */
export const SUPPORT_SESSION_MARKER = 'supportRoom';

export interface SupportBinding {
  projectId: string;
  bindingId: string;
  connectionId: string;
  rid: string;
  support: SupportRoomConfig;
}

/**
 * The room for a support binding, with its session: found, or declared now. Two callers declaring
 * the same binding at once declare one room.
 */
export async function ensureSupportRoom(binding: SupportBinding): Promise<RoomRow> {
  let room = await roomOfBinding(binding.bindingId);
  let minted: string | null = null;
  if (!room) {
    room = await db.transaction(async (tx) => {
      await lockXact(tx, 'supportRoom', binding.bindingId);
      const raced = await roomOfBinding(binding.bindingId, tx);
      if (raced) return raced;
      const account = await insertAgentAccount(tx, `support-${binding.bindingId.slice(0, 8)}`);
      minted = account.id;
      return insertRoom(tx, {
        projectId: binding.projectId,
        bindingId: binding.bindingId,
        connectionId: binding.connectionId,
        rid: binding.rid,
        principalUserId: account.id,
      });
    });
  }
  if (minted) await setUserDisplayName(minted, 'Support assistant (Rocket.Chat)');
  if (room.sessionId) return room;
  return withSession(room);
}

/** Give a room whose session is missing (never made, or deleted) a new one. */
async function withSession(room: RoomRow): Promise<RoomRow> {
  const session = await createChatSessionRow({
    projectId: room.projectId,
    userId: room.principalUserId,
    title: 'Support group (Rocket.Chat)',
    runKind: 'system',
    runMetadata: { source: 'support-room', roomId: room.id },
    metadata: { [SUPPORT_SESSION_MARKER]: { roomId: room.id } },
  });
  const set = await db.transaction(async (tx) => {
    await lockXact(tx, 'supportRoom', room.bindingId);
    const fresh = await roomOfBinding(room.bindingId, tx);
    if (fresh?.sessionId) return { room: fresh, used: false };
    await setRoomSession(tx, room.id, session.id);
    return { room: { ...room, sessionId: session.id }, used: true };
  });
  if (!set.used) {
    logger.info(
      { roomId: room.id, sessionId: session.id },
      'support: another declaration gave the room its session first; this one stays idle',
    );
  }
  return set.room;
}

/** Every support binding of a project, declared. A binding naming more than one room is refused at write. */
export async function declareSupportRooms(projectId: string): Promise<RoomRow[]> {
  const pairs = await listActiveBindingsForProjectProvider(projectId, 'rocketchat');
  const rooms: RoomRow[] = [];
  for (const { binding } of pairs) {
    const config = binding.config as RocketChatBindingConfig | null;
    const rid = config?.rids?.[0];
    if (!config?.support || !rid) continue;
    if ((config.rids?.length ?? 0) !== 1) {
      logger.error(
        { bindingId: binding.id, projectId },
        'support: a support binding names more than one room; refused, not declared',
      );
      continue;
    }
    rooms.push(
      await ensureSupportRoom({
        projectId,
        bindingId: binding.id,
        connectionId: binding.connectionId,
        rid,
        support: config.support,
      }),
    );
  }
  return rooms;
}
