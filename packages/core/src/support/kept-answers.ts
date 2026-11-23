// The owner's answer to a Forge question, kept while his chat account is no Forge account (ISS-976).
// The binding names him by his chat id; the answer is recorded as a Forge account, which exists only
// once he links his chat account or a project admin names it (`assistant/identity/named-links.ts`).
// Until then the cited answer is kept here, and once the account exists it is recorded as his, once,
// and nothing is asked of him again. The setup step is his admins': the agent never raises it with him.
// His go or no on a release is kept the same way, on the same record, and decided as his once his
// account is named (ISS-1313, `release-decide-as.ts:decideKeptGo`).

import { and, eq, isNull, sql } from 'drizzle-orm';
import { resolveSpeaker, type SpeakerLinked } from '../assistant/index.js';
import { outsideTokenScope } from '../credentials/pat-scope.js';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { permissionFactsOf } from '../permissions/index.js';
import { answerAs } from '../questions/index.js';
import { decideKeptGo, type KeptGo } from './release-decide-as.js';
import { namingStep } from './setup-step.js';
import { type ActionRow, insertAction, type RoomRow, roomById } from './store.js';
import { roomAuth } from './thread.js';

const KEPT = 'answer_kept';
const ANSWER = 'answer_question';
const RELEASE = 'release_decision';

/** The round's answer the owner's words make: a choice's option, or his words. */
export type KeptAnswer =
  | { kind: 'option'; optionId: string; text?: string }
  | { kind: 'text'; text: string };

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
 * and how, and what it may tell the room of `what` he said. Never that it should ask him.
 */
export async function ownerSetupStep(projectId: string, what = 'his answer'): Promise<string> {
  return `the owner's chat account is no Forge account yet, so ${what} cannot be recorded as anyone. It is kept, and it is recorded as his, once and with nothing asked again, when ${await namingStep(projectId, 'his')}, or he links it himself from Forge. That step is his admins', never his: do not ask him to link anything or to change his chat profile. You may tell the room ${what} is noted and waits on a setup step its admins own. Nothing was recorded yet.`;
}

/**
 * Why the Forge account the owner's chat account resolves to cannot answer in `projectId`: it holds
 * no role there, since a naming lends that account's own grants and no more (ISS-1210); null where
 * it holds one.
 */
export async function ownerRoleGap(userId: string, projectId: string): Promise<string | null> {
  if ((await permissionFactsOf(userId, projectId)).role) return null;
  return `the owner's chat account is Forge account ${userId}, which holds no role in this question's project, so his answer cannot be recorded as him there. A project admin adds that account to the project, or an admin corrects the naming; never ask him. Nothing was recorded.`;
}

/** Keep what the owner said, once per room and key, on the record his account's naming reads. */
async function keep(
  room: RoomRow,
  thread: string,
  tool: typeof ANSWER | typeof RELEASE,
  key: string,
  input: Kept | KeptGo,
): Promise<void> {
  const externalId = `${KEPT}:${key}`;
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
    tool,
    input: { ...input },
    externalId,
  });
}

/** Keep the owner's cited answer to a question, once per room, message and question. */
export async function keepOwnerAnswer(room: RoomRow, thread: string, kept: Kept): Promise<void> {
  await keep(room, thread, ANSWER, `${kept.questionId}:${kept.message}`, kept);
}

/** Keep the owner's cited go or no on a release (ISS-1313), once per room, message and release. */
export async function keepOwnerGo(room: RoomRow, kept: KeptGo): Promise<void> {
  await keep(
    room,
    kept.thread,
    RELEASE,
    `release:${kept.projectId}:${kept.version}:${kept.message}`,
    kept,
  );
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

/** The project a kept row's naming must hold in: its question's, or its release's. */
const projectOfKept = (row: ActionRow): string =>
  row.tool === RELEASE ? (row.input as KeptGo).projectId : (row.input as Kept).questionProjectId;

/** Record one kept row as `userId`, as his own account: what became of it, as its room is told. */
async function recordKept(
  room: RoomRow,
  row: ActionRow,
  userId: string,
): Promise<{ outcome: Recorded; line: string }> {
  if (row.tool === RELEASE) {
    const go = row.input as KeptGo;
    const outcome = await decideKeptGo(room, go, userId);
    const what = `His kept ${go.decision === 'approve' ? 'go' : 'no'} (message ${go.message}) on ${go.project} ${go.version}`;
    return {
      outcome,
      line: outcome.recorded
        ? `${what} is now recorded as his release decision.`
        : `${what} was not recorded: ${outcome.why}.`,
    };
  }
  const kept = row.input as Kept;
  // his own account answers, never the token of the request that named it (ISS-1313)
  const outcome = await outsideTokenScope(() => recordOne(kept, userId));
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
  return {
    outcome,
    line: outcome.recorded
      ? `His kept answer (message ${kept.message}) to Forge question ${kept.questionId} is now recorded as his; the master who asked is woken.`
      : `His kept answer (message ${kept.message}) to Forge question ${kept.questionId} was not recorded: ${outcome.why}.`,
  };
}

/**
 * Record everything kept for the account just linked or named, as the Forge account it now resolves
 * to, each once: an answer to its question, a go on its release (ISS-1313). What became of each, by
 * room, with the thread it was kept on. One whose project the account does not resolve in stays kept.
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
    const projectId = projectOfKept(row);
    if (linked.projectId && projectId !== linked.projectId) continue;
    const room = await roomById(row.roomId);
    if (!room) continue;
    const { namespace } = await roomAuth(room).catch(() => ({ namespace: null }));
    if (namespace !== linked.namespace) continue;
    const who = await resolveSpeaker(
      { source: linked.source, namespace, externalId: linked.externalId },
      projectId,
    );
    if (!who.linked) continue;
    // claimed once: a second link, or a second pass, finds it spent
    const [claimed] = await db
      .update(supportActions)
      .set({ output: { recording: true } })
      .where(and(eq(supportActions.id, row.id), isNull(supportActions.output)))
      .returning({ id: supportActions.id });
    if (!claimed) continue;
    const { outcome, line } = await recordKept(room, row, who.userId);
    await db.update(supportActions).set({ output: outcome }).where(eq(supportActions.id, row.id));
    const entry = told.get(room.id) ?? { thread: row.thread, lines: [] };
    entry.lines.push(line);
    told.set(room.id, entry);
  }
  return told;
}
