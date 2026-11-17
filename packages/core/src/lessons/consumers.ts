/**
 * The corrections that reach lessons through the outbox (REQ-50 BC-1; the others are recorded in
 * their act's own transaction): a mockup accepted or returned with a reason, read through the
 * mockup's own contract view, and a person's reply to the assistant in a project chat or to the bot
 * in a bound room's thread, which the fast model reads and which is kept only at
 * `CHAT_CORRECTION_THRESHOLD` or above. A gateway miss keeps nothing: a
 * reply is never a correction because the model was unreachable. The model reads the thread the reply
 * answers before it says what the reply corrects (ISS-1251).
 */

import { CHAT_CORRECTION_THRESHOLD } from '@forge/contracts/lessons';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { conversationMessages, conversations } from '../db/schema-conversations.js';
import { callFastModelObject } from '../integrations/llm/index.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { registerLessonInvalidation } from './anchors.js';
import { recordAppliedFromText } from './applied.js';
import { type ThreadPost, threadBefore, threadLines } from './correction-thread.js';
import { recordCorrection } from './corrections.js';
import { lessonsPorts } from './ports.js';

const TEXT_CHARS = 4000;
const CLASSIFY_MAX_TOKENS = 300;

const chatVerdict = z.object({
  correction: z.boolean(),
  confidence: z.number().min(0).max(1),
  what: z.string().max(240),
  // the thread leaves more than one reading of what the reply corrects; said on the correction, never guessed away
  ambiguous: z.boolean().optional(),
});
export type ChatVerdict = z.infer<typeof chatVerdict>;

export function chatClassifyPrompt(
  assistant: string,
  person: string,
  thread: readonly ThreadPost[] = [],
): string {
  return [
    'An assistant answered a person, and the person replied. Decide whether the reply corrects the assistant: it says the assistant got something wrong, misunderstood, missed a rule, or should do it another way.',
    'A new question, thanks, agreement or more detail is not a correction.',
    "Read the thread first. The reply answers the posts before it, so what it corrects is what those posts are about: a product, a record, a step the assistant took, or the assistant's own wording. Never assume it is about the assistant's own reply when the thread is about something else.",
    'Answer `correction`, your `confidence` from 0 to 1, and in `what` one sentence saying what the assistant got wrong, naming the subject the thread shows (empty when it is not a correction). Set `ambiguous` when the thread leaves more than one reading of what is corrected, and say both readings in `what`.',
    ...(thread.length > 0 ? [`Thread, oldest first:\n${threadLines(thread)}`] : []),
    `Assistant:\n${assistant.slice(0, TEXT_CHARS)}`,
    `Person:\n${person.slice(0, TEXT_CHARS)}`,
  ].join('\n\n');
}

/** How a reply is read for a correction: the fast model, or a test's own reading. */
export type ChatClassifier = (
  projectId: string,
  assistant: string,
  person: string,
  thread: readonly ThreadPost[],
) => Promise<ChatVerdict | null>;

/**
 * The correction as kept: what was wrong, and whether the thread left it open. The person's own words
 * stay on the message `sourceRef` names, where the drafting step reads them with the thread.
 */
export const correctionReason = (v: ChatVerdict): string =>
  `${v.what.trim()}${v.ambiguous ? ' (The thread leaves this reading open.)' : ''}`;

/** The fast model's reading of one reply, or null on a gateway miss. */
export const classifyChatReply: ChatClassifier = async (projectId, assistant, person, thread) => {
  const answer = await callFastModelObject(
    { surface: 'lessons', projectId, what: 'a chat reply read for a correction' },
    chatClassifyPrompt(assistant, person, thread),
    chatVerdict,
    { maxTokens: CLASSIFY_MAX_TOKENS },
  );
  if (answer.ok) return answer.value;
  logger.warn(
    { projectId, miss: answer.miss, detail: answer.detail },
    'lessons: a chat reply was not read for a correction',
  );
  return null;
};

/** Whether a verdict keeps the reply as a correction. */
export const keepsCorrection = (v: ChatVerdict | null): v is ChatVerdict =>
  v?.correction === true && v.confidence >= CHAT_CORRECTION_THRESHOLD && v.what.trim() !== '';

/** Where a reply was said: a project chat, or a bound room's thread (the room its route resolved). */
type ReplyVenue = { source: 'chat' } | { source: 'room'; room: { id: string; rid: string } };

