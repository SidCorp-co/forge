// The project's master posts in its project's room (ISS-862): the daily review, in the master's own
// words, at the room's top level. Core writes none of the words (agent-is-the-voice): it picks the
// project's bound team room, screens the text as the team reads it, posts it and records who posted.
// A customer support group is never one: what the team reads is not posted where customers read.

import type { SupportMasterPostRequest } from '@forge/contracts/support-channel';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { no, type Outcome } from './outcome.js';
import { roomIsBound } from './rooms.js';
import { screenForThread } from './screen.js';
import { insertAction, type RoomRow, roomsOfProject } from './store.js';
import { postTopLevel, scrubbedForRoom, TOP_LEVEL } from './thread.js';

const TOOL = 'master_post';

/** The project's bound team rooms: a channel agent's group or an operations room, never a support group. */
async function teamRoomsOf(projectId: string): Promise<RoomRow[]> {
  const rooms = (await roomsOfProject(projectId)).filter((r) => r.kind !== 'support');
  const bound = await Promise.all(rooms.map(async (r) => ((await roomIsBound(r)) ? r : null)));
  return bound.filter((r): r is RoomRow => r !== null);
}

/** The room a post names, or the project's one team room, or the refusal naming what it saw. */
function roomOf(rooms: readonly RoomRow[], rid: string | undefined): Outcome<RoomRow> {
  const named = rid ? rooms.find((r) => r.rid === rid) : rooms.length === 1 ? rooms[0] : undefined;
  if (named) return { ok: true, value: named };
  const seen = rooms.map((r) => r.rid).join(', ');
  if (rid || rooms.length === 0) {
    return no(
      'SUPPORT_ROOM_UNKNOWN',
      rid ? '/rid' : '',
      rid
        ? `${rid} is no bound team room of this project${seen ? `; its rooms are ${seen}` : ''}. Nothing was posted.`
        : 'this project binds no team room (a channel agent group or an operations room), so there is nowhere to post. Nothing was posted.',
    );
  }
  return no(
    'SUPPORT_ROOM_AMBIGUOUS',
    '/rid',
    `this project binds ${rooms.length} team rooms (${seen}): name one with \`rid\`. Nothing was posted.`,
  );
}

/** Posts the master's text at the top level of its project's team room, recorded as the master's. */
export async function postAsMaster(
  actor: { userId: string; projectId: string },
  input: SupportMasterPostRequest,
): Promise<Outcome<{ rid: string; messageId: string | null }>> {
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(actor.projectId));
  const chosen = roomOf(await teamRoomsOf(actor.projectId), input.rid);
  if (!chosen.ok) return chosen;
  const room = chosen.value;
  const text = await scrubbedForRoom(room, input.text);
  const admitted = await screenForThread(room, null, TOP_LEVEL, text, 'operations-reply', TOOL);
  if (!admitted.ok) return admitted;
  const posted = await postTopLevel({
    room,
    text: admitted.value.text,
    proof: admitted.value.proof,
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted.conversationId,
    thread: posted.messageId ?? TOP_LEVEL,
    kind: 'announced',
    actorKind: 'session',
    tool: TOOL,
    input: { text, by: actor.userId },
    externalId: posted.messageId,
  });
  return { ok: true, value: { rid: room.rid, messageId: posted.messageId } };
}
