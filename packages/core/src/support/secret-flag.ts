// A secret a member posts (REQ-75 BC-40): told to the session once per thread, and a key sent alone
// held as one where the thread says a key is what it is.
//
// ISS-1326: the scrubber reads a secret by its label or its known prefix, and a bare hex key has
// neither, since record ids, uuids and shas share its shape (ISS-614). In a chat thread the words
// around it tell them apart: one opaque token sent alone, right after a secret was filtered there or
// after its writer said a key is coming, is a secret; the same token in a thread about anything else
// is an id, and stays as it was written.
//
// ISS-1328: the note the session is handed asks for the deletion once, says why nothing was kept and
// names the credential door (`support.secret_link`) in the same line; a later secret in the same
// thread is told as already said, so no second deletion ask and no rotation ask ever follow. Core
// posts nothing (ISS-845). ISS-1348: where the thread asked for a slot, the note carries that slot's
// link and a fresh one-time write command, for the reply to give at once.

import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import type { RocketChatIncomingMessage } from '../integrations/rocketchat/index.js';
import { webBaseUrl } from '../lib/web-base-url.js';
import { channelOfRoom, shownNames } from './channel.js';
import { membersOf } from './channel-store.js';
import { threadOf } from './rules.js';
import { againOf, openAskIn, recordAsk } from './secret-asks.js';
import { secretWriteOf } from './secret-link.js';
import { slotLabelOf } from './secret-receipts.js';
import { insertAction, type RoomRow } from './store.js';

/** How recent a filtered secret or a writer's word that a key is coming still speaks for a token. */
const SECRET_CONTEXT_MS = 15 * 60_000;

/** One opaque token: no space, long enough to be a key, letters and digits both, and no address. */
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_+/=.-]{15,}$/;

/** Words saying a key or a secret is what comes next, in the languages the rooms write in. */
const KEY_COMING = new RegExp(
  [
    '\\b(?:secret|api[ _-]?key|key|token|password|passwd|credential',
    'mật khẩu|khóa|khoá|mã bí mật)\\b', // i18n-allow: the Vietnamese words rooms say a key with
  ].join('|'),
  'i',
);

/** Whether a message is one opaque token alone, the shape a key and an id share. */
function isBareToken(text: string): boolean {
  const t = text.trim();
  return OPAQUE.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t) && !/^https?:/i.test(t);
}

/**
 * Whether a bare token is a secret by what stands around it (ISS-1326): a secret was filtered in its
 * thread (at the top level, from its writer) within `SECRET_CONTEXT_MS`, or its writer's message just
 * before it says a key or secret is coming. A token in any other thread is an id (ISS-614).
 */
export async function bareKeyInContext(
  room: Pick<RoomRow, 'id'>,
  m: Pick<RocketChatIncomingMessage, 'id' | 'tmid' | 'text' | 'userId'>,
): Promise<boolean> {
  if (!isBareToken(m.text)) return false;
  const since = new Date(Date.now() - SECRET_CONTEXT_MS);
  const thread = threadOf(m);
  // a message at the top level is a thread of its own: its writer's top-level messages are its context
  const where = m.tmid
    ? eq(supportActions.thread, thread)
    : sql`${supportActions.thread} = ${supportActions.externalId}`;
  const before = await db
    .select({ id: supportActions.externalId, input: supportActions.input })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'member'),
        eq(supportActions.actorKey, m.userId),
        gte(supportActions.createdAt, since),
        where,
      ),
    )
    .orderBy(desc(supportActions.createdAt))
    .limit(3);
  const ids = before.flatMap((r) => (r.id ? [r.id] : []));
  const [flagged] = await db
    .select({ n: sql<number>`1` })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.kind, 'secret_flagged'),
        gte(supportActions.createdAt, since),
        m.tmid
          ? or(
              eq(supportActions.thread, thread),
              inArray(sql`${supportActions.input}->>'message'`, ids.length ? ids : ['']),
            )
          : inArray(sql`${supportActions.input}->>'message'`, ids.length ? ids : ['']),
      ),
    )
    .limit(1);
  if (flagged) return true;
  const said = (before[0]?.input as { text?: unknown } | null)?.text;
  return typeof said === 'string' && KEY_COMING.test(said);
}

