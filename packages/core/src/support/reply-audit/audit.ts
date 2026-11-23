// support.audit (ISS-1250; owner 2026-11-16, "teach the flow, not block it"): right after it posts a
// reply, the room's agent scores it against the one rubric, and the verdict is kept per reply with
// what code found beside its reading. Nothing here holds, rewrites or judges a reply on its behalf.
// A failed verdict is a room correction in the lessons store (REQ-50, the store `noteRoomReplies`
// feeds), from which the steward's pass draws the lessons the room's next turns carry. What the agent
// says the reply missed (a capability it should have reached for) is kept as it named it, each door
// read against the catalog Forge serves (ISS-1251) and a REST read against the routes the app serves
// (ISS-1395): the capabilities page counts misses from here.

import type {
  ReplyMiss,
  SupportAuditRequest,
  SupportAuditView,
} from '@forge/contracts/support-reply-audit';
import { and, desc, eq, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { readMessages } from '../../conversations/index.js';
import { db } from '../../db/client.js';
import { conversations } from '../../db/schema-conversations.js';
import { supportActions } from '../../db/schema-support.js';
import { supportReplyVerdicts } from '../../db/schema-support-verdicts.js';
import { doorNamed as servedDoorNamed } from '../../guides/index.js';
import { auditCorrectionRef, recordCorrection } from '../../lessons/index.js';
import { doorCatalog } from '../../lib/door-catalog.js';
import { handedOn, isStateRead, stateRead } from '../dated-reads.js';
import { supportConfigOf } from '../grants.js';
import { RELEASE_READS, releaseReadInTurn } from '../live-claims.js';
import { roleOfRoom } from '../ops-role.js';
import { knownThread, no, type Outcome, threadUnknown } from '../outcome.js';
import { sessionTurnSpan } from '../session-turns.js';
import type { RoomRow } from '../store.js';
import { type AnsweringLanguage, answeringLanguageOf } from './answering-language.js';
import { apiHosts } from './code-lines.js';
import { type Judgement, judgeReply, type TurnReads } from './judge.js';

/** The thread's last messages the room's language is read from where neither the asker nor the persona tells it. */
const CONTEXT_MESSAGES = 12;
const REASON_CHARS = 900;

interface Posted {
  text: string;
  /** The thread it was posted in. */
  thread: string;
  /** The request it named, asked in another thread of the room (ISS-1314). */
  request: string | null;
  /** That request's thread, where it named one. */
  requestThread: string | null;
  at: Date;
  /** The session and turn that posted it, where a turn's request did (ISS-1029). */
  sessionId: string | null;
  turnId: string | null;
}

/** The reply the session posted in this room's thread under that chat message id, as it posted it. */
async function replyPosted(room: RoomRow, thread: string, message: string): Promise<Posted | null> {
  const [row] = await db
    .select({
      input: supportActions.input,
      at: supportActions.createdAt,
      sessionId: supportActions.sessionId,
      turnId: supportActions.turnId,
    })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.thread, thread),
        eq(supportActions.kind, 'reply'),
        eq(supportActions.externalId, message),
      ),
    )
    .limit(1);
  const input = row?.input as
    | { text?: unknown; request?: { message?: unknown; thread?: unknown } }
    | null
    | undefined;
  if (!row || typeof input?.text !== 'string') return null;
  const request = input.request?.message;
  const requestThread = input.request?.thread;
  return {
    text: input.text,
    thread,
    request: typeof request === 'string' ? request : null,
    requestThread: typeof requestThread === 'string' ? requestThread : null,
    at: row.at,
    sessionId: row.sessionId,
    turnId: row.turnId,
  };
}

/**
 * Whether an act landed somewhere else (a raise, a route, an ask or a filing) in the reply's thread or
 * the thread of the request it named, before the reply and in any turn of the conversation (ISS-1423):
 * "I raised it earlier" told in a later turn reports an act that landed.
 */
