/**
 * The two acts that end a requirement's delivery (workflow requirement-lifecycle r4): a holder of
 * requirements.approve accepts the delivered head, and a requirement not going to be built is
 * dropped with a reason. Both move through the requirement machine's kernel transition.
 */

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { issueStatusToneOn } from '@forge/contracts/issue-vocabulary';
import { REQUIREMENT_MACHINE } from '@forge/contracts/requirement-machine';
import { requirementKey } from '@forge/contracts/requirements';
import { entriesOf } from '@forge/contracts/state-machine';
import { eq } from 'drizzle-orm';
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
import { acceptRefusals, type DeliveryProof, dropRefusals } from './acceptance-rules.js';
import { type RequirementActor, type Row, rowIn, signerRefusal } from './read.js';
import { deliveryAt, type StandingIssue } from './standing.js';
import { issueCriteriaOf } from './standing-facts.js';
import {
  answer,
  inTx,
  lockRequirements,
  type RequirementOutcome,
  requirementKernelActor,
} from './write-tx.js';

const DROPPABLE = entriesOf(REQUIREMENT_MACHINE, 'dropped') as RequirementStatus[];

/** The delivery phase of `row` at its head, read on `ex` by the computation the standing reads. */
export async function deliveryIn(
  ex: Tx,
  projectId: string,
  row: Pick<Row, 'id' | 'status' | 'currentRevision'>,
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
  const issueCriteria = await issueCriteriaOf(
    linked.map((i) => i.id),
    ex,
  );
  const standingIssues: StandingIssue[] = linked.map((i) => ({
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
    },
    row.currentRevision,
  );
  const proof: DeliveryProof = {
    liveIssues: read.live.length,
    unshipped: read.live.filter((i) => i.status !== 'closed').map((i) => i.displayId),
    unproven: read.coverage
      .filter((c) => c.verdict !== 'passing')
      .map((c) => ({ code: c.code, verdict: c.verdict })),
  };
  return { ...read, proof };
}

/** A holder of requirements.approve accepts the delivered head: agreed → accepted, accepted_at stored. */
export async function acceptDelivery(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  revision: number;
  reason?: string | null | undefined;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  const row = await rowIn(db, projectId, input.ref);
  const signer = await signerRefusal(actor, projectId, 'accepting a delivery');
  if (signer) return { ok: false, refusals: [signer] };
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    const { proof } = await deliveryIn(tx, projectId, current);
    const refused = acceptRefusals({
      status: current.status as RequirementStatus,
      named: input.revision,
      head: current.currentRevision,
      proof,
    });
    if (refused.length) return refused;
    const now = new Date();
    const reason = input.reason?.trim() || null;
    const accepted = await transition(tx, REQUIREMENT_MACHINE, {
      to: 'accepted',
      expect: 'agreed',
      set: { acceptedAt: now, updatedAt: now },
      where: eq(requirements.id, row.id),
      reason,
      actor: requirementKernelActor(actor),
      source: 'requirements',
      returning: ['id'],
    });
    movedRow(accepted);
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

/** A requirement not going to be built is dropped, with a reason, once no live issue links to it. */
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
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    const status = current.status as RequirementStatus;
    const { live } = await deliveryIn(tx, projectId, current);
    const refused = dropRefusals({
      status,
      droppable: DROPPABLE,
      reason: input.reason,
      liveIssues: live.map((i) => i.displayId),
    });
    if (refused.length) return refused;
    const dropped = await transition(tx, REQUIREMENT_MACHINE, {
      to: 'dropped',
      expect: status,
      set: { updatedAt: new Date() },
      where: eq(requirements.id, row.id),
      reason: input.reason.trim(),
      actor: requirementKernelActor(actor),
      source: 'requirements',
      returning: ['id'],
    });
    movedRow(dropped);
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}
