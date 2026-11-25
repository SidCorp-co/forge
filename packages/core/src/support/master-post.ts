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
// A room the product's users read takes none of a master's words, in any thread (owner 2026-11-25,
// ISS-1467): a master hands its bot facts (`master-tell.ts`) and the bot says them. An operations room every project of the organization shares takes a
// post naming no thread only in the project's own thread its binding records (ISS-934). No post of
// a master lands at a room's top level (ISS-1224, owner 2026-11-12): one naming no thread goes in the
// room's report thread, and where none can be opened it is refused by name. Images the post
// names follow its text into the same room and thread, each checked before anything is posted
// (ISS-1024, `master-post-images.ts`). A project a channel agent's binding names in `agent.projects`
// posts into that agent's rooms as well, since the group cannot be bound to it a second time (ISS-1230),
// and every project of the organization posts in its own recorded thread of an operations room another
// project binds for all of them (`scope: forge`), and only there (ISS-1242).
// A master edits or deletes its own post within a window (ISS-1238, `master-post-edit.ts`).

import type { SupportMasterPostRequest } from '@forge/contracts/support-channel';
import { findBindingWithConnectionById } from '../integrations/index.js';
import { fetchMessage } from '../integrations/rocketchat/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { orgSiblingProjects } from '../projects/index.js';
import { teamOnlyRoom } from './grants.js';
import {
  checkPostImages,
  type PostedImage,
  type PostImage,
  postImagesAfter,
  stagePostImages,
} from './master-post-images.js';
import { placedAs, postInOneVoice } from './one-voice.js';
import { agentProjectSlugs } from './ops-scope.js';
import { no, type Outcome } from './outcome.js';
import { reportThreadFor } from './report-thread.js';
import { boundButUndeclared, declareSupportRooms, heldElsewhere, roomIsBound } from './rooms.js';
import { type SessionDoor, screenForThread } from './screen.js';
import { sharedThreadRefusal, standingIn } from './shared-thread.js';
import { insertAction, type RoomRow, roomsOfProject } from './store.js';
import {
  postInThread,
  projectThreadOfRoom,
  roomAuth,
  scrubbedForRoom,
  TOP_LEVEL,
  topLevelThreadOf,
} from './thread.js';
import { threadConversation } from './thread-conversation.js';

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
  /** Whose answer the post replaced in place, so one voice stands in the thread (ISS-1243). */
  replaced?: 'agent' | 'master';
  updated?: true; // a report updated its own earlier post in place (ISS-1417)
  landedIn?: 'project-thread' | 'report-thread'; // where a post bound for a top level went (ISS-1433)
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
      (await roomIsBound(room)) ? { room, team: await teamOnlyRoom(room) } : null,
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
 * With them, each operations room a sibling binds for the whole organization (`scope: forge`): every
 * project of it has its own thread there, recorded on that binding (ISS-1242, Forge-Communicate).
 */
async function followedRoomsOf(projectId: string): Promise<Postable[]> {
  const siblings = await orgSiblingProjects(projectId);
  const self = siblings.find((p) => p.id === projectId);
  if (!self) return [];
  const out: Postable[] = [];
  for (const home of siblings) {
    if (home.id === projectId) continue;
    for (const room of await roomsOfProject(home.id)) {
      if (!isShared(room) && !(await agentProjectSlugs(room)).includes(self.slug)) continue;
      if (await roomIsBound(room)) out.push({ room, team: await teamOnlyRoom(room) });
    }
  }
  return out;
}

/** An operations room every project of its home's organization shares, one thread each. */
export const isShared = (room: RoomRow) => room.kind === 'operations' && room.scope === 'forge';

