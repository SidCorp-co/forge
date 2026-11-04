// The project's master posts in its project's room (ISS-862): the daily review, in the master's own
// words, at the room's top level; or a result into the thread of the person who asked for it
// (ISS-871), a thread a member wrote in, of the named room or the one room holding it. Core writes
// none of the words (agent-is-the-voice): it picks the room, screens the text for the room's readers,
// posts it and records who posted. A customer support group is never one. A room the product's users
// read takes a master's words only in an asker's thread, never at its top level (ISS-872). An
// operations room every project of the organization shares takes them in the project's own thread its
// binding records, never at its top level (ISS-934).

import type { SupportMasterPostRequest } from '@forge/contracts/support-channel';
import { projectThreadsOf } from '../integrations/rocketchat/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { findProjectSlugs } from '../projects/index.js';
import { readersOf } from './grants.js';
import { no, type Outcome } from './outcome.js';
import { boundButUndeclared, declareSupportRooms, roomIsBound } from './rooms.js';
import { type SessionDoor, screenForThread } from './screen.js';
import {
  insertAction,
  type RoomRow,
  roomsOfProject,
  threadConversation,
  threadMembers,
} from './store.js';
import { postInThread, postTopLevel, scrubbedForRoom, TOP_LEVEL } from './thread.js';

const TOOL = 'master_post';

interface Postable {
  room: RoomRow;
  team: boolean;
}

/** The project's bound rooms a master may post in, a channel agent's group or an operations room, with who reads each. */
async function postableRoomsOf(projectId: string): Promise<Postable[]> {
  const rooms = (await roomsOfProject(projectId)).filter((r) => r.kind !== 'support');
  const bound = await Promise.all(
    rooms.map(async (room) =>
      (await roomIsBound(room)) ? { room, team: (await readersOf(room)) === 'team' } : null,
    ),
  );
  return bound.filter((r): r is Postable => r !== null);
}

/**
 * The project's postable rooms, with a room `rid` names that its binding names but nobody declared
 * declared now and among them (ISS-933). A room is declared when its binding changes or its first
 * message arrives, so a room bound before either, or whose declaration failed, has none; an unchanged
 * save of the binding declares nothing, so a refusal sending an admin to save it again would stand
 * forever. The declaration is idempotent: two posts declaring at once declare one room.
 */
async function postableRoomsNaming(
  projectId: string,
  rid: string | undefined,
): Promise<Postable[]> {
  const rooms = await postableRoomsOf(projectId);
  if (!rid || rooms.some((r) => r.room.rid === rid)) return rooms;
  if (!(await boundButUndeclared(projectId, rid))) return rooms;
  await declareSupportRooms(projectId);
  return postableRoomsOf(projectId);
}

type Posted = Outcome<{ rid: string; messageId: string | null; thread?: string }>;

const doorOf = (p: Postable): SessionDoor => (p.team ? 'operations-reply' : 'support-reply');
const ridsOf = (ps: readonly Postable[]) => ps.map((p) => p.room.rid).join(', ');

/** Why a room the users read takes no top-level post, and where one goes instead. */
function usersRoomRefusal(users: readonly Postable[], team: readonly Postable[]): Outcome<never> {
  const where = team.length
    ? `post the top level in a room the team reads (${ridsOf(team)})`
    : "this project binds no room the team reads: a project admin names the owner's room as the binding's `agent.ownerRoom`, or binds a room with `readers: team`";
  return no(
    'SUPPORT_MASTER_POST_USERS_ROOM',
    '/rid',
    `${ridsOf(users)} ${users.length > 1 ? 'are' : 'is'} read by the product's users, so a master posts there only into an asker's thread, named as \`thread\`; ${where}. Nothing was posted.`,
  );
}

/** The room a top-level post names, or the project's one team room, or the refusal naming what it saw. */
function topLevelRoomOf(rooms: readonly Postable[], rid: string | undefined): Outcome<Postable> {
  const team = rooms.filter((r) => r.team);
  if (rid) {
    const named = rooms.find((r) => r.room.rid === rid);
    if (!named) {
      return no(
        'SUPPORT_ROOM_UNKNOWN',
        '/rid',
        `${rid} is no bound room of this project${rooms.length ? `; its rooms are ${ridsOf(rooms)}` : ''}. Nothing was posted.`,
      );
    }
    return named.team ? { ok: true, value: named } : usersRoomRefusal([named], team);
  }
  if (team.length === 1 && team[0]) return { ok: true, value: team[0] };
  if (team.length > 1) {
    return no(
      'SUPPORT_ROOM_AMBIGUOUS',
      '/rid',
      `this project binds ${team.length} rooms the team reads (${ridsOf(team)}): name one with \`rid\`. Nothing was posted.`,
    );
  }
  if (rooms.length > 0) return usersRoomRefusal(rooms, team);
  return no(
    'SUPPORT_ROOM_UNKNOWN',
    '',
    'this project binds no team room (a channel agent group or an operations room), so there is nowhere to post. Nothing was posted.',
  );
}

