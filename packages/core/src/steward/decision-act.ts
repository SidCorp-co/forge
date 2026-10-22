// A steward decision is carried out by its answer (REQ-48 BC-5), as the person who answered it. On an
// issue: `open` moves the prepared draft to open through the kernel; `drop` drops it with the
// answerer's reason; `keep` records the keep, which the decide door reads so the same question is not
// asked again while the issue's standing holds; `link` links the draft to the requirement the answer
// names and has the steward diagnose it again, which prepares it and asks whether to open it;
// `requirement` starts a draft requirement from the draft's feedback; `merge` copies the draft's text
// to the live issue it repeats and drops the draft. A requirement's and a feedback item's are
// `decision-subjects.ts`. The answer is written in the act's own transaction, so an act refused, a
// move the kernel refuses included, refuses the answer by its own name and the question stays open,
// and nothing is written twice. Each act is logged on the item as a steward act, undone through its
// own door or refused naming a person's override.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import {
  STEWARD_DECISIONS_WITH_REASON,
  type StewardDecision,
  type StewardRefusalCode,
  stewardLinkOf,
} from '@forge/contracts/steward';
import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { accountActor, issueDisplayIds, transitionIssueStatus } from '../issues/index.js';
import { refuser } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import type { StewardDecisionAnswer } from '../questions/index.js';
import { recordAct } from './acts-store.js';
import { fingerprintOf } from './decision-ask.js';
import { linkDraftIn, proposeItsPlacement, startRequirementIn } from './decision-draft.js';
import { mergePlanOf } from './decision-merge.js';
import { carryFeedbackDecision, carryRequirementDecision } from './decision-subjects.js';
import { openStandings } from './ports.js';

const refuse = refuser<StewardRefusalCode>('STEWARD_DECISION_STALE');

/** What a keep and a drop say their reason is for, as the refusal of a missing one names it. */
const REASON_FOR: Partial<Record<StewardDecision, string>> = {
  keep: 'until when it stays as it is, or why',
  drop: 'why it is not work',
  withdraw: 'why the draft revision goes',
  reopen: 'why the fix does not answer it',
};

/** The decisions each kind of item takes; any other is no decision of it. */
const TAKES: Record<StewardDecisionAnswer['subject']['kind'], readonly StewardDecision[]> = {
  issue: ['open', 'keep', 'drop', 'link', 'requirement', 'merge'],
  requirement: ['merge', 'drop', 'keep', 'withdraw'],
  feedback: ['keep', 'drop', 'verify', 'reopen'],
};

/** The decisions that act on a draft alone. */
const DRAFT_ONLY: readonly StewardDecision[] = ['open', 'link', 'requirement', 'merge'];

export type Logged = { door: string; did: string; undo?: { door: string; body: null } | null };

/** What every kind's carrying needs: the item's key, the said source, and the act log in `tx`. */
export interface Carry {
  key: string;
  said: string;
  logged: (tx: Tx, act: Logged) => Promise<string>;
}

/** Refuse a keep, drop, withdraw or reopen answered with no reason, naming what it is for. */
function requireReason(d: StewardDecisionAnswer, key: string): void {
  const reasonFor = REASON_FOR[d.decision];
  if (reasonFor && STEWARD_DECISIONS_WITH_REASON.includes(d.decision) && !d.note) {
    throw refuse(
      'STEWARD_DECISION_REASON_REQUIRED',
      `answering ${d.decision} on ${key} takes your reason in \`note\`: ${reasonFor}`,
      '/note',
    );
  }
}

