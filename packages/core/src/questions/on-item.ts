// The product item a question a person owes on an issue is asked about (REQ-68 BC-4): a person never
// works an issue, so the question reaches them as a decision on the item the issue serves. The one
// rule, read by the steward's ask and its decision alike:
//
//   1. the requirement the issue delivers;
//   2. else the feedback item it carries (the oldest, where it carries several);
//   3. else the requirement the steward names as the one it serves, where it can tell which;
//   4. else none: it stays the project's question, which Needs you lists on its own and answers in
//      Approvals (`questions/needs-you-read.ts:readOpenPersonQuestions`, `issueItem` null).
//
// Placing it writes the question's `about` (the column a delivery run's ask names since REQ-67 BC-5),
// so the item's page lists it, Needs you opens that item, and the answer is recorded there. A question
// that already names what it is about, and one a merge mark or a design decision answers, are left as
// they are. Questions asked before `about` existed (ISS-643, ISS-639, ISS-582 on dev.489) are placed
// the first time the steward reads their issue stuck, by this one path, never row by row.

import type { QuestionAbout, QuestionRefusalCode } from '@forge/contracts/questions';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
import { refuser } from '../lib/refusal.js';
import { requirementIdIn } from './ports.js';

const refuse = refuser<QuestionRefusalCode>('QUESTION_REFUSED');

/** The product item an issue serves, by the first two rules: null where it serves neither. */
export type IssueItem =
  | { kind: 'requirement'; id: string; key: string }
  | { kind: 'feedback'; id: string; key: string };

/** The requirement the issue delivers, else the oldest feedback item it carries; null for neither. */
export async function issueItemOf(issueId: string, exec: Tx = db): Promise<IssueItem | null> {
  const [row] = rowsOf<{
    req_id: string | null;
    req_key: string | null;
    fb_id: string | null;
    fb_key: string | null;
  }>(
    await exec.execute(sql`
      SELECT r.id AS req_id, 'REQ-' || r.req_seq AS req_key, fb.id AS fb_id, 'FB-' || fb.fb_seq AS fb_key
        FROM issues i
        LEFT JOIN requirements r ON r.id = i.requirement_id
        LEFT JOIN LATERAL (
          SELECT f.id, f.fb_seq FROM feedback_route_issues ri JOIN feedback f ON f.id = ri.feedback_id
           WHERE ri.issue_id = i.id ORDER BY f.fb_seq LIMIT 1) fb ON true
       WHERE i.id = ${issueId}`),
  );
  if (row?.req_id && row.req_key) return { kind: 'requirement', id: row.req_id, key: row.req_key };
  if (row?.fb_id && row.fb_key) return { kind: 'feedback', id: row.fb_id, key: row.fb_key };
  return null;
}

/** Where an issue's open questions were placed, and the questions themselves. */
export interface PlacedOnItem {
  /** The item they are asked about; null where they stay the project's own question. */
  item: { kind: 'requirement' | 'feedback'; key: string } | null;
  /** Every open question a person owes on the issue, by id and the round's prompt, oldest first. */
  questions: { id: string; prompt: string }[];
}

const aboutOf = (item: IssueItem): QuestionAbout =>
  item.kind === 'requirement'
    ? { kind: 'requirement', requirementId: item.id }
    : { kind: 'feedback', feedbackId: item.id };

/** The requirement `ref` (REQ-n) names in the project, or a refusal naming it. */
async function namedRequirement(exec: Tx, projectId: string, ref: string): Promise<IssueItem> {
  const id = await requirementIdIn(exec, projectId, ref);
  if (!id) {
    throw refuse(
      'QUESTION_ABOUT_UNKNOWN',
      `\`item\` is \`${ref}\`, which names no requirement of this project — name the requirement the issue serves by its key (REQ-n), or leave \`item\` out so the question stays the project's`,
      '/item',
    );
  }
  return { kind: 'requirement', id, key: ref.toUpperCase() };
}

/**
 * Place every open question a person owes on the issue on the item it serves, by the rule above;
 * `named` is the requirement the steward reads the issue as serving (rule 3). Answers where they
 * now stand, with the questions; an issue with none open answers no questions.
 */
export async function placeOpenQuestionsOnItem(
  input: { projectId: string; issueId: string; named?: string | undefined },
  exec: Tx = db,
): Promise<PlacedOnItem> {
  const open = rowsOf<{ id: string; prompt: string | null; about: QuestionAbout | null }>(
    await exec.execute(sql`
      SELECT id, steps -> -1 ->> 'prompt' AS prompt, about
        FROM agent_questions
       WHERE issue_id = ${input.issueId} AND project_id = ${input.projectId}
         AND status = 'open' AND blocker_kind = 'human' AND batch_id IS NULL
         AND awaits_merge_issue_id IS NULL AND awaits_workflow_id IS NULL
       ORDER BY created_at, id`),
  );
  const questions = open.map((q) => ({ id: q.id, prompt: q.prompt ?? '' }));
  if (open.length === 0) return { item: null, questions };
  const served = await issueItemOf(input.issueId, exec);
  const item =
    served ?? (input.named ? await namedRequirement(exec, input.projectId, input.named) : null);
  if (!item) return { item: null, questions };
  const unplaced = open.filter((q) => q.about === null).map((q) => q.id);
  if (unplaced.length > 0) {
    await exec.execute(sql`
      UPDATE agent_questions SET about = ${JSON.stringify(aboutOf(item))}::jsonb, updated_at = now()
       WHERE id IN (${idList(unplaced)})`);
  }
  return { item: { kind: item.kind, key: item.key }, questions };
}
