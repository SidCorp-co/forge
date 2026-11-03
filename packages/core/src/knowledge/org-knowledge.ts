// An organisation's own knowledge (ISS-861): a ruling written once reaches every project of the org.
// The org's always-on entries are carried into each project's prompt ahead of the project's own, and
// a project entry under the same slug takes the org's place (`service.ts:selectAlwaysInjectFromKnowledge`).
// Read and written at `/api/orgs/:orgId/knowledge/:slug` by an org admin.

import type { OrgKnowledgeEntry, OrgKnowledgeWrite } from '@forge/contracts/org-knowledge';
import { and, asc, eq, notInArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEntries, orgKnowledgeEntries, projects } from '../db/schema.js';

type Row = typeof orgKnowledgeEntries.$inferSelect;

const viewOf = (r: Row): OrgKnowledgeEntry => ({
  orgId: r.orgId,
  slug: r.slug,
  title: r.title,
  body: r.body,
  injection: r.injection,
  orderIndex: r.orderIndex,
  updatedBy: r.updatedBy,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** Every entry the org holds, in their order. */
export async function orgKnowledgeOf(orgId: string): Promise<OrgKnowledgeEntry[]> {
  const rows = await db
    .select()
    .from(orgKnowledgeEntries)
    .where(eq(orgKnowledgeEntries.orgId, orgId))
    .orderBy(asc(orgKnowledgeEntries.orderIndex), asc(orgKnowledgeEntries.slug));
  return rows.map(viewOf);
}

/** The org's entry under `slug`, or null where it holds none. */
export async function orgKnowledgeEntryOf(
  orgId: string,
  slug: string,
): Promise<OrgKnowledgeEntry | null> {
  const [row] = await db
    .select()
    .from(orgKnowledgeEntries)
    .where(and(eq(orgKnowledgeEntries.orgId, orgId), eq(orgKnowledgeEntries.slug, slug)))
    .limit(1);
  return row ? viewOf(row) : null;
}

/** Create or replace the org's entry under `slug`, written by `userId`. */
export async function writeOrgKnowledge(
  orgId: string,
  slug: string,
  write: OrgKnowledgeWrite,
  userId: string,
): Promise<OrgKnowledgeEntry> {
  const now = new Date();
  const [row] = await db
    .insert(orgKnowledgeEntries)
    .values({ orgId, slug, ...write, updatedBy: userId, updatedAt: now })
    .onConflictDoUpdate({
      target: [orgKnowledgeEntries.orgId, orgKnowledgeEntries.slug],
      set: { ...write, updatedBy: userId, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error('org knowledge: the upsert returned no row');
  return viewOf(row);
}

/** Remove the org's entry under `slug`; false where it held none. */
export async function deleteOrgKnowledge(orgId: string, slug: string): Promise<boolean> {
  const removed = await db
    .delete(orgKnowledgeEntries)
    .where(and(eq(orgKnowledgeEntries.orgId, orgId), eq(orgKnowledgeEntries.slug, slug)))
    .returning({ slug: orgKnowledgeEntries.slug });
  return removed.length > 0;
}

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

/**
 * The slugs of the on-demand entries of the org `projectId` belongs to, in their order, less any the
 * project holds under the same slug, which takes the org's place (ISS-867). A prompt's guide index
 * names them, and the project's own knowledge door reads one (`service.ts:getKnowledgeEntry`).
 */
export async function orgOnDemandSlugsOf(projectId: string): Promise<string[]> {
  const held = db
    .select({ slug: knowledgeEntries.slug })
    .from(knowledgeEntries)
    .where(eq(knowledgeEntries.projectId, projectId));
  const rows = await db
    .select({ slug: orgKnowledgeEntries.slug })
    .from(orgKnowledgeEntries)
    .innerJoin(projects, eq(projects.orgId, orgKnowledgeEntries.orgId))
    .where(
      and(
        eq(projects.id, projectId),
        eq(orgKnowledgeEntries.injection, 'on_demand'),
        notInArray(orgKnowledgeEntries.slug, held),
      ),
    )
    .orderBy(asc(orgKnowledgeEntries.orderIndex), asc(orgKnowledgeEntries.slug));
  return rows.map((r) => r.slug);
}

/** The entry under `slug` of the org `projectId` belongs to, or null where it holds none. */
export async function orgEntryForProject(projectId: string, slug: string): Promise<Row | null> {
  const [row] = await db
    .select({ entry: orgKnowledgeEntries })
    .from(orgKnowledgeEntries)
    .innerJoin(projects, eq(projects.orgId, orgKnowledgeEntries.orgId))
    .where(and(eq(projects.id, projectId), eq(orgKnowledgeEntries.slug, slug)))
    .limit(1);
  return row?.entry ?? null;
}

/** When the entry under `slug` of the org `projectId` belongs to was written first; null where none. */
export async function orgKnowledgeCreatedAt(projectId: string, slug: string): Promise<Date | null> {
  return (await orgEntryForProject(projectId, slug))?.createdAt ?? null;
}
