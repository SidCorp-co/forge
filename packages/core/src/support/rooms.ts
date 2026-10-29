// A room's declaration (REQ-75 BC-10, BC-20; REQ-77 BC-1): one room row per `rocketchat` binding
// that carries `support`, and one per room of a binding that carries `operations`, each with the agent
// account its session acts as and the one `chat` session that answers it. A binding that carries
// `agent` declares a row per room too, and every one of them shares ONE account and ONE session: the
// project's channel agent. Declared when the binding changes (`integration.changed`) and again on the
// room's first message, so a room is never answered without one.

import type { SupportRoomConfig } from '@forge/contracts/support';
import type { OperationsScope } from '@forge/contracts/support-operations';
import {
  closeResidentOnBox,
  createChatSessionRow,
  sessionRowById,
} from '../agent-sessions/index.js';
import { insertAgentAccount, setUserDisplayName } from '../auth/index.js';
import { db } from '../db/client.js';
import {
  findBindingWithConnectionById,
  listActiveBindingsForProjectProvider,
} from '../integrations/index.js';
import type { RocketChatBindingConfig } from '../integrations/rocketchat/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { logger } from '../lib/logger.js';
import {
  agentRoomsOfBinding,
  insertRoom,
  type RoomRow,
  roomOfBinding,
  setRoomSession,
  setRoomsSession,
} from './store.js';

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

/**
 * The metadata key a channel agent's session carries beside the support marker (REQ-77): the binding
 * whose rooms it serves, and whether it was placed in owner mode. Fixed when the session is made; a
 * grant that changes owner mode replaces the session (`replaceStaleAgentSession`).
 */
export const CHANNEL_AGENT_MARKER = 'channelAgent';
export interface ChannelAgentMarker {
  bindingId: string;
  ownerMode: boolean;
}

/** The channel agent marker a session carries, or null for any other session. */
export function agentMarkerOf(metadata: unknown): ChannelAgentMarker | null {
  const m = (metadata as Record<string, unknown> | null)?.[CHANNEL_AGENT_MARKER] as
    | { bindingId?: unknown; ownerMode?: unknown }
    | undefined;
  if (typeof m?.bindingId !== 'string') return null;
  return { bindingId: m.bindingId, ownerMode: m.ownerMode === true };
}

/** Whether a channel agent's grant puts it in owner mode (REQ-77 BC-20). */
export const grantsOwnerMode = (agent: SupportRoomConfig | null | undefined): boolean =>
  Boolean(agent?.grants?.abilities.includes('owner_mode'));

export interface SupportBinding {
  projectId: string;
  bindingId: string;
  connectionId: string;
  rid: string;
  /** A support group's block, or an operations room's scope: exactly one. */
  room:
    | { kind: 'support'; support: SupportRoomConfig }
    | { kind: 'operations'; scope: OperationsScope }
    | { kind: 'agent'; agent: SupportRoomConfig };
}

const ROOM_NAMES = {
  support: { account: 'Support assistant (Rocket.Chat)', session: 'Support group (Rocket.Chat)' },
  operations: {
    account: 'Operations assistant (Rocket.Chat)',
    session: 'Operations room (Rocket.Chat)',
  },
  agent: { account: 'Channel agent (Rocket.Chat)', session: 'Channel agent (Rocket.Chat)' },
} as const;

/** The lock a room's declaration takes: a channel agent's rooms take one per binding, as they share. */
const lockKey = (bindingId: string, rid: string, kind: RoomRow['kind']) =>
  kind === 'agent' ? `${bindingId}:agent` : `${bindingId}:${rid}`;

/**
 * The room a binding attaches at `rid`, with its session: found, or declared now. Two callers
 * declaring the same room at once declare one.
 */
export async function ensureSupportRoom(binding: SupportBinding): Promise<RoomRow> {
  let room = await roomOfBinding(binding.bindingId, binding.rid);
  let minted: string | null = null;
  if (!room) {
    const kind = binding.room.kind;
    room = await db.transaction(async (tx) => {
      await lockXact(tx, 'supportRoom', lockKey(binding.bindingId, binding.rid, kind));
      const raced = await roomOfBinding(binding.bindingId, binding.rid, tx);
      if (raced) return raced;
      // a channel agent's rooms share its account and its session: a new group joins them
      const sibling =
        kind === 'agent' ? (await agentRoomsOfBinding(binding.bindingId, tx))[0] : undefined;
      const principalUserId =
        sibling?.principalUserId ??
        (await insertAgentAccount(tx, `support-${binding.bindingId.slice(0, 8)}`)).id;
      if (!sibling) minted = principalUserId;
      return insertRoom(tx, {
        projectId: binding.projectId,
        bindingId: binding.bindingId,
        connectionId: binding.connectionId,
        rid: binding.rid,
        kind,
        scope: binding.room.kind === 'operations' ? binding.room.scope : null,
        principalUserId,
        sessionId: sibling?.sessionId ?? null,
      });
    });
  }
  if (minted) await setUserDisplayName(minted, ROOM_NAMES[room.kind].account);
  if (room.sessionId) return room;
  return withSession(room, binding);
}