/** Whether the thread was already told of a secret: the note is said once per thread. */
async function toldBefore(roomId: string, thread: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`1` })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.thread, thread),
        eq(supportActions.kind, 'secret_flagged'),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The door the note gives (ISS-1348 c4): where this thread asked for a slot already, that slot's link
 * and a fresh one-time write command, to give at once; otherwise the act that makes them.
 */
async function doorLine(room: RoomRow, thread: string): Promise<string | null> {
  const asked = await openAskIn(room.id, thread);
  const web = webBaseUrl();
  if (asked && web) {
    const { row, token } = await recordAsk(againOf(asked), true);
    const write =
      token && row.writeExpiresAt ? secretWriteOf(web, token, row.writeExpiresAt) : null;
    return [
      `This thread asked for ${slotLabelOf(asked)}: in that same reply, give the person its link ${asked.link}`,
      write
        ? `and, where the value sits in a file, this command, good once for ${write.minutes} minutes: ${write.command}`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return null;
}

/** The act that makes a slot's door, where the thread asked for none yet. */
const ASK_THE_DOOR =
  'In that same reply, give the person the link and the one-time write command support.secret_link { thread, kind, …, presign: true } answers for the slot they meant (a variable, a testing profile’s credential or an integration’s), so the right door is the first one next time; never name a settings screen yourself.';

/** The note on a thread's first secret: once, why, the door, one deletion ask, no rotation. */
function firstSecretNote(
  messageId: string,
  who: string,
  asked: string | null,
  door: string | null,
): string {
  return [
    `Message ${messageId} from ${who} in this thread held a secret; Forge kept nothing of it, and the bot cannot delete it.`,
    'Say so once in this thread, in your own words: that it was not kept, and why (a secret is never kept in chat or in Forge).',
    door ?? ASK_THE_DOOR,
    `You may ask ${asked ? `@${asked}` : 'a Technical member'} once to delete that message from the chat server; if its author or a Technical member declines, that is settled for this thread and is never asked again.`,
    'Never ask anyone to rotate, change or revoke it, never repeat what it held, and never keep it anywhere.',
  ].join(' ');
}

/** The note on a later secret in a thread already told: nothing is said of it again. */
function againSecretNote(messageId: string, who: string, door: string | null): string {
  return [
    `Message ${messageId} from ${who} in this thread also held a secret; Forge kept nothing of it.`,
    'This thread was already told once: say nothing more of it, ask no deletion and no rotation, and answer what the person asked.',
    door
      ? `Where they want it used: ${door}. Never repeat what it held.`
      : 'Where they want it used, the link support.secret_link answers is still the way; never repeat what it held.',
  ].join(' ');
}

/**
 * A member posted a secret (BC-40): what was kept of the message is scrubbed already, and the session
 * is handed the fact (which message, whose, the Technical member who can delete it and the credential
 * door) to say in its own words, once per thread (ISS-1328). Core posts nothing (ISS-845).
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
  const who = author.label ? `@${author.label}` : `account ${author.key}`;
  const asked = technical ? (await shownNames(room, [technical]))(technical.username) : null;
  const again = await toldBefore(room.id, thread);
  const door = await doorLine(room, thread);
  const note = again
    ? againSecretNote(messageId, who, door)
    : firstSecretNote(messageId, who, asked, door);
  // the fact goes to the session as a note of the thread, handed on with the message itself
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread,
    kind: 'message_in',
    actorKind: 'core',
    input: { note },
    externalId: `secret:${messageId}`,
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread,
    kind: 'secret_flagged',
    actorKind: 'core',
    input: { message: messageId },
    output: { technical: asked, posted: false, told: again ? 'again' : 'first' },
  });
}
