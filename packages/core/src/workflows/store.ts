import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
  projectWorkflowDesigns,
  projectWorkflows,
  workflowBuilds,
} from '../db/schema-workflows.js';
import type { DesignDecision, DesignStatus } from './design.js';
import type { WorkflowWrite } from './schema.js';

export interface StoredWorkflow {
  id: string;
  projectId: string;
  flow: string;
  kind: string;
  status: string;
  revision: number;
  document: unknown;
  designStatus: DesignStatus | null;
  designFingerprint: string | null;
  approvedRevision: number | null;
  writtenByUser: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DesignState {
  designStatus: DesignStatus | null;
  designFingerprint: string;
  approvedRevision: number | null;
}

const columns = {
  id: projectWorkflows.id,
  projectId: projectWorkflows.projectId,
  flow: projectWorkflows.flow,
  kind: projectWorkflows.kind,
  status: projectWorkflows.status,
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
  status: doc.status,
  refreshedAtSha: doc.refreshedAtSha,
  document: doc,
});

export async function lockWorkflows(tx: Tx, projectId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workflows:${projectId}`}, 0))`,
  );
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
    design: DesignState;
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

export async function setDesignState(
  tx: Tx,
  id: string,
  state: { designStatus: DesignStatus; approvedRevision?: number | null },
): Promise<void> {
  await tx
    .update(projectWorkflows)
    .set({ ...state, updatedAt: sql`now()` })
    .where(eq(projectWorkflows.id, id));
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
  designIssueId: projectWorkflowDesigns.designIssueId,
};

export async function insertDesign(
  tx: Tx,
  input: {
    workflowId: string;
    revision: number;
    document: WorkflowWrite;
    userId: string;
    /** The issue the design is drawn under; absent, the revision it supersedes names it. */
    designIssueId?: string | null | undefined;
  },
): Promise<void> {
  const designIssueId =
    input.designIssueId !== undefined
      ? input.designIssueId
      : ((await designsOf(tx, input.workflowId))[0]?.designIssueId ?? null);
  await tx.insert(projectWorkflowDesigns).values({
    workflowId: input.workflowId,
    revision: input.revision,
    document: input.document,
    proposedByUser: input.userId,
    designIssueId,
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
  },
): Promise<void> {
  await tx
    .update(projectWorkflowDesigns)
    .set({
      decision: input.decision,
      decidedByUser: input.userId,
      decidedAt: sql`now()`,
      reason: input.reason,
    })
    .where(
      and(
        eq(projectWorkflowDesigns.workflowId, input.workflowId),
        eq(projectWorkflowDesigns.revision, input.revision),
      ),
    );
}

export interface StoredBuild {
  issueId: string;
  workflowId: string;
  issSeq: number;
  title: string;
  status: string;
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
  input: { issueId: string; workflowId: string; projectId: string; userId: string },
): Promise<void> {
  await tx.insert(workflowBuilds).values({
    issueId: input.issueId,
    workflowId: input.workflowId,
    projectId: input.projectId,
    linkedByUser: input.userId,
  });
}

export async function unlinkBuild(tx: Tx, issueId: string): Promise<void> {
  await tx.delete(workflowBuilds).where(eq(workflowBuilds.issueId, issueId));
}
