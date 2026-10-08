import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectWorkflows } from '../db/schema-workflows.js';

/** Every workflow the project draws, by its flow, with its last change: what a memory may name (REQ-33 BC-4). */
export async function workflowFlowsOf(
  projectId: string,
): Promise<{ flow: string; updatedAt: Date }[]> {
  return db
    .select({ flow: projectWorkflows.flow, updatedAt: projectWorkflows.updatedAt })
    .from(projectWorkflows)
    .where(eq(projectWorkflows.projectId, projectId))
    .orderBy(asc(projectWorkflows.flow));
}

/** The flow each of these workflow ids of the project draws, in one read: how a person is shown a design a uuid names. */
export async function workflowFlowsByIds(
  projectId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: projectWorkflows.id, flow: projectWorkflows.flow })
    .from(projectWorkflows)
    .where(and(eq(projectWorkflows.projectId, projectId), inArray(projectWorkflows.id, [...ids])));
  return new Map(rows.map((r) => [r.id, r.flow]));
}
