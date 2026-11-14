// The project's master posts in any room its project binds (ISS-862, ISS-871, ISS-943): a support
// room, a channel agent's group or an operations room, in a named thread, or in the report thread of
// a room the team reads (ISS-1224, `report-thread.ts`), as that room's bot. Core writes none of the words (agent-is-the-voice): it
// picks the room, screens the text for the room's readers, posts it and records who posted.
//
// The door is core's, not a chat plugin's on the master's box: one post, made with the bot credential
// core already holds for the room, screened by the room's rules and recorded as the master's in the
// room's own record, which the channel agent and the daily review read. A plugin posting straight to
// the chat server would hold the bot's credential on a box, skip the screen and leave no record.
//
// A room the product's users read takes a master's words only in an asker's thread (a member wrote
// in it), never at its top level (ISS-872, the owner's trial of 2026-11-02), naming nobody but the
// thread's asker or a member of the room (ISS-1097, `mention-reach.ts`), in plain words with no
// internal code (`screen.ts`). An operations room every project of the organization shares takes a
// post naming no thread only in the project's own thread its binding records (ISS-934). No post of
// a master lands at a room's top level (ISS-1224, owner 2026-11-12): one naming no thread goes in the
// room's report thread, and where none can be opened it is refused by name. Images the post
// names follow its text into the same room and thread, each checked before anything is posted
// (ISS-1024, `master-post-images.ts`). A project a channel agent's binding names in `agent.projects`
// posts into that agent's rooms as well, since the group cannot be bound to it a second time (ISS-1230).
// A master edits or deletes its own post within a window (ISS-1238, `master-post-edit.ts`).

import type { SupportMasterPostRequest } from '@forge/contracts/support-channel';
import { findBindingWithConnectionById } from '../integrations/index.js';
import { fetchMessage } from '../integrations/rocketchat/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { orgSiblingProjects } from '../projects/index.js';
import { askerOf, mentionRefusal } from './channel.js';
import { readersOf } from './grants.js';
import {
  checkPostImages,
  type PostedImage,
  type PostImage,
  postImagesAfter,
  stagePostImages,
} from './master-post-images.js';
import { agentProjectSlugs } from './ops-scope.js';
import { no, type Outcome } from './outcome.js';
import { reportThreadFor } from './report-thread.js';
import { toldResultOfThread } from './room-reads.js';
import { boundButUndeclared, declareSupportRooms, heldElsewhere, roomIsBound } from './rooms.js';
import { type SessionDoor, screenForThread } from './screen.js';
import {
  insertAction,
  type RoomRow,
  roomsOfProject,
  threadConversation,
  threadMembers,
} from './store.js';
import {
  postInThread,
  projectThreadOfRoom,
  roomAuth,
  scrubbedForRoom,
  TOP_LEVEL,
  topLevelThreadOf,
} from './thread.js';

/** The tool a master's post is recorded under; its edit and delete read it back (ISS-1238). */
export const TOOL = 'master_post';

export interface Postable {
  room: RoomRow;
  team: boolean;
}

type Actor = { userId: string; projectId: string };
type Posted = Outcome<{
  rid: string;
  messageId: string | null;
  thread?: string;
  attachments?: { attachmentId: string; messageId: string | null }[];
}>;

/** The project a post was made for, recorded where the room is another project's (ISS-1230). */
const forOf = (actor: Actor, room: RoomRow) =>
  room.projectId === actor.projectId ? {} : { for: actor.projectId };

/** What a post's record and answer say of its images: the record names each, never its bytes. */
const recordedImages = (posted: readonly PostedImage[]) =>
  posted.length > 0 ? { attachments: posted } : {};
const answeredImages = (posted: readonly PostedImage[]) =>
  posted.length > 0
    ? {
        attachments: posted.map(({ attachmentId, messageId }) => ({ attachmentId, messageId })),
      }
    : {};

