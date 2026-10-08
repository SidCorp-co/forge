import { type DesignStatus, WORKFLOW_DESIGN_MACHINE } from '@forge/contracts/design-status';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import type { Said } from '@forge/contracts/said';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
  projectWorkflowDesigns,
  projectWorkflows,
  workflowBuilds,
} from '../db/schema-workflows.js';
import { lockXact } from '../lib/advisory-lock.js';
import { movedRow, transition } from '../lifecycle/index.js';
import type { DesignDecision } from './design.js';
import type { WorkflowWrite } from './schema.js';
import type { WorkflowWriter } from './service.js';

export interface StoredWorkflow {
  id: string;
  projectId: string;
  flow: string;
  kind: string;
  revision: number;
  document: unknown;
  designStatus: DesignStatus | null;
  designFingerprint: string | null;
  approvedRevision: number | null;
  writtenByUser: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DesignState {
  designStatus: DesignStatus | null;
  designFingerprint: string;
  approvedRevision: number | null;
}

const columns = {
  id: projectWorkflows.id,
  projectId: projectWorkflows.projectId,
  flow: projectWorkflows.flow,
  kind: projectWorkflows.kind,
  revision: projectWorkflows.revision,
  document: projectWorkflows.document,
  designStatus: sql<DesignStatus | null>`${projectWorkflows.designStatus}`,
  designFingerprint: projectWorkflows.designFingerprint,
  approvedRevision: projectWorkflows.approvedRevision,
  writtenByUser: projectWorkflows.writtenByUser,
  createdAt: projectWorkflows.createdAt,
  updatedAt: projectWorkflows.updatedAt,
};

const values = (doc: WorkflowWrite) => ({
  projectId: doc.project,
  flow: doc.flow,
  kind: doc.kind,
  document: doc,
});

export async function lockWorkflows(tx: Tx, projectId: string): Promise<void> {
  await lockXact(tx, 'workflows', projectId);
}

export async function readWorkflow(tx: Tx, id: string): Promise<StoredWorkflow | null> {
  const [row] = await tx.select(columns).from(projectWorkflows).where(eq(projectWorkflows.id, id));
  return row ?? null;
}

export async function workflowHolding(
  tx: Tx,
  projectId: string,
  flow: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: projectWorkflows.id })
    .from(projectWorkflows)
    .where(and(eq(projectWorkflows.projectId, projectId), eq(projectWorkflows.flow, flow)))
    .limit(1);
  return row?.id ?? null;
}

export async function workflowsOf(tx: Tx, projectId: string): Promise<StoredWorkflow[]> {
  return tx
    .select(columns)
    .from(projectWorkflows)
    .where(eq(projectWorkflows.projectId, projectId))
    .orderBy(asc(projectWorkflows.kind), asc(projectWorkflows.flow));
}

export async function insertWorkflow(
  tx: Tx,
  doc: WorkflowWrite,
  userId: string,
  design: DesignState,
): Promise<StoredWorkflow> {
  const [row] = await tx
    .insert(projectWorkflows)
    .values({ ...values(doc), ...design, revision: 1, writtenByUser: userId })
    .returning(columns);
  if (!row) throw new Error('workflows: the insert returned no row');
  return row;
}

export async function replaceWorkflow(
  tx: Tx,
  input: {
    id: string;
    revision: number;
    doc: WorkflowWrite;
    userId: string;
    design: Omit<DesignState, 'designStatus'>;
  },
): Promise<StoredWorkflow> {
  const [row] = await tx
    .update(projectWorkflows)
    .set({
      ...values(input.doc),
      ...input.design,
      revision: input.revision + 1,
      writtenByUser: input.userId,
      updatedAt: sql`now()`,
    })
    .where(and(eq(projectWorkflows.id, input.id), eq(projectWorkflows.revision, input.revision)))
    .returning(columns);
  if (!row) throw new Error(`workflows: workflow ${input.id} moved under its own lock`);
  return row;
}

/** A design's approval state moves only through the kernel, recorded in kernel_transitions. */
export async function moveDesign(
  tx: Tx,
  id: string,
  from: DesignStatus | null,
  to: DesignStatus,
  how: { writer: WorkflowWriter; reason?: string | null; approvedRevision?: number },
): Promise<void> {
  const moved = await transition(tx, WORKFLOW_DESIGN_MACHINE, {
    to,
    ...(from === null ? {} : { expect: from }),
    set: { approvedRevision: how.approvedRevision, updatedAt: sql`now()` },
    where: eq(projectWorkflows.id, id),
    reason: how.reason ?? null,
    actor: { type: 'user', id: how.writer.userId, agency: how.writer.agency },
    source: 'workflows',
    returning: ['id'],
  });
  movedRow(moved);
}

export interface StoredDesign {
  workflowId: string;
  revision: number;
  document: unknown;
  proposedByUser: string;
  proposedAt: Date;
  decision: DesignDecision | null;
  decidedByUser: string | null;
  decidedAt: Date | null;
  reason: string | null;
  /** `reason` as said where Forge composed it; null where the decider wrote it. */
  reasonSays: Said | null;
  designIssueId: string | null;
}

