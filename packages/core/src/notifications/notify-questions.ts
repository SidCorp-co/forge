// A question a step asks one person reaches that person's bell when it is asked (REQ-34 BC-21, ISS-456;
// judge run ad038e31: REQ-95's create asked its author why it was needed and their bell stayed empty).
// Every door writes its question through `questions/write.ts`, and every write emits `question.asked`,
// so this consumer is the one place a question is told. The person asked is the one the question's own
// item names: a requirement's author for a question asked of the requirement, a feedback item's
// reporter for a clarification asked of the item. A question asked on an issue or on nothing names no
// person and is told to nobody here; Needs you lists it, and its reminder is the upkeep's. The asker is
// never told their own question, and an agent has no bell.
//
// The notice is a `task` on the item's one bell row (`emit.ts:itemGroupOf`, ISS-1192), so a second
// question on the same item reads the row as new again, and the three-day reminder joins that row
// (`steward/decision-upkeep.ts`). Its answer or its void resolves it.

import { questionAskedResolutionKey } from '@forge/contracts/notifications';
import type { OutboxEventPayload as Payload } from '@forge/contracts/outbox-events';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { resolveNotifications } from './auto-resolve.js';
import { emitNotification } from './emit.js';

const PROMPT_MAX = 300;

interface AskedRow {
  id: string;
  project_id: string;
  status: string;
  blocker_kind: string;
  asked_by: string | null;
  requirement_id: string | null;
  feedback_id: string | null;
  round: number | null;
  prompt: string | null;
  item_key: string | null;
  /** The person the item names: the requirement's author, the feedback item's reporter; null for an agent. */
  person: string | null;
}

async function askedRowOf(questionId: string): Promise<AskedRow | null> {
  const [row] = rowsOf<AskedRow>(
    await db.execute(sql`
      SELECT q.id, q.project_id, q.status, q.blocker_kind, q.asked_by, q.requirement_id, q.feedback_id,
             (q.steps -> -1 ->> 'round')::int AS round,
             q.steps -> -1 ->> 'prompt' AS prompt,
             coalesce((SELECT 'REQ-' || r.req_seq FROM requirements r WHERE r.id = q.requirement_id),
                      (SELECT 'FB-' || f.fb_seq FROM feedback f WHERE f.id = q.feedback_id)) AS item_key,
             CASE
               WHEN q.requirement_id IS NOT NULL THEN
                 (SELECT rv.author_id FROM requirement_revisions rv
                   WHERE rv.requirement_id = q.requirement_id AND rv.revision = 1
                     AND rv.author_agency = 'human')
               WHEN q.feedback_id IS NOT NULL THEN
                 (SELECT f.reported_by FROM feedback f
                   WHERE f.id = q.feedback_id AND f.reporter_agency = 'human')
             END AS person
        FROM agent_questions q
       WHERE q.id = ${questionId}`),
  );
  return row ?? null;
}

const clipped = (text: string) =>
  text.length > PROMPT_MAX ? `${text.slice(0, PROMPT_MAX - 1).trimEnd()}…` : text;

/** Tells the person `questionId` asks, where its item names one who did not ask it. */
export async function tellAsked(questionId: string): Promise<'told' | 'nobody'> {
  const q = await askedRowOf(questionId);
  if (q?.status !== 'open' || q.blocker_kind !== 'human') return 'nobody';
  if (!q.requirement_id && !q.feedback_id) return 'nobody';
  if (!q.person) {
    logger.info(
      { question: q.id, item: q.item_key },
      'questions: the item this asks names no person (an agent wrote it), so no bell is rung',
    );
    return 'nobody';
  }
  if (q.person === q.asked_by) return 'nobody';
  const prompt = clipped((q.prompt ?? '').trim());
  await emitNotification({
    recipients: [q.person],
    projectId: q.project_id,
    type: 'question_asked',
    requirementId: q.requirement_id,
    feedbackId: q.feedback_id,
    title: q.item_key ? `${q.item_key}: ${prompt}` : prompt,
    resolutionKey: questionAskedResolutionKey(q.id),
    dedupeKey: `question-asked:${q.id}:r${q.round ?? 1}`,
  });
  return 'told';
}

export function registerQuestionNotifications(): void {
  const name = 'notify-questions';
  consume('question.asked', { name, handle: (p) => tellAsked(p.questionId).then(() => undefined) });
  consume('question.answered', {
    name,
    handle: async (p: Payload<'question.answered'>) => {
      await resolveNotifications(questionAskedResolutionKey(p.questionId), 'Answered');
    },
  });
  // a void or an expiry ends the ask as an answer does
  consume('question.transitioned', {
    name,
    handle: async (p) => {
      await resolveNotifications(questionAskedResolutionKey(p.id), 'No longer asked');
    },
  });
}
