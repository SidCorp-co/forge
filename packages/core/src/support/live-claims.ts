// What a channel agent may say about what is live (ISS-1123): a post that says something is or is
// not live, deployed or released is held to a release read of the same turn, never to memory. The
// turn is the one core opened at its hand-over (`session-turns.ts`, ISS-1202): a `releases` or
// `deployment` read is recorded on the room under that turn, and a claim posted in it finds the
// read. A note core handed the session in this turn that reads an environment itself (a result told
// live, a promise answered, a release reaching production) is the same read, made by core. Anything
// else is refused by name, pointing at the read to make; nothing is posted.

import { and, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { no, type Outcome } from './outcome.js';
import { insertAction, type RoomRow, roomsOfSession } from './store.js';
import { TOP_LEVEL } from './thread.js';

/** The acts that read what an environment serves: the project's releases, a bound target's deployment. */
export const RELEASE_READS: ReadonlySet<string> = new Set(['releases', 'deployment']);

/** The notes core hands a session after reading an environment itself (`result.ts`, `promise-watch.ts`, `release-notes.ts`). */
const RELEASE_NOTE_IDS = ['result:%', 'promise:%', 'release-told:%'] as const;

/**
 * A claim that something is or is not live, deployed or released, in English or Vietnamese: the
 * words of a state of an environment, never an order's or a ticket's (`is live` right after an
 * order or ticket, named or by its code, is that record's state). Contractions (`it's live`),
 * `went live`, and `shipped to` or `pushed to` production count as the plain forms do.
 */
const LIVE_CLAIM_RE =
  /(?<!\b(?:orders?|tickets?|đơn(?:\s+hàng)?)\s+(?:\S+\s+)?)\b(?:is|are|was|were|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|'s|’s|not|now|already|yet|been|still|be)\s+(?:not\s+)?(?:yet\s+)?(?:live|deployed|released|in\s+production|on\s+production|on\s+prod)\b|\b(?:reached|hit)\s+(?:production|prod|staging)\b|\b(?:went|deployed|released|shipped|pushed|live)\s+(?:\S+\s+)?(?:to|on|in)\s+(?:production|prod|staging)\b|\bgo(?:es|ne|ing)?\s+live\b|\bwent\s+live\b|(?:^|[^\p{L}])lên\s+(?:production|prod|staging|live|môi\s+trường)|(?:^|[^\p{L}])(?:đã|chưa|đang|sẽ)\s+(?:được\s+)?(?:triển\s+khai|phát\s+hành|deploy|release)|(?:^|[^\p{L}])trên\s+(?:production|prod)(?![\p{L}])/iu; // i18n-allow: the Vietnamese phrasing of a live or not-live claim being policed

/** The words of a live or not-live claim in `text`, or null where it makes none. */
export function liveClaimIn(text: string): string | null {
  const m = text.match(LIVE_CLAIM_RE);
  return m ? m[0].trim() : null;
}

/** Record a release read the session made, under the turn it made it in. */
export async function noteReleaseRead(
  room: RoomRow,
  turn: string | null | undefined,
  input: { action: string } & Record<string, unknown>,
): Promise<void> {
  if (!turn || !RELEASE_READS.has(input.action)) return;
  const { action, ...args } = input;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread: TOP_LEVEL,
    kind: 'operation',
    actorKind: 'session',
    tool: action,
    input: { ...args, turn },
  });
}

/** Whether the session read a release in this turn, or core handed it a note that read one. */
async function releaseReadInTurn(room: RoomRow, turn: string): Promise<boolean> {
  const rooms = room.sessionId ? await roomsOfSession(room.sessionId) : [room];
  const ids = rooms.map((r) => r.id);
  const [read] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        inArray(supportActions.roomId, ids),
        eq(supportActions.kind, 'operation'),
        eq(supportActions.actorKind, 'session'),
        inArray(supportActions.tool, [...RELEASE_READS]),
        sql`${supportActions.input}->>'turn' = ${turn}`,
      ),
    )
    .limit(1);
  if (read) return true;
  // the turn began when its messages were handed over (`delivery.ts:claimUndelivered`); a note
  // written into it later is of the same turn
  const [began] = await db
    .select({
      at: sql<Date | null>`max(${supportActions.deliveredAt})`.mapWith((v) =>
        v ? new Date(v) : null,
      ),
    })
    .from(supportActions)
    .where(
      and(
        inArray(supportActions.roomId, ids),
        eq(supportActions.kind, 'message_in'),
        sql`${supportActions.output}->>'path' IN ('start', 'send')`,
      ),
    );
  if (!began?.at) return false;
  const [note] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        inArray(supportActions.roomId, ids),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'core'),
        isNotNull(supportActions.deliveredAt),
        gte(supportActions.deliveredAt, began.at),
        or(...RELEASE_NOTE_IDS.map((p) => sql`${supportActions.externalId} LIKE ${p}`)),
      ),
    )
    .limit(1);
  return Boolean(note);
}

/**
 * A channel agent's post that says what is live with no release read this turn, refused and recorded
 * on the thread; null where the post makes no such claim, or the turn read a release.
 */
export async function unreadLiveClaim<T>(
  room: RoomRow,
  post: {
    thread: string;
    conversationId: string | null;
    text: string;
    turn: string | null | undefined;
    tool: string;
  },
): Promise<Outcome<T> | null> {
  if (room.kind !== 'agent') return null;
  const claim = liveClaimIn(post.text);
  if (!claim) return null;
  if (post.turn && (await releaseReadInTurn(room, post.turn))) return null;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: post.conversationId,
    thread: post.thread,
    kind: 'refused',
    actorKind: 'session',
    tool: post.tool,
    input: { text: post.text },
    output: { code: 'SUPPORT_LIVE_CLAIM_UNREAD', claim },
  });
  return no(
    'SUPPORT_LIVE_CLAIM_UNREAD',
    '/text',
    `nothing was posted: "${claim}" says what is live, and this turn read no release. Read it now with support.releases { project } (or support.deployment { target } on a target your grant names), and say the version it returns; never what is live from memory or an earlier turn.`,
  );
}
