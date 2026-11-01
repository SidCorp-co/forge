// An organisation's own knowledge (ISS-861): a ruling written once reaches every project of the org.
// The org's always-on entries are carried into each project's prompt ahead of the project's own, and
// a project entry under the same slug takes the org's place (`service.ts:selectAlwaysInjectFromKnowledge`).
// Read and written at `/api/orgs/:orgId/knowledge/:slug` by an org admin.

import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orgKnowledgeEntries, projects } from '../db/schema.js';

/** The always-on entries of the org `projectId` belongs to, in their order; none where it has no org. */
export async function orgAlwaysInjectOf(
  projectId: string,
): Promise<{ slug: string; body: string }[]> {
  return db
    .select({ slug: orgKnowledgeEntries.slug, body: orgKnowledgeEntries.body })
    .from(orgKnowledgeEntries)
    .innerJoin(projects, eq(projects.orgId, orgKnowledgeEntries.orgId))
    .where(and(eq(projects.id, projectId), eq(orgKnowledgeEntries.injection, 'always')))
    .orderBy(asc(orgKnowledgeEntries.orderIndex), asc(orgKnowledgeEntries.slug));
}