const designColumns = {
  workflowId: projectWorkflowDesigns.workflowId,
  revision: projectWorkflowDesigns.revision,
  document: projectWorkflowDesigns.document,
  proposedByUser: projectWorkflowDesigns.proposedByUser,
  proposedAt: projectWorkflowDesigns.proposedAt,
  decision: sql<DesignDecision | null>`${projectWorkflowDesigns.decision}`,
  decidedByUser: projectWorkflowDesigns.decidedByUser,
  decidedAt: projectWorkflowDesigns.decidedAt,
  reason: projectWorkflowDesigns.reason,
  reasonSays: projectWorkflowDesigns.reasonSays,
  designIssueId: projectWorkflowDesigns.designIssueId,
};

/**
 * The issue a new revision inherits, or, where it is no longer work, that issue with the revision
 * that named it (`revision`) and the newest revision, the one the write supersedes (`superseded`).
 */
export type InheritedDesignIssue =
  | { issueId: string | null }
  | {
      lapsed: {
        issueId: string;
        issSeq: number;
        status: string;
        revision: number;
        superseded: number;
        supersededRepin: boolean;
      };
    };

// A revision a write proposes again is drawn under the issue the latest revision to name one named,
// while that issue is still work: inheriting a closed one linked hop-access-decision r6 to ISS-38
// though it was drawn under ISS-64 (FB-54). The walk goes past revisions that name none, because
// those were stored with null after their issue closed (patient-data-flow r8, FB-54) or are re-pins,
// approved in the act that wrote them with no issue (`design-repin-service.ts`), and reading only the
// newest would let the next write through with none as well. Where that issue is closed or
// dropped the writer names the drawing issue, and the write is refused until it does
// (`design.ts:designIssueLapsedRefusal`); where no revision ever named one there is nothing to lose
// and none is inherited.
export async function designIssueToInherit(
  tx: Tx,
  workflowId: string,
): Promise<InheritedDesignIssue> {
  const designs = await designsOf(tx, workflowId);
  const named = designs.find((d) => d.designIssueId !== null);
  const prior = named?.designIssueId ?? null;
  if (!named || !prior) return { issueId: null };
  const [issue] = await tx
    .select({ status: issues.status, issSeq: issues.issSeq })
    .from(issues)
    .where(eq(issues.id, prior))
    .limit(1);
  if (!issue) return { issueId: null };
  if (!ISSUE_TERMINAL_STATUSES.includes(issue.status)) return { issueId: prior };
  const newest = designs[0] ?? named;
  return {
    lapsed: {
      issueId: prior,
      issSeq: issue.issSeq,
      status: issue.status,
      revision: named.revision,
      superseded: newest.revision,
      supersededRepin:
        newest.designIssueId === null && newest.reasonSays?.key === 'designs.reason.repinOnly',
    },
  };
}

/**
 * Re-names the issue a revision still waiting on its approver is drawn under (`propose { issue }` on a
 * proposed design): the revision's document and status stay as they are. Answers the issue it was
 * drawn under before, or null where it named none.
 */
export async function redrawDesign(
  tx: Tx,
  input: { workflowId: string; revision: number; designIssueId: string },
): Promise<{ before: string | null }> {
  const [row] = await tx
    .select({ designIssueId: projectWorkflowDesigns.designIssueId })
    .from(projectWorkflowDesigns)
    .where(
      and(
        eq(projectWorkflowDesigns.workflowId, input.workflowId),
        eq(projectWorkflowDesigns.revision, input.revision),
        sql`${projectWorkflowDesigns.decision} IS NULL`,
      ),
    )
    .for('update');
  if (!row) {
    throw new Error(
      `workflows: revision ${input.revision} of ${input.workflowId} is not waiting on its approver`,
    );
  }
  await tx
    .update(projectWorkflowDesigns)
    .set({ designIssueId: input.designIssueId })
    .where(
      and(
        eq(projectWorkflowDesigns.workflowId, input.workflowId),
        eq(projectWorkflowDesigns.revision, input.revision),
      ),
    );
  return { before: row.designIssueId };
}

export async function insertDesign(
  tx: Tx,
  input: {
    workflowId: string;
    revision: number;
    document: WorkflowWrite;
    userId: string;
    /** The issue the design is drawn under, named or inherited by the caller (`designIssueToInherit`). */
    designIssueId: string | null;
  },
): Promise<void> {
  await tx.insert(projectWorkflowDesigns).values({
    workflowId: input.workflowId,
    revision: input.revision,
    document: input.document,
    proposedByUser: input.userId,
    designIssueId: input.designIssueId,
  });
}