async function handedOnBefore(roomId: string, posted: Posted): Promise<boolean> {
  const threads = [posted.thread, ...(posted.requestThread ? [posted.requestThread] : [])];
  const [row] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        inArray(supportActions.thread, threads),
        handedOn,
        lte(supportActions.createdAt, posted.at),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Whether a master's answer to the room's ask (`master-ask.ts:answerMasterAsk`) was handed in the
 * reply's turn (ISS-1430): delivered at or after the turn's hand-over (its messages are stamped
 * delivered just before the turn opens, one written into the running turn later) and before the reply.
 */
async function masterAnsweredInTurn(roomId: string, posted: Posted, turnId: string) {
  const span = await sessionTurnSpan(turnId);
  if (!span) return false;
  const opened = span.startedAt.toISOString();
  const handedAt = sql`COALESCE((SELECT max(t.delivered_at) FROM support_actions t
    WHERE t.room_id = ${roomId} AND t.kind = 'message_in' AND t.output->>'path' IN ('start', 'send')
      AND t.delivered_at <= ${opened}::timestamptz), ${opened}::timestamptz)`;
  const [row] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'core'),
        sql`${supportActions.input}->>'ask' IS NOT NULL`,
        sql`${supportActions.deliveredAt} >= ${handedAt}`,
        lte(supportActions.deliveredAt, posted.at),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The acts around a reply its session posted in a turn: whether that turn read live state or looked
 * at a screen, whether an act landed somewhere else in that turn or earlier in the conversation,
 * whether a master's answer was handed in it, and when the session last read in an earlier turn.
 * Undefined where the reply names no turn.
 */
async function readsAround(room: RoomRow, posted: Posted): Promise<TurnReads | undefined> {
  if (!posted.sessionId || !posted.turnId) return undefined;
  const roomId = room.id;
  const inTurn = and(
    eq(supportActions.sessionId, posted.sessionId),
    eq(supportActions.turnId, posted.turnId),
  );
  const mine = await db
    .select({ kind: supportActions.kind, tool: supportActions.tool })
    .from(supportActions)
    .where(and(inTurn, or(stateRead, handedOn)));
  const reads = mine.filter((r) => isStateRead(r.kind, r.tool));
  const acted = reads.length < mine.length || (await handedOnBefore(roomId, posted));
  // ISS-1440: a read of the turn is a read of the thing it read; an issue read says nothing of what is served
  const servedRead =
    reads.some((r) => r.tool !== null && RELEASE_READS.has(r.tool)) ||
    (await releaseReadInTurn(room, posted.turnId));
  const masterAnswered = await masterAnsweredInTurn(roomId, posted, posted.turnId);
  const [earlier] =
    reads.length > 0
      ? []
      : await db
          .select({
            at: sql<Date | null>`max(${supportActions.createdAt})`.mapWith((v) =>
              v ? new Date(v) : null,
            ),
          })
          .from(supportActions)
          .where(
            and(
              eq(supportActions.sessionId, posted.sessionId),
              stateRead,
              ne(supportActions.turnId, posted.turnId),
              lte(supportActions.createdAt, posted.at),
            ),
          );
  return turnReadsOf({
    reads,
    acted,
    servedRead,
    masterAnswered,
    earlierAt: earlier?.at ?? null,
  });
}

/**
 * The reads around a reply from what its turn did (ISS-1440): a master's answer handed in the turn is
 * kept whether or not the turn also read something, because his check covers a claim the turn's own
 * read did not reach ("the release says shipped" read, "it works" said as his).
 */
export function turnReadsOf(input: {
  reads: readonly { kind: string; tool: string | null }[];
  acted: boolean;
  servedRead: boolean;
  masterAnswered: boolean;
  earlierAt: Date | null;
}): TurnReads {
  const { reads, acted, servedRead, masterAnswered } = input;
  const read = reads.length > 0;
  return {
    thisTurn: read,
    earlierAt: read ? null : input.earlierAt,
    looked: reads.some((r) => r.tool === 'look'),
    handedOn: acted,
    masterAnswered,
    servedRead,
    behaviourRead: reads.some((r) => r.kind === 'diagnose' || r.tool === 'look'),
  };
}

const textOf = (input: unknown) => {
  const text = (input as { text?: unknown } | null | undefined)?.text;
  return typeof text === 'string' ? text : null;
};

/**
 * What the person the reply answers wrote: the request it named, else the thread's latest message a
 * member wrote before it. Null where no member wrote one.
 */
async function askedOf(room: RoomRow, thread: string, reply: Posted): Promise<string | null> {
  const [row] = await db
    .select({ input: supportActions.input })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'member'),
        ...(reply.request
          ? [eq(supportActions.externalId, reply.request)]
          : [eq(supportActions.thread, thread), lte(supportActions.createdAt, reply.at)]),
      ),
    )
    .orderBy(desc(supportActions.createdAt))
    .limit(1);
  return textOf(row?.input);
}

