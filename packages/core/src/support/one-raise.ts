// One Forge question is put to the owner once (ISS-1347, FB-768, FB-786, FB-796): a question the
// agent asked with `ask_owner` is also listed on his Needs you, and handed back as an owed- item,
// whose `raise_owed` put the same question to him again; the epod owner said four asks for two
// decisions were "making him say ok" over and over. A second raise of an open question, by either
// act and from any thread, is refused naming the first, which his answer there still settles. A
// raise his answer settled, or whose question is answered or gone, holds nothing back.

import { questionDecisionId } from '@forge/contracts/needs-you-decisions';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentQuestions } from '../db/schema-questions.js';
import { supportActions } from '../db/schema-support.js';
import { no, type Outcome } from './outcome.js';
import type { RoomRow } from './store.js';

const ASK = 'ask_owner';
const RAISE = 'raise_owed';
const OWNER_ANSWER = 'owner_answer';

/** The Forge question an owed- item puts to him, by its Needs-you id; null for any other decision. */
export function questionOfOwed(owed: unknown): string | null {
  if (typeof owed !== 'string') return null;
  const prefix = questionDecisionId('');
  return owed.startsWith(prefix) ? (owed.slice(prefix.length).split('#')[0] ?? null) : null;
}

/** The first raise of `questionId` this room put to the owner that still waits on him, or null. */
async function firstOpenRaise(
  room: RoomRow,
  questionId: string,
): Promise<{ thread: string; messageId: string | null; at: Date; kept: boolean } | null> {
  const [q] = await db
    .select({ status: agentQuestions.status })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  if (q?.status !== 'open') return null;
  const owedId = questionDecisionId(questionId);
  const raises = await db
    .select()
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        or(
          and(
            eq(supportActions.kind, 'routed'),
            eq(supportActions.tool, ASK),
            sql`${supportActions.input} ->> 'questionId' = ${questionId}`,
          ),
          and(
            eq(supportActions.kind, 'operation'),
            eq(supportActions.tool, RAISE),
            or(
              sql`${supportActions.input} ->> 'owed' = ${owedId}`,
              sql`${supportActions.input} ->> 'owed' like ${`${owedId}#%`}`,
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(supportActions.createdAt));
  if (raises.length === 0) return null;
  const answered = await db
    .select({ input: supportActions.input })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.kind, 'routed'),
        inArray(supportActions.tool, [OWNER_ANSWER]),
      ),
    );
  const settled = new Set(answered.map((r) => (r.input as { ask?: string } | null)?.ask));
  // his answer kept while his account is no Forge account (ISS-976) is his answer: never ask again
  const [kept] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.kind, 'answer_kept'),
        isNull(supportActions.output),
        sql`${supportActions.input} ->> 'questionId' = ${questionId}`,
      ),
    )
    .limit(1);
  const first = raises.find((r) => kept || !settled.has(r.id));
  if (!first) return null;
  const messageId = (first.output as { messageId?: string | null } | null)?.messageId ?? null;
  return { thread: first.thread, messageId, at: first.createdAt, kept: Boolean(kept) };
}

/**
 * Refused by name, at `code`, where `questionId` was already put to the owner and still waits on
 * him: names the first raise and says to close this thread with silence. Null where it may be raised.
 */
export async function secondRaise<T>(
  room: RoomRow,
  questionId: string,
  code: 'SUPPORT_OWNER_ALREADY_ASKED' | 'SUPPORT_OWED_ALREADY_RAISED',
  thread: string,
): Promise<Outcome<T> | null> {
  const first = await firstOpenRaise(room, questionId);
  if (!first) return null;
  const line = first.messageId ? `, its line ${first.messageId}` : '';
  const waits = first.kept
    ? 'his answer to it is kept and waits on an admin naming his account; it is recorded as his then'
    : 'his answer there reaches you and settles it';
  return no(
    code,
    '/thread',
    `Forge question ${questionId} was already put to the owner in the technical channel, from thread ${first.thread}${line}, at ${first.at.toISOString()}; it is put to him once, and ${waits}. Close ${thread} with support.silent { thread: "${thread}", reason } and tell him nothing again. Nothing was posted.`,
  );
}