/** The shared operations rooms another project of the organization binds, which this project posts in too (ISS-1439). */
export async function sharedRoomsOf(projectId: string): Promise<RoomRow[]> {
  return (await followedRoomsOf(projectId)).filter((f) => isShared(f.room)).map((f) => f.room);
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
export async function roomRefusal(
  projectId: string,
  rid: string,
  rooms: readonly Postable[],
  nothing = 'Nothing was posted.',
): Promise<Outcome<never>> {
  const held = (await roomsOfProject(projectId)).find((r) => r.rid === rid);
  if (held) {
    return no(
      'SUPPORT_ROOM_SWITCHED_OFF',
      '/rid',
      `${rid} was bound to this project, but ${await whyUnbound(held)}. ${nothing}`,
    );
  }
  return no(
    'SUPPORT_ROOM_UNKNOWN',
    '/rid',
    `${rid} is no room a binding of this project names, nor one whose binding names this project in agent.projects, nor an operations room its organization shares${rooms.length ? `; its rooms are ${ridsOf(rooms)}` : ''}. ${nothing}`,
  );
}

/** Why a room the users read takes no top-level post, and where one goes instead (ISS-872). */
function usersRoomRefusal(users: readonly Postable[], team: readonly Postable[]): Outcome<never> {
  const where = team.length
    ? `post naming no thread goes in a room the team reads (${ridsOf(team)}), which takes it in its report thread`
    : "post for the team needs a room only it reads: an operations room, or a channel agent's owner room, which a project admin names as the binding's `agent.ownerRoom` (a support room is never the team's, whatever its `readers` says)";
  return no(
    'SUPPORT_MASTER_POST_USERS_ROOM',
    '/rid',
    `${ridsOf(users)} ${users.length > 1 ? 'are' : 'is'} read by the product's users, so a master never posts there: hand its bot the facts with master-tells, naming the thread; a ${where}. Nothing was posted.`,
  );
}

/** Why a master's post in a thread of a room the users read is refused, and the route that serves it instead. */
function usersThreadRefusal(rid: string, thread: string): Outcome<never> {
  return no(
    'SUPPORT_MASTER_POST_USERS_ROOM',
    '/thread',
    `${rid} is read by the product's users, so a master never posts there, in thread ${thread} or any other, whatever the words or files: hand the room's bot the facts with master-tells (\`thread\`, \`facts\`), and the bot tells the person in its own words. Nothing was posted.`,
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
    if (conversationId) return { ok: true, value: { at, conversationId } };
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
    if (at) return { ok: true, value: { at, conversationId: null } };
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
  if (!at.team) return usersThreadRefusal(room.rid, input.thread);
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
  const staged = await stagePostImages(room, images);
  if (!staged.ok) return staged;
  // one voice: it replaces the bot's answer to the current request rather than standing beside it (ISS-1243)
  const placed = await postInOneVoice({
    room,
    thread: input.thread,
    conversationId,
    ...admitted.value,
    followsUp: input.followsUp,
    report: input.report ? { key: input.report, projectId: actor.projectId } : undefined,
  });
  if (!placed.ok) return placed;
  const posted = placed.value;
  const shown = await postImagesAfter(room, staged.value, input.thread, posted.messageId);
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted.conversationId,
    thread: input.thread,
    kind: 'routed',
    actorKind: 'session',
    tool: TOOL,
    input: {
      text,
      by: actor.userId,
      ...forOf(actor, room),
      ...recordedImages(shown.posted),
      ...(posted.replaced ? { replaced: posted.replaced } : {}),
      ...(input.report ? { report: input.report } : {}),
    },
    externalId: posted.messageId,
  });
  if (shown.failure) return shown.failure;
  return {
    ok: true,
    value: {
      rid: room.rid,
      messageId: posted.messageId,
      thread: input.thread,
      ...placedAs(posted),
      ...answeredImages(shown.posted),
    },
  };
}

/**
 * The master's post where a room's top level would take it (`thread.ts:topLevelThreadOf`, `to`):
 * its project's own thread of an operations room recording one, else (`thread` null) the report
 * thread of a room the team reads, opened once the post is screened and its images taken, so a
 * refused post opens nothing (ISS-1224); never its top level. Screened as a top-level post is, as
 * everyone reads it, recorded as the master's and answered with which it went in (`landedIn`).
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
  const admitted = await screenForThread(room, null, TOP_LEVEL, text, doorOf(at), TOOL, thread);
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
      landedIn: thread ? 'project-thread' : 'report-thread',
      ...answeredImages(shown.posted),
    },
  };
}

/** The room of the named ones recording `thread` as the project's own thread, or null. */
export async function roomRecording(
  projectId: string,
  rooms: readonly Postable[],
  rid: string | undefined,
  thread: string,
): Promise<Postable | null> {
  for (const at of rooms) {
    if (rid && at.room.rid !== rid) continue;
    if ((await projectThreadOfRoom(at.room, projectId)) === thread) return at;
  }
  return null;
}

/**
 * Every room a master's post reaches, its project's own first, and of them the rooms it only
 * follows: a channel agent's naming it in `agent.projects` (ISS-1230), or an operations room its
 * organization shares (ISS-1242). The thread read beside the post reaches the same (ISS-1406).
 */
export async function masterReach(
  projectId: string,
  rid: string | undefined,
): Promise<{ rooms: Postable[]; own: Postable[]; followed: Postable[] }> {
  const own = await postableRoomsNaming(projectId, rid);
  const followed = (await followedRoomsOf(projectId)).filter(
    (f) => !own.some((o) => o.room.rid === f.room.rid),
  );
  return { rooms: [...own, ...followed], own, followed };
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
  // a room whose binding names this project in agent.projects takes its master's posts too (ISS-1230)
  const { rooms, own, followed } = await masterReach(actor.projectId, input.rid);
  if (input.rid && !rooms.some((r) => r.room.rid === input.rid)) {
    return roomRefusal(actor.projectId, input.rid, rooms);
  }
  if (input.thread) {
    const recording = await roomRecording(actor.projectId, rooms, input.rid, input.thread);
    if (recording) return postAtTop(actor, recording, input.text, input.thread, images.value);
    // another project's shared operations room takes this project's posts in its own thread alone
    const shared = followed.filter((f) => isShared(f.room));
    // ... but also in a thread it has standing in there (ISS-1439)
    for (const at of shared) {
      if (input.rid && at.room.rid !== input.rid) continue;
      if (await standingIn(actor.projectId, at.room, input.thread)) {
        return postInNamedThread(actor, [at], { ...input, thread: input.thread }, images.value);
      }
    }
    const named = input.rid ? shared.find((f) => f.room.rid === input.rid) : undefined;
    if (named) return sharedThreadRefusal(actor.projectId, named.room, input.thread);
    const open = rooms.filter((r) => !shared.includes(r));
    return postInNamedThread(actor, open, { ...input, thread: input.thread }, images.value);
  }
  // naming no room, a post goes to the project's own; a followed room takes one it names
  const chosen = topLevelRoomOf(input.rid ? rooms : own, input.rid);
  if (!chosen.ok) return chosen;
  // a shared operations room takes it in the project's own thread; any other in its report thread
  const to = await topLevelThreadOf(chosen.value.room, actor.projectId, true);
  if (!to.ok) return to;
  return postAtTop(actor, chosen.value, input.text, to.value, images.value);
}