/** Carry `d` out as its answerer, recording the answer with `answerIn` inside the act's transaction. */
export async function carryStewardDecision<R>(
  d: StewardDecisionAnswer,
  answerIn: (tx: Tx) => Promise<R>,
): Promise<R> {
  if (!TAKES[d.subject.kind].includes(d.decision)) {
    throw refuse(
      'STEWARD_DECISION_OPTIONS_UNKNOWN',
      `${d.decision} is no decision a ${d.subject.kind} takes; void the question (POST /api/questions/${d.questionId}/void)`,
      '/optionId',
    );
  }
  const asked = fingerprintOf(d.fingerprint ?? undefined);
  if (!asked) throw new Error(`steward: decision question ${d.questionId} names no run that asked`);
  const carry = (key: string): Carry => ({
    key,
    said: `the answer to the steward's question ${d.questionId}`,
    logged: (tx, act) =>
      recordAct(
        {
          runId: asked.runId,
          projectId: d.projectId,
          act: 'stuck_diagnosis',
          door: act.door,
          did: act.did,
          wrote: { kind: 'question', ref: d.questionId },
          undo: act.undo ?? null,
        },
        tx,
      ),
  });
  if (d.subject.kind === 'requirement') {
    return carryRequirementDecision(d, answerIn, (key) => {
      requireReason(d, key);
      return carry(key);
    });
  }
  if (d.subject.kind === 'feedback') {
    return carryFeedbackDecision(d, answerIn, (key) => {
      requireReason(d, key);
      return carry(key);
    });
  }
  const [issue] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
      title: issues.title,
      description: issues.description,
      requirementId: issues.requirementId,
    })
    .from(issues)
    .where(eq(issues.id, d.subject.id))
    .limit(1);
  if (!issue) throw notFound(`no issue ${d.subject.id}`);
  const key = (await issueDisplayIds([issue.id])).get(issue.id) ?? issue.id;
  requireReason(d, key);
  if (DRAFT_ONLY.includes(d.decision) && issue.status !== 'draft') {
    throw refuse(
      'STEWARD_DECISION_STALE',
      `${key} is ${issue.status} now, no longer the draft this question asked about; answer keep or drop, or void the question (POST /api/questions/${d.questionId}/void)`,
      '/optionId',
    );
  }
  const { said, logged } = carry(key);

  if (d.decision === 'keep') {
    return db.transaction(async (tx) => {
      const answered = await answerIn(tx);
      await logged(tx, { door: `KEEP ${key}`, did: `Kept ${key} on ${said}: ${d.note}` });
      return answered;
    });
  }

  if (d.decision === 'link') {
    const target = stewardLinkOf(d.optionId);
    if (!target) throw new Error(`steward: link option ${d.optionId} names no requirement`);
    const standing = (await openStandings(d.projectId)).find(
      (s) => s.subject.kind === 'issue' && s.subject.id === issue.id,
    );
    return db.transaction(async (tx) => {
      const answered = await answerIn(tx);
      const linked = await linkDraftIn(tx, {
        projectId: d.projectId,
        issue,
        key,
        requirement: target.requirement,
        stuckCode: standing?.stuck?.code ?? 'draft_carrier',
      });
      if (linked) {
        await logged(tx, {
          door: `POST /api/projects/${d.projectId}/requirements/${target.requirement}/issues`,
          did: `Linked ${key} to ${target.requirement}, delivering ${target.bc}, on ${said}`,
          undo: {
            door: `DELETE /api/projects/${d.projectId}/requirements/${target.requirement}/issues/${issue.id}`,
            body: null,
          },
        });
      }
      return answered;
    });
  }

  if (d.decision === 'requirement') {
    const actor = await accountActor(d.by);
    const started = await db.transaction(async (tx) => {
      const answered = await answerIn(tx);
      const { id, made, from } = await startRequirementIn(tx, {
        projectId: d.projectId,
        actor: {
          userId: d.by,
          agency: actor.type === 'user' && actor.agency === 'agent' ? 'agent' : 'human',
        },
        issue,
        key,
        said,
      });
      await logged(tx, {
        door: `POST /api/projects/${d.projectId}/requirements`,
        did: `Started ${made} from ${from} for ${key} on ${said}`,
      });
      return { answered, id };
    });
    proposeItsPlacement(d.projectId, started.id);
    return started.answered;
  }

  const merge = d.decision === 'merge' ? await mergePlanOf(d, issue, key, said) : null;
  const to = d.decision === 'open' ? 'open' : 'dropped';
  const reason =
    d.decision === 'open'
      ? `Opened on ${said}.`
      : merge
        ? `Merged into ${merge.targetKey} on ${said}: its text is a comment there.`
        : `Dropped on ${said}: ${d.note}`;
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
        if (merge) await merge.write(tx);
        await logged(tx, {
          door: merge
            ? `POST /api/issues/${merge.targetId}/comments`
            : `POST /api/issues/${issue.id}/transition`,
          did: reason.replace(/^\w+/, (w) => `${w} ${key}`),
        });
      },
    },
  );
  if (answered === undefined) throw new Error(`steward: ${key}'s move wrote no answer`);
  return answered;
}
