import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { resolveIssueRouteRef } from '../issues/issue-route-ref.js';
import { assertProjectAccess, effectiveProjectRole } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { isOnboardingDesign } from '../onboarding/read.js';
import type { DesignApprover } from '../project-config/schema.js';
import { readProjectDocument } from '../project-config/service.js';
import {
  type DesignDecision,
  type DesignRefusal,
  decisionRefusals,
  designApproverRefusal,
  proposeRefusal,
} from './design.js';
import { type DesignIssueOutcome, settleDesignIssue } from './design-issue.js';
import { designRequirementsOf } from './design-requirements.js';
import { buildGateOf, designWaitingOn, revisionStateOf } from './design-standing.js';
import { assertWriter, storedWorkflow, userNames, type WorkflowWriter } from './service.js';
import {
  buildOfIssue,
  buildsOf,
  decideDesign,
  designsOf,
  insertDesign,
  linkBuild,
  lockWorkflows,
  readWorkflow,
  type StoredWorkflow,
  setDesignState,
  unlinkBuild,
} from './store.js';

export type DesignView = Awaited<ReturnType<typeof designView>> & {
  designIssue?: DesignIssueOutcome;
};

export type DesignOutcome =
  | { ok: true; design: DesignView }
  | { ok: false; refusals: DesignRefusal[] };

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

// cm:guard a design onboarding drafted takes only a person's approval (approve-guard): it ignores
// `workflows.designApprover: master`, so the master never approves the picture it drew of the code
export async function designApproverOf(
  projectId: string,
  workflowId?: string,
): Promise<DesignApprover> {
  if (workflowId && (await isOnboardingDesign(projectId, workflowId))) return 'owner';
  return (await readProjectDocument(projectId))?.document.workflows?.designApprover ?? 'owner';
}

/** The approver refusal, worded for an onboarding design where the project's policy is not why. */
async function decideRefusalFor(actor: WorkflowWriter, projectId: string, workflowId: string) {
  const refusal = await approverRefusalFor(
    actor,
    projectId,
    await designApproverOf(projectId, workflowId),
  );
  if (
    refusal?.code === 'WORKFLOW_DESIGN_APPROVER_NOT_PERSON' &&
    (await isOnboardingDesign(projectId, workflowId))
  ) {
    return {
      ...refusal,
      detail: `agent ${actor.userId} acts as an agent; workflow ${workflowId} was drafted by onboarding, and an onboarding design is approved only by a person (an org owner or admin), whatever workflows.designApprover says.`,
    };
  }
  return refusal;
}

async function approverRefusalFor(
  actor: WorkflowWriter,
  projectId: string,
  approver: DesignApprover,
): Promise<DesignRefusal | null> {
  const access = await effectiveProjectRole(actor.userId, projectId);
  return designApproverRefusal(
    {
      userId: actor.userId,
      agency: actor.agency,
      role: access?.role ?? null,
      orgRole: access?.orgRole ?? null,
    },
    projectId,
    approver,
  );
}

async function rowIn(projectId: string, id: string): Promise<StoredWorkflow> {
  const row = await readWorkflow(db, id);
  if (!row || row.projectId !== projectId) {
    throw notFound(`project ${projectId} holds no workflow ${id}`);
  }
  return row;
}

