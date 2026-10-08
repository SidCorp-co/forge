import { approvalPermission } from '@forge/contracts/permissions';
import { type Said, verbatim } from '@forge/contracts/said';
import { findTemplate, type WorkflowTemplate } from '@forge/contracts/workflow-templates';
import type { PinOnlyChange } from '@forge/contracts/workflows';
import { db, type Tx } from '../db/client.js';
import { activeIssuePrefix, resolveIssueRouteRef } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { userNames } from '../lib/people.js';
import { notFound } from '../middleware/route-errors.js';
import { emitEvent } from '../outbox/index.js';
import { actorFor, permissionFactsOf, projectResource, requireCan } from '../permissions/index.js';
import {
  type DesignDecision,
  type DesignRefusal,
  decisionRefusals,
  designApproverRefusal,
  proposeRefusal,
} from './design.js';
import {
  baseApprovalRefusal,
  basesOfStored,
  designsLeftStale,
  readBases,
  standingBaseRefusal,
} from './design-bases.js';
import { revisionChangesOf } from './design-changes.js';
import {
  type DesignIssueOutcome,
  handBack,
  parkedAtDecision,
  recordApprovedDesign,
} from './design-issue.js';
import { pinOnlyChange } from './design-repin.js';
import { designRequirementsOf } from './design-requirements.js';
import {
  buildGateOf,
  builtAgainstOf,
  designWaitingOn,
  revisionStateOf,
} from './design-standing.js';
import { nodeSetRefusals, nodesOfDocument, observedNodesIn } from './node-refs.js';
import { answerDesignQuestions } from './ports.js';
import { readStoredWorkflow } from './schema.js';
import {
  assertWriter,
  drawingIssueOf,
  storedWorkflow,
  templatesOf,
  type WorkflowWriter,
} from './service.js';
import {
  buildOfIssue,
  buildsOf,
  decideDesign,
  designsOf,
  insertDesign,
  linkBuild,
  lockWorkflows,
  moveDesign,
  readWorkflow,
  type StoredDesign,
  type StoredWorkflow,
  setBuildSteps,
  workflowsOf,
} from './store.js';

export type DesignView = Awaited<ReturnType<typeof designView>> & {
  designIssue?: DesignIssueOutcome;
};

export type DesignOutcome =
  | { ok: true; design: DesignView }
  | { ok: false; refusals: DesignRefusal[] };

export async function approverRefusalFor(
  actor: WorkflowWriter,
  projectId: string,
): Promise<DesignRefusal | null> {
  return designApproverRefusal(await permissionFactsOf(actor.userId, projectId));
}

async function rowIn(projectId: string, id: string): Promise<StoredWorkflow> {
  const row = await readWorkflow(db, id);
  if (!row || row.projectId !== projectId) {
    throw notFound(`project ${projectId} holds no workflow ${id}`);
  }
  return row;
}

/** The newest revision against the approved one, where only the base revisions it pins differ. */
function pinOnlyOf(
  designs: readonly StoredDesign[],
  approvedRevision: number | null,
  templates: readonly WorkflowTemplate[] | undefined,
): PinOnlyChange | null {
  const approved = readStoredWorkflow(
    designs.find((d) => d.revision === approvedRevision)?.document,
  );
  const proposed = readStoredWorkflow(designs[0]?.document);
  if (!approved || !proposed || designs[0]?.revision === approvedRevision) return null;
  return pinOnlyChange(approved, proposed, findTemplate(templates ?? [], proposed.template));
}

