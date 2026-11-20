// support.audit (ISS-1250; owner 2026-11-16, "teach the flow, not block it"): right after it posts a
// reply, the room's agent scores it against the one rubric, and the verdict is kept per reply with
// what code found beside its reading. Nothing here holds, rewrites or judges a reply on its behalf.
// A failed verdict is a room correction in the lessons store (REQ-50, the store `noteRoomReplies`
// feeds), from which the steward's pass draws the lessons the room's next turns carry. What the agent
// says the reply missed (a capability it should have reached for) is kept as it named it, each door
// read against the catalog Forge serves (ISS-1251): the capabilities page counts misses from here.

import type {
  ReplyMiss,
  SupportAuditRequest,
  SupportAuditView,
} from '@forge/contracts/support-reply-audit';
import { and, desc, eq, lte } from 'drizzle-orm';
import { readMessages } from '../../conversations/index.js';
import { db } from '../../db/client.js';
import { conversations } from '../../db/schema-conversations.js';
import { supportActions } from '../../db/schema-support.js';
import { supportReplyVerdicts } from '../../db/schema-support-verdicts.js';
import { doorNamed as servedDoorNamed } from '../../guides/index.js';
import { auditCorrectionRef, recordCorrection } from '../../lessons/index.js';
import { doorCatalog } from '../../lib/door-catalog.js';
import { supportConfigOf } from '../grants.js';
import { roleOfRoom } from '../ops-role.js';
import { knownThread, no, type Outcome, threadUnknown } from '../outcome.js';
import type { RoomRow } from '../store.js';
import { type AnsweringLanguage, answeringLanguageOf } from './answering-language.js';
import { apiHosts } from './code-lines.js';
import { type Judgement, judgeReply } from './judge.js';

/** The thread's last messages the room's language is read from where neither the asker nor the persona tells it. */
const CONTEXT_MESSAGES = 12;
const REASON_CHARS = 900;

interface Posted {
  text: string;
  /** The request it named, asked in another thread of the room (ISS-1314). */
  request: string | null;
  at: Date;
}

/** The reply the session posted in this room's thread under that chat message id, as it posted it. */
async function replyPosted(room: RoomRow, thread: string, message: string): Promise<Posted | null> {
  const [row] = await db
    .select({ input: supportActions.input, at: supportActions.createdAt })
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
    | { text?: unknown; request?: { message?: unknown } }
    | null
    | undefined;
  if (!row || typeof input?.text !== 'string') return null;
  const request = input.request?.message;
  return { text: input.text, request: typeof request === 'string' ? request : null, at: row.at };
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

/** The refusal a door Forge serves none as answers, with the shape a door is named in. */
export const doorUnknown = <T>(
  code: 'SUPPORT_AUDIT_DOOR_UNKNOWN' | 'SELF_AUDIT_DOOR_UNKNOWN',
  path: string,
  ref: string,
): Outcome<T> =>
  no(
    code,
    path,
    `${ref} is no door Forge serves: name a capability as your map or forge_find names it (\`support.member\`, \`issues.merge\`) or as a route (\`POST /api/projects/:id/feedback\`). Nothing was kept.`,
  );

/**
 * Each miss under the door id the catalog serves it as: an action as forge_find lists it, a route, or a
 * route the catalog folds into an action, which is kept as that action. A door Forge serves none as is
 * refused by name, with the shape a door is named in.
 */
export function missesOf(
  missed: SupportAuditRequest['missed'],
  catalog = doorCatalog(),
  code: 'SUPPORT_AUDIT_DOOR_UNKNOWN' | 'SELF_AUDIT_DOOR_UNKNOWN' = 'SUPPORT_AUDIT_DOOR_UNKNOWN',
): Outcome<ReplyMiss[]> {
  const out: ReplyMiss[] = [];
  for (const [i, m] of (missed ?? []).entries()) {
    const door = doorNamed(m.door, catalog);
    if (!door) return doorUnknown(code, `/missed/${i}/door`, m.door);
    if (!out.some((o) => o.door === door.id)) out.push({ door: door.id, why: m.why });
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