async function designView(row: StoredWorkflow, viewer: WorkflowWriter | null) {
  const [designs, builds, approver, prefix, requirements] = await Promise.all([
    designsOf(db, row.id),
    buildsOf(db, [row.id]),
    designApproverOf(row.projectId, row.id),
    activeIssuePrefix(row.projectId),
    designRequirementsOf(row.id),
  ]);
  const names = await userNames([
    ...designs.map((d) => d.proposedByUser),
    ...designs.map((d) => d.decidedByUser),
  ]);
  const name = (id: string | null) => (id === null ? null : (names.get(id) ?? id));
  const awaiting = row.designStatus === 'proposed' ? (designs[0]?.revision ?? null) : null;
  const head = {
    status: row.designStatus,
    proposedRevision: awaiting,
    approvedRevision: row.approvedRevision,
  };
  const canDecide = viewer
    ? (await approverRefusalFor(viewer, row.projectId, approver)) === null
    : false;
  const latest = designs[0]
    ? { revision: designs[0].revision, author: name(designs[0].proposedByUser) }
    : null;
  return {
    workflowId: row.id,
    flow: row.flow,
    status: row.designStatus,
    revision: row.revision,
    proposedRevision: awaiting,
    approvedRevision: row.approvedRevision,
    approver,
    canDecide,
    waitingOn: designWaitingOn({ ...head, latest, approver, canDecide }),
    revisions: designs.map((d) => ({
      revision: d.revision,
      designIssueId: d.designIssueId,
      document: d.document,
      proposedBy: d.proposedByUser,
      proposedByName: name(d.proposedByUser),
      proposedAt: d.proposedAt.toISOString(),
      decision: d.decision,
      decidedBy: d.decidedByUser,
      decidedByName: name(d.decidedByUser),
      decidedAt: d.decidedAt?.toISOString() ?? null,
      reason: d.reason,
      state: revisionStateOf(d, head),
    })),
    builds: builds.map((b) => ({
      issueId: b.issueId,
      displayId: formatIssueRef(prefix, b.issSeq),
      title: b.title,
      status: b.status,
    })),
    gate: buildGateOf(head),
    requirements,
  };
}

export async function readDesignAs(viewer: WorkflowWriter, projectId: string, id: string) {
  await assertProjectAccess(projectId, viewer.userId, 'viewer');
  return designView(await rowIn(projectId, id), viewer);
}

export async function proposeDesign(input: {
  projectId: string;
  id: string;
  writer: WorkflowWriter;
  revision: number;
  /** The issue the design is drawn under, by key or uuid; absent, the revision before names it. */
  issue?: string | undefined;
}): Promise<DesignOutcome> {
  const { projectId, id, writer, revision } = input;
  await assertWriter(writer, projectId);
  const designIssueId = input.issue
    ? await designIssueIn(projectId, input.issue, writer.userId)
    : undefined;
  const outcome = await db.transaction(async (tx): Promise<DesignRefusal[] | null> => {
    await lockWorkflows(tx, projectId);
    const row = await readWorkflow(tx, id);
    if (!row || row.projectId !== projectId) {
      throw notFound(`project ${projectId} holds no workflow ${id}`);
    }
    if (row.revision !== revision) {
      return [
        {
          code: 'WORKFLOW_DESIGN_REVISION_STALE',
          path: '/revision',
          detail: `revision ${revision} is not this workflow's; it stands at revision ${row.revision}. Propose the revision you read.`,
        },
      ];
    }
    const refusal = proposeRefusal(row.designStatus, id);
    if (refusal) return [refusal];
    if (designIssueId && (await buildOfIssue(tx, designIssueId))?.workflowId === id) {
      return [
        {
          code: 'WORKFLOW_DESIGN_ISSUE_IS_BUILD',
          path: '/issue',
          detail: `${input.issue} builds workflow ${id}, so it waits on this approval and cannot be the issue the design is drawn under; name the issue that draws it.`,
        },
      ];
    }
    await insertDesign(tx, {
      workflowId: id,
      revision: row.revision,
      document: storedWorkflow(row),
      userId: writer.userId,
      designIssueId,
    });
    await setDesignState(tx, id, { designStatus: 'proposed' });
    return null;
  });
  if (outcome) return { ok: false, refusals: outcome };
  return { ok: true, design: await designView(await rowIn(projectId, id), writer) };
}

export async function decideDesignAs(input: {
  projectId: string;
  id: string;
  decider: WorkflowWriter;
  revision: number;
  decision: DesignDecision;
  reason: string | null;
}): Promise<DesignOutcome> {
  const { projectId, id, decider, revision, decision } = input;
  const reason = input.reason?.trim() || null;
  await rowIn(projectId, id);
  const refusal = await decideRefusalFor(decider, projectId, id);
  if (refusal) return { ok: false, refusals: [refusal] };
  type Decided = { refusals: DesignRefusal[] } | { flow: string; designIssueId: string | null };
  const outcome = await db.transaction(async (tx): Promise<Decided> => {
    await lockWorkflows(tx, projectId);
    const row = await readWorkflow(tx, id);
    if (!row) throw notFound(`project ${projectId} holds no workflow ${id}`);
    const [latest] = await designsOf(tx, id);
    const refusals = decisionRefusals({
      status: row.designStatus,
      proposedRevision: latest?.revision ?? null,
      revision,
      decision,
      reason,
    });
    if (refusals.length > 0) return { refusals };
    await decideDesign(tx, { workflowId: id, revision, decision, userId: decider.userId, reason });
    await setDesignState(
      tx,
      id,
      decision === 'approve'
        ? { designStatus: 'approved', approvedRevision: revision }
        : { designStatus: 'returned' },
    );
    return { flow: row.flow, designIssueId: latest?.designIssueId ?? null };
  });
  if ('refusals' in outcome) return { ok: false, refusals: outcome.refusals };
  const designIssue = await settleDesignIssue({
    projectId,
    workflowId: id,
    flow: outcome.flow,
    revision,
    decision,
    reason,
    designIssueId: outcome.designIssueId,
    decider,
  });
  return {
    ok: true,
    design: { ...(await designView(await rowIn(projectId, id), decider)), designIssue },
  };
}