/** Every room the project's bindings answer now, of any kind, with who reads each. */
export async function postableRoomsOf(projectId: string): Promise<Postable[]> {
  const rooms = await roomsOfProject(projectId);
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

/**
 * The rooms of a channel agent whose binding names this project in `agent.projects` (ISS-1230). A
 * group answered by one binding is never bound by a second (`SUPPORT_ROOM_ANSWERED_TWICE`), whose
 * remedy is to name the other projects there; each one so named posts its master's results into
 * that room too, on the room's record. Naming it took an admin of the named project (ISS-874).
 */
async function followedRoomsOf(projectId: string): Promise<Postable[]> {
  const siblings = await orgSiblingProjects(projectId);
  const self = siblings.find((p) => p.id === projectId);
  if (!self) return [];
  const out: Postable[] = [];
  for (const home of siblings) {
    if (home.id === projectId) continue;
    for (const room of await roomsOfProject(home.id)) {
      if (!(await agentProjectSlugs(room)).includes(self.slug)) continue;
      if (await roomIsBound(room)) out.push({ room, team: (await readersOf(room)) === 'team' });
    }
  }
  return out;
}

const doorOf = (p: Postable): SessionDoor => (p.team ? 'operations-reply' : 'support-reply');
const ridsOf = (ps: readonly Postable[]) => ps.map((p) => p.room.rid).join(', ');
const WHERE_BOUND = 'Project settings → Integrations → Rocket.Chat';

/** Why a room the project held once takes no post now. */
async function whyUnbound(room: RoomRow): Promise<string> {
  const pair = await findBindingWithConnectionById(room.bindingId);
  const why = !pair
    ? 'the binding that named it is gone'
    : !pair.binding.active
      ? `its binding ${room.bindingId} is switched off`
      : !pair.connection.active
        ? `its Rocket.Chat connection ${pair.connection.id} is switched off`
        : `its binding ${room.bindingId} no longer names it`;
  return (await heldElsewhere(room.rid, room))
    ? `${why}, and another project's binding answers that group now, so a post there is that project's master's`
    : `${why}; a project admin switches the binding on, or names the room in it again, in ${WHERE_BOUND}`;
}

/** The refusal for a named room no binding of the project answers now: one it never bound, or one switched off. */
async function roomRefusal(
  projectId: string,
  rid: string,
  rooms: readonly Postable[],
): Promise<Outcome<never>> {
  const held = (await roomsOfProject(projectId)).find((r) => r.rid === rid);
  if (held) {
    return no(
      'SUPPORT_ROOM_SWITCHED_OFF',
      '/rid',
      `${rid} was bound to this project, but ${await whyUnbound(held)}. Nothing was posted.`,
    );
  }
  return no(
    'SUPPORT_ROOM_UNKNOWN',
    '/rid',
    `${rid} is no room a binding of this project names, nor one whose binding names this project in agent.projects${rooms.length ? `; its rooms are ${ridsOf(rooms)}` : ''}. Nothing was posted.`,
  );
}

/** Why a room the users read takes no top-level post, and where one goes instead (ISS-872). */
function usersRoomRefusal(users: readonly Postable[], team: readonly Postable[]): Outcome<never> {
  const where = team.length
    ? `post naming no thread in a room the team reads (${ridsOf(team)}), which takes it in its report thread`
    : "this project binds no room the team reads: a project admin names the owner's room as the binding's `agent.ownerRoom`, or binds a room with `readers: team`";
  return no(
    'SUPPORT_MASTER_POST_USERS_ROOM',
    '/rid',
    `${ridsOf(users)} ${users.length > 1 ? 'are' : 'is'} read by the product's users, so a master posts there only in an asker's thread, named as \`thread\`; ${where}. Nothing was posted.`,
  );
}

/** The room a top-level post names, or the project's one team room; a room the users read takes none. */
function topLevelRoomOf(rooms: readonly Postable[], rid: string | undefined): Outcome<Postable> {
  const team = rooms.filter((r) => r.team);
  const named = rid ? rooms.find((r) => r.room.rid === rid) : undefined;
  if (named) return named.team ? { ok: true, value: named } : usersRoomRefusal([named], team);
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
    'this project binds no Rocket.Chat room (a support room, a channel agent group or an operations room), so there is nowhere to post. Nothing was posted.',
  );
}

/** Where a thread was found: its room, and the conversation its record is on where it has one. */
export interface Placed {
  at: Postable;
  conversationId: string | null;
}

/**
 * The thread in its room, admitted where the room takes a master's words in it: any thread of a
 * room the team reads; only an asker's thread of a room the product's users read (ISS-872).
 */
async function admitThread(
  at: Postable,
  thread: string,
  conversationId: string | null,
): Promise<Outcome<Placed>> {
  if (at.team || (await threadMembers(at.room.id, thread)).length > 0) {
    return { ok: true, value: { at, conversationId } };
  }
  return no(
    'SUPPORT_THREAD_UNKNOWN',
    '/thread',
    `no member has written in thread ${thread} of ${at.room.rid}, which the product's users read: a master posts there only in an asker's thread. Nothing was posted.`,
  );
}

/** The chat server's word on a thread: the room its first message is in, a reply's own thread, or nothing. */
type Root = { kind: 'root'; rid: string } | { kind: 'reply'; tmid: string } | { kind: 'unknown' };

