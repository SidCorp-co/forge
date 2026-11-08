// A message sent straight to a room's session, not written in any room (ISS-950). It ran as a web
// chat turn under a token minted for the sender, which no room act admits, so the session had none
// of its room's grants and told the owner so in prose. It now runs as its room's turn: the room's
// token, tools and grants, briefed like any turn. Its identity is the sender's: an act that runs as
// the person asking names the direct message, and runs as the sender under their own permissions,
// only in the turn whose token the direct message was handed with. Only a holder of project.admin
// sends one; anyone else is refused by name before anything runs.

import { randomUUID } from 'node:crypto';
import {
  mergeSessionMetadata,
  noClaudeClient,
  type RoomDirectTurn,
  turnCredentialChatDevice,
} from '../agent-sessions/index.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { userNames } from '../lib/people.js';
import { holds } from '../permissions/index.js';
import { DIRECT_THREAD, DIRECT_TURN_KEY, type DirectTurnRecord } from './direct-asker.js';
import { handTurn } from './dispatch.js';
import { refuse } from './refusals.js';
import { SUPPORT_SESSION_MARKER } from './rooms.js';
import { type RoomRow, roomById } from './store.js';

/** Run a direct message to a room's session as its room's turn, as the sender; refused by name otherwise. */
export async function sendDirectTurn(turn: RoomDirectTurn): Promise<void> {
  const { session, senderId } = turn;
  if (turn.attachmentIds.length > 0 || turn.deviceId) {
    throw refuse(
      'SUPPORT_DIRECT_TURN_SHAPE',
      `a room's session takes a direct message as its room's turn, on the box its room is served by and as text: ${turn.deviceId ? 'a picked box' : 'attached files'} cannot go with it. Send the text alone; nothing ran`,
      turn.deviceId ? '/deviceId' : '/attachmentIds',
    );
  }
  const facts = await effectiveProjectRole(senderId, session.projectId);
  if (!facts || !holds(facts, 'project.admin')) {
    throw refuse(
      'SUPPORT_DIRECT_TURN_NEEDS_ADMIN',
      `a direct message to a room's session runs with the room's grants, so only the project's owner or an admin sends one, and you hold ${facts?.role ? `the ${facts.role} role` : 'no role'} here. Ask in the room instead; nothing ran`,
    );
  }
  const room = await roomOfSession(session);
  if (!room) {
    throw refuse(
      'SUPPORT_ROOM_UNKNOWN',
      `session ${session.id} is marked a room's session, and no room holds it now; nothing ran`,
    );
  }
  const client = await turnCredentialChatDevice(session);
  if (!client.deviceId) throw noClaudeClient('session');
  const label = (await userNames([senderId])).get(senderId) ?? senderId;
  const id = randomUUID();
  await handTurn(
    room,
    session,
    { ...client, deviceId: client.deviceId },
    { direct: directTurnText({ id, label, role: facts.role ?? 'admin', message: turn.message }) },
    async (tokenId) => {
      const record: DirectTurnRecord = { id, userId: senderId, label, tokenId };
      await mergeSessionMetadata(session.id, { [DIRECT_TURN_KEY]: record });
    },
  );
}

/** The room the session answers, as its marker names it. */
async function roomOfSession(session: RoomDirectTurn['session']): Promise<RoomRow | null> {
  const marker = (session.metadata as Record<string, unknown> | null)?.[SUPPORT_SESSION_MARKER] as
    | { roomId?: unknown }
    | undefined;
  if (typeof marker?.roomId !== 'string') return null;
  const room = await roomById(marker.roomId);
  return room?.sessionId === session.id ? room : null;
}

/** What the session reads for a direct message: who sent it, how it answers, and whom it acts as. */
export function directTurnText(args: {
  id: string;
  label: string;
  role: string;
  message: string;
}): string {
  return [
    `A direct message from ${args.label}, this project's ${args.role}, sent to you here and not in any room. Answer it in this turn's own words: they are read on your session's page, and nothing is posted in a room for it unless ${args.label} asks for a post there. Your tools and grants are your room's. An act that runs as the person asking names thread \`${DIRECT_THREAD}\` and message \`${args.id}\`, and runs as ${args.label}, under their own permissions.`,
    `${args.label} wrote:`,
    args.message,
  ].join('\n\n');
}
