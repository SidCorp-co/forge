/**
 * The links a requirement holds: the issues that deliver it and the designs it is drawn with, and
 * what an issue reads back — whether its requirement changed since its plan was written.
 */

import { requirementKey } from '@forge/contracts/requirements';
import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import {
  type RequirementStatus,
  requirementCriterionSteps,
  requirements,
  requirementWorkflows,
} from '../db/schema-requirements.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import {
  adoptIssuePlan,
  findIssueById,
  isUuid,
  linkIssueToRequirement,
  resolveIssueRouteRef,
  unlinkIssueFromRequirement,
} from '../issues/index.js';
import { RefusalError } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import {
  actorFor,
  permissionFactsOf,
  permissionRefusal,
  projectResource,
  requireCan,
} from '../permissions/index.js';
import { gateOf } from '../project-config/index.js';
import { projectsOf, requirementNamed } from './issue-projects.js';
import { planDriftOf } from './plan-drift.js';
import { type RequirementActor, rowIn, signerRefusal } from './read.js';
import { designWithdrawnRefusal, linkIssueRefusal, refuseRequirement } from './rules.js';
import { answer, inTx, lockRequirements, type RequirementOutcome } from './write-tx.js';

/**
 * The issue a link names: by key, an issue of the requirement's own project; by uuid, an issue of
 * any project of the same organization, a sibling project's issue delivering it. Who may link
 * holds `project.write` on the requirement's project (asked before this) and `project.read` on the
 * issue's: one rule for a person and for an agent, whose credential must reach both projects. An
 * issue of another organization, and one of a project the caller cannot read, are refused by name.
 */
async function issueIn(projectId: string, ref: string, userId: string) {
  if (!isUuid(ref)) return resolveIssueRouteRef(ref, projectId, userId);
  const issue = await findIssueById(ref);
  if (!issue) throw notFound(`no issue ${ref}`);
  if (issue.projectId === projectId) return issue;
  const [here, there] = await projectsOf([projectId, issue.projectId]);
  if (!here || !there || here.orgId !== there.orgId) {
    throw refuseRequirement(
      'REQUIREMENT_ISSUE_OTHER_ORG',
      `issue ${ref} is an issue of another organization's project; a requirement is delivered only by issues of its own organization's projects, so link one of those.`,
      '/issue',
    );
  }
  const refusal = permissionRefusal(
    await permissionFactsOf(userId, issue.projectId),
    'project.read',
    `Linking an issue of ${there.slug} to a requirement of ${here.slug}`,
  );
  if (refusal) throw new RefusalError([refusal], refusal.code);
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
    const refusal = linkIssueRefusal(
      current.status as RequirementStatus,
      await gateOf(projectId, 'link_requirement_agreed'),
    );
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
    if (held?.requirementId === row.id) {
      if (input.adoptPlan) {
        await adoptIssuePlan(tx, issue.id, { plannedRevision });
      }
      return null;
    }
    if (held?.requirementId) {
      const elsewhere = await requirementNamed(tx, held.requirementId);
      const own = elsewhere.projectId === projectId;
      return [
        {
          code: 'REQUIREMENT_ISSUE_LINKED_ELSEWHERE',
          path: '/issue',
          detail: `${input.issue} already delivers ${own ? '' : `${elsewhere.slug}/`}${elsewhere.key}; an issue serves one requirement, so unlink it there first: DELETE /api/projects/${own ? ':id' : elsewhere.projectId}/requirements/${elsewhere.key}/issues/${input.issue}.`,
        },
      ];
    }
    await linkIssueToRequirement(tx, issue.id, row.id, { plannedRevision });
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
  if (issue.requirementId !== row.id)
    throw notFound(`${input.ref} is not delivered by ${input.issue}`);
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
    .select({
      projectId: projectWorkflows.projectId,
      flow: projectWorkflows.flow,
      designStatus: projectWorkflows.designStatus,
    })
    .from(projectWorkflows)
    .where(eq(projectWorkflows.id, input.workflowId));
  if (!wf || wf.projectId !== projectId) {
    throw notFound(`project ${projectId} holds no workflow ${input.workflowId}`);
  }
  if (wf.designStatus === 'withdrawn') {
    return { ok: false, refusals: [designWithdrawnRefusal(wf.flow, '/workflowId')] };
  }
  await db
    .insert(requirementWorkflows)
    .values({ requirementId: row.id, workflowId: input.workflowId, linkedBy: actor.userId })
    .onConflictDoNothing();
  return answer(projectId, row.id, actor, null);
}