async function designView(row: StoredWorkflow, viewer: WorkflowWriter | null) {
  const approver = approvalPermission('workflow-designs');
  const [designs, builds, prefix, requirements, held, templates] = await Promise.all([
    designsOf(db, row.id),
    buildsOf(db, [row.id]),
    activeIssuePrefix(row.projectId),
    designRequirementsOf(row.id),
    row.designStatus === 'proposed' ? workflowsOf(db, row.projectId) : [],
    row.designStatus === 'proposed' ? templatesOf(row.projectId) : null,
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
  const canDecide = viewer ? (await approverRefusalFor(viewer, row.projectId)) === null : false;
  const latest = designs[0]
    ? { revision: designs[0].revision, author: name(designs[0].proposedByUser) }
    : null;
  const blocked =
    awaiting !== null ? standingBaseRefusal(awaiting, designs[0]?.document, held) : null;
  return {
    workflowId: row.id,
    flow: row.flow,
    status: row.designStatus,
    revision: row.revision,
    proposedRevision: awaiting,
    approvedRevision: row.approvedRevision,
    approver,
    canDecide,
    waitingOn: designWaitingOn({
      ...head,
      latest,
      canDecide,
      baseUnapproved: blocked,
    }),
    // what the approver reads before Approve: a refusal core already knows, and the designs it strands
    approvalBlocked: blocked
      ? {
          code: blocked.code,
          revision: blocked.revision,
          bases: blocked.bases,
          detail: blocked.detail,
        }
      : null,
    approvalLeavesStale: awaiting !== null ? designsLeftStale(row.flow, awaiting, held) : [],
    // a proposal that only moves the revisions its bases are pinned at, with the proof nothing else moved
    pinOnly:
      awaiting !== null ? pinOnlyOf(designs, row.approvedRevision, templates?.templates) : null,
    revisions: designs.map((d, at) => ({
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
      // Forge's own sentence by key; a decider's words as they wrote them
      says: { reason: d.reasonSays ?? (d.reason ? verbatim(d.reason) : null) },
      state: revisionStateOf(d, head),
      changes: revisionChangesOf(designs[at + 1]?.document, d.document),
    })),
    builds: builds.map((b) => ({
      issueId: b.issueId,
      displayId: formatIssueRef(prefix, b.issSeq),
      title: b.title,
      status: b.status,
      builtAgainst: builtAgainstOf(b.linkedAt, designs),
    })),
    gate: buildGateOf(head),
    requirements,
  };
}

export async function readDesignAs(viewer: WorkflowWriter, projectId: string, id: string) {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  return designView(await rowIn(projectId, id), viewer);
}

export async function proposeDesign(input: {
  projectId: string;
  id: string;
  writer: WorkflowWriter;
  revision: number;
  /** The issue the design is drawn under, by key or uuid; absent, the revision before names it while
   *  that issue is still work (`service.ts:drawingIssueOf`). */
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
          detail: `${input.issue} builds workflow ${row.flow}, so it waits on this approval and cannot be the issue the design is drawn under; name the issue that draws it.`,
        },
      ];
    }
    const drawing = await drawingIssueOf(tx, {
      projectId,
      workflowId: id,
      flow: row.flow,
      named: designIssueId,
    });
    if ('refusal' in drawing) return [drawing.refusal];
    await insertDesign(tx, {
      workflowId: id,
      revision: row.revision,
      document: storedWorkflow(row),
      userId: writer.userId,
      designIssueId: drawing.issueId,
    });
    await moveDesign(tx, id, row.designStatus, 'proposed', { writer });
    return null;
  });
  if (outcome) return { ok: false, refusals: outcome };
  return { ok: true, design: await designView(await rowIn(projectId, id), writer) };
}

/**
 * Everything one decision records, inside a transaction holding the project's workflow lock and after
 * its refusals were read: the decided revision, the design's move, the design issue's mark, the
 * questions it answers and the event.
 */
