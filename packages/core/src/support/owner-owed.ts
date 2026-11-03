// The open questions a person owes on the projects a channel agent follows (ISS-916): a master's or a
// run's question with `blockerKind` human, asked through the channel or not. The agent is shown them
// on a turn holding the owner's message, so it can tell an answer from a new request, and it records
// the owner's message as one's answer from any thread (`question-task.ts:answerHandedQuestion` with
// `forgeQuestion`). Who wrote the message is the chat server's word, never what it says.

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { agentQuestions, isChoiceStep } from '../db/schema-questions.js';
import { keyOf } from './ops-reads.js';
import { projectsInScope } from './ops-scope.js';
import { no, type Outcome } from './outcome.js';
import { questionRefusal } from './owner-ask-targets.js';
import type { RoomRow } from './store.js';

/** How many owed questions a turn lists before it says how many more there are. */
const SHOWN = 5;
/** How much of a question's words a line carries. */
const WORDS = 240;

const clipped = (text: string) =>
  text.length > WORDS ? `${text.slice(0, WORDS - 1).trimEnd()}…` : text;

/**
 * The note a turn holding the owner's message carries: the open questions a person owes on the
 * projects this agent follows, oldest first, each with its id, its issue, its words and its options;
 * null where none is open.
 */
export async function ownerOwedNote(room: RoomRow): Promise<string | null> {
  const reach = await projectsInScope(room);
  if (reach.length === 0) return null;
  const rows = await db
    .select({
      id: agentQuestions.id,
      projectId: agentQuestions.projectId,
      steps: agentQuestions.steps,
      issSeq: issues.issSeq,
    })
    .from(agentQuestions)
    .leftJoin(issues, eq(issues.id, agentQuestions.issueId))
    .where(
      and(
        inArray(
          agentQuestions.projectId,
          reach.map((p) => p.id),
        ),
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.blockerKind, 'human'),
        isNull(agentQuestions.batchId),
      ),
    )
    .orderBy(asc(agentQuestions.createdAt));
  if (rows.length === 0) return null;
  const lines = rows.slice(0, SHOWN).map((q) => {
    const project = reach.find((p) => p.id === q.projectId);
    const step = q.steps.at(-1);
    const on = project && q.issSeq !== null ? ` on ${keyOf(project, q.issSeq)}` : '';
    const options =
      step && isChoiceStep(step)
        ? ` — options: ${step.options.map((o) => `${o.id} (${o.label})`).join(', ')}`
        : '';
    return `- question ${q.id}${on}: ${JSON.stringify(clipped(step?.prompt ?? ''))}${options}`;
  });
  const more = rows.length > SHOWN ? [`- and ${rows.length - SHOWN} more`] : [];
  return [
    'Open questions the owner owes an answer to, wherever he writes it:',
    ...lines,
    ...more,
    'Where his message answers one, record it with support.answer_question { thread, forgeQuestion, message, option? } and file nothing for it; only his own message answers one.',
    'Where it may answer one but you cannot tell which, ask him which, once, in that same thread, and file nothing until he says.',
  ].join('\n');
}

/**
 * The round of an open, person-owed question of the projects this agent follows, which the owner's
 * message may answer from any thread; refused by name otherwise.
 */
export async function ownerOwedQuestion(
  room: RoomRow,
  questionId: string,
): Promise<Outcome<{ questionId: string; round: number }>> {
  const reach = await projectsInScope(room);
  const why = await questionRefusal(
    reach.map((p) => p.id),
    questionId,
  );
  if (why) {
    return no('SUPPORT_OWNER_QUESTION_UNKNOWN', '/forgeQuestion', `${why}. Nothing was recorded.`);
  }
  const [q] = await db
    .select({ blockerKind: agentQuestions.blockerKind, steps: agentQuestions.steps })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  const step = q?.steps.at(-1);
  if (!q || !step || q.blockerKind !== 'human') {
    return no(
      'SUPPORT_OWNER_QUESTION_UNKNOWN',
      '/forgeQuestion',
      `question ${questionId} is owed by ${q?.blockerKind === 'machine' ? 'a machine check' : 'the master'}, not a person, so the owner's words answer it nowhere. Nothing was recorded.`,
    );
  }
  return { ok: true, value: { questionId, round: step.round } };
}
