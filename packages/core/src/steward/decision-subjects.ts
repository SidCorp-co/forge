// A steward decision on a requirement or a feedback item, carried out as the person who answered it
// in the answer's transaction (REQ-48 BC-5). A requirement's `drop`, `withdraw` and `merge` are the
// requirements module's own writes (`requirements/steward-decision.ts`); a feedback item's `drop`
// declines it, `verify` and `reopen` settle its fix, through the feedback module's own writes
// (`feedback/steward-settle.ts`). `keep` writes nothing but the act, which the decide door reads so
// the same question is not asked again while the item's standing holds. A refusal refuses the answer
// by its own code and the question stays open.

import { feedbackKey } from '@forge/contracts/feedback';
import { requirementKey } from '@forge/contracts/requirements';
import { stewardMergeOf } from '@forge/contracts/steward';
import { db, type Tx } from '../db/client.js';
import { rowIn as feedbackRowIn, stewardSettleFeedbackIn } from '../feedback/index.js';
import { accountActor } from '../issues/index.js';
import { type Refusal, RefusalError } from '../lib/refusal.js';
import type { StewardDecisionAnswer } from '../questions/index.js';
import { rowIn as requirementRowIn, stewardRequirementActIn } from '../requirements/index.js';
import type { Carry } from './decision-act.js';

async function agencyOf(userId: string): Promise<'agent' | 'human'> {
  const actor = await accountActor(userId);
  return actor.type === 'user' && actor.agency === 'agent' ? 'agent' : 'human';
}

const thrown = (refusal: Refusal) => new RefusalError([refusal], refusal.code);

/** Answer and log a keep in one transaction: nothing else moves. */
function kept<R>(answerIn: (tx: Tx) => Promise<R>, c: Carry, note: string | null): Promise<R> {
  return db.transaction(async (tx) => {
    const answered = await answerIn(tx);
    await c.logged(tx, { door: `KEEP ${c.key}`, did: `Kept ${c.key} on ${c.said}: ${note}` });
    return answered;
  });
}

export async function carryRequirementDecision<R>(
  d: StewardDecisionAnswer,
  answerIn: (tx: Tx) => Promise<R>,
  carryOf: (key: string) => Carry,
): Promise<R> {
  const row = await requirementRowIn(db, d.projectId, d.subject.id);
  const c = carryOf(requirementKey(row.reqSeq));
  if (d.decision === 'keep') return kept(answerIn, c, d.note);
  const reason = d.note ?? '';
  const into = stewardMergeOf(d.optionId)?.into;
  const decision =
    d.decision === 'merge' && into
      ? ({ act: 'merge', into, reason } as const)
      : d.decision === 'withdraw'
        ? ({ act: 'withdraw', reason } as const)
        : ({ act: 'drop', reason } as const);
  const actor = { userId: d.by, agency: await agencyOf(d.by) };
  return db.transaction(async (tx) => {
    const answered = await answerIn(tx);
    const refused = await stewardRequirementActIn(tx, {
      projectId: d.projectId,
      requirementId: row.id,
      actor,
      decision,
      said: c.said,
    });
    if (refused) throw thrown(refused);
    const did =
      decision.act === 'merge'
        ? `Merged ${c.key} into ${decision.into} on ${c.said}`
        : decision.act === 'withdraw'
          ? `Withdrew ${c.key}'s draft revision on ${c.said}: ${reason}`
          : `Dropped ${c.key} on ${c.said}: ${reason}`;
    await c.logged(tx, {
      door: `POST /api/projects/${d.projectId}/requirements/${c.key}/${decision.act}`,
      did,
    });
    return answered;
  });
}

const FEEDBACK_ACT = { drop: 'declined', verify: 'verified', reopen: 'reopened' } as const;

export async function carryFeedbackDecision<R>(
  d: StewardDecisionAnswer,
  answerIn: (tx: Tx) => Promise<R>,
  carryOf: (key: string) => Carry,
): Promise<R> {
  const row = await feedbackRowIn(db, d.projectId, d.subject.id);
  const c = carryOf(feedbackKey(row.fbSeq));
  if (d.decision === 'keep') return kept(answerIn, c, d.note);
  const act = FEEDBACK_ACT[d.decision as keyof typeof FEEDBACK_ACT];
  if (!act) throw new Error(`steward: ${d.decision} is no act on a feedback item`);
  const actor = { userId: d.by, agency: await agencyOf(d.by) };
  return db.transaction(async (tx) => {
    const answered = await answerIn(tx);
    const refused = await stewardSettleFeedbackIn(tx, {
      projectId: d.projectId,
      feedbackId: row.id,
      actor,
      act,
      note: d.note,
    });
    if (refused) throw thrown(refused);
    await c.logged(tx, {
      door: `POST /api/projects/${d.projectId}/feedback/${c.key}/${act === 'declined' ? 'triage' : act === 'verified' ? 'verify' : 'reopen'}`,
      did: `${act === 'declined' ? 'Declined' : act === 'verified' ? 'Verified' : 'Reopened'} ${c.key} on ${c.said}${d.note ? `: ${d.note}` : ''}`,
    });
    return answered;
  });
}
