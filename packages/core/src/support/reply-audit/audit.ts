// Every stored room line judged right after it is sent (ISS-1250, owner 2026-11-16): a line stored on
// a room thread's conversation is told on the outbox in the transaction that stored it
// (`noteLineStored`), and its reader judges it off the post's path, so a judge that fails or is slow
// never holds or fails the post. The verdict is kept per line; a failed one by the room's agent is a
// room correction in the lessons store (REQ-50, the store `noteRoomReplies` feeds), and nothing else.

import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import type { ReplySubject } from '@forge/contracts/support-reply-audit';
import { eq } from 'drizzle-orm';
import { readMessagesInRange, type StoredConversationMessage } from '../../conversations/index.js';
import { db, type TxOnly } from '../../db/client.js';
import { conversationMessages, conversations } from '../../db/schema-conversations.js';
import { supportReplyVerdicts } from '../../db/schema-support-verdicts.js';
import { callFastModelObject } from '../../integrations/llm/index.js';
import { recordCorrection } from '../../lessons/index.js';
import { logger } from '../../lib/logger.js';
import { emitEvent } from '../../outbox/index.js';
import { channelOf, memberOf } from '../channel-store.js';
import { roomLanguage } from '../report-thread.js';
import { type RoomRow, roomById } from '../store.js';
import { apiHosts } from '../web-links.js';
import {
  type JudgeInput,
  type Judgement,
  judgeLine,
  MODEL_JUDGEMENT,
  type ReplyModel,
  type ThreadLine,
} from './judge.js';

type Stored = OutboxEventPayload<'support.replyStored'>;

/** The thread's last messages the judge reads a line against. */
const CONTEXT_MESSAGES = 12;
const JUDGE_MAX_TOKENS = 400;
const REASON_CHARS = 900;

/** Tell each line `written` holds, in the transaction that stored it: the session's, core's or a silence's. */
export async function noteLineStored(
  tx: TxOnly,
  room: RoomRow,
  conversationId: string,
  written: readonly StoredConversationMessage[],
  subject: ReplySubject,
): Promise<void> {
  for (const message of written) {
    await emitEvent(tx, 'support.replyStored', {
      projectId: room.projectId,
      roomId: room.id,
      conversationId,
      messageId: message.id,
      subject,
    });
  }
}

/** The fast model core reads a room reply's correction with, on the conversation surface. */
export const fastModelJudge =
  (projectId: string): ReplyModel =>
  (prompt) =>
    callFastModelObject(
      { surface: 'conversation', projectId, what: 'a room line judged after it was sent' },
      prompt,
      MODEL_JUDGEMENT,
      { maxTokens: JUDGE_MAX_TOKENS },
    );

const SILENCE_NOTE = /^stayed silent:\s*/;

function threadLineOf(m: StoredConversationMessage): ThreadLine {
  if (m.role === 'assistant') return { who: 'bot', text: m.content };
  if (m.role === 'system') return { who: 'forge', text: m.content };
  return { who: 'person', name: m.authorLabel, text: m.content };
}

/**
 * Who the line answers: the last person who wrote in the thread before it, with their row in the
 * channel record, the one source of who a member is, which core refreshes before each turn.
 */
async function askerOf(
  room: RoomRow,
  earlier: readonly StoredConversationMessage[],
): Promise<JudgeInput['asker']> {
  const last = earlier.filter((m) => m.role === 'user').at(-1);
  const name = last?.authorLabel ?? last?.authorKey;
  if (!name) return null;
  const channel = await channelOf(room.projectId, room.rid);
  const row = channel ? await memberOf(channel.id, name) : null;
  return {
    name,
    record: row
      ? { name: row.username, roles: row.roles, state: row.state, askFor: row.askFor }
      : null,
  };
}

/** The verdict already kept for a line, so a redelivery judges nothing twice. */
async function judgedBefore(messageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: supportReplyVerdicts.id })
    .from(supportReplyVerdicts)
    .where(eq(supportReplyVerdicts.messageId, messageId))
    .limit(1);
  return row !== undefined;
}

const reasonOf = (j: Judgement) =>
  `A room line failed its after-send audit: ${j.findings.map((f) => `${f.line} (${f.why})`).join('; ')}`.slice(
    0,
    REASON_CHARS,
  );

/**
 * Judge one stored line and keep its verdict; the verdict's id, or null where there was nothing to
 * judge (its message or room is gone) or it was judged before. `model` is the fast model by default.
 */
export async function auditStoredLine(
  p: Stored,
  model: ReplyModel = fastModelJudge(p.projectId),
): Promise<string | null> {
  if (await judgedBefore(p.messageId)) return null;
  const [line] = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.id, p.messageId))
    .limit(1);
  const room = await roomById(p.roomId);
  if (!line || !room) return null;
  const earlier = await readMessagesInRange(p.conversationId, {
    firstSeq: 0,
    lastSeq: line.seq - 1,
    limit: CONTEXT_MESSAGES,
  });
  const before = earlier.map(threadLineOf);
  const judgement = await judgeLine(
    {
      subject: p.subject,
      asker: await askerOf(room, earlier),
      text: p.subject === 'silence' ? line.content.replace(SILENCE_NOTE, '') : line.content,
      thread: before,
      language: await roomLanguage(room, [...before.map((b) => b.text), line.content]),
      roomKind: room.kind,
      apiHosts: apiHosts(),
    },
    model,
  );
  if (judgement.miss) {
    logger.warn(
      { projectId: p.projectId, roomId: room.id, messageId: p.messageId, miss: judgement.miss },
      'support: a room line was not read by the model; its verdict holds what code found',
    );
  }
  return keepVerdict(p, room, judgement);
}

/** The verdict and, for a failed line by the room's agent, its room correction, in one write. */
async function keepVerdict(p: Stored, room: RoomRow, j: Judgement): Promise<string | null> {
  const [thread] = await db
    .select({ title: conversations.title })
    .from(conversations)
    .where(eq(conversations.id, p.conversationId));
  return db.transaction(async (tx) => {
    // a line core wrote in the agent's place corrects core, never the agent, so it teaches no lesson
    const correctionId =
      j.verdict === 'fail' && p.subject !== 'core_line'
        ? await recordCorrection(tx, {
            projectId: p.projectId,
            source: 'room',
            sourceRef: `audit:${p.messageId}`,
            item: {
              kind: 'conversation',
              id: p.conversationId,
              key: `Room ${room.rid}`,
              title: thread?.title ?? null,
            },
            reason: reasonOf(j),
            by: { userId: null, agency: 'agent' },
            score: j.score,
          })
        : null;
    const [row] = await tx
      .insert(supportReplyVerdicts)
      .values({
        projectId: p.projectId,
        roomId: room.id,
        roomKind: room.kind,
        bot: room.connectionId,
        conversationId: p.conversationId,
        messageId: p.messageId,
        subject: p.subject,
        verdict: j.verdict,
        failed: j.failed,
        findings: j.findings,
        model: j.model,
        miss: j.miss,
        correctionId,
      })
      .onConflictDoNothing({ target: supportReplyVerdicts.messageId })
      .returning({ id: supportReplyVerdicts.id });
    return row?.id ?? null;
  });
}
