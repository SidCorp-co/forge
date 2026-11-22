// A project's one technical channel (ISS-1243 item 13, owner 2026-11-15): every permission or
// approval a room agent needs, every technical finding and every ask of the owner is raised there,
// and nowhere else, so a work thread is told only the answer or that it is in hand. By default it is
// the project's own thread of the operations room its organization shares (`scope: forge`; at
// SidCorp, Forge-Communicate, owner 2026-11-17, ISS-1271), opened on its first need and recorded on
// that room's binding (`project-thread.ts`). Only where the organization has no such room is it a
// direct message to the owner the asking room's binding names. The project document's
// `technicalChannel` overrides it: `{ kind: "dm", user? }` for a direct message, `{ kind: "thread" }`
// for the shared room's thread, refused by name where the organization binds none. A channel that
// cannot be reached is refused by name, naming the key that fixes it; nothing falls back to the
// asker's thread.

import type {
  SupportMasterTechnicalRequest,
  TechnicalChannel,
  TechnicalNeed,
} from '@forge/contracts/support-technical';
import {
  directRoomFor,
  FIXED_REPLY_CONSTANT,
  sendFixedReply,
} from '../integrations/rocketchat/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { findProjectSlugs, projectName } from '../projects/index.js';
import { grantsOf, supportConfigOf } from './grants.js';
import { no, type Outcome, threadUnknown } from './outcome.js';
import { ownerUsername } from './owner-consent.js';
import { projectThreadFor, sharedRoomOf } from './project-thread.js';
import { roomIsBound } from './rooms.js';
import { screenForThread } from './screen.js';
import { insertAction, type RoomRow, roomsOfProject } from './store.js';
import { heldRaise, readTechnicalTurn, type TechnicalTurn, wordsMisfit } from './technical-turn.js';
import { actingThread, postInThread, roomAuth, scrubbedForRoom, TOP_LEVEL } from './thread.js';

/** The tool a raised need is recorded under on the asker's thread. */
export const TECHNICAL = 'technical';

/** Where the project document names the channel, said the same way by every refusal. */
const KEY =
  'the project document\'s `technicalChannel` ({ kind: "thread" } for its own thread of the shared operations room, or { kind: "dm", user } for a direct message)';

/**
 * The project's channel as it stands: the one its document names, else its thread of the operations
 * room its organization shares where one is bound, else a direct message to the owner.
 */
export async function technicalChannelOf(projectId: string): Promise<TechnicalChannel> {
  const named = (await readProjectDocument(projectId))?.document.technicalChannel;
  if (named) return named;
  return (await sharedRoomOf(projectId)) ? { kind: 'thread' } : { kind: 'dm' };
}

/**
 * Where a post went: the channel's kind, its room, the line's id, and for the shared room the
 * project's thread it went into (a direct message posts at its top level).
 */
export type Raised = Outcome<{
  channel: 'thread' | 'dm';
  rid: string;
  messageId: string | null;
  thread: string | null;
}>;

/** Where the project's channel is, resolved before a word is written: a thread, or a direct message. */
export type Destination =
  | { kind: 'thread'; room: RoomRow; thread: string }
  | { kind: 'dm'; rid: string; user: string };

async function sharedThreadOf(projectId: string, path: string): Promise<Outcome<Destination>> {
  const shared = await sharedRoomOf(projectId);
  if (!shared) {
    return no(
      'SUPPORT_TECHNICAL_CHANNEL_UNNAMED',
      path,
      `this project's technical channel is its own thread of the operations room its organization shares, and its organization binds no operations room of scope forge; bind one, or name a direct message in ${KEY}. Nothing was raised.`,
    );
  }
  const at = await projectThreadFor(shared, projectId);
  if (!at.ok) {
    return no(
      'SUPPORT_TECHNICAL_CHANNEL_UNREACHABLE',
      path,
      `this project's own thread of ${shared.rid}, the operations room its organization shares, could not be opened (${at.why}), so nothing was raised; try again, or name a direct message in ${KEY}.`,
    );
  }
  return { ok: true, value: { kind: 'thread', room: shared, thread: at.thread } };
}

async function directOf(
  room: RoomRow,
  channel: { user?: string | undefined },
  path: string,
): Promise<Outcome<Destination>> {
  const user = channel.user ?? grantsOf(await supportConfigOf(room)).owner ?? null;
  if (!user) {
    return no(
      'SUPPORT_TECHNICAL_CHANNEL_UNNAMED',
      path,
      `this project's technical channel is a direct message, and it names no person while this room's binding names no owner (its grant's \`owner\`): name one in ${KEY}. Nothing was raised.`,
    );
  }
  const { auth } = await roomAuth(room);
  const direct = await directRoomFor(auth, user);
  if (!direct.ok) {
    return no(
      'SUPPORT_TECHNICAL_CHANNEL_UNREACHABLE',
      path,
      `${direct.reason}, so nothing was raised in the technical channel; name another person or the shared thread in ${KEY}.`,
    );
  }
  return { ok: true, value: { kind: 'dm', rid: direct.rid, user } };
}

