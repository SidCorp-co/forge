// The owner's answer to a Forge question, kept while his chat account is no Forge account (ISS-976).
// The binding names him by his chat id; the answer is recorded as a Forge account, which exists only
// once he links his chat account or a project admin names it (`assistant/identity/named-links.ts`).
// Until then the cited answer is kept here, and once the account exists it is recorded as his, once,
// and nothing is asked of him again. The setup step is his admins': the agent never raises it with him.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { resolveSpeaker, type SpeakerLinked } from '../assistant/index.js';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { holderNames } from '../permissions/index.js';
import { answerAs } from '../questions/index.js';
import { insertAction, type RoomRow, roomById } from './store.js';
import { roomAuth } from './thread.js';

const KEPT = 'answer_kept';
const ANSWER = 'answer_question';

/** The round's answer the owner's words make: a choice's option, or his words. */
export type KeptAnswer = { kind: 'option'; optionId: string } | { kind: 'text'; text: string };

/** What a kept row holds: the cited message, the question it answers, and his answer to it. */
interface Kept {
  questionId: string;
  /** The question's project: a naming holds in its own project alone, so the answer waits on it. */
  questionProjectId: string;
  round: number;
  message: string;
  ownerKey: string;
  answer: KeptAnswer;
}

/**
 * What the agent reads where the owner's account is no Forge account yet: who owes the setup step
 * and how, and what it may tell the room. Never that it should ask him.
 */
export async function ownerSetupStep(projectId: string): Promise<string> {
  const names = await holderNames('project.admin', projectId);
  const admins = names.length > 0 ? `a project admin (${names.join(', ')})` : 'a project admin';
  return `the owner's chat account is no Forge account yet, so his answer cannot be recorded as anyone. It is kept, and it is recorded as his, once and with nothing asked again, when ${admins} names his Forge account (POST /api/projects/${projectId}/speaker-links/named), or he links it himself from Forge. That step is his admins', never his: do not ask him to link anything or to change his chat profile. You may tell the room his answer is noted and waits on a setup step its admins own. Nothing was recorded yet.`;
}

/** Keep the owner's cited answer to a question, once per room, message and question. */
export async function keepOwnerAnswer(room: RoomRow, thread: string, kept: Kept): Promise<void> {
  const externalId = `${KEPT}:${kept.questionId}:${kept.message}`;
  const [held] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.kind, KEPT),
        eq(supportActions.externalId, externalId),
      ),
    )
    .limit(1);
  if (held) return;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread,
    kind: KEPT,
    actorKind: 'core',
    tool: ANSWER,
    input: { ...kept },
    externalId,
  });
}

type Recorded = { recorded: true; by: string } | { recorded: false; why: string };

async function recordOne(kept: Kept, userId: string): Promise<Recorded> {
  try {
    await answerAs({
      questionId: kept.questionId,
      answer: kept.answer,
      round: kept.round,
      userId,
      via: 'assistant',
    });
    return { recorded: true, by: userId };
  } catch (err) {
    if (isRefusal(err))
      return { recorded: false, why: err.refusals.map((r) => r.detail).join('; ') };
    logger.error({ err, questionId: kept.questionId }, 'support: a kept owner answer failed');
    return { recorded: false, why: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Record every answer kept for the account just linked or named, as the Forge account it now
 * resolves to, each once: what became of each, by room, with the thread it was kept on. An answer
 * whose question's project the account does not resolve in stays kept.
 */
export async function recordKeptAnswers(
  linked: SpeakerLinked,
): Promise<Map<string, { thread: string; lines: string[] }>> {
  const rows = await db
    .select()
    .from(supportActions)
    .where(
      and(
        eq(supportActions.kind, KEPT),
        isNull(supportActions.output),
        sql`${supportActions.input} ->> 'ownerKey' = ${linked.externalId}`,
      ),
    );
  const told = new Map<string, { thread: string; lines: string[] }>();
  for (const row of rows) {
    const kept = row.input as Kept;
    if (linked.projectId && kept.questionProjectId !== linked.projectId) continue;
    const room = await roomById(row.roomId);
    if (!room) continue;
    const { namespace } = await roomAuth(room).catch(() => ({ namespace: null }));
    if (namespace !== linked.namespace) continue;
    const who = await resolveSpeaker(
      { source: linked.source, namespace, externalId: linked.externalId },
      kept.questionProjectId,
    );
    if (!who.linked) continue;
    // claimed once: a second link, or a second pass, finds it spent
    const [claimed] = await db
      .update(supportActions)
      .set({ output: { recording: true } })
      .where(and(eq(supportActions.id, row.id), isNull(supportActions.output)))
      .returning({ id: supportActions.id });
    if (!claimed) continue;
    const outcome = await recordOne(kept, who.userId);
    await db.update(supportActions).set({ output: outcome }).where(eq(supportActions.id, row.id));
    if (outcome.recorded) {
      await insertAction({
        roomId: room.id,
        projectId: room.projectId,
        conversationId: null,
        thread: row.thread,
        kind: 'routed',
        actorKind: 'core',
        tool: ANSWER,
        input: {
          thread: row.thread,
          message: kept.message,
          forgeQuestion: kept.questionId,
          kept: row.id,
        },
      });
    }
    const entry = told.get(room.id) ?? { thread: row.thread, lines: [] };
    entry.lines.push(
      outcome.recorded
        ? `His kept answer (message ${kept.message}) to Forge question ${kept.questionId} is now recorded as his; the master who asked is woken.`
        : `His kept answer (message ${kept.message}) to Forge question ${kept.questionId} was not recorded: ${outcome.why}.`,
    );
    told.set(room.id, entry);
  }
  return told;
}
