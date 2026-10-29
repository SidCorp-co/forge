// Whether a bound room is answering, and if not, why (REQ-75 r5 BC-26). Each cause is one somebody
// can act on, named with what to do: the binding is off, or no longer names the group; the chat server refuses the bot or does not
// answer; the bot is not a member of the group; no core process listens for the bot's messages; no
// online box of the project can run the session, or it lacks what the room's grant needs; the
// session is not resident on its box. A room nobody can reach reads unhealthy, never silently fine.

import {
  SUPPORT_BOX_CAPABILITIES,
  type SupportHealthCause,
  type SupportRoomHealth,
} from '@forge/contracts/support';
import { boxLacks, sessionRowById, turnCredentialChatDevice } from '../agent-sessions/index.js';
import { findBindingWithConnectionById } from '../integrations/index.js';
import {
  type BotMembership,
  connectionListening,
  fetchBotMembership,
} from '../integrations/rocketchat/index.js';
import { grantsOf, supportConfigOf } from './grants.js';
import { bindingNamesRoom } from './rooms.js';
import type { RoomRow } from './store.js';
import { roomAuth } from './thread.js';

/** How long a room's chat-server read is reused: the room list refetches every 30 s. */
const MEMBERSHIP_TTL_MS = 30_000;
const memberships = new Map<string, { at: number; read: BotMembership }>();

/** Drop every cached chat-server read, so the next health read asks the server again. */
export function forgetMemberships(): void {
  memberships.clear();
}

async function membershipOf(room: RoomRow): Promise<BotMembership> {
  const cached = memberships.get(room.id);
  if (cached && Date.now() - cached.at < MEMBERSHIP_TTL_MS) return cached.read;
  const read = await roomAuth(room)
    .then(({ auth }) => fetchBotMembership(auth, room.rid))
    .catch(
      (err): BotMembership => ({
        state: 'unreachable',
        why: `the bot's connection could not be read (${err instanceof Error ? err.message : String(err)})`,
      }),
    );
  memberships.set(room.id, { at: Date.now(), read });
  return read;
}

/** The capabilities the room's box must declare for its turns to run as its grant says. */
async function capabilitiesNeeded(room: RoomRow): Promise<string[]> {
  if (room.kind === 'operations') return ['confinedChatNetwork'];
  const grants = grantsOf(await supportConfigOf(room));
  // a channel agent in owner mode runs confined in its own clone of the repository (ISS-765)
  const need = ['confinedChatNetwork', SUPPORT_BOX_CAPABILITIES.checkout];
  if (room.kind === 'agent' && grants.abilities.includes('owner_mode')) {
    need.push(SUPPORT_BOX_CAPABILITIES.owner);
  }
  if (grants.abilities.includes('build')) need.push(SUPPORT_BOX_CAPABILITIES.build);
  if (grants.abilities.includes('run_commands')) need.push(SUPPORT_BOX_CAPABILITIES.commands);
  return need;
}

/** The room's health and, where the bot can read it, the group's name. */
export async function roomHealth(
  room: RoomRow,
): Promise<{ health: SupportRoomHealth; name: string | null }> {
  const causes: { code: SupportHealthCause; detail: string }[] = [];
  const add = (code: SupportHealthCause, detail: string) => causes.push({ code, detail });

  const pair = await findBindingWithConnectionById(room.bindingId);
  if (!pair?.binding.active || !pair.connection.active) {
    add(
      'BINDING_OFF',
      "this room's Rocket.Chat binding or its bot connection is switched off, so nothing listens for it; switch it on in Project settings → Integrations → Rocket.Chat",
    );
  } else if (!bindingNamesRoom(pair.binding.config, room.rid)) {
    add(
      'ROOM_LEFT_BINDING',
      `binding ${room.bindingId} no longer names group ${room.rid}, so nothing answers this room; its record stays here. Bind the group again to have it answered`,
    );
  }

  const membership = await membershipOf(room);
  let name: string | null = null;
  if (membership.state === 'member') name = membership.name;
  else if (membership.state === 'not-member') {
    add(
      'BOT_NOT_IN_ROOM',
      `the bot is not a member of group ${room.rid}, so it receives none of its messages; add the bot to the group in Rocket.Chat`,
    );
  } else if (membership.state === 'rejected') {
    add(
      'BOT_REJECTED',
      `the chat server refused the bot's credential (${membership.status}); rotate the bot token on its Rocket.Chat connection`,
    );
  } else {
    add(
      'CHAT_UNREACHABLE',
      `${membership.why}; nothing in the group reaches Forge until it answers`,
    );
  }

  const listening = await connectionListening(room.connectionId);
  if (listening === 'nowhere' || listening === 'reconnecting') {
    add(
      'NOT_LISTENING',
      listening === 'nowhere'
        ? "no core process holds the bot's live connection, so the group's messages are not heard; core picks it up within a reload — if it stays so, read core's rocketchat log"
        : "this core holds the bot's connection and its socket is reconnecting; messages sent now are not heard until it is live",
    );
  }

  const session = room.sessionId ? await sessionRowById(room.sessionId) : null;
  if (!session) {
    add(
      'SESSION_NOT_LISTENING',
      'the room has no session yet; it is declared on the next message or warm-up',
    );
    return { health: done(causes), name };
  }
  const client = await turnCredentialChatDevice(session);
  if (!client.deviceId) {
    add(
      'NO_BOX',
      "no online runner box of this project can run the room's session; bring the project's runner online",
    );
    return { health: done(causes), name };
  }
  const box = await boxLacks(client.deviceId, await capabilitiesNeeded(room));
  if (box && box.lacks.length > 0) {
    add(
      'BOX_TOO_OLD',
      `the box ${box.name} does not declare ${box.lacks.join(', ')}, which this room's grant needs; update its forge-runner`,
    );
  }
  const resident =
    session.status === 'running' ||
    (session.runtimeState === 'awaiting_input' && session.deviceId === client.deviceId);
  if (!resident) {
    add(
      'SESSION_NOT_LISTENING',
      `the session is not resident on its box (it is ${session.status}${session.failureReason ? `: ${session.failureReason}` : ''}); the warm-up sweep restarts it within a minute`,
    );
  }
  return { health: done(causes), name };
}

const done = (causes: SupportRoomHealth['causes']): SupportRoomHealth => ({
  healthy: causes.length === 0,
  causes,
  checkedAt: new Date().toISOString(),
});