/**
 * The ids of the designs `names` names in the project, by flow name or id, in their order; or the
 * names it holds no design for, and those naming a withdrawn design with where each was named. Read
 * before a write that links them, so nothing is half written.
 */
export async function designIdsOf(
  projectId: string,
  names: readonly string[],
): Promise<
  | { ok: true; ids: string[] }
  | { ok: false; missing: string[]; withdrawn: { at: number; flow: string }[] }
> {
  if (names.length === 0) return { ok: true, ids: [] };
  const held = await db
    .select({
      id: projectWorkflows.id,
      flow: projectWorkflows.flow,
      designStatus: projectWorkflows.designStatus,
    })
    .from(projectWorkflows)
    .where(eq(projectWorkflows.projectId, projectId));
  const ids: string[] = [];
  const missing: string[] = [];
  const withdrawn: { at: number; flow: string }[] = [];
  names.forEach((name, at) => {
    const hit = held.find((w) => w.id === name || w.flow === name);
    if (!hit) missing.push(name);
    else if (hit.designStatus === 'withdrawn') withdrawn.push({ at, flow: hit.flow });
    else ids.push(hit.id);
  });
  return missing.length > 0 || withdrawn.length > 0
    ? { ok: false, missing, withdrawn }
    : { ok: true, ids: [...new Set(ids)] };
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
  await db.transaction(async (tx) => {
    await lockRequirements(tx, projectId);
    const removed = await tx
      .delete(requirementWorkflows)
      .where(
        and(
          eq(requirementWorkflows.requirementId, row.id),
          eq(requirementWorkflows.workflowId, input.workflowId),
        ),
      )
      .returning({ workflowId: requirementWorkflows.workflowId });
    if (removed.length === 0) throw notFound(`${input.ref} links no workflow ${input.workflowId}`);
    await tx
      .delete(requirementCriterionSteps)
      .where(
        and(
          eq(requirementCriterionSteps.requirementId, row.id),
          eq(requirementCriterionSteps.workflowId, input.workflowId),
        ),
      );
  });
  return answer(projectId, row.id, actor, null);
}

/** The requirement an issue delivers, naming its project where it is a sibling project's. */
export async function requirementOfIssue(issueId: string) {
  const [r] = await db
    .select({
      id: requirements.id,
      issueProjectId: issues.projectId,
      projectId: requirements.projectId,
      projectSlug: projects.slug,
      projectName: projects.name,
      reqSeq: requirements.reqSeq,
      title: requirements.title,
      status: requirements.status,
      currentRevision: requirements.currentRevision,
      plannedRevision: issues.plannedRevision,
    })
    .from(issues)
    .innerJoin(requirements, eq(requirements.id, issues.requirementId))
    .innerJoin(projects, eq(projects.id, requirements.projectId))
    .where(eq(issues.id, issueId));
  if (!r) return null;
  const drift = await planDriftOf(db, issueId);
  return {
    requirementId: r.id,
    key: requirementKey(r.reqSeq),
    project:
      r.projectId === r.issueProjectId
        ? null
        : { id: r.projectId, slug: r.projectSlug, name: r.projectName },
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
): Promise<{ plannedRevision: number | null } | null> {
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
  if (!plan?.trim()) return { plannedRevision: null };
  if (r.currentRevision === null) {
    throw refuseRequirement(
      'REQUIREMENT_REVISION_NOT_CURRENT',
      `${requirementKey(r.reqSeq ?? 0)} has no current revision, so there is nothing for this plan to be written against; a person accepts a revision first.`,
      '/plan',
    );
  }
  return { plannedRevision: r.currentRevision };
}

/**
 * Whether an issue may link to a requirement at `status` on `projectId`: an agreed one always, a
 * draft where the project's gate `link_requirement_agreed` is not enforced (REQ-76 BC-4).
 */
export async function linkRefusalOn(
  projectId: string,
  status: Parameters<typeof linkIssueRefusal>[0],
): Promise<ReturnType<typeof linkIssueRefusal>> {
  return linkIssueRefusal(status, await gateOf(projectId, 'link_requirement_agreed'));
}
