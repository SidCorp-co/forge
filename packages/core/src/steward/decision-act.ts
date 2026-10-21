// A steward decision is carried out by its answer (REQ-48 BC-5), as the person who answered it:
// `open` moves the draft to open through the kernel, `drop` drops the issue with the answerer's
// reason, and `keep` records the keep, which the decide door reads so the same question is not asked
// again while the issue's standing holds. The answer is written in the act's own transaction, so a
// move the kernel refuses refuses the answer by the kernel's own name and the question stays open.
// Each act is logged on the item as a steward act; a move's undo is a person's, named by the undo door.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { STEWARD_DECISIONS_WITH_REASON, type StewardRefusalCode } from '@forge/contracts/steward';
import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { accountActor, issueDisplayIds, transitionIssueStatus } from '../issues/index.js';
import { refuser } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import type { StewardDecisionAnswer } from '../questions/index.js';
import { recordAct } from './acts-store.js';
import { fingerprintOf } from './door-decide.js';

const refuse = refuser<StewardRefusalCode>('STEWARD_DECISION_STALE');

/** What a keep and a drop say their reason is for, as the refusal of a missing one names it. */
const REASON_FOR = {
  keep: 'until when it stays as it is, or why',
  drop: 'why it is not work',
} as const;

/** Carry `d` out as its answerer, recording the answer with `answerIn` inside the act's transaction. */
export async function carryStewardDecision<R>(
  d: StewardDecisionAnswer,
  answerIn: (tx: Tx) => Promise<R>,
): Promise<R> {
  const [issue] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
    })
    .from(issues)
    .where(eq(issues.id, d.issueId))
    .limit(1);
  if (!issue) throw notFound(`no issue ${d.issueId}`);
  const key = (await issueDisplayIds([issue.id])).get(issue.id) ?? issue.id;
  if (d.decision !== 'open' && STEWARD_DECISIONS_WITH_REASON.includes(d.decision) && !d.note) {
    throw refuse(
      'STEWARD_DECISION_REASON_REQUIRED',
      `answering ${d.decision} on ${key} takes your reason in \`note\`: ${REASON_FOR[d.decision]}`,
      '/note',
    );
  }
  if (d.decision === 'open' && issue.status !== 'draft') {
    throw refuse(
      'STEWARD_DECISION_STALE',
      `${key} is ${issue.status} now, no longer the draft this question asked about; answer keep or drop, or void the question (POST /api/questions/${d.questionId}/void)`,
      '/optionId',
    );
  }
  const asked = fingerprintOf(d.fingerprint ?? undefined);
  if (!asked) throw new Error(`steward: decision question ${d.questionId} names no run that asked`);
  const said = `the answer to the steward's question ${d.questionId}`;
  const logged = (tx: Tx, door: string, did: string) =>
    recordAct(
      {
        runId: asked.runId,
        projectId: d.projectId,
        act: 'stuck_diagnosis',
        door,
        did,
        wrote: { kind: 'question', ref: d.questionId },
        undo: null,
      },
      tx,
    );
  if (d.decision === 'keep') {
    return db.transaction(async (tx) => {
      const answered = await answerIn(tx);
      await logged(tx, `KEEP ${key}`, `Kept ${key} on ${said}: ${d.note}`);
      return answered;
    });
  }
  const to = d.decision === 'open' ? 'open' : 'dropped';
  const reason = d.decision === 'open' ? `Opened on ${said}.` : `Dropped on ${said}: ${d.note}`;
  let answered: R | undefined;
  await transitionIssueStatus(
    { ...issue, status: issue.status as IssueStatus },
    to,
    await accountActor(d.by),
    {
      reason,
      transitionReason: reason,
      beforeStatusWrite: async (tx) => {
        answered = await answerIn(tx);
        await logged(
          tx,
          `POST /api/issues/${issue.id}/transition`,
          reason.replace(/^\w+/, (w) => `${w} ${key}`),
        );
      },
    },
  );
  if (answered === undefined) throw new Error(`steward: ${key}'s move wrote no answer`);
  return answered;
}