/** The project's channel for `room`, or the refusal naming the key that fixes it at `path`. */
export async function destinationOf(room: RoomRow, path: string): Promise<Outcome<Destination>> {
  const channel = await technicalChannelOf(room.projectId);
  return channel.kind === 'thread'
    ? sharedThreadOf(room.projectId, path)
    : directOf(room, channel, path);
}

export async function postTo(room: RoomRow, to: Destination, text: string): Promise<Raised> {
  if (to.kind === 'thread') {
    const posted = await postInThread({ room: to.room, thread: to.thread, text });
    return {
      ok: true,
      value: {
        channel: 'thread',
        rid: to.room.rid,
        messageId: posted.messageId,
        thread: to.thread,
      },
    };
  }
  const { auth } = await roomAuth(room);
  const safe = await scrubbedForRoom(room, text);
  const { messageId } = await sendFixedReply(
    { kind: 'rest', auth, rid: to.rid },
    safe,
    FIXED_REPLY_CONSTANT,
  );
  return { ok: true, value: { channel: 'dm', rid: to.rid, messageId, thread: null } };
}

/**
 * The line as the channel reads it (ISS-1299): in the project's own thread, the words alone, after a
 * mention where one is due, since the thread already names the project and a template lead ("X
 * asks:") reads as a form; in a direct message, the project's name first, so the owner knows which of
 * his projects speaks. The agent's words carry what is needed, in the reader's language.
 */
export function technicalLine(
  project: string | null,
  words: string,
  mention: string | null = null,
): string {
  return `${mention ? `@${mention} ` : ''}${project ? `${project} · ` : ''}${words}`;
}

/** The line for `room`'s project: named as its people know it, by its slug only where it has no name. */
async function lineOf(
  room: RoomRow,
  channel: 'thread' | 'dm',
  words: string,
  mention: string | null = null,
): Promise<string> {
  if (channel === 'thread') return technicalLine(null, words, mention);
  const project =
    (await projectName(room.projectId)) ??
    (await findProjectSlugs([room.projectId])).get(room.projectId) ??
    room.projectId;
  return technicalLine(project, words, mention);
}

/**
 * The whole line a need is posted as, screened as a room post is (`screenForThread`), lead included,
 * so nothing reaches the channel that the screen did not read. Refused by name, recorded on
 * `thread`, nothing posted.
 */
export async function screenedTechnical(
  room: RoomRow,
  at: { conversationId: string | null; thread: string; tool: string },
  words: string,
  mention: string | null = null,
): Promise<Outcome<{ text: string }>> {
  const channel = (await technicalChannelOf(room.projectId)).kind;
  const line = await lineOf(room, channel, words, mention);
  const admitted = await screenForThread(
    room,
    at.conversationId,
    at.thread,
    line,
    'operations-reply',
    at.tool,
  );
  return admitted.ok ? { ok: true, value: { text: admitted.value.text } } : admitted;
}

/**
 * Post `text` in the project's technical channel and nowhere else, or the refusal naming the key
 * that fixes it at `path`; nothing is recorded here, the caller records it on its own thread.
 */
export async function postTechnical(room: RoomRow, text: string, path: string): Promise<Raised> {
  const to = await destinationOf(room, path);
  return to.ok ? postTo(room, to.value, text) : to;
}

/** The channel's thread as it stands for a raise from `room`: its reader, and who spoke in it. */
async function turnAt(room: RoomRow, to: Destination): Promise<TechnicalTurn> {
  const key = to.kind === 'dm' ? to.user : grantsOf(await supportConfigOf(room)).owner;
  return readTechnicalTurn(
    room,
    to.kind === 'thread' ? { roomId: to.room.id, thread: to.thread } : null,
    { key: key ?? null, name: key ? await ownerUsername(room.projectId, key) : null },
  );
}

/**
 * Raise one need in the project's technical channel, from the thread it arose in: posted there
 * alone, recorded as a `routed` action of that thread naming where it went. The asker's thread is
 * posted nothing; the agent tells it the answer or that it is in hand. An agent's raise first reads
 * the thread it posts into (ISS-1299): held while a person's message there within the turn is not the
 * one it answers, and refused where its words are not in his language; its words are posted only
 * once the whole line passed the screen. Core's own line naming an act it refused (`act-deny.ts`) is
 * written by core and posted as written.
 */
