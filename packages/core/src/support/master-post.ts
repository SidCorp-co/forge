// The project's master posts in its project's room (ISS-862): the daily review, in the master's own
// words, at the room's top level; or a result into the thread of the person who asked for it
// (ISS-871), a thread a member wrote in, of the named room or the one team room holding it. Core writes none of the words (agent-is-the-voice): it picks the
// project's bound team room, screens the text as the team reads it, posts it and records who posted.
// A customer support group is never one: what the team reads is not posted where customers read.

import type { SupportMasterPostRequest } from '@forge/contracts/support-channel';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { knownThread, no, type Outcome } from './outcome.js';
import { roomIsBound } from './rooms.js';
import { screenForThread } from './screen.js';
import { insertAction, type RoomRow, roomsOfProject } from './store.js';
import { postInThread, postTopLevel, scrubbedForRoom, TOP_LEVEL } from './thread.js';

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

/** The room of the named ones whose record holds `thread`, and its conversation; or the refusal. */
async function roomOfThread(
  rooms: readonly RoomRow[],
  rid: string | undefined,
  thread: string,
): Promise<Outcome<{ room: RoomRow; conversationId: string }>> {
  const named = rid ? rooms.filter((r) => r.rid === rid) : rooms;
  if (rid && named.length === 0) return roomOf(rooms, rid) as Outcome<never>;
  for (const room of named) {
    const conversationId = await knownThread(room, thread);
    if (conversationId) return { ok: true, value: { room, conversationId } };
  }
  return no(
    'SUPPORT_THREAD_UNKNOWN',
    '/thread',
    `no member has written in thread ${thread} of ${rid ?? (named.map((r) => r.rid).join(', ') || 'any team room of this project')}, so there is no asker to answer there. Nothing was posted.`,
  );
}

/** The master's answer in the asker's own thread, screened as the team reads it and recorded as the master's. */
async function postInAskersThread(
  actor: { userId: string; projectId: string },
  input: SupportMasterPostRequest & { thread: string },
): Promise<Outcome<{ rid: string; messageId: string | null; thread?: string }>> {
  const found = await roomOfThread(await teamRoomsOf(actor.projectId), input.rid, input.thread);
  if (!found.ok) return found;
  const { room, conversationId } = found.value;
  const text = await scrubbedForRoom(room, input.text);
  const admitted = await screenForThread(
    room,
    conversationId,
    input.thread,
    text,
    'operations-reply',
    TOOL,
  );
  if (!admitted.ok) return admitted;
  const posted = await postInThread({
    room,
    thread: input.thread,
    text: admitted.value.text,
    proof: admitted.value.proof,
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted.conversationId,
    thread: input.thread,
    kind: 'routed',
    actorKind: 'session',
    tool: TOOL,
    input: { text, by: actor.userId },
    externalId: posted.messageId,
  });
  return { ok: true, value: { rid: room.rid, messageId: posted.messageId, thread: input.thread } };
}

/**
 * Posts the master's text at the top level of its project's team room, or in the thread it names,
 * recorded as the master's.
 */
export async function postAsMaster(
  actor: { userId: string; projectId: string },
  input: SupportMasterPostRequest,
): Promise<Outcome<{ rid: string; messageId: string | null; thread?: string }>> {
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(actor.projectId));
  if (input.thread) return postInAskersThread(actor, { ...input, thread: input.thread });
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
