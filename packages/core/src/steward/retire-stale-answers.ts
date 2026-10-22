// The stale-draft answers the retired sweep's consumer never carried out (REQ-48 BC-5). That consumer
// acted on `question.answered` after the answer committed, so a drop or merge answered just before
// the deploy that removed it can stand answered with its draft still a draft. The retirement carries
// each one out once, as the person who answered it, through the same writes a steward decision uses;
// one a rule refuses is recorded on its answered round by name, as the consumer recorded it, and
// logged. A draft no longer a draft, or a round already carrying an outcome, was acted on: left alone.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { stewardMergeOptionId } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { accountActor, issueDisplayIds, transitionIssueStatus } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { RefusalError } from '../lib/refusal.js';
import { recordAnswerResume } from '../questions/index.js';
import { stewardRequirementActIn } from '../requirements/index.js';
import { mergePlanOf } from './decision-merge.js';

/** The option every stale-draft question offered, as its jsonb mark. */
export const STALE_DRAFT_ASKED_MARK = JSON.stringify([{ id: 'stale_draft.drop' }]);

interface Unacted {
  id: string;
  project_id: string;
  issue_id: string | null;
  requirement_id: string | null;
  chosen: 'stale_draft.drop' | 'stale_draft.merge';
  answered_by: string;
  note: string | null;
  asked_at: string;
  target: { kind: string; id: string; key: string } | null;
}

export interface CarriedAnswer {
  questionId: string;
  outcome: 'carried' | { code: string; detail: string };
}

/** The answered drops and merges whose draft is still a draft and whose round records no outcome. */
async function unacted(): Promise<Unacted[]> {
  return rowsOf<Unacted>(
    await db.execute(sql`
      SELECT q.id, q.project_id, q.issue_id, q.requirement_id,
             q.steps -> -1 ->> 'chosenOptionId' AS chosen,
             q.steps -> -1 ->> 'answeredBy' AS answered_by,
             q.steps -> -1 ->> 'note' AS note,
             q.steps -> -1 ->> 'askedAt' AS asked_at,
             (SELECT o -> 'target' FROM jsonb_array_elements(q.steps -> -1 -> 'options') o
               WHERE o ->> 'id' = q.steps -> -1 ->> 'chosenOptionId') AS target
        FROM agent_questions q
       WHERE q.status = 'answered'
         AND q.steps -> 0 -> 'options' @> ${STALE_DRAFT_ASKED_MARK}::jsonb
         AND q.steps -> -1 -> 'resume' IS NULL
         AND q.steps -> -1 ->> 'chosenOptionId' IN ('stale_draft.drop', 'stale_draft.merge')
         AND q.steps -> -1 ->> 'answeredBy' IS NOT NULL
         AND (EXISTS (SELECT 1 FROM issues i WHERE i.id = q.issue_id AND i.status = 'draft')
           OR EXISTS (SELECT 1 FROM requirements r WHERE r.id = q.requirement_id AND r.status = 'draft'))
       ORDER BY q.created_at`),
  );
}

const ruled = (code: string, detail: string) => ({ code, detail });

async function agencyOf(userId: string): Promise<'agent' | 'human'> {
  const actor = await accountActor(userId);
  return actor.type === 'user' && actor.agency === 'agent' ? 'agent' : 'human';
}

/** Carry one answer out; null where it was done, else the rule that refused it. */
async function carry(a: Unacted): Promise<{ code: string; detail: string } | null> {
  const said = `the answer to Forge's merge-or-drop question ${a.id}`;
  const reason = a.note?.trim() || 'answered drop';
  const merge = a.chosen === 'stale_draft.merge';
  if (merge && !a.target) {
    return ruled('STALE_DRAFT_MERGE_NO_TARGET', 'the merge answered names no target to merge into');
  }
  if (a.requirement_id) {
    const requirementId = a.requirement_id;
    if (merge && a.target?.kind !== 'requirement') {
      return ruled(
        'STALE_DRAFT_MERGE_NO_TARGET',
        `the merge names ${a.target?.key}, not a requirement; a requirement merges only into a requirement`,
      );
    }
    const actor = { userId: a.answered_by, agency: await agencyOf(a.answered_by) };
    return db.transaction((tx) =>
      stewardRequirementActIn(tx, {
        projectId: a.project_id,
        requirementId,
        actor,
        decision:
          merge && a.target
            ? { act: 'merge', into: a.target.key, reason }
            : { act: 'drop', reason },
        said,
      }),
    );
  }
  const [issue] = rowsOf<{
    id: string;
    project_id: string;
    status: string;
    reopen_count: number;
    title: string;
    description: string | null;
  }>(
    await db.execute(sql`
      SELECT id, project_id, status, reopen_count, title, description FROM issues WHERE id = ${a.issue_id}`),
  );
  if (!issue) return ruled('STALE_DRAFT_MERGE_NO_TARGET', 'the question stands on no issue');
  const key = (await issueDisplayIds([issue.id])).get(issue.id) ?? issue.id;
  const plan =
    merge && a.target
      ? await mergePlanOf(
          {
            questionId: a.id,
            projectId: a.project_id,
            subject: { kind: 'issue', id: issue.id },
            decision: 'merge',
            optionId: stewardMergeOptionId(a.target.key),
            by: a.answered_by,
            note: a.note,
            fingerprint: null,
            askedAt: new Date(a.asked_at),
          },
          {
            id: issue.id,
            projectId: issue.project_id,
            title: issue.title,
            description: issue.description,
          },
          key,
          said,
        )
      : null;
  const why = plan
    ? `Merged into ${plan.targetKey} on ${said}: its text is a comment there.`
    : `Dropped on ${said}: ${reason}`;
  await transitionIssueStatus(
    {
      id: issue.id,
      projectId: issue.project_id,
      status: issue.status as IssueStatus,
      reopenCount: issue.reopen_count,
    },
    'dropped',
    await accountActor(a.answered_by),
    {
      reason: why,
      transitionReason: why,
      ...(plan ? { beforeStatusWrite: (tx) => plan.write(tx) } : {}),
    },
  );
  return null;
}

/** Carry out every answered drop or merge the retired consumer left undone; what each came to. */
export async function carryUnactedStaleAnswers(): Promise<CarriedAnswer[]> {
  const out: CarriedAnswer[] = [];
  for (const a of await unacted()) {
    let refused: { code: string; detail: string } | null;
    try {
      refused = await carry(a);
    } catch (err) {
      if (!(err instanceof RefusalError)) throw err;
      const [first] = err.refusals;
      refused = ruled(first?.code ?? err.fallbackCode, first?.detail ?? err.message);
    }
    if (refused) {
      await recordAnswerResume(a.id, { kind: 'refused', ...refused, at: new Date().toISOString() });
      logger.warn(
        { questionId: a.id, projectId: a.project_id, answer: a.chosen, code: refused.code },
        'retire-stale-drafts: an answered drop or merge was not carried out by rule; its draft stays a draft',
      );
    }
    out.push({ questionId: a.id, outcome: refused ?? 'carried' });
  }
  return out;
}
