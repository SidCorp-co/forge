/**
 * The acts that move a requirement through its delivery (REQ-74 BC-8..10; workflow
 * requirement-lifecycle r4): into delivery, to delivered, accepted (by its checklist, or by decision
 * over it), and dropped with a reason. Each is an explicit act of a person, the assistant or an agent
 * through the requirement machine's kernel transition; nothing here moves a status off a result.
 */

import type { ChecklistEvaluation } from '@forge/contracts/checklists';
import type { IssueStatus } from '@forge/contracts/issue-machine';
import { issueStatusToneOn } from '@forge/contracts/issue-vocabulary';
import {
  REQUIREMENT_CRITERIA_PROVEN_GUARD,
  REQUIREMENT_HAS_LIVE_ISSUE_GUARD,
  REQUIREMENT_MACHINE,
} from '@forge/contracts/requirement-machine';
import { requirementKey } from '@forge/contracts/requirements';
import { entriesOf } from '@forge/contracts/state-machine';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
  type RequirementStatus,
  requirementCriteria,
  requirements,
} from '../db/schema-requirements.js';
import { activeIssuePrefix } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { emitEvent } from '../outbox/index.js';
import { personGateOf, readEffectivePolicy } from '../project-config/index.js';
import {
  acceptRefusals,
  type DeliveryProof,
  decisionRefusals,
  dropRefusals,
  duplicateTargetRefusal,
  liveIssueRefusal,
  provenRefusal,
} from './acceptance-rules.js';
import { postWaivedDecisionIn, waivedOf } from './acceptance-waived.js';
import { acceptanceAnswersOf, uncitedVerdictsIn } from './checklist-record.js';
import { type RequirementActor, type Row, rowIn, signerRefusal } from './read.js';
import { deferredRefusal, type RequirementRefusal } from './rules.js';
import { deliveryAt, type LiveBuildHolds, type ProofIssue } from './standing.js';
import { issueCriteriaOf, liveBuildOf, requirementVerdictsOf } from './standing-facts.js';
import { restsOnShipped } from './standing-shipped.js';
import {
  answer,
  inTx,
  lockRequirements,
  type RequirementOutcome,
  requirementKernelActor,
  voidsItsDecisions,
} from './write-tx.js';

const DROPPABLE = entriesOf(REQUIREMENT_MACHINE, 'dropped') as RequirementStatus[];

/**
 * What the live build holds of the verdict commits on `requirementId`'s issues and on its criteria at
 * the requirement itself, read apart from any
 * transaction since it asks production and the source host (`standing-facts.ts:liveBuildOf`).
 */
export async function liveBuildOfRequirement(
  projectId: string,
  requirementId: string,
): Promise<LiveBuildHolds | null> {
  const linked = await db
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.requirementId, requirementId));
  return liveBuildOf(
    projectId,
    await issueCriteriaOf(linked.map((i) => i.id)),
    await requirementVerdictsOf([requirementId]),
  );
}

/**
 * The delivery phase of `row` at its head, read on `ex` by the computation the standing reads,
 * against what the live build holds (`liveBuildOfRequirement`, read before `ex` was opened) and
 * under the judge the project's policy declares, as the standing reads it.
 */
export async function deliveryIn(
  ex: Tx,
  projectId: string,
  row: Pick<Row, 'id' | 'status' | 'currentRevision'>,
  liveBuild: LiveBuildHolds | null = null,
) {
  const linked = await ex
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      title: issues.title,
      status: issues.status,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(eq(issues.requirementId, row.id))
    .orderBy(issues.issSeq);
  const criteria = await ex
    .select({
      id: requirementCriteria.id,
      code: requirementCriteria.code,
      body: requirementCriteria.body,
      sinceRevision: requirementCriteria.sinceRevision,
      retiredRevision: requirementCriteria.retiredRevision,
    })
    .from(requirementCriteria)
    .where(eq(requirementCriteria.requirementId, row.id));
  const prefix = await activeIssuePrefix(projectId);
  const policy = await readEffectivePolicy(projectId);
  const issueCriteria = await issueCriteriaOf(
    linked.map((i) => i.id),
    ex,
  );
  const standingIssues: ProofIssue[] = linked.map((i) => ({
    id: i.id,
    displayId: formatIssueRef(prefix, i.issSeq),
    title: i.title,
    status: i.status,
    tone: issueStatusToneOn(i.status as IssueStatus, false),
    updatedAt: i.updatedAt,
    closedAt: null,
    changedSincePlan: false,
  }));
  const read = deliveryAt(
    {
      status: row.status as RequirementStatus,
      criteria,
      issues: standingIssues,
      issueCriteria,
      requirementVerdicts: await requirementVerdictsOf([row.id], ex),
      liveBuild,
      judge: policy?.document.qa ?? null,
    },
    row.currentRevision,
  );
  const proof: DeliveryProof = {
    liveIssues: read.live.length,
    shipped: restsOnShipped(read.live, read.coverage),
    unshipped: read.live.filter((i) => i.status !== 'closed').map((i) => i.displayId),
    unproven: read.coverage
      .filter((c) => c.verdict !== 'passing')
      .map((c) => ({ code: c.code, verdict: c.verdict, why: c.why })),
  };
  return { ...read, proof };
}