/**
 * Give a room whose session is missing (never made, or deleted) a new one. A channel agent's rooms
 * are given one together: the session is set on every room of the binding that has none.
 */
async function withSession(room: RoomRow, binding?: SupportBinding): Promise<RoomRow> {
  const agent =
    room.kind === 'agent'
      ? {
          [CHANNEL_AGENT_MARKER]: {
            bindingId: room.bindingId,
            ownerMode: grantsOwnerMode(
              binding?.room.kind === 'agent' ? binding.room.agent : await agentConfigOf(room),
            ),
          } satisfies ChannelAgentMarker,
        }
      : {};
  const session = await createChatSessionRow({
    projectId: room.projectId,
    userId: room.principalUserId,
    title: ROOM_NAMES[room.kind].session,
    runKind: 'system',
    runMetadata: { source: 'support-room', roomId: room.id },
    metadata: { [SUPPORT_SESSION_MARKER]: { roomId: room.id }, ...agent },
  });
  const set = await db.transaction(async (tx) => {
    await lockXact(tx, 'supportRoom', lockKey(room.bindingId, room.rid, room.kind));
    const fresh = await roomOfBinding(room.bindingId, room.rid, tx);
    if (fresh?.sessionId) return { room: fresh, used: false };
    if (room.kind === 'agent') await setRoomsSession(tx, room.bindingId, session.id);
    else await setRoomSession(tx, room.id, session.id);
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

/** A channel agent room's `agent` block as its binding holds it now; null for any other room. */
export async function agentConfigOf(
  room: Pick<RoomRow, 'kind' | 'bindingId'>,
): Promise<SupportRoomConfig | null> {
  if (room.kind !== 'agent') return null;
  const pair = await findBindingWithConnectionById(room.bindingId);
  return ((pair?.binding.config ?? null) as RocketChatBindingConfig | null)?.agent ?? null;
}

/**
 * A channel agent placed in one mode while its grant now says the other is replaced (REQ-77 BC-20):
 * a confined process is never reused as a full session, nor a full one as confined. The old session
 * is told closed on its box and its rooms let go of it, so the next declaration places a new one.
 * True when it replaced one.
 */
export async function replaceStaleAgentSession(
  bindingId: string,
  agent: SupportRoomConfig,
): Promise<boolean> {
  const [first] = await agentRoomsOfBinding(bindingId);
  if (!first?.sessionId) return false;
  const session = await sessionRowById(first.sessionId);
  const marker = session ? agentMarkerOf(session.metadata) : null;
  if (session && marker && marker.ownerMode === grantsOwnerMode(agent)) return false;
  await db.transaction(async (tx) => {
    await lockXact(tx, 'supportRoom', lockKey(bindingId, first.rid, 'agent'));
    await setRoomsSession(tx, bindingId, null);
  });
  if (session?.deviceId) {
    await closeResidentOnBox(session.id, session.deviceId).catch((err) =>
      logger.error({ err, sessionId: session.id }, 'support: closing a replaced agent failed'),
    );
  }
  logger.info(
    { bindingId, sessionId: first.sessionId, ownerMode: grantsOwnerMode(agent) },
    "support: the channel agent's owner mode changed; its session is replaced",
  );
  return true;
}

/**
 * Every support, operations and channel agent binding of a project, declared: a support binding's
 * one group, and each room an operations or agent binding names. A support binding naming more than
 * one room is refused at write.
 */
export async function declareSupportRooms(projectId: string): Promise<RoomRow[]> {
  const pairs = await listActiveBindingsForProjectProvider(projectId, 'rocketchat');
  const rooms: RoomRow[] = [];
  for (const { binding } of pairs) {
    const config = binding.config as RocketChatBindingConfig | null;
    if (config?.agent) {
      await replaceStaleAgentSession(binding.id, config.agent);
      for (const rid of config.rids ?? []) {
        rooms.push(
          await ensureSupportRoom({
            projectId,
            bindingId: binding.id,
            connectionId: binding.connectionId,
            rid,
            room: { kind: 'agent', agent: config.agent },
          }),
        );
      }
      continue;
    }
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
