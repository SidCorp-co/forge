// A secret a member posts (REQ-75 BC-40): told to the session once per thread, and a key sent alone
// held as one where the thread says a key is what it is.
//
// ISS-1326: the scrubber reads a secret by its label or its known prefix, and a bare hex key has
// neither, since record ids, uuids and shas share its shape (ISS-614). In a chat thread the words
// around it tell them apart: one opaque token sent alone, right after a secret was filtered there or
// after its writer said a key is coming, is a secret; the same token in a thread about anything else
// is an id, and stays as it was written.
//
// ISS-1372 (owner 2026-11-20): what a member hands over is kept in the bound project's vault before
// the message is recorded (`secret-keep.ts`), and the note the session is handed names each entry,
// its project, who can use it and the page where it is revoked or replaced, to say once in the same
// reply. Nobody is asked to delete the message or rotate what it held: they chose to send it, and the
// message is theirs. Core posts nothing (ISS-845). Each value not kept is named with why, never by
// itself; where nothing was kept and the thread asked for a slot (ISS-1348), the note carries that
// slot's link and write command.

import { SUPPORT_KEPT_SECRET_SCOPE } from '@forge/contracts/support';
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema-projects.js';
import { supportActions } from '../db/schema-support.js';
import type { RocketChatIncomingMessage } from '../integrations/rocketchat/index.js';
import { webBaseUrl } from '../lib/web-base-url.js';
import { type KeptEntry, SECRET_VALUE_MAX, slotKeyOf } from '../project-config/index.js';
import { threadOf } from './rules.js';
import { againOf, openAskIn, recordAsk } from './secret-asks.js';
import type { KeptHere, NotKept, NotKeptWhy } from './secret-keep.js';
import { secretWriteOf } from './secret-link.js';
import { anchorOf } from './secret-page-slots.js';
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
 * The writer's last messages before `m` that speak for it, newest first: in its thread, or, for a
 * message at the top level (a thread of its own), the writer's top-level messages, within
 * `SECRET_CONTEXT_MS`. Read alike by `bareKeyInContext` and `toldBefore`, so a key filtered by its
 * context is told as that context was told.
 */
async function writerContext(
  roomId: string,
  m: Pick<RocketChatIncomingMessage, 'id' | 'tmid' | 'userId'>,
  since: Date,
): Promise<{ id: string | null; input: unknown }[]> {
  const where = m.tmid
    ? eq(supportActions.thread, threadOf(m))
    : sql`${supportActions.thread} = ${supportActions.externalId}`;
  return db
    .select({ id: supportActions.externalId, input: supportActions.input })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'member'),
        eq(supportActions.actorKey, m.userId),
        gte(supportActions.createdAt, since),
        sql`${supportActions.externalId} IS DISTINCT FROM ${m.id}`,
        where,
      ),
    )
    .orderBy(desc(supportActions.createdAt))
    .limit(3);
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
  const before = await writerContext(room.id, m, since);
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

/**
 * Whether the thread was already told of a secret: the note is said once per thread. A message at the
 * top level is told as its context was (`writerContext`), the writer's recent top-level messages,
 * which `bareKeyInContext` read as one thread.
 */