/**
 * The delivered head is accepted, accepted_at stored, judged by the acceptance checklist. Who may
 * accept is the project's `approvals.accept`: a holder of requirements.approve where it is on,
 * anyone who may write the requirement where it is off. `byDecision` accepts over the checklist's
 * blocking items: the same signer, with a reason and no unfinished linked issue; each item waived is
 * recorded on the move and posted as a decision on the requirement.
 */
export async function acceptDelivery(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  revision: number;
  reason?: string | null | undefined;
  byDecision?: boolean | undefined;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  const row = await rowIn(db, projectId, input.ref);
  const gate = await personGateOf(projectId, 'accept');
  const signer = await signerRefusal(actor, projectId, gate.act, row, gate.permission);
  if (signer) return { ok: false, refusals: [signer] };
  const liveBuild = await liveBuildOfRequirement(projectId, row.id);
  const reason = input.reason?.trim() || null;
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    const status = current.status as RequirementStatus;
    const refused = acceptRefusals({
      status,
      named: input.revision,
      head: current.currentRevision,
    });
    if (refused.length) return refused;
    if (input.byDecision) {
      const { live } = await deliveryIn(tx, projectId, current);
      const undecided = decisionRefusals({
        reason,
        unfinished: live.filter((i) => i.status !== 'closed').map((i) => i.displayId),
      });
      if (undecided.length) return undecided;
    }
    let judged: ChecklistEvaluation | null = null;
    const now = new Date();
    const accepted = await transition(tx, REQUIREMENT_MACHINE, {
      to: 'accepted',
      expect: status,
      set: { acceptedAt: now, updatedAt: now },
      where: eq(requirements.id, row.id),
      reason,
      actor: requirementKernelActor(actor),
      afterWrite: voidsItsDecisions('accepted', actor, reason, 'requirements'),
      source: 'requirements',
      returning: ['id'],
      // the acceptance checklist (Requirement lifecycle r15 acceptance_check), judged by the kernel
      checklist: {
        record: async ({ tx: moveTx }) => {
          const { proof } = await deliveryIn(moveTx, projectId, current, liveBuild);
          const uncited = await uncitedVerdictsIn(
            moveTx,
            row.id,
            await activeIssuePrefix(projectId),
          );
          return acceptanceAnswersOf(proof, uncited);
        },
        waive: input.byDecision === true,
        judged: (evaluation) => {
          judged = evaluation;
        },
      },
    });
    movedRow(accepted);
    const waived = waivedOf(judged);
    if (waived.length && reason) {
      await postWaivedDecisionIn(tx, {
        projectId,
        requirementId: row.id,
        reqSeq: row.reqSeq,
        revision: input.revision,
        actor,
        reason,
        waived,
      });
    }
    await emitEvent(tx, 'requirement.accepted', {
      projectId,
      requirementId: row.id,
      key: requirementKey(row.reqSeq),
      revision: input.revision,
      acceptedBy: actor.userId,
    });
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}

/**
 * The explicit moves into delivery and to delivered (REQ-74 BC-8): a person, the assistant or an
 * agent moves it through one door, asked what an accept asks, and each guard refuses by name what is
 * missing (BC-9, BC-10), judged under the kernel's lock on the delivery read in the move's own
 * transaction.
 */
