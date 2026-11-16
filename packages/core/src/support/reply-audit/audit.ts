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
import { and, eq } from 'drizzle-orm';
import { readMessages } from '../../conversations/index.js';
import { db } from '../../db/client.js';
import { conversations } from '../../db/schema-conversations.js';
import { supportActions } from '../../db/schema-support.js';
import { supportReplyVerdicts } from '../../db/schema-support-verdicts.js';
import { recordCorrection } from '../../lessons/index.js';
import { doorCatalog } from '../../lib/door-catalog.js';
import { knownThread, no, type Outcome, threadUnknown } from '../outcome.js';
import { roomLanguage } from '../report-thread.js';
import type { RoomRow } from '../store.js';
import { apiHosts } from './code-lines.js';
import { type Judgement, judgeReply } from './judge.js';

/** The thread's last messages the room's language is read from where the project declares none. */
const CONTEXT_MESSAGES = 12;
const REASON_CHARS = 900;

/** The reply the session posted in this room's thread under that chat message id, as it posted it. */
async function replyPosted(room: RoomRow, thread: string, message: string) {
  const [row] = await db
    .select({ input: supportActions.input })
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
  const text = (row?.input as { text?: unknown } | null | undefined)?.text;
  return typeof text === 'string' ? text : null;
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
 * Each miss under the door id the catalog serves it as: an action as forge_find lists it, a route, or a
 * route the catalog folds into an action, which is kept as that action. A door Forge serves none as is
 * refused by name, with the shape a door is named in.
 */
export function missesOf(
  missed: SupportAuditRequest['missed'],
  catalog = doorCatalog(),
): Outcome<ReplyMiss[]> {
  const out: ReplyMiss[] = [];
  for (const [i, m] of (missed ?? []).entries()) {
    const door =
      catalog.doors.find((d) => d.id === m.door) ??
      (/^[A-Z]+ \//.test(m.door) ? catalog.doorOf({ tool: 'rest', action: m.door }) : null);
    if (!door) {
      return no(
        'SUPPORT_AUDIT_DOOR_UNKNOWN',
        `/missed/${i}/door`,
        `${m.door} is no door Forge serves: name a missed capability as forge_find lists it (\`support.member\`) or as a route (\`POST /api/projects/:id/feedback\`). Nothing was kept.`,
      );
    }
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
  const text = await replyPosted(room, input.thread, input.message);
  if (text === null) {
    return no(
      'SUPPORT_MESSAGE_UNKNOWN',
      '/message',
      `${input.message} is no reply you posted in thread ${input.thread}: audit a reply by the messageId reply answered you. Nothing was kept.`,
    );
  }
  const recent = await readMessages(conversationId, CONTEXT_MESSAGES);
  const judgement = judgeReply(
    {
      text,
      language: await roomLanguage(
        room,
        recent.map((m) => m.content),
      ),
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
            sourceRef: `audit:${room.id}:${input.message}`,
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
