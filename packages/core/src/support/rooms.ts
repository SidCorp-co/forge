// A room's declaration (REQ-75 BC-10, BC-20): one room row per `rocketchat` binding that carries
// `support`, and one per room of a binding that carries `operations`, each with the agent account its
// session acts as and the one `chat` session that answers it. Declared when the binding changes
// (`integration.changed`) and again on the room's first message, so a room is never answered without
// one.

import type { SupportRoomConfig } from '@forge/contracts/support';
import type { OperationsScope } from '@forge/contracts/support-operations';
import { createChatSessionRow } from '../agent-sessions/index.js';
import { insertAgentAccount, setUserDisplayName } from '../auth/index.js';
import { db } from '../db/client.js';
import {
  findBindingWithConnectionById,
  listActiveBindingsForProjectProvider,
} from '../integrations/index.js';
import type { RocketChatBindingConfig } from '../integrations/rocketchat/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { logger } from '../lib/logger.js';
import { insertRoom, type RoomRow, roomOfBinding, setRoomSession } from './store.js';

/**
 * Whether the room is still one its binding answers: the binding and its connection are on, and the
 * binding still names the room's group. A room whose group was taken out of its binding keeps its row
 * and its record, and is neither warmed nor read as healthy.
 */
export async function roomIsBound(room: Pick<RoomRow, 'bindingId' | 'rid'>): Promise<boolean> {
  const pair = await findBindingWithConnectionById(room.bindingId);
  if (!pair?.binding.active || !pair.connection.active) return false;
  return bindingNamesRoom(pair.binding.config, room.rid);
}

/** Whether a rocketchat binding's config names the group `rid`. */
export function bindingNamesRoom(config: unknown, rid: string): boolean {
  return ((config as RocketChatBindingConfig | null)?.rids ?? []).includes(rid);
}

/** The metadata key a support session carries; its end hands the room's waiting messages on. */
export const SUPPORT_SESSION_MARKER = 'supportRoom';

export interface SupportBinding {
  projectId: string;
  bindingId: string;
  connectionId: string;
  rid: string;
  /** A support group's block, or an operations room's scope: exactly one. */
  room:
    | { kind: 'support'; support: SupportRoomConfig }
    | { kind: 'operations'; scope: OperationsScope };
}

/**
 * The room a binding attaches at `rid`, with its session: found, or declared now. Two callers
 * declaring the same room at once declare one.
 */
export async function ensureSupportRoom(binding: SupportBinding): Promise<RoomRow> {
  let room = await roomOfBinding(binding.bindingId, binding.rid);
  let minted: string | null = null;
  if (!room) {
    room = await db.transaction(async (tx) => {
      await lockXact(tx, 'supportRoom', `${binding.bindingId}:${binding.rid}`);
      const raced = await roomOfBinding(binding.bindingId, binding.rid, tx);
      if (raced) return raced;
      const account = await insertAgentAccount(tx, `support-${binding.bindingId.slice(0, 8)}`);
      minted = account.id;
      return insertRoom(tx, {
        projectId: binding.projectId,
        bindingId: binding.bindingId,
        connectionId: binding.connectionId,
        rid: binding.rid,
        kind: binding.room.kind,
        scope: binding.room.kind === 'operations' ? binding.room.scope : null,
        principalUserId: account.id,
      });
    });
  }
  if (minted) {
    await setUserDisplayName(
      minted,
      binding.room.kind === 'operations'
        ? 'Operations assistant (Rocket.Chat)'
        : 'Support assistant (Rocket.Chat)',
    );
  }
  if (room.sessionId) return room;
  return withSession(room);
}

/** Give a room whose session is missing (never made, or deleted) a new one. */
async function withSession(room: RoomRow): Promise<RoomRow> {
  const session = await createChatSessionRow({
    projectId: room.projectId,
    userId: room.principalUserId,
    title:
      room.kind === 'operations' ? 'Operations room (Rocket.Chat)' : 'Support group (Rocket.Chat)',
    runKind: 'system',
    runMetadata: { source: 'support-room', roomId: room.id },
    metadata: { [SUPPORT_SESSION_MARKER]: { roomId: room.id } },
  });
  const set = await db.transaction(async (tx) => {
    await lockXact(tx, 'supportRoom', `${room.bindingId}:${room.rid}`);
    const fresh = await roomOfBinding(room.bindingId, room.rid, tx);
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

/**
 * Every support and operations binding of a project, declared: a support binding's one group, and
 * each room an operations binding names. A support binding naming more than one room is refused at
 * write.
 */
export async function declareSupportRooms(projectId: string): Promise<RoomRow[]> {
  const pairs = await listActiveBindingsForProjectProvider(projectId, 'rocketchat');
  const rooms: RoomRow[] = [];
  for (const { binding } of pairs) {
    const config = binding.config as RocketChatBindingConfig | null;
    if (config?.operations) {
      for (const rid of config.rids ?? []) {
        rooms.push(
          await ensureSupportRoom({
            projectId,
            bindingId: binding.id,
            connectionId: binding.connectionId,
            rid,
            room: { kind: 'operations', scope: config.operations.scope },
          }),
        );
      }
      continue;
    }
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
        room: { kind: 'support', support: config.support },
      }),
    );
  }
  return rooms;
}