/**
 * One person's reply to an assistant message, read for a correction: a chat's and a room's alike,
 * through the one classifier and threshold. A chat writer is a Forge user; a room writer is a chat
 * account, recorded as the Forge user it resolves to, or with no user where it resolves to none
 * (the owner is often a chat-only identity): who said it stays on the message `sourceRef` names.
 */
export async function correctionFromReply(
  p: {
    projectId: string;
    conversationId: string;
    assistantMessageId: string;
    personMessageId: string;
  },
  venue: ReplyVenue,
  classify: ChatClassifier = classifyChatReply,
): Promise<string | null> {
  const rows = await db
    .select({
      id: conversationMessages.id,
      role: conversationMessages.role,
      content: conversationMessages.content,
      author: conversationMessages.authorUserId,
      authorKey: conversationMessages.authorKey,
      authorLabel: conversationMessages.authorLabel,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, p.conversationId),
        inArray(conversationMessages.id, [p.assistantMessageId, p.personMessageId]),
      ),
    );
  const assistant = rows.find((r) => r.id === p.assistantMessageId && r.role === 'assistant');
  const person = rows.find((r) => r.id === p.personMessageId && r.role === 'user');
  if (!assistant || !person) return null;
  const posts = await threadBefore(p.conversationId, { id: p.personMessageId });
  const verdict = await classify(p.projectId, assistant.content, person.content, posts);
  if (!keepsCorrection(verdict)) return null;
  const [thread] = await db
    .select({ title: conversations.title })
    .from(conversations)
    .where(eq(conversations.id, p.conversationId));
  const userId =
    venue.source === 'chat'
      ? person.author
      : person.authorKey
        ? await lessonsPorts().roomWriterOf(venue.room.id, {
            key: person.authorKey,
            label: person.authorLabel,
          })
        : null;
  return db.transaction((tx) =>
    recordCorrection(tx, {
      projectId: p.projectId,
      source: venue.source,
      sourceRef: person.id,
      item: {
        kind: 'conversation',
        id: p.conversationId,
        key: venue.source === 'chat' ? 'Chat' : `Room ${venue.room.rid}`,
        title: thread?.title ?? null,
      },
      reason: correctionReason(verdict),
      by: { userId, agency: 'human' },
      score: verdict.confidence,
    }),
  );
}

export function registerLessonCorrections(): void {
  registerLessonInvalidation();
  consume('mockup.transitioned', {
    name: 'lessons-corrections',
    handle: async (p) => {
      if (!p.reason?.trim() || (p.to !== 'accepted' && p.to !== 'returned')) return;
      if (p.actor.type !== 'user') return;
      const by = {
        userId: p.actor.id,
        agency: p.actor.agency === 'agent' ? 'agent' : 'human',
      } as const;
      // the decider reads the mockup it decided, as its own contract view shows it
      const mockup = await lessonsPorts().mockupOf(p.projectId, p.id, by);
      if (!mockup) return;
      await db.transaction((tx) =>
        recordCorrection(tx, {
          projectId: p.projectId,
          source: p.to === 'returned' ? 'mockup_returned' : 'mockup_accepted',
          sourceRef: `${p.id}:${p.to}`,
          item: { kind: 'mockup', id: p.id, key: mockup.key, title: mockup.caption ?? mockup.name },
          reason: p.reason,
          by,
          at: new Date(p.at),
        }),
      );
    },
  });
  // a run's or a master's issue comment ends with the `Lessons applied:` line its orientation asks
  // for; that line is how it says so, kept against the issue as the door would keep it (ISS-1251 c10)
  consume('comment.created', {
    name: 'lessons-applied',
    handle: async (p) => {
      if (p.authored !== 'agent' || !/Lessons applied:/i.test(p.body)) return;
      const ref = await lessonsPorts().issueKeyOf(p.issueId);
      if (!ref) return;
      await recordAppliedFromText({
        projectId: p.projectId,
        text: p.body,
        output: { kind: 'issue', ref },
        agentUserId: p.actor.type === 'user' ? p.actor.id : null,
      });
    },
  });
  consume('chat.replied', {
    name: 'lessons-chat',
    handle: async (p) => {
      await correctionFromReply(p, { source: 'chat' });
    },
  });
  consume('room.replied', {
    name: 'lessons-room',
    handle: async ({ room, ...p }) => {
      await correctionFromReply(p, { source: 'room', room });
    },
  });
}
