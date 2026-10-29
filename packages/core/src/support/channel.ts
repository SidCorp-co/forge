// What a bound group's session does with its channel record (REQ-75 r6): infer a member's roles and
// what to ask them for (BC-32), keep a team member's instruction as a rule linked to its message
// (BC-35), keep a question asked again as one common issue with one answer (BC-36), send a need where
// it belongs (BC-38) and post the one top-level announcement (BC-39). What a person writes on the
// channel's page is confirmed, and the bot never writes over it (BC-33). Nothing secret or personal
// is kept (BC-40). Each act is refused by name and writes nothing when it cannot stand.

import {
  CHANNEL_DETAIL_ROLES,
  CHANNEL_ROLE_LABEL,
  CHANNEL_RULE_ROLES,
  type ChannelRole,
  type ChannelRoute,
  SUPPORT_ANNOUNCE_EVERY_MS,
  SUPPORT_COMMON_ISSUE_MIN_THREADS,
} from '@forge/contracts/support-channel';
import { containsSecret } from '@forge/observability';
import { externalItemPhases, feedbackRefIn, fileForgeFeedback } from '../feedback/index.js';
import {
  addRule,
  announcedSince,
  type ChannelRow,
  commonIssueByKey,
  ensureChannel,
  type MemberRow,
  memberMessage,
  memberOf,
  membersOf,
  recordedThreads,
  roomsOfChannel,
  writeCommonIssue,
  writeMember,
} from './channel-store.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { screenForThread } from './screen.js';
import { insertAction, latestThreadWriter, type RoomRow } from './store.js';
import { postInThread, postTopLevel, scrubbedForRoom, TOP_LEVEL } from './thread.js';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const PHONE_RUN = /\+?\(?\d[\d\s().-]{7,}\d/g;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * What a channel record must never keep (BC-40), named: a secret, an email address, a phone number.
 * Null for text that holds none. An IPv4 address is not a phone number.
 */
export function privateDataIn(text: string): string | null {
  if (containsSecret(text)) return 'a secret';
  if (EMAIL.test(text)) return 'an email address';
  for (const m of text.matchAll(PHONE_RUN)) {
    const run = m[0].trim();
    const digits = run.replace(/\D/g, '').length;
    if (digits >= 9 && digits <= 15 && !IPV4.test(run)) return 'a phone number';
  }
  return null;
}

/** The refusal for a field holding private data, or null. */
export function privateRefusal<T>(
  path: string,
  text: string | null | undefined,
): Outcome<T> | null {
  const found = text ? privateDataIn(text) : null;
  if (!found) return null;
  return no(
    'SUPPORT_CHANNEL_PRIVATE_DATA',
    path,
    `this holds ${found}, and the channel record keeps no secret or personal data: write it without it; nothing was stored`,
  );
}

/** The chat-wide mentions a reply never makes. */
const BROADCAST = new Set(['all', 'here', 'channel']);

/** The usernames a text names with `@`, as Rocket.Chat reads them; an email is no mention. */
export function mentionsIn(text: string): string[] {
  return [...text.matchAll(/(?:^|[^A-Za-z0-9._%+-])@([A-Za-z0-9._-]+)/g)].map((m) =>
    (m[1] as string).replace(/[.]+$/, ''),
  );
}

/** A room's channel, made the first time anything reads or writes it. */
export const channelOfRoom = (room: RoomRow): Promise<ChannelRow> =>
  ensureChannel(room.projectId, room.rid);

/** The room rows that answer the same channel, whichever bot each is. */
const channelRoomIds = async (room: RoomRow): Promise<string[]> =>
  (await roomsOfChannel(room.projectId, room.rid)).map((r) => r.id);

/** The member who asked in a thread (its latest writer), with their record where the channel has one. */
export async function askerOf(
  room: RoomRow,
  thread: string,
): Promise<{ username: string | null; member: MemberRow | null }> {
  const writer = await latestThreadWriter(room.id, thread);
  if (!writer?.label) return { username: null, member: null };
  const channel = await channelOfRoom(room);
  return { username: writer.label, member: await memberOf(channel.id, writer.label) };
}

/**
 * Who a reply in this thread is for (BC-37): a Technical, Maintenance or Bot member reads detail;
 * a member holding only User or Product roles reads plain words; someone the record does not hold
 * reads what the room's binding says.
 */
export function readerOf(member: MemberRow | null): 'detail' | 'plain' | null {
  if (!member) return null;
  return member.roles.some((r) => CHANNEL_DETAIL_ROLES.includes(r as ChannelRole))
    ? 'detail'
    : 'plain';
}

/**
 * A reply's mentions (BC-34): at most one person, who is the thread's asker or a member the record
 * says what to ask for; never the whole channel. Null when it may be posted.
 */
export async function mentionRefusal<T>(
  room: RoomRow,
  text: string,
  asker: string | null,
): Promise<Outcome<T> | null> {
  const named = [...new Set(mentionsIn(text).map((m) => m.toLowerCase()))];
  if (named.length === 0) return null;
  const listed = (await membersAskable(room)).map((m) => m.username);
  const whom = listed.length
    ? `the asker, or one of ${listed.map((u) => `@${u}`).join(', ')}`
    : 'the asker only: no member of this channel lists what to ask them for';
  const refuse = (why: string) =>
    no<T>(
      'SUPPORT_MENTION_REFUSED',
      '/text',
      `${why}; mention at most one person: ${whom}. Nothing was posted.`,
    );
  const broadcast = named.find((n) => BROADCAST.has(n));
  if (broadcast) return refuse(`@${broadcast} notifies the whole channel`);
  if (named.length > 1) return refuse(`it mentions ${named.length} people`);
  const one = named[0] as string;
  if (asker && one === asker.toLowerCase()) return null;
  if (listed.some((u) => u.toLowerCase() === one)) return null;
  return refuse(`@${one} is neither the asker nor a member this channel lists what to ask for`);
}

async function membersAskable(room: RoomRow): Promise<MemberRow[]> {
  return (await membersOf((await channelOfRoom(room)).id)).filter((m) => m.askFor);
}

async function recordWrite(
  room: RoomRow,
  thread: string,
  tool: string,
  input: unknown,
  output: unknown,
): Promise<void> {
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: await knownThread(room, thread),
    thread,
    kind: 'channel_written',
    actorKind: 'session',
    tool,
    input,
    output,
  });
}