/** Every revision put in front of the approver, newest first. */
export async function designsOf(tx: Tx, workflowId: string): Promise<StoredDesign[]> {
  return tx
    .select(designColumns)
    .from(projectWorkflowDesigns)
    .where(eq(projectWorkflowDesigns.workflowId, workflowId))
    .orderBy(desc(projectWorkflowDesigns.revision));
}

/**
 * Each design of the project's approved revision and newest revision, the two a pin-only reading
 * compares; one statement for the project, never one per design.
 */
export async function headDesignsOf(tx: Tx, projectId: string): Promise<StoredDesign[]> {
  const newest = sql`(SELECT max(d2.revision) FROM project_workflow_designs d2 WHERE d2.workflow_id = ${projectWorkflowDesigns.workflowId})`;
  return tx
    .select(designColumns)
    .from(projectWorkflowDesigns)
    .innerJoin(projectWorkflows, eq(projectWorkflows.id, projectWorkflowDesigns.workflowId))
    .where(
      and(
        eq(projectWorkflows.projectId, projectId),
        or(
          eq(projectWorkflowDesigns.revision, projectWorkflows.approvedRevision),
          eq(projectWorkflowDesigns.revision, newest),
        ),
      ),
    )
    .orderBy(asc(projectWorkflowDesigns.workflowId), desc(projectWorkflowDesigns.revision));
}

/** The reason on each workflow's latest decided revision, for those whose latest decision is a return. */
export async function returnReasonsOf(
  tx: Tx,
  workflowIds: readonly string[],
): Promise<Map<string, string>> {
  if (workflowIds.length === 0) return new Map();
  const rows = await tx
    .selectDistinctOn([projectWorkflowDesigns.workflowId], {
      workflowId: projectWorkflowDesigns.workflowId,
      decision: projectWorkflowDesigns.decision,
      reason: projectWorkflowDesigns.reason,
    })
    .from(projectWorkflowDesigns)
    .where(
      and(
        inArray(projectWorkflowDesigns.workflowId, [...workflowIds]),
        sql`${projectWorkflowDesigns.decision} IS NOT NULL`,
      ),
    )
    .orderBy(projectWorkflowDesigns.workflowId, desc(projectWorkflowDesigns.revision));
  return new Map(
    rows
      .filter((r) => r.decision === 'return' && r.reason)
      .map((r) => [r.workflowId, r.reason as string]),
  );
}

export async function decideDesign(
  tx: Tx,
  input: {
    workflowId: string;
    revision: number;
    decision: DesignDecision;
    userId: string;
    reason: string | null;
    /** `reason` as said where Forge composed it; null where the decider wrote it. */
    reasonSays?: Said | null;
  },
): Promise<void> {
  await tx
    .update(projectWorkflowDesigns)
    .set({
      decision: input.decision,
      decidedByUser: input.userId,
      decidedAt: sql`now()`,
      reason: input.reason,
      reasonSays: input.reasonSays ?? null,
    })
    .where(
      and(
        eq(projectWorkflowDesigns.workflowId, input.workflowId),
        eq(projectWorkflowDesigns.revision, input.revision),
      ),
    );
}

interface StoredBuild {
  issueId: string;
  workflowId: string;
  issSeq: number;
  title: string;
  status: string;
  linkedAt: Date;
}

export async function buildsOf(tx: Tx, workflowIds: readonly string[]): Promise<StoredBuild[]> {
  if (workflowIds.length === 0) return [];
  return tx
    .select({
      issueId: workflowBuilds.issueId,
      workflowId: workflowBuilds.workflowId,
      issSeq: issues.issSeq,
      title: issues.title,
      status: issues.status,
      linkedAt: workflowBuilds.linkedAt,
    })
    .from(workflowBuilds)
    .innerJoin(issues, eq(issues.id, workflowBuilds.issueId))
    .where(inArray(workflowBuilds.workflowId, [...workflowIds]))
    .orderBy(asc(issues.issSeq));
}

export async function buildOfIssue(
  tx: Tx,
  issueId: string,
): Promise<{ workflowId: string } | null> {
  const [row] = await tx
    .select({ workflowId: workflowBuilds.workflowId })
    .from(workflowBuilds)
    .where(eq(workflowBuilds.issueId, issueId))
    .limit(1);
  return row ?? null;
}

export async function linkBuild(
  tx: Tx,
  input: {
    issueId: string;
    workflowId: string;
    projectId: string;
    userId: string;
    stepIds?: string[] | null;
    observedStepIds?: string[] | null;
  },
): Promise<void> {
  await tx.insert(workflowBuilds).values({
    issueId: input.issueId,
    workflowId: input.workflowId,
    projectId: input.projectId,
    linkedByUser: input.userId,
    stepIds: input.stepIds ?? null,
    observedStepIds: input.observedStepIds ?? null,
  });
}

export async function setBuildSteps(
  tx: Tx,
  issueId: string,
  set: { stepIds?: string[] | null; observedStepIds?: string[] | null },
) {
  await tx.update(workflowBuilds).set(set).where(eq(workflowBuilds.issueId, issueId));
}
