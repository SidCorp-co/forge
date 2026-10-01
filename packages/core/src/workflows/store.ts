import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import type { WorkflowWrite } from './schema.js';

export interface StoredWorkflow {
  id: string;
  projectId: string;
  flow: string;
  kind: string;
  status: string;
  revision: number;
  document: unknown;
  writtenByUser: string;
  createdAt: Date;
  updatedAt: Date;
}

const columns = {
  id: projectWorkflows.id,
  projectId: projectWorkflows.projectId,
  flow: projectWorkflows.flow,
  kind: projectWorkflows.kind,
  status: projectWorkflows.status,
  revision: projectWorkflows.revision,
  document: projectWorkflows.document,
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
): Promise<StoredWorkflow> {
  const [row] = await tx
    .insert(projectWorkflows)
    .values({ ...values(doc), revision: 1, writtenByUser: userId })
    .returning(columns);
  if (!row) throw new Error('workflows: the insert returned no row');
  return row;
}

export async function replaceWorkflow(
  tx: Tx,
  input: { id: string; revision: number; doc: WorkflowWrite; userId: string },
): Promise<StoredWorkflow> {
  const [row] = await tx
    .update(projectWorkflows)
    .set({
      ...values(input.doc),
      revision: input.revision + 1,
      writtenByUser: input.userId,
      updatedAt: sql`now()`,
    })
    .where(and(eq(projectWorkflows.id, input.id), eq(projectWorkflows.revision, input.revision)))
    .returning(columns);
  if (!row) throw new Error(`workflows: workflow ${input.id} moved under its own lock`);
  return row;
}
