/**
 * The links a requirement holds: the issues that deliver it and the designs it is drawn with, and
 * what an issue reads back — whether its requirement changed since its plan was written.
 */

import { requirementKey } from '@forge/contracts/requirements';
import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
  type RequirementStatus,
  requirements,
  requirementWorkflows,
} from '../db/schema-requirements.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import {
  adoptIssuePlan,
  linkIssueToRequirement,
  resolveIssueRouteRef,
  unlinkIssueFromRequirement,
} from '../issues/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { plannedBaselineSeqIn } from './baselines.js';
import { planDriftOf } from './plan-drift.js';
import { notFound, type RequirementActor, rowIn, signerRefusal } from './read.js';
import { linkIssueRefusal, refuseRequirement } from './rules.js';
import { answer, inTx, lockRequirements, type RequirementOutcome } from './write-tx.js';

async function issueIn(projectId: string, ref: string, userId: string) {
  const issue = await resolveIssueRouteRef(ref, projectId, userId);
  if (issue.projectId !== projectId) {
    throw notFound(`issue ${ref} is not an issue of project ${projectId}`);
  }
  return issue;
}

/** An issue names the agreed requirement it delivers; its plan then records which revision it read. */
export async function linkIssue(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  issue: string;
  adoptPlan?: boolean | undefined;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  const issue = await issueIn(projectId, input.issue, actor.userId);
  if (input.adoptPlan) {
    const signer = await signerRefusal(
      actor,
      projectId,
      'adopting an existing plan for a revision',
    );
    if (signer) return answer(projectId, row.id, actor, [signer]);
  }
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const current = await rowIn(tx, projectId, row.id);
    const refusal = linkIssueRefusal(current.status as RequirementStatus);
    if (refusal) return [refusal];
    const [held] = await tx
      .select({ requirementId: issues.requirementId, plan: issues.plan })
      .from(issues)
      .where(eq(issues.id, issue.id));
    if (input.adoptPlan && !held?.plan?.trim()) {
      return [
        {
          code: 'REQUIREMENT_NO_PLAN_TO_ADOPT',
          path: '/adoptPlan',
          detail: `${input.issue} has no plan, so there is nothing to adopt for revision ${current.currentRevision ?? 'none'}; link it without adoptPlan and its next plan records the revision it read.`,
        },
      ];
    }
    // Without adoptPlan a pre-existing plan stays planned against no revision and reads changed-since-plan;
    // only a person attesting the plan already satisfies the current revision may record it (D1, requirements-walkthrough)
    const plannedRevision = input.adoptPlan ? (current.currentRevision ?? null) : null;
    const plannedBaselineSeq = input.adoptPlan
      ? await plannedBaselineSeqIn(tx, row.id, plannedRevision)
      : null;
    if (held?.requirementId === row.id) {
      if (input.adoptPlan) {
        await adoptIssuePlan(tx, issue.id, { plannedRevision, plannedBaselineSeq });
      }
      return null;
    }
    if (held?.requirementId) {
      const elsewhere = await rowIn(tx, projectId, held.requirementId);
      return [
        {
          code: 'REQUIREMENT_ISSUE_LINKED_ELSEWHERE',
          path: '/issue',
          detail: `${input.issue} already delivers ${requirementKey(elsewhere.reqSeq)}; an issue serves one requirement, so unlink it there first.`,
        },
      ];
    }
    await linkIssueToRequirement(tx, issue.id, row.id, { plannedRevision, plannedBaselineSeq });
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}

export async function unlinkIssue(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  issue: string;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  const issue = await issueIn(projectId, input.issue, actor.userId);
  await unlinkIssueFromRequirement(issue.id, row.id);
  return answer(projectId, row.id, actor, null);
}

/** A design the requirement is drawn with; the next agree pins its approved revision. */
export async function linkWorkflow(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  workflowId: string;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  const [wf] = await db
    .select({ projectId: projectWorkflows.projectId })
    .from(projectWorkflows)
    .where(eq(projectWorkflows.id, input.workflowId));
  if (!wf || wf.projectId !== projectId) {
    throw notFound(`project ${projectId} holds no workflow ${input.workflowId}`);
  }
  await db
    .insert(requirementWorkflows)
    .values({ requirementId: row.id, workflowId: input.workflowId, linkedBy: actor.userId })
    .onConflictDoNothing();
  return answer(projectId, row.id, actor, null);
}

export async function unlinkWorkflow(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  workflowId: string;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  await db
    .delete(requirementWorkflows)
    .where(
      and(
        eq(requirementWorkflows.requirementId, row.id),
        eq(requirementWorkflows.workflowId, input.workflowId),
      ),
    );
  return answer(projectId, row.id, actor, null);
}

export async function requirementOfIssue(issueId: string) {
  const [r] = await db
    .select({
      id: requirements.id,
      reqSeq: requirements.reqSeq,
      title: requirements.title,
      status: requirements.status,
      currentRevision: requirements.currentRevision,
      plannedRevision: issues.plannedRevision,
    })
    .from(issues)
    .innerJoin(requirements, eq(requirements.id, issues.requirementId))
    .where(eq(issues.id, issueId));
  if (!r) return null;
  const drift = await planDriftOf(db, issueId);
  return {
    requirementId: r.id,
    key: requirementKey(r.reqSeq),
    title: r.title,
    status: r.status as RequirementStatus,
    currentRevision: r.currentRevision,
    plannedRevision: r.plannedRevision,
    changedSincePlan: drift?.changed ?? false,
    refusal: drift?.changed
      ? { code: 'REQUIREMENT_CHANGED_SINCE_PLAN' as const, detail: drift.detail }
      : null,
  };
}

// A plan is written against the requirement's current revision and records it as
// planned_revision; a requirement with no current revision refuses it (REQUIREMENT_REVISION_NOT_CURRENT)
export async function plannedRevisionFor(
  tx: Tx,
  issueId: string,
  plan: string | null,
): Promise<{ plannedRevision: number | null; plannedBaselineSeq: number | null } | null> {
  const [r] = await tx
    .select({
      requirementId: issues.requirementId,
      reqSeq: requirements.reqSeq,
      currentRevision: requirements.currentRevision,
    })
    .from(issues)
    .leftJoin(requirements, eq(requirements.id, issues.requirementId))
    .where(eq(issues.id, issueId));
  if (!r?.requirementId) return null;
  if (!plan?.trim()) return { plannedRevision: null, plannedBaselineSeq: null };
  if (r.currentRevision === null) {
    throw refuseRequirement(
      'REQUIREMENT_REVISION_NOT_CURRENT',
      `${requirementKey(r.reqSeq ?? 0)} has no current revision, so there is nothing for this plan to be written against; a person accepts a revision first.`,
      '/plan',
    );
  }
  return {
    plannedRevision: r.currentRevision,
    plannedBaselineSeq: await plannedBaselineSeqIn(tx, r.requirementId, r.currentRevision),
  };
}