export async function recordDecision(
  tx: Tx,
  input: {
    projectId: string;
    row: Pick<StoredWorkflow, 'id' | 'flow' | 'designStatus'>;
    designIssueId: string | null;
    revision: number;
    decision: DesignDecision;
    reason: string | null;
    /** `reason` as said, where Forge composed it; absent where the decider wrote it. */
    reasonSays?: Said | null;
    decider: WorkflowWriter;
  },
): Promise<{ parked: boolean; approved: DesignIssueOutcome | null }> {
  const { projectId, row, designIssueId, revision, decision, reason, decider } = input;
  const id = row.id;
  await decideDesign(tx, {
    workflowId: id,
    revision,
    decision,
    userId: decider.userId,
    reason,
    reasonSays: input.reasonSays ?? null,
  });
  await moveDesign(tx, id, row.designStatus, decision === 'approve' ? 'approved' : 'returned', {
    writer: decider,
    reason,
    ...(decision === 'approve' ? { approvedRevision: revision } : {}),
  });
  const parked = await parkedAtDecision(tx, designIssueId);
  // the approved revision is its design issue's deliverable: its mark records it (ISS-262)
  const approved =
    decision === 'approve'
      ? await recordApprovedDesign(tx, { designIssueId, flow: row.flow, revision, decider })
      : null;
  // the decision is the answer a question waiting on this revision asked for (ISS-254)
  await answerDesignQuestions(tx, {
    workflowId: id,
    revision,
    flow: row.flow,
    decision,
    reason,
    by: decider.userId,
    agency: decider.agency,
  });
  await emitEvent(tx, 'workflow.designDecided', {
    projectId,
    workflowId: id,
    decision,
    issueId: designIssueId,
  });
  return { parked, approved };
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
  const refusal = await approverRefusalFor(decider, projectId);
  if (refusal) return { ok: false, refusals: [refusal] };
  type Decided =
    | { refusals: DesignRefusal[] }
    | {
        flow: string;
        designIssueId: string | null;
        parked: boolean;
        approved: DesignIssueOutcome | null;
      };
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
    const bases = decision === 'approve' ? basesOfStored(latest?.document) : [];
    const unapproved =
      bases.length > 0
        ? baseApprovalRefusal(revision, readBases(bases, await workflowsOf(tx, projectId)))
        : null;
    if (unapproved) return { refusals: [unapproved] };
    const { parked, approved } = await recordDecision(tx, {
      projectId,
      row,
      designIssueId: latest?.designIssueId ?? null,
      revision,
      decision,
      reason,
      decider,
    });
    return { flow: row.flow, designIssueId: latest?.designIssueId ?? null, parked, approved };
  });
  if ('refusals' in outcome) return { ok: false, refusals: outcome.refusals };
  // a return hands the drawing back; an approval's mark was written inside the decision
  const designIssue =
    decision === 'return'
      ? await handBack({
          projectId,
          flow: outcome.flow,
          revision,
          reason,
          designIssueId: outcome.designIssueId,
          parked: outcome.parked,
          decider,
        })
      : (outcome.approved ?? { issueId: outcome.designIssueId, action: 'none', status: null });
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

/** A build may name only nodes of the latest observation as the observed steps it removes or rebuilds. */
async function observedStepsRefusal(
  tx: Tx,
  projectId: string,
  workflowId: string,
  flow: string,
  steps: string[],
): Promise<DesignRefusal | null> {
  const nodes = await observedNodesIn(tx, projectId, workflowId);
  if (!nodes) {
    return {
      code: 'WORKFLOW_NODE_UNKNOWN',
      path: '/observedSteps',
      detail: `workflow ${flow} has no observation yet, so a build can name no observed step; name planned steps under steps, or wait for the code to be observed.`,
    };
  }
  const [wrong] = nodeSetRefusals(nodes, { steps }, '/observedSteps');
  return (wrong as DesignRefusal | undefined) ?? null;
}

/** An issue names the workflow it builds; any project member may say so, the gate is what it buys. */
export async function linkBuildAs(input: {
  projectId: string;
  id: string;
  actor: WorkflowWriter;
  issue: string;
  steps?: string[] | undefined;
  observedSteps?: string[] | undefined;
}): Promise<DesignOutcome> {
  const { projectId, id, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
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
    const steps = input.steps ? [...new Set(input.steps)] : null;
    if (steps) {
      const nodes = nodesOfDocument(
        row.id,
        row.flow,
        row.revision,
        readStoredWorkflow(row.document),
      );
      const [wrong] = nodeSetRefusals(nodes, { steps }, '');
      if (wrong) return wrong as DesignRefusal;
    }
    const observedSteps = input.observedSteps ? [...new Set(input.observedSteps)] : null;
    if (observedSteps) {
      const wrong = await observedStepsRefusal(tx, projectId, row.id, row.flow, observedSteps);
      if (wrong) return wrong;
    }
    const held = await buildOfIssue(tx, issue.id);
    if (held?.workflowId === id) {
      if (steps || observedSteps) {
        await setBuildSteps(tx, issue.id, {
          ...(steps ? { stepIds: steps } : {}),
          ...(observedSteps ? { observedStepIds: observedSteps } : {}),
        });
      }
      return null;
    }
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
    await linkBuild(tx, {
      issueId: issue.id,
      workflowId: id,
      projectId,
      userId: actor.userId,
      stepIds: steps,
      observedStepIds: observedSteps,
    });
    return null;
  });
  if (refusal) return { ok: false, refusals: [refusal] };
  return { ok: true, design: await designView(await rowIn(projectId, id), actor) };
}