/** The room of the named ones in which a member wrote `thread`, and its conversation; or the refusal. */
async function roomOfThread(
  rooms: readonly Postable[],
  rid: string | undefined,
  thread: string,
): Promise<Outcome<{ at: Postable; conversationId: string }>> {
  const named = rid ? rooms.filter((r) => r.room.rid === rid) : rooms;
  if (rid && named.length === 0) {
    return no(
      'SUPPORT_ROOM_UNKNOWN',
      '/rid',
      `${rid} is no bound room of this project${rooms.length ? `; its rooms are ${ridsOf(rooms)}` : ''}. Nothing was posted.`,
    );
  }
  for (const at of named) {
    // an asker's thread: a member wrote in it, never a top-level post's own
    if ((await threadMembers(at.room.id, thread)).length === 0) continue;
    const conversationId = await threadConversation(at.room.id, thread);
    if (conversationId) return { ok: true, value: { at, conversationId } };
  }
  return no(
    'SUPPORT_THREAD_UNKNOWN',
    '/thread',
    `no member has written in thread ${thread} of ${rid ?? (ridsOf(named) || 'any room of this project')}, so there is no asker to answer there. Nothing was posted.`,
  );
}

/** The master's answer in the asker's own thread, screened for the room's readers and recorded as the master's. */
async function postInAskersThread(
  actor: { userId: string; projectId: string },
  rooms: readonly Postable[],
  input: SupportMasterPostRequest & { thread: string },
): Promise<Posted> {
  const found = await roomOfThread(rooms, input.rid, input.thread);
  if (!found.ok) return found;
  const { at, conversationId } = found.value;
  const room = at.room;
  const text = await scrubbedForRoom(room, input.text);
  const admitted = await screenForThread(
    room,
    conversationId,
    input.thread,
    text,
    doorOf(at),
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
 * The project's own thread in an operations room (ISS-934), as the room's binding records it in
 * `operations.threads`; null for any other room, or where none is recorded.
 */
async function projectThreadIn(projectId: string, at: Postable): Promise<string | null> {
  if (at.room.kind !== 'operations') return null;
  const slug = (await findProjectSlugs([projectId])).get(projectId);
  if (!slug) return null;
  const recorded = await projectThreadsOf(projectId, slug);
  return (
    recorded.find((t) => t.bindingId === at.room.bindingId && t.rid === at.room.rid)?.thread ?? null
  );
}

/**
 * Why a master posts nothing in an operations room every project of the organization shares, one
 * thread per project, while its binding records none for this project: never at its top level.
 */
async function unrecordedRefusal(projectId: string, room: RoomRow): Promise<Outcome<never>> {
  const slug = (await findProjectSlugs([projectId])).get(projectId) ?? projectId;
  return no(
    'SUPPORT_PROJECT_THREAD_UNRECORDED',
    '/thread',
    `${room.rid} is an operations room every project of the organization shares, one thread per project, and its binding records no thread for ${slug}, so the post would land at its top level. A project admin records the project's thread as \`operations.threads["${room.rid}"]["${slug}"]\` on binding ${room.bindingId} (PUT /api/projects/${room.projectId}/bindings/${room.bindingId}). Nothing was posted.`,
  );
}

/** The master's post in its project's own thread of an operations room, screened as a top-level post is. */
async function postInProjectThread(
  actor: { userId: string; projectId: string },
  at: Postable,
  thread: string,
  given: string,
): Promise<Posted> {
  const room = at.room;
  const text = await scrubbedForRoom(room, given);
  const admitted = await screenForThread(room, null, thread, text, 'operations-reply', TOOL);
  if (!admitted.ok) return admitted;
  const posted = await postInThread({
    room,
    thread,
    text: admitted.value.text,
    proof: admitted.value.proof,
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted.conversationId,
    thread,
    kind: 'announced',
    actorKind: 'session',
    tool: TOOL,
    input: { text, by: actor.userId },
    externalId: posted.messageId,
  });
  return { ok: true, value: { rid: room.rid, messageId: posted.messageId, thread } };
}

/** The room of the named ones whose recorded project thread is `thread`, or null. */
async function roomRecording(
  projectId: string,
  rooms: readonly Postable[],
  rid: string | undefined,
  thread: string,
): Promise<Postable | null> {
  for (const at of rooms) {
    if (rid && at.room.rid !== rid) continue;
    if ((await projectThreadIn(projectId, at)) === thread) return at;
  }
  return null;
}

/**
 * Posts the master's text at the top level of a room its project's team reads, in its project's own
 * thread where the room is an operations room recording one, or in the asker's thread it names,
 * recorded as the master's. A room every project of the organization shares takes no top-level post.
 */
export async function postAsMaster(
  actor: { userId: string; projectId: string },
  input: SupportMasterPostRequest,
): Promise<Posted> {
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(actor.projectId));
  const rooms = await postableRoomsNaming(actor.projectId, input.rid);
  if (input.thread) {
    const own = await roomRecording(actor.projectId, rooms, input.rid, input.thread);
    if (own) return postInProjectThread(actor, own, input.thread, input.text);
    return postInAskersThread(actor, rooms, { ...input, thread: input.thread });
  }
  const chosen = topLevelRoomOf(rooms, input.rid);
  if (!chosen.ok) return chosen;
  const thread = await projectThreadIn(actor.projectId, chosen.value);
  if (thread) return postInProjectThread(actor, chosen.value, thread, input.text);
  if (chosen.value.room.kind === 'operations' && chosen.value.room.scope === 'forge') {
    return unrecordedRefusal(actor.projectId, chosen.value.room);
  }
  const room = chosen.value.room;
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
