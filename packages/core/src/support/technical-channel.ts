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

import type { TechnicalChannel, TechnicalNeed } from '@forge/contracts/support-technical';
import {
  directRoomFor,
  FIXED_REPLY_CONSTANT,
  sendFixedReply,
} from '../integrations/rocketchat/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { findProjectSlugs, projectName } from '../projects/index.js';
import { grantsOf, supportConfigOf } from './grants.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { projectThreadFor, sharedRoomOf } from './project-thread.js';
import { roomLanguage } from './report-thread.js';
import { screenForThread } from './screen.js';
import { insertAction, type RoomRow } from './store.js';
import { postInThread, roomAuth, scrubbedForRoom } from './thread.js';

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

async function postInSharedThread(room: RoomRow, text: string, path: string): Promise<Raised> {
  const shared = await sharedRoomOf(room.projectId);
  if (!shared) {
    return no(
      'SUPPORT_TECHNICAL_CHANNEL_UNNAMED',
      path,
      `this project's technical channel is its own thread of the operations room its organization shares, and its organization binds no operations room of scope forge; bind one, or name a direct message in ${KEY}. Nothing was raised.`,
    );
  }
  const at = await projectThreadFor(shared, room.projectId);
  if (!at.ok) {
    return no(
      'SUPPORT_TECHNICAL_CHANNEL_UNREACHABLE',
      path,
      `this project's own thread of ${shared.rid}, the operations room its organization shares, could not be opened (${at.why}), so nothing was raised; try again, or name a direct message in ${KEY}.`,
    );
  }
  const posted = await postInThread({ room: shared, thread: at.thread, text });
  return {
    ok: true,
    value: { channel: 'thread', rid: shared.rid, messageId: posted.messageId, thread: at.thread },
  };
}

async function postInDirect(
  room: RoomRow,
  channel: { user?: string | undefined },
  text: string,
  path: string,
): Promise<Raised> {
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
  const safe = await scrubbedForRoom(room, text);
  const { messageId } = await sendFixedReply(
    { kind: 'rest', auth, rid: direct.rid },
    safe,
    FIXED_REPLY_CONSTANT,
  );
  return { ok: true, value: { channel: 'dm', rid: direct.rid, messageId, thread: null } };
}

/**
 * What the asking project needs, in plain words, by the room's language (ISS-1249): the line opens
 * with these after the project's name, then the agent's words, and holds no room, thread or question
 * id. Where the line came from is the routed action's record, never the posted text.
 */
const NEED_WORDS: Readonly<Record<'vi' | 'en', Readonly<Record<TechnicalNeed, string>>>> = {
  vi: {
    ask: 'hỏi', // i18n-allow: the plain Vietnamese lead of an ask in the technical channel (ISS-1249)
    permission: 'xin quyền', // i18n-allow: the plain Vietnamese lead of a permission need (ISS-1249)
    approval: 'xin duyệt', // i18n-allow: the plain Vietnamese lead of an approval need (ISS-1249)
    finding: 'báo', // i18n-allow: the plain Vietnamese lead of a technical finding (ISS-1249)
  },
  en: {
    ask: 'asks',
    permission: 'asks for a permission',
    approval: 'asks for approval',
    finding: 'reports',
  },
};

/** The line as the channel reads it: a mention where one is due, the project's name, the need, the words. */
export function technicalLine(
  project: string,
  need: TechnicalNeed,
  language: 'vi' | 'en',
  words: string,
  mention: string | null = null,
): string {
  return `${mention ? `@${mention} ` : ''}${project} ${NEED_WORDS[language][need]}: ${words}`;
}

/** The line for `room`'s project: named as its people know it, by its slug only where it has no name. */
async function lineOf(
  room: RoomRow,
  need: TechnicalNeed,
  words: string,
  mention: string | null = null,
): Promise<string> {
  const project =
    (await projectName(room.projectId)) ??
    (await findProjectSlugs([room.projectId])).get(room.projectId) ??
    room.projectId;
  return technicalLine(project, need, await roomLanguage(room, [words]), words, mention);
}

/**
 * The whole line a need is posted as, screened as a room post is (`screenForThread`), lead included,
 * so nothing reaches the channel that the screen did not read. Refused by name, recorded on
 * `thread`, nothing posted.
 */
export async function screenedTechnical(
  room: RoomRow,
  at: { conversationId: string | null; thread: string; tool: string },
  need: TechnicalNeed,
  words: string,
  mention: string | null = null,
): Promise<Outcome<{ text: string }>> {
  const line = await lineOf(room, need, words, mention);
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
  const channel = await technicalChannelOf(room.projectId);
  return channel.kind === 'thread'
    ? postInSharedThread(room, text, path)
    : postInDirect(room, channel, text, path);
}

/**
 * Raise one need in the project's technical channel, from the thread it arose in: posted there
 * alone, recorded as a `routed` action of that thread naming where it went. The asker's thread is
 * posted nothing; the agent tells it the answer or that it is in hand. An agent's words are posted
 * only once the whole line passed the screen; core's own line naming an act it refused (`act-deny.ts`)
 * is written by core and posted as written, under the same plain lead.
 */
export async function raiseTechnical(
  room: RoomRow,
  input: { thread: string; need: TechnicalNeed; text: string },
  written: 'agent' | 'core' = 'agent',
): Promise<Raised> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const at = { conversationId, thread: input.thread, tool: TECHNICAL };
  const line =
    written === 'agent'
      ? await screenedTechnical(room, at, input.need, input.text)
      : { ok: true as const, value: { text: await lineOf(room, input.need, input.text) } };
  if (!line.ok) return line;
  const out = await postTechnical(room, line.value.text, '/need');
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