/** Ask the chat server, through each named room's bot, which room the thread's first message is in. */
async function rootOf(rooms: readonly Postable[], thread: string): Promise<Root> {
  const asked = new Set<string>();
  for (const { room } of rooms) {
    if (asked.has(room.connectionId)) continue;
    asked.add(room.connectionId);
    const { auth } = await roomAuth(room);
    const message = await fetchMessage(auth, thread);
    if (!message?.rid) continue;
    if (message.tmid) return { kind: 'reply', tmid: message.tmid };
    return { kind: 'root', rid: message.rid };
  }
  return { kind: 'unknown' };
}

/**
 * The room of the named ones a thread is in, by the project's record and then by the chat server.
 * `nothing` ends each refusal: what the caller did not do (a post, or a route's save).
 */
export async function roomOfThread(
  rooms: readonly Postable[],
  rid: string | undefined,
  thread: string,
  nothing = 'Nothing was posted.',
): Promise<Outcome<Placed>> {
  const named = rid ? rooms.filter((r) => r.room.rid === rid) : rooms;
  for (const at of named) {
    const conversationId = await threadConversation(at.room.id, thread);
    if (conversationId) return admitThread(at, thread, conversationId);
  }
  const where = rid ?? (ridsOf(named) || 'any room of this project');
  const root = await rootOf(named, thread);
  if (root.kind === 'reply') {
    return no(
      'SUPPORT_THREAD_UNKNOWN',
      '/thread',
      `${thread} is a reply in thread ${root.tmid}, not a thread's first message: name ${root.tmid} as \`thread\`. ${nothing}`,
    );
  }
  if (root.kind === 'root') {
    const at = named.find((r) => r.room.rid === root.rid);
    if (at) return admitThread(at, thread, null);
    return no(
      'SUPPORT_THREAD_OF_ANOTHER_ROOM',
      '/thread',
      `thread ${thread} is in room ${root.rid}, not in ${where}${rid ? '' : ', the rooms this project binds'}. ${nothing}`,
    );
  }
  for (const other of rooms) {
    if (named.includes(other)) continue;
    if (await threadConversation(other.room.id, thread)) {
      return no(
        'SUPPORT_THREAD_OF_ANOTHER_ROOM',
        '/thread',
        `thread ${thread} is in room ${other.room.rid}, not in ${where}. ${nothing}`,
      );
    }
  }
  return no(
    'SUPPORT_THREAD_UNKNOWN',
    '/thread',
    `neither this project's record nor the chat server holds a thread ${thread} in ${where}. ${nothing}`,
  );
}

/**
 * A users' thread already told a recorded item's result takes a master's post only as a follow-up
 * naming the message that told it (ISS-969, FB-498: the 0.9.0 notice reached an asker told the same
 * change seventeen hours before). A refusal, not a warning: a warning heard after the post is sent
 * does not stop the repeat, and a genuine follow-up has its one named way through.
 */
async function repeatRefusal(
  roomId: string,
  thread: string,
  followsUp: string | undefined,
): Promise<Posted | null> {
  const told = await toldResultOfThread(roomId, thread);
  if (!told || followsUp === told.message) return null;
  return no(
    'SUPPORT_MASTER_POST_ALREADY_TOLD',
    followsUp === undefined ? '/thread' : '/followsUp',
    `thread ${thread} was already told ${told.feedbackKey ?? 'a recorded item'}'s result at ${told.at.toISOString()}, in message ${told.message}, so a post there repeats it to the person who asked. Post only what that message did not say, as a follow-up naming it: \`followsUp: "${told.message}"\`. Nothing was posted.`,
  );
}

/** The master's post in a named thread of its room, screened for the room's readers and recorded as the master's. */
async function postInNamedThread(
  actor: Actor,
  rooms: readonly Postable[],
  input: SupportMasterPostRequest & { thread: string },
  images: readonly PostImage[],
): Promise<Posted> {
  const found = await roomOfThread(rooms, input.rid, input.thread);
  if (!found.ok) return found;
  const { at, conversationId } = found.value;
  const room = at.room;
  const text = await scrubbedForRoom(room, input.text);
  if (!at.team) {
    const repeat = await repeatRefusal(room.id, input.thread, input.followsUp);
    if (repeat) return repeat;
    // toward users a post names at most one person: the asker, the starter or a member of the room
    const mentions = await mentionRefusal<never>(
      room,
      text,
      (await askerOf(room, input.thread)).username,
      input.thread,
    );
    if (mentions) return mentions;
  }
  const admitted = await screenForThread(
    room,
    conversationId,
    input.thread,
    text,
    doorOf(at),
    TOOL,
  );
  if (!admitted.ok) return admitted;
  const staged = await stagePostImages(room, images);
  if (!staged.ok) return staged;
  const posted = await postInThread({
    room,
    thread: input.thread,
    text: admitted.value.text,
    proof: admitted.value.proof,
  });
  const shown = await postImagesAfter(room, staged.value, input.thread, posted.messageId);
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted.conversationId,
    thread: input.thread,
    kind: 'routed',
    actorKind: 'session',
    tool: TOOL,
    input: { text, by: actor.userId, ...forOf(actor, room), ...recordedImages(shown.posted) },
    externalId: posted.messageId,
  });
  if (shown.failure) return shown.failure;
  return {
    ok: true,
    value: {
      rid: room.rid,
      messageId: posted.messageId,
      thread: input.thread,
      ...answeredImages(shown.posted),
    },
  };
}