export async function raiseTechnical(
  room: RoomRow,
  input: { thread: string; need: TechnicalNeed; text: string; answers?: string | undefined },
  written: 'agent' | 'core' = 'agent',
): Promise<Raised> {
  // a notice thread Forge handed a task in raises from the same door (ISS-1347)
  const conversationId = await actingThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const to = await destinationOf(room, '/need');
  if (!to.ok) return to;
  const at = { conversationId, thread: input.thread, tool: TECHNICAL };
  let text: string;
  if (written === 'agent') {
    const turn = await turnAt(room, to.value);
    const sameRoom = to.value.kind === 'thread' && to.value.room.id === room.id;
    const unread = heldRaise(turn, input.answers, sameRoom) ?? wordsMisfit(turn, input.text);
    if (unread) return unread;
    const line = await screenForThread(
      room,
      conversationId,
      input.thread,
      await lineOf(room, to.value.kind, input.text),
      'operations-reply',
      at.tool,
    );
    if (!line.ok) return line;
    text = line.value.text;
  } else {
    text = await lineOf(room, to.value.kind, input.text);
  }
  const out = await postTo(room, to.value, text);
  if (!out.ok) return out;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'routed',
    actorKind: 'session',
    tool: TECHNICAL,
    input,
    output: { route: TECHNICAL, ...out.value },
    externalId: out.value.messageId,
  });
  return out;
}

/**
 * The project's own bound room a direct message to its technical channel is sent from: any where the
 * channel names its person, else one whose binding names an owner, the owner's room first.
 */
async function directRoomOf(
  projectId: string,
  channel: { user?: string | undefined },
): Promise<RoomRow | null> {
  const rooms: RoomRow[] = [];
  for (const room of await roomsOfProject(projectId)) {
    if (await roomIsBound(room)) rooms.push(room);
  }
  if (channel.user) return rooms[0] ?? null;
  for (const room of rooms) {
    const config = await supportConfigOf(room);
    if (config?.ownerRoom === room.rid && grantsOf(config).owner) return room;
  }
  for (const room of rooms) {
    if (grantsOf(await supportConfigOf(room)).owner) return room;
  }
  return rooms[0] ?? null;
}

/**
 * Where a master's raise goes (ISS-1405): the project's channel, and the room its bot speaks from,
 * the shared operations room for its thread, else the project's own room for a direct message.
 */
async function masterDestinationOf(
  projectId: string,
): Promise<Outcome<{ room: RoomRow; to: Destination }>> {
  const channel = await technicalChannelOf(projectId);
  if (channel.kind === 'thread') {
    const to = await sharedThreadOf(projectId, '/need');
    if (!to.ok) return to;
    if (to.value.kind !== 'thread') throw new Error('a shared thread resolved to a direct message');
    return { ok: true, value: { room: to.value.room, to: to.value } };
  }
  const room = await directRoomOf(projectId, channel);
  if (!room) {
    return no(
      'SUPPORT_TECHNICAL_CHANNEL_UNREACHABLE',
      '/need',
      `this project's technical channel is a direct message, and the project binds no chat room whose bot could send it; bind one, or name the shared thread in ${KEY}. Nothing was raised.`,
    );
  }
  const to = await directOf(room, channel, '/need');
  return to.ok ? { ok: true, value: { room, to: to.value } } : to;
}

/**
 * A project master raises one need in its project's technical channel under its own credential
 * (ISS-1405, FB-813): the room session's door (`raiseTechnical`) admits only a support group's own
 * session, so a master told by `SUPPORT_PERMISSION_TALK` to raise a grant it needs is sent here. The
 * line is read and screened as a room agent's raise is (held on a person's unanswered message, in
 * the reader's language, no internal code), posted only in the channel, and recorded as the master's
 * on the room it went through.
 */
export async function raiseAsMaster(
  actor: { userId: string; projectId: string },
  input: SupportMasterTechnicalRequest,
): Promise<Raised> {
  const from = await masterDestinationOf(actor.projectId);
  if (!from.ok) return from;
  const { room, to } = from.value;
  const turn = await turnAt(room, to);
  // a master holds no room session, so a held raise teaches it the general answer, never a session door
  const unread = heldRaise(turn, input.answers, false) ?? wordsMisfit(turn, input.text);
  if (unread) return unread;
  const thread = to.kind === 'thread' ? to.thread : TOP_LEVEL;
  const line = await screenForThread(
    room,
    null,
    thread,
    await lineOf(room, to.kind, input.text),
    'operations-reply',
    TECHNICAL,
  );
  if (!line.ok) return line;
  const out = await postTo(room, to, line.value.text);
  if (!out.ok) return out;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread,
    kind: 'routed',
    actorKind: 'session',
    tool: TECHNICAL,
    input: {
      need: input.need,
      text: input.text,
      by: actor.userId,
      ...(room.projectId === actor.projectId ? {} : { for: actor.projectId }),
    },
    output: { route: TECHNICAL, ...out.value },
    externalId: out.value.messageId,
  });
  return out;
}