export async function moveDelivery(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  to: 'in_delivery' | 'delivered';
  reason?: string | null | undefined;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  const row = await rowIn(db, projectId, input.ref);
  const gate = await personGateOf(
    projectId,
    'accept',
    input.to === 'in_delivery' ? 'moving it into delivery' : 'marking it delivered',
  );
  const signer = await signerRefusal(actor, projectId, gate.act, row, gate.permission);
  if (signer) return { ok: false, refusals: [signer] };
  const liveBuild =
    input.to === 'delivered' ? await liveBuildOfRequirement(projectId, row.id) : null;
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    const deferred = deferredRefusal(
      current.status as RequirementStatus,
      'moving its delivery',
      '',
    );
    if (deferred) return [deferred];
    const now = new Date();
    const moved = await transition(tx, REQUIREMENT_MACHINE, {
      to: input.to,
      expect: current.status as RequirementStatus,
      set: { updatedAt: now },
      where: eq(requirements.id, row.id),
      reason: input.reason?.trim() || null,
      actor: requirementKernelActor(actor),
      afterWrite: voidsItsDecisions(input.to, actor, input.reason?.trim() || null, 'requirements'),
      source: 'requirements',
      returning: ['id'],
      guards: {
        [REQUIREMENT_HAS_LIVE_ISSUE_GUARD]: async ({ tx: moveTx }) =>
          liveIssueRefusal((await deliveryIn(moveTx, projectId, current)).live.length),
        [REQUIREMENT_CRITERIA_PROVEN_GUARD]: async ({ tx: moveTx }) =>
          provenRefusal((await deliveryIn(moveTx, projectId, current, liveBuild)).coverage),
      },
    });
    movedRow(moved);
    if (input.to === 'delivered' && current.currentRevision !== null) {
      await emitEvent(tx, 'requirement.delivered', {
        projectId,
        requirementId: row.id,
        key: requirementKey(row.reqSeq),
        title: row.title,
        revision: current.currentRevision,
      });
    }
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}

/** A requirement not going to be built is dropped, with a reason, once no live issue links to it. */
/** Drops `rowId` inside the caller's transaction, under the requirements lock; refusals when it may not go. */
/** The drop of one requirement in the caller's transaction, under the project's requirement lock. */
export async function dropIn(
  tx: Tx,
  projectId: string,
  rowId: string,
  reason: string,
  actor: RequirementActor,
): Promise<RequirementRefusal[] | null> {
  await lockRequirements(tx, projectId);
  const current = await rowIn(tx, projectId, rowId);
  const status = current.status as RequirementStatus;
  const { live } = await deliveryIn(tx, projectId, current);
  const refused = dropRefusals({
    status,
    droppable: DROPPABLE,
    reason,
    liveIssues: live.map((i) => i.displayId),
  });
  if (refused.length) return refused;
  const dropped = await transition(tx, REQUIREMENT_MACHINE, {
    to: 'dropped',
    expect: status,
    set: { updatedAt: new Date() },
    where: eq(requirements.id, rowId),
    reason: reason.trim(),
    actor: requirementKernelActor(actor),
    afterWrite: voidsItsDecisions('dropped', actor, reason.trim(), 'requirements'),
    source: 'requirements',
    returning: ['id'],
  });
  movedRow(dropped);
  return null;
}

export async function dropRequirement(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  reason: string;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  const row = await rowIn(db, projectId, input.ref);
  const signer = await signerRefusal(actor, projectId, 'dropping a requirement');
  if (signer) return { ok: false, refusals: [signer] };
  const refusals = await inTx((tx) => dropIn(tx, projectId, row.id, input.reason, actor));
  return answer(projectId, row.id, actor, refusals);
}

/**
 * An accepted duplicate suggestion on a requirement (requirement-to-delivery `ready`: "merge or link
 * before agreeing"): the repeat is dropped, its reason naming the requirement it repeats, inside the
 * accept's transaction. Dropping is a sign-off, so the accepter holds requirements.approve.
 */
export async function dropAsDuplicateIn(
  tx: Tx,
  input: {
    projectId: string;
    requirementId: string;
    duplicateOf: string;
    note?: string | undefined;
    suggestionId: string;
    actor: RequirementActor;
  },
): Promise<
  { refusals: RequirementRefusal[] } | { refusals: null; requirement: string; duplicateOf: string }
> {
  const { projectId, actor } = input;
  const signer = await signerRefusal(actor, projectId, 'dropping a requirement as a duplicate');
  if (signer) return { refusals: [signer] };
  const dup = await rowIn(tx, projectId, input.requirementId);
  const original = await rowIn(tx, projectId, input.duplicateOf).catch((err: unknown) => {
    if (err instanceof HTTPException) return null;
    throw err;
  });
  const self = duplicateTargetRefusal(dup.id, original, input.duplicateOf);
  if (self) return { refusals: [self] };
  if (!original) throw new Error('requirements: a missing original was not refused');
  const originalKey = requirementKey(original.reqSeq);
  const reason = `Duplicate of ${originalKey}${input.note ? `: ${input.note}` : ''} (suggestion ${input.suggestionId}).`;
  const refusals = await dropIn(tx, projectId, dup.id, reason, actor);
  if (refusals) return { refusals };
  return { refusals: null, requirement: requirementKey(dup.reqSeq), duplicateOf: originalKey };
}