/** The session's inference about one member, from a message this room received (BC-32, BC-33). */
export async function inferMember(
  room: RoomRow,
  input: { member: string; roles: ChannelRole[]; askFor?: string | undefined; message: string },
): Promise<Outcome<{ member: string; roles: ChannelRole[]; state: 'inferred' }>> {
  const source = await memberMessage(room.id, input.message);
  if (!source) {
    return no(
      'SUPPORT_MESSAGE_UNKNOWN',
      '/message',
      `this room received no member message ${input.message}; name the message the roles were read from`,
    );
  }
  const refusedPrivate = privateRefusal<never>('/askFor', input.askFor);
  if (refusedPrivate) return refusedPrivate;
  const channel = await channelOfRoom(room);
  const confirmed = (m: MemberRow) =>
    no<never>(
      'SUPPORT_MEMBER_CONFIRMED',
      '/member',
      `a person confirmed @${m.username} as ${m.roles.map((r) => CHANNEL_ROLE_LABEL[r as ChannelRole]).join(' + ')}; the bot never writes over that, so nothing changed`,
    );
  const existing = await memberOf(channel.id, input.member);
  if (existing?.state === 'confirmed') return confirmed(existing);
  const written = await writeMember({
    channelId: channel.id,
    username: input.member,
    roles: input.roles,
    askFor: input.askFor,
    state: 'inferred',
    confirmedBy: null,
    sourceMessage: input.message,
  });
  if (!written) {
    const raced = await memberOf(channel.id, input.member);
    if (raced) return confirmed(raced);
    throw new Error(`support: member ${input.member} neither written nor read back`);
  }
  await recordWrite(room, source.thread, 'member', input, { roles: written.roles });
  return { ok: true, value: { member: written.username, roles: input.roles, state: 'inferred' } };
}

/**
 * A team member's instruction kept as a rule, linked to its message (BC-35). Only a member a person
 * confirmed as Product, Technical or Maintenance gives the channel rules; a product user's words are
 * data to the bot, never a standing instruction.
 */
