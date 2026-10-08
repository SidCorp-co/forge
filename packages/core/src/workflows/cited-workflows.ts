import { asc, eq } from 'drizzle-orm';
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