/**
 * The master's post where a room's top level would take it (`thread.ts:topLevelThreadOf`, `to`):
 * its project's own thread of an operations room recording one, else (`thread` null) the report
 * thread of a room the team reads, opened once the post is screened and its images taken, so a
 * refused post opens nothing (ISS-1224); never
 * its top level. Screened as a top-level post is, since everyone in the room reads it, and recorded
 * as the master's.
 */
async function postAtTop(
  actor: Actor,
  at: Postable,
  given: string,
  thread: string | null,
  images: readonly PostImage[],
): Promise<Posted> {
  const room = at.room;
  const text = await scrubbedForRoom(room, given);
  const admitted = await screenForThread(room, null, TOP_LEVEL, text, doorOf(at), TOOL);
  if (!admitted.ok) return admitted;
  const staged = await stagePostImages(room, images);
  if (!staged.ok) return staged;
  let to = thread;
  if (!to) {
    const report = await reportThreadFor(room, [text]);
    if (!report.ok) return report;
    to = report.value;
  }
  const posted = await postInThread({
    room,
    thread: to,
    text: admitted.value.text,
    proof: admitted.value.proof,
  });
  const shown = await postImagesAfter(room, staged.value, to, posted.messageId);
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted.conversationId,
    thread: to,
    kind: 'announced',
    actorKind: 'session',
    tool: TOOL,
    input: { text, by: actor.userId, ...forOf(actor, room), ...recordedImages(shown.posted) },
    externalId: posted.messageId,
  });
  if (shown.failure) return shown.failure;
  return {
    ok: true,
    value: {
      rid: room.rid,
      messageId: posted.messageId,
      thread: to,
      ...answeredImages(shown.posted),
    },
  };
}

/** The room of the named ones whose recorded project thread is `thread`, or null. */
async function roomRecording(
  rooms: readonly Postable[],
  rid: string | undefined,
  thread: string,
): Promise<Postable | null> {
  for (const at of rooms) {
    if (rid && at.room.rid !== rid) continue;
    if ((await projectThreadOfRoom(at.room)) === thread) return at;
  }
  return null;
}

/**
 * Posts the master's text in a room its project binds, as that room's bot: in the thread it names,
 * its project's own thread of an operations room recording one, or in the report thread of the team
 * room it names or the project's one team room, never at a top level; recorded as the master's.
 */
export async function postAsMaster(actor: Actor, input: SupportMasterPostRequest): Promise<Posted> {
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(actor.projectId));
  const images = await checkPostImages(actor.userId, actor.projectId, input.attachments);
  if (!images.ok) return images;
  const own = await postableRoomsNaming(actor.projectId, input.rid);
  // a room whose binding names this project in agent.projects takes its master's posts too (ISS-1230)
  const followed = (await followedRoomsOf(actor.projectId)).filter(
    (f) => !own.some((o) => o.room.rid === f.room.rid),
  );
  const rooms = [...own, ...followed];
  if (input.rid && !rooms.some((r) => r.room.rid === input.rid)) {
    return roomRefusal(actor.projectId, input.rid, rooms);
  }
  if (input.thread) {
    const own = await roomRecording(rooms, input.rid, input.thread);
    if (own) return postAtTop(actor, own, input.text, input.thread, images.value);
    return postInNamedThread(actor, rooms, { ...input, thread: input.thread }, images.value);
  }
  // naming no room, a post goes to the project's own; a followed room takes one it names
  const chosen = topLevelRoomOf(input.rid ? rooms : own, input.rid);
  if (!chosen.ok) return chosen;
  // a shared operations room takes it in the project's own thread; any other in its report thread
  const to = await topLevelThreadOf(chosen.value.room);
  if (!to.ok) return to;
  return postAtTop(actor, chosen.value, input.text, to.value, images.value);
}