async function designIssueIn(projectId: string, ref: string, userId: string): Promise<string> {
  const issue = await resolveIssueRouteRef(ref, projectId, userId);
  if (issue.projectId !== projectId) {
    throw notFound(`issue ${ref} is not an issue of project ${projectId}`);
  }
  return issue.id;
}

/** An issue names the workflow it builds; any project member may say so, the gate is what it buys. */
export async function linkBuildAs(input: {
  projectId: string;
  id: string;
  actor: WorkflowWriter;
  issue: string;
}): Promise<DesignOutcome> {
  const { projectId, id, actor } = input;
  await assertProjectAccess(projectId, actor.userId, 'member');
  const issue = await resolveIssueRouteRef(input.issue, projectId, actor.userId);
  if (issue.projectId !== projectId) {
    throw notFound(`issue ${input.issue} is not an issue of project ${projectId}`);
  }
  const refusal = await db.transaction(async (tx): Promise<DesignRefusal | null> => {
    await lockWorkflows(tx, projectId);
    const row = await readWorkflow(tx, id);
    if (!row || row.projectId !== projectId) {
      throw notFound(`project ${projectId} holds no workflow ${id}`);
    }
    const held = await buildOfIssue(tx, issue.id);
    if (held?.workflowId === id) return null;
    if ((await designsOf(tx, id))[0]?.designIssueId === issue.id) {
      return {
        code: 'WORKFLOW_DESIGN_ISSUE_IS_BUILD',
        path: '/issue',
        detail: `${input.issue} is the issue workflow ${id}'s design is drawn under; linking it as a build would make it wait on its own approval.`,
      };
    }
    if (held) {
      return {
        code: 'WORKFLOW_BUILD_ALREADY_LINKED',
        path: '/issue',
        detail: `${input.issue} already builds workflow ${held.workflowId}; an issue builds one workflow, so its approver unlinks that one first.`,
      };
    }
    await linkBuild(tx, { issueId: issue.id, workflowId: id, projectId, userId: actor.userId });
    return null;
  });
  if (refusal) return { ok: false, refusals: [refusal] };
  return { ok: true, design: await designView(await rowIn(projectId, id), actor) };
}

// cm:why lifting the link lifts the gate, so it is the approver's act and never the master's escape from a design nobody approved
export async function unlinkBuildAs(input: {
  projectId: string;
  id: string;
  actor: WorkflowWriter;
  issue: string;
}): Promise<DesignOutcome> {
  const { projectId, id, actor } = input;
  await rowIn(projectId, id);
  const refusal = await approverRefusalFor(actor, projectId, await designApproverOf(projectId));
  if (refusal) return { ok: false, refusals: [refusal] };
  const issue = await resolveIssueRouteRef(input.issue, projectId, actor.userId);
  const missing = await db.transaction(async (tx): Promise<DesignRefusal | null> => {
    await lockWorkflows(tx, projectId);
    const held = await buildOfIssue(tx, issue.id);
    if (held?.workflowId !== id) {
      return {
        code: 'WORKFLOW_BUILD_NOT_LINKED',
        path: '/issue',
        detail: `${input.issue} does not build workflow ${id}${held ? `; it builds ${held.workflowId}` : ''}.`,
      };
    }
    await unlinkBuild(tx, issue.id);
    return null;
  });
  if (missing) return { ok: false, refusals: [missing] };
  return { ok: true, design: await designView(await rowIn(projectId, id), actor) };
}