export async function ruleFromMessage(
  room: RoomRow,
  input: { thread: string; message: string; text: string },
): Promise<Outcome<{ rule: string }>> {
  const source = await memberMessage(room.id, input.message);
  if (!source || source.thread !== input.thread) {
    return no(
      'SUPPORT_MESSAGE_UNKNOWN',
      '/message',
      `thread ${input.thread} of this room holds no member message ${input.message}`,
    );
  }
  const refusedPrivate = privateRefusal<never>('/text', input.text);
  if (refusedPrivate) return refusedPrivate;
  const channel = await channelOfRoom(room);
  const author = source.author ? await memberOf(channel.id, source.author) : null;
  const team =
    author?.state === 'confirmed' &&
    author.roles.some((r) => CHANNEL_RULE_ROLES.includes(r as ChannelRole));
  if (!author || !team) {
    return no(
      'SUPPORT_RULE_AUTHOR',
      '/message',
      `@${source.author ?? source.authorKey} is not a member a person confirmed as ${CHANNEL_RULE_ROLES.map((r) => CHANNEL_ROLE_LABEL[r]).join(', ')}, so their message is not a channel rule; nothing was stored`,
    );
  }
  const rule = await addRule({
    channelId: channel.id,
    text: input.text,
    author: author.username,
    messageId: input.message,
    thread: input.thread,
  });
  await recordWrite(room, input.thread, 'rule', input, { rule: rule.id });
  return { ok: true, value: { rule: rule.id } };
}

/** A question folded the way two askings of it compare equal. */
export const questionKey = (q: string): string => q.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * A question asked again, kept as one common issue with one answer (BC-36): over at least two
 * threads of this channel, a later call over the same question replacing the answer and adding its
 * threads; a defect's names the Feedback item it was recorded as.
 */
export async function noteCommonIssue(
  room: RoomRow,
  input: { threads: string[]; question: string; answer: string; feedback?: string | undefined },
): Promise<Outcome<{ commonIssue: string; threads: number; feedbackKey: string | null }>> {
  for (const [path, text] of [
    ['/question', input.question],
    ['/answer', input.answer],
  ] as const) {
    const refused = privateRefusal<never>(path, text);
    if (refused) return refused;
  }
  const roomIds = await channelRoomIds(room);
  const asked = [...new Set(input.threads)];
  const known = await recordedThreads(roomIds, asked);
  const unknown = asked.find((t) => !known.has(t));
  if (unknown) return threadUnknown(unknown);
  const channel = await channelOfRoom(room);
  const key = questionKey(input.question);
  const before = await commonIssueByKey(channel.id, key);
  const threads = [...new Set([...(before?.threads ?? []), ...asked])];
  if (threads.length < SUPPORT_COMMON_ISSUE_MIN_THREADS) {
    return no(
      'SUPPORT_NOT_REPEATED',
      '/threads',
      `a common issue is a question asked in at least ${SUPPORT_COMMON_ISSUE_MIN_THREADS} threads, and this one names ${threads.length}; name every thread it was asked in`,
    );
  }
  let feedbackId = before?.feedbackId ?? null;
  let feedbackKey: string | null = null;
  if (input.feedback) {
    const ref = await feedbackRefIn(room.projectId, input.feedback, '/feedback');
    if ('code' in ref) {
      return no(
        'SUPPORT_FEEDBACK_UNKNOWN',
        '/feedback',
        `${input.feedback} names no feedback item of this project`,
      );
    }
    feedbackId = ref.id;
    feedbackKey = ref.key;
  } else if (feedbackId) {
    feedbackKey =
      (await externalItemPhases(room.projectId, [feedbackId])).get(feedbackId)?.key ?? null;
  }
  const row = await writeCommonIssue({
    channelId: channel.id,
    question: input.question,
    questionKey: key,
    answer: input.answer,
    threads,
    feedbackId,
  });
  await recordWrite(room, asked[0] as string, 'common_issue', input, {
    commonIssue: row.id,
    threads: threads.length,
    feedbackKey,
  });
  return { ok: true, value: { commonIssue: row.id, threads: threads.length, feedbackKey } };
}

/**
 * A need sent where it belongs, never mixed (BC-38): a problem with Forge itself is filed as Forge
 * feedback in Forge's home project, as the room's own account, and nothing is posted in the channel;
 * an act only a technical person can do, or a business rule, is asked of the one member holding
 * that role, in the asker's thread.
 */