/** The persona the room's agent is briefed with: an operations room's role's, else its binding's. */
async function personaOf(room: RoomRow): Promise<string | null> {
  if (room.kind === 'operations') {
    const role = await roleOfRoom(room);
    return role.ok ? role.value.persona : null;
  }
  return (await supportConfigOf(room))?.persona ?? null;
}

/**
 * The language the reply is held to (ISS-1377): the room's answering language, read from the person
 * it answers, the persona, then the room's people, never the project's content language.
 */
async function answeringOf(
  room: RoomRow,
  thread: string,
  conversationId: string,
  reply: Posted,
): Promise<AnsweringLanguage> {
  const recent = await readMessages(conversationId, CONTEXT_MESSAGES);
  return answeringLanguageOf({
    asked: await askedOf(room, thread, reply),
    persona: await personaOf(room),
    texts: recent.filter((m) => m.role === 'user').map((m) => m.content),
  });
}

async function verdictOf(roomId: string, message: string): Promise<SupportAuditView | null> {
  const [row] = await db
    .select()
    .from(supportReplyVerdicts)
    .where(and(eq(supportReplyVerdicts.roomId, roomId), eq(supportReplyVerdicts.message, message)))
    .limit(1);
  if (!row) return null;
  return {
    verdict: row.verdict,
    failed: row.failed as SupportAuditView['failed'],
    findings: row.findings as SupportAuditView['findings'],
    missed: row.missed as ReplyMiss[],
    correctionId: row.correctionId,
    already: true,
  };
}

const reasonOf = (j: Judgement) =>
  `A room reply failed its audit: ${j.findings.map((f) => `${f.line} (${f.why})`).join('; ')}`.slice(
    0,
    REASON_CHARS,
  );

/**
 * The door a capability is named as: an action as forge_find lists it, the capability name a Tier-0
 * map gives a REST door (`issues.merge`), a twin or card id, a route, or a route the catalog folds
 * into an action, which is that action. Null where Forge serves no such door.
 */
