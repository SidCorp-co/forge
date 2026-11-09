// The designs a re-pin reading compares, read for a person's read of many projects at once
// (ISS-1070 r20): a project whose designs declare a base read its own, and forge-dev's three such
// projects sent the statement three times a person's attention.

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsPerProject } from '../db/read-memo.js';
import { projectWorkflowDesigns, projectWorkflows } from '../db/schema-workflows.js';
import { designColumns, isHeadDesign, type StoredDesign } from './store.js';

/**
 * `store.ts:headDesignsOf` outside a transaction: every project asked before the request's quiet
 * point, and every project a read across declared, read in one statement, each project's rows in
 * the order its own read sends them.
 */
export function headDesignsRead(
  projectId: string,
): Promise<(StoredDesign & { projectId: string })[]> {
  return rowsPerProject(
    'headDesigns',
    projectId,
    (ids) =>
      db
        .select({ ...designColumns, projectId: projectWorkflows.projectId })
        .from(projectWorkflowDesigns)
        .innerJoin(projectWorkflows, eq(projectWorkflows.id, projectWorkflowDesigns.workflowId))
        .where(and(inArray(projectWorkflows.projectId, [...ids]), isHeadDesign))
        .orderBy(asc(projectWorkflowDesigns.workflowId), desc(projectWorkflowDesigns.revision)),
    (r) => r.projectId,
  );
}