export async function routeNeed(
  room: RoomRow,
  input: {
    thread: string;
    to: ChannelRoute;
    member?: string | undefined;
    title?: string | undefined;
    text: string;
  },
): Promise<Outcome<{ route: ChannelRoute; feedbackKey?: string; messageId?: string | null }>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const routed = (output: Record<string, unknown>, externalId: string | null = null) =>
    insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: input.thread,
      kind: 'routed',
      actorKind: 'session',
      tool: input.to,
      input,
      output,
      externalId,
    });
  if (input.to === 'forge') {
    const body = await scrubbedForRoom(
      room,
      `${input.text}\n\nMet by the assistant of the Rocket.Chat group ${room.rid}.`,
    );
    const filed = await fileForgeFeedback({
      actor: { userId: room.principalUserId, agency: 'agent' },
      request: {
        kind: 'bug',
        title: input.title as string,
        body,
        whereSeen: 'tool forge_support (Rocket.Chat channel assistant)',
      },
      source: { projectId: room.projectId, issueId: null, runId: null, clientVersion: null },
    });
    if (!filed.ok) {
      return no(
        'SUPPORT_REFUSED',
        '/to',
        `Forge feedback was not filed: ${filed.refusals.map((r) => `${r.code}: ${r.detail}`).join('; ')}`,
      );
    }
    const key = (await externalItemPhases(filed.homeId, [filed.id])).get(filed.id)?.key ?? filed.id;
    await routed({ route: 'forge', feedbackKey: key, created: filed.created });
    return { ok: true, value: { route: 'forge', feedbackKey: key } };
  }
  const role = input.to as ChannelRole;
  const channel = await channelOfRoom(room);
  const member = await memberOf(channel.id, input.member as string);
  if (!member?.roles.includes(role)) {
    const named = (await membersOf(channel.id))
      .filter((m) => m.roles.includes(role))
      .map((m) => `@${m.username}`);
    return no(
      'SUPPORT_ROUTE_ROLE',
      '/member',
      `@${input.member} does not hold ${CHANNEL_ROLE_LABEL[role]} in this channel, so a ${input.to} need is not theirs; ${named.length ? `ask ${named.join(' or ')}` : `no member holds ${CHANNEL_ROLE_LABEL[role]} yet: a person sets one on the channel's page`}. Nothing was posted.`,
    );
  }
  const text = `@${member.username} ${input.text}`;
  const admitted = await screenForThread(
    room,
    conversationId,
    input.thread,
    text,
    'operations-reply',
    'route',
  );
  if (!admitted.ok) return admitted;
  const posted = await postInThread({
    room,
    thread: input.thread,
    text: admitted.value.text,
    proof: admitted.value.proof,
  });
  await routed({ route: input.to, member: member.username }, posted.messageId);
  return { ok: true, value: { route: input.to, messageId: posted.messageId } };
}

/**
 * The one top-level post (BC-39): news that changes something for everyone, screened as plain
 * words since everyone reads it, naming nobody, and at most one per channel an hour.
 */
export async function announce(
  room: RoomRow,
  input: { text: string },
): Promise<Outcome<{ messageId: string | null }>> {
  const since = new Date(Date.now() - SUPPORT_ANNOUNCE_EVERY_MS);
  if (await announcedSince(await channelRoomIds(room), since)) {
    return no(
      'SUPPORT_ANNOUNCE_LIMIT',
      '/text',
      `this channel was already told news at top level in the last ${SUPPORT_ANNOUNCE_EVERY_MS / 60_000} minutes; post in the thread the news belongs to. Nothing was posted.`,
    );
  }
  if (mentionsIn(input.text).length > 0) {
    return no(
      'SUPPORT_MENTION_REFUSED',
      '/text',
      'an announcement is for everyone and mentions nobody; nothing was posted',
    );
  }
  const text = await scrubbedForRoom(room, input.text);
  const admitted = await screenForThread(room, null, TOP_LEVEL, text, 'support-reply', 'announce');
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
    input: { text },
    externalId: posted.messageId,
  });
  return { ok: true, value: { messageId: posted.messageId } };
}

/**
 * A member posted a secret (BC-40): what was kept of the message is scrubbed already, and core asks
 * one Technical member, in the thread, to delete it from the chat server, which the bot cannot.
 */
export async function flagSecret(
  room: RoomRow,
  conversationId: string,
  thread: string,
  messageId: string,
  author: { key: string; label: string | null },
): Promise<void> {
  const channel = await channelOfRoom(room);
  const technical = (await membersOf(channel.id))
    .filter((m) => m.roles.includes('technical'))
    .sort((a, b) => (a.state === b.state ? 0 : a.state === 'confirmed' ? -1 : 1))[0];
  const who = author.label ? `@${author.label}'s message` : 'A message';
  const text = technical
    ? `@${technical.username} ${who} in this thread holds a secret. Please delete that message; Forge kept nothing of it.`
    : `${who} in this thread holds a secret. A Technical member should delete that message; Forge kept nothing of it.`;
  const posted = await postInThread({ room, thread, text }).catch(() => null);
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted?.conversationId ?? conversationId,
    thread,
    kind: 'secret_flagged',
    actorKind: 'core',
    input: { message: messageId },
    output: { technical: technical?.username ?? null, posted: Boolean(posted) },
    externalId: posted?.messageId ?? null,
  });
}