export function doorNamed(ref: string, catalog = doorCatalog()) {
  return (
    servedDoorNamed(catalog, ref) ??
    (/^[A-Z]+ \//.test(ref) ? catalog.doorOf({ tool: 'rest', action: ref }) : null)
  );
}

/**
 * The refusal a name that is neither a capability nor a route Forge serves answers, with the shapes a
 * door is named in.
 */
export const doorUnknown = <T>(
  code: 'SUPPORT_AUDIT_DOOR_UNKNOWN' | 'SELF_AUDIT_DOOR_UNKNOWN',
  path: string,
  ref: string,
): Outcome<T> =>
  no(
    code,
    path,
    `${ref} is no door Forge serves: no capability and no route by that name. Name a capability as your map or forge_find names it (\`support.member\`, \`issues.merge\`) or a route the API serves as METHOD /path (\`GET /api/projects/:id/boxes\`). Nothing was kept.`,
  );

/**
 * Each miss under the door id the catalog serves it as: an action as forge_find lists it, a route, or a
 * route the catalog folds into an action, which is kept as that action. A route the app serves that no
 * door counts (a REST read, ISS-1395) is kept as its route, since that is what the agent should have
 * reached for. A name that is neither is refused by name, with the shapes a door is named in.
 */
export function missesOf(
  missed: SupportAuditRequest['missed'],
  catalog = doorCatalog(),
  code: 'SUPPORT_AUDIT_DOOR_UNKNOWN' | 'SELF_AUDIT_DOOR_UNKNOWN' = 'SUPPORT_AUDIT_DOOR_UNKNOWN',
): Outcome<ReplyMiss[]> {
  const out: ReplyMiss[] = [];
  for (const [i, m] of (missed ?? []).entries()) {
    const id = doorNamed(m.door, catalog)?.id ?? catalog.servedRoute(m.door);
    if (!id) return doorUnknown(code, `/missed/${i}/door`, m.door);
    if (!out.some((o) => o.door === id)) out.push({ door: id, why: m.why });
  }
  return { ok: true, value: out };
}

/**
 * Keep the agent's audit of its own reply: the verdict, and for a failed one its room correction, in
 * one write. A reply audited before answers that verdict unchanged; a message that is no reply the
 * session posted in this thread is refused by name, and nothing is kept.
 */
export async function auditReply(
  room: RoomRow,
  input: SupportAuditRequest,
): Promise<Outcome<SupportAuditView>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const missed = missesOf(input.missed);
  if (!missed.ok) return missed;
  const before = await verdictOf(room.id, input.message);
  if (before) return { ok: true, value: before };
  const posted = await replyPosted(room, input.thread, input.message);
  if (posted === null) {
    return no(
      'SUPPORT_MESSAGE_UNKNOWN',
      '/message',
      `${input.message} is no reply you posted in thread ${input.thread}: audit a reply by the messageId reply answered you. Nothing was kept.`,
    );
  }
  const judgement = judgeReply(
    {
      text: posted.text,
      language: await answeringOf(room, input.thread, conversationId, posted),
      roomKind: room.kind,
      apiHosts: apiHosts(),
      reads: await readsAround(room, posted),
    },
    input.failed,
  );
  const [thread] = await db
    .select({ title: conversations.title })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  const kept = await db.transaction(async (tx) => {
    const correctionId =
      judgement.verdict === 'fail'
        ? await recordCorrection(tx, {
            projectId: room.projectId,
            source: 'room',
            sourceRef: auditCorrectionRef(room.id, input.message),
            item: {
              kind: 'conversation',
              id: conversationId,
              key: `Room ${room.rid}`,
              title: thread?.title ?? null,
            },
            reason: reasonOf(judgement),
            by: { userId: room.principalUserId, agency: 'agent' },
            // the agent's own finding, or code's: neither is a guess the threshold weighs
            score: 1,
          })
        : null;
    const [row] = await tx
      .insert(supportReplyVerdicts)
      .values({
        projectId: room.projectId,
        roomId: room.id,
        roomKind: room.kind,
        bot: room.connectionId,
        conversationId,
        thread: input.thread,
        message: input.message,
        verdict: judgement.verdict,
        failed: judgement.failed,
        findings: judgement.findings,
        missed: missed.value,
        correctionId,
      })
      .onConflictDoNothing({ target: [supportReplyVerdicts.roomId, supportReplyVerdicts.message] })
      .returning({ id: supportReplyVerdicts.id });
    return row ? correctionId : undefined;
  });
  // a second audit of the same reply raced this one and was kept first: answer that one
  if (kept === undefined) {
    const raced = await verdictOf(room.id, input.message);
    if (raced) return { ok: true, value: raced };
  }
  return {
    ok: true,
    value: { ...judgement, missed: missed.value, correctionId: kept ?? null, already: false },
  };
}