async function toldBefore(
  roomId: string,
  thread: string,
  messageId: string,
  writer: string,
): Promise<boolean> {
  let told = eq(supportActions.thread, thread);
  if (thread === messageId) {
    const since = new Date(Date.now() - SECRET_CONTEXT_MS);
    const context = await writerContext(roomId, { id: messageId, userId: writer }, since);
    const ids = context.flatMap((r) => (r.id ? [r.id] : []));
    if (ids.length) told = or(told, inArray(sql`${supportActions.input}->>'message'`, ids)) ?? told;
  }
  const [row] = await db
    .select({ n: sql<number>`1` })
    .from(supportActions)
    .where(and(eq(supportActions.roomId, roomId), eq(supportActions.kind, 'secret_flagged'), told))
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

/** The act that makes a slot's door, where the thread asked for none yet and nothing was kept. */
const ASK_THE_DOOR =
  'Where they want it used, give in that same reply the link and the one-time write command support.secret_link { thread, kind, …, presign: true } answers for the slot they meant (a variable, a testing profile’s credential or an integration’s); never name a settings screen yourself.';

/** Never asked of the person who sent it (ISS-1372, owner 2026-11-20): the message is theirs. */
const NOTHING_ASKED =
  'Ask nobody to delete the message, or to rotate, change or revoke what it held: they chose to send it, the chat message is theirs, and Forge deletes nothing of it. Never repeat what it held.';

/** Where a kept entry is revoked or replaced: its row on the project's Secrets page. */
function entryPage(slug: string, projectId: string, ref: string): string | null {
  const web = webBaseUrl();
  if (!web) return null;
  const anchor = anchorOf(slotKeyOf({ projectId, key: ref, environment: null }));
  return `${web}/projects/${slug}/settings?tab=secrets#${anchor}`;
}

/** One kept entry as the note says it: its name, project, who can use it and where it is revoked. */
function keptLine(e: KeptEntry, project: { id: string; slug: string }, who: string): string {
  const page = entryPage(project.slug, project.id, e.ref);
  const use =
    e.state === 'usable'
      ? `usable now for ${project.slug}'s own work, read at GET /api/projects/${project.id}/acting-secrets/${SUPPORT_KEPT_SECRET_SCOPE}/${e.name} and audited on every read; acts done with it are recorded as ${e.actsAs}`
      : `${who} holds no project admin on ${project.slug}, so nobody reads it until a person holding project admin approves it in Forge, and it is destroyed unused at ${e.expiresAt}`;
  return `"${e.label}" (${e.kind}) kept in ${project.slug}'s vault as ${e.ref}: ${use}; it is revoked or replaced on its page${page ? ` ${page}` : ` (the Secrets page of ${project.slug})`}.`;
}

/** Why a value was not kept, as the note says it. */
const NOT_KEPT_WHY: Record<NotKeptWhy, string> = {
  no_vault: 'this core has no vault key',
  too_long: `it is longer than the ${SECRET_VALUE_MAX} characters a secret holds`,
  unreadable: 'it could not be read back exactly from the message',
  failed: 'keeping it failed',
};

/** Each value not kept, by its words and its place among the filtered ones, never by itself. */
const missedOf = (missed: readonly NotKept[]) =>
  missed
    .map((n) => `"${n.label}" (filtered value ${n.index + 1}): ${NOT_KEPT_WHY[n.why]}`)
    .join('; ');

/**
 * The note on a thread's secret: what was kept, said once in this reply, and nothing asked of its
 * sender, not even a slot the thread asked for; each value not kept, with why, so nobody is told Forge
 * holds it; where nothing was kept, the door.
 */
export function secretNote(input: {
  messageId: string;
  who: string;
  held: Pick<KeptHere, 'kept' | 'missed'>;
  project: { id: string; slug: string };
  again: boolean;
  door: string | null;
}): string {
  const { messageId, who, project, again, door } = input;
  const { kept, missed } = input.held;
  if (kept.length > 0) {
    return [
      `Message ${messageId} from ${who} in this thread held ${kept.length === 1 ? 'a credential' : `${kept.length} credentials`}, and Forge kept ${kept.length === 1 ? 'it' : 'them'} before the message was recorded; the room's record and transcript read [Secret kept: <name>] where each stood.`,
      ...kept.map((e) => keptLine(e, project, who)),
      ...(missed.length > 0
        ? [
            `Not kept, so the record reads [Filtered] there and no vault holds it: ${missedOf(missed)}.`,
          ]
        : []),
      `Tell the room once, in this same reply and in your own words: what was kept, under which name, for which project, what happens to it (it is usable now, or waits for a project admin's approval), what they need to do (nothing, unless they want it revoked or replaced, and where), and the page${missed.length > 0 ? ', and what was not kept and why' : ''}. Say it as what you did and know, in the second person, and never name a master, a team or a hand-off. Then go on with what they sent it for.`,
      `Where the person wants something done with it, ask with support.ask_master naming its secret:// name, never the value; that act is yours, never something to say.`,
      NOTHING_ASKED,
    ].join(' ');
  }
  return [
    `Message ${messageId} from ${who} in this thread held a secret, and Forge could not keep it, so the room's record reads [Filtered] and no vault holds it${missed.length > 0 ? `: ${missedOf(missed)}` : ''}.`,
    again
      ? 'This thread was already told once: say nothing more of it, and answer what the person asked.'
      : 'Say so once in this thread, in your own words.',
    door ?? ASK_THE_DOOR,
    NOTHING_ASKED,
  ].join(' ');
}

/**
 * A member posted a secret (BC-40): it was kept in the bound project's vault before the message was
 * recorded (ISS-1372, `secret-keep.ts`), and the session is handed the fact, which entry, under which
 * name, who can use it and where it is revoked, to say once in its own words in the same reply. Nobody
 * is asked to delete anything. Core posts nothing (ISS-845).
 */
export async function flagSecret(
  room: RoomRow,
  conversationId: string,
  thread: string,
  messageId: string,
  author: { key: string; label: string | null },
  held: Pick<KeptHere, 'kept' | 'missed'>,
): Promise<void> {
  const { kept } = held;
  const who = author.label ? `@${author.label}` : `account ${author.key}`;
  const again = await toldBefore(room.id, thread, messageId, author.key);
  // once a value is kept nothing more is asked of its sender (owner, 2026-11-20): the slot's door
  // (ISS-1348 c4) is given only where nothing was kept and the thread still owes that slot
  const door = kept.length > 0 ? null : await doorLine(room, thread);
  const [project] = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, room.projectId))
    .limit(1);
  const note = secretNote({
    messageId,
    who,
    held,
    project: project ?? { id: room.projectId, slug: room.projectId },
    again,
    door,
  });
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
    output: {
      posted: false,
      told: again ? 'again' : 'first',
      kept: kept.map((e) => ({ ref: e.ref, state: e.state })),
      missed: held.missed.map((n) => ({ index: n.index, why: n.why })),
    },
  });
}
