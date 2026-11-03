/**
 * The corrections that reach lessons through the outbox (REQ-50 BC-1; the others are recorded in
 * their act's own transaction): a mockup accepted or returned with a reason, read through the
 * mockup's own contract view, and a person's reply to the assistant in a project chat or to the bot
 * in a bound room's thread, which the fast model reads and which is kept only at
 * `CHAT_CORRECTION_THRESHOLD` or above. A gateway miss keeps nothing: a
 * reply is never a correction because the model was unreachable.
 */

import { CHAT_CORRECTION_THRESHOLD } from '@forge/contracts/lessons';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { conversationMessages, conversations } from '../db/schema-conversations.js';
import { callFastModelObject } from '../integrations/llm/index.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { recordCorrection } from './corrections.js';
import { lessonsPorts } from './ports.js';

const TEXT_CHARS = 4000;
const CLASSIFY_MAX_TOKENS = 300;

const chatVerdict = z.object({
  correction: z.boolean(),
  confidence: z.number().min(0).max(1),
  what: z.string().max(240),
});
export type ChatVerdict = z.infer<typeof chatVerdict>;

export function chatClassifyPrompt(assistant: string, person: string): string {
  return [
    'An assistant answered a person, and the person replied. Decide whether the reply corrects the assistant: it says the assistant got something wrong, misunderstood, missed a rule, or should do it another way.',
    'A new question, thanks, agreement or more detail is not a correction.',
    'Answer `correction`, your `confidence` from 0 to 1, and in `what` one sentence saying what the assistant got wrong (empty when it is not a correction).',
    `Assistant:\n${assistant.slice(0, TEXT_CHARS)}`,
    `Person:\n${person.slice(0, TEXT_CHARS)}`,
  ].join('\n\n');
}

/** The fast model's reading of one reply, or null on a gateway miss. */
export async function classifyChatReply(
  projectId: string,
  assistant: string,
  person: string,
): Promise<ChatVerdict | null> {
  const answer = await callFastModelObject(
    { surface: 'lessons', projectId, what: 'a chat reply read for a correction' },
    chatClassifyPrompt(assistant, person),
    chatVerdict,
    { maxTokens: CLASSIFY_MAX_TOKENS },
  );
  if (answer.ok) return answer.value;
  logger.warn(
    { projectId, miss: answer.miss, detail: answer.detail },
    'lessons: a chat reply was not read for a correction',
  );
  return null;
}

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
  const verdict = await classifyChatReply(p.projectId, assistant.content, person.content);
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
      reason: verdict.what,
      by: { userId, agency: 'human' },
      score: verdict.confidence,
    }),
  );
}

export function registerLessonCorrections(): void {
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
