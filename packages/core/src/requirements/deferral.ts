/**
 * Deferring a requirement out of the current release, and undeferring it (ISS-85): a person's act
 * with a reason, one insert-only requirement_deferrals row each, and the head's status `deferred`
 * until the undefer puts back the status the defer left. A deferred requirement waits on nobody.
 */

import { REQUIREMENT_MACHINE } from '@forge/contracts/requirement-machine';
import { and, eq, notInArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
  type RequirementStatus,
  requirementDeferrals,
  requirements,
} from '../db/schema-requirements.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { movedRow, transition } from '../lifecycle/transition.js';
import { latestDeferOf } from './deferral-read.js';
import { type RequirementActor, rowIn, signerRefusal } from './read.js';
import { deferRefusals, undeferRefusal } from './rules.js';
import {
  answer,
  inTx,
  lockRequirements,
  type RequirementOutcome,
  requirementKernelActor,
} from './service.js';

async function workingIssuesOf(tx: Tx, projectId: string, requirementId: string) {
  const rows = await tx
    .select({ issSeq: issues.issSeq })
    .from(issues)
    .where(
      and(
        eq(issues.requirementId, requirementId),
        notInArray(issues.status, ['draft', 'closed', 'dropped']),
      ),
    )
    .orderBy(issues.issSeq);
  const prefix = await activeIssuePrefix(projectId);
  return rows.map((r) => formatIssueRef(prefix, r.issSeq));
}

export async function deferRequirement(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  reason: string;
  targetPhase?: string | null | undefined;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  const row = await rowIn(db, projectId, input.ref);
  const signer = await signerRefusal(actor, projectId, 'deferring a requirement');
  if (signer) return { ok: false, refusals: [signer] };
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    const status = current.status as RequirementStatus;
    const refused = deferRefusals({
      status,
      reason: input.reason,
      workingIssues: await workingIssuesOf(tx, projectId, row.id),
    });
    if (refused.length) return refused;
    await tx.insert(requirementDeferrals).values({
      requirementId: row.id,
      act: 'defer',
      fromStatus: status as 'draft' | 'agreed',
      targetPhase: input.targetPhase?.trim() || null,
      reason: input.reason.trim(),
      decidedBy: actor.userId,
    });
    const deferred = await transition(tx, REQUIREMENT_MACHINE, {
      to: 'deferred',
      expect: status,
      set: { updatedAt: new Date() },
      where: eq(requirements.id, row.id),
      reason: input.reason.trim(),
      actor: requirementKernelActor(actor),
      source: 'requirement-deferral',
      returning: ['id'],
    });
    movedRow(deferred);
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}

export async function undeferRequirement(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  reason?: string | null | undefined;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  const row = await rowIn(db, projectId, input.ref);
  const signer = await signerRefusal(actor, projectId, 'undeferring a requirement');
  if (signer) return { ok: false, refusals: [signer] };
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    const refusal = undeferRefusal(current.status as RequirementStatus);
    if (refusal) return [refusal];
    const defer = await latestDeferOf(tx, row.id);
    if (!defer || defer.fromStatus === 'deferred') {
      throw new Error(`requirements: ${row.id} is deferred with no defer row to undo`);
    }
    await tx.insert(requirementDeferrals).values({
      requirementId: row.id,
      act: 'undefer',
      fromStatus: 'deferred',
      reason: input.reason?.trim() || null,
      decidedBy: actor.userId,
    });
    const undeferred = await transition(tx, REQUIREMENT_MACHINE, {
      to: defer.fromStatus,
      expect: 'deferred',
      set: { updatedAt: new Date() },
      where: eq(requirements.id, row.id),
      reason: input.reason?.trim() || null,
      actor: requirementKernelActor(actor),
      source: 'requirement-deferral',
      returning: ['id'],
    });
    movedRow(undeferred);
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}
