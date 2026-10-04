/**
 * ISS-950 (Tier 3c of ISS-587) — the reads behind the four generated diagrams, and only the reads.
 *
 * Every module attribute comes from `labels` and every fact about a module comes from the
 * knowledge node it is bound to through `labels.knowledge_entry_id` (ISS-947). `issue_labels` is
 * read here for exactly one thing, the context diagram's edge weights, which is the one use the
 * issue admits; a generated diagram that read tags for anything else would be the wrong shape.
 */

import { and, eq, gt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { issueLabels, knowledgeEntries, labels, projects } from '../db/schema.js';
import type { CoOccurrence, ModuleDiagramSnapshot, ModuleSnapshot } from './module-diagrams.js';

function readActor(metadata: unknown): string | null {
  const actor = (metadata as { actor?: unknown } | null)?.actor;
  return typeof actor === 'string' && actor.trim() !== '' ? actor.trim() : null;
}

async function loadModules(projectId: string): Promise<ModuleSnapshot[]> {
  const rows = await db
    .select({
      id: labels.id,
      name: labels.name,
      slug: labels.slug,
      parentId: labels.parentId,
      body: knowledgeEntries.body,
      metadata: knowledgeEntries.metadata,
      relatedIssueIds: knowledgeEntries.relatedIssueIds,
    })
    .from(labels)
    .leftJoin(knowledgeEntries, eq(knowledgeEntries.id, labels.knowledgeEntryId))
    .where(and(eq(labels.projectId, projectId), eq(labels.kind, 'module')));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug ?? row.name,
    parentId: row.parentId,
    node:
      row.body === null
        ? null
        : {
            body: row.body,
            relatedIssueCount: Array.isArray(row.relatedIssueIds) ? row.relatedIssueIds.length : 0,
            actor: readActor(row.metadata),
          },
  }));
}

async function loadCoOccurrences(projectId: string): Promise<CoOccurrence[]> {
  const a = alias(issueLabels, 'a');
  const b = alias(issueLabels, 'b');
  const la = alias(labels, 'la');
  const lb = alias(labels, 'lb');

  const rows = await db
    .select({
      aId: a.labelId,
      bId: b.labelId,
      issueCount: sql<number>`count(*)::int`,
    })
    .from(a)
    .innerJoin(b, and(eq(b.issueId, a.issueId), gt(b.labelId, a.labelId)))
    .innerJoin(la, and(eq(la.id, a.labelId), eq(la.kind, 'module'), eq(la.projectId, projectId)))
    .innerJoin(lb, and(eq(lb.id, b.labelId), eq(lb.kind, 'module'), eq(lb.projectId, projectId)))
    .groupBy(a.labelId, b.labelId);

  return rows.map((r) => ({ aId: r.aId, bId: r.bId, issueCount: Number(r.issueCount) }));
}

/** The whole of what the four generators read, taken at one moment from live rows. */
export async function loadModuleDiagramSnapshot(projectId: string): Promise<ModuleDiagramSnapshot> {
  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  const [modules, coOccurrences] = await Promise.all([
    loadModules(projectId),
    loadCoOccurrences(projectId),
  ]);

  return {
    projectName: project?.name ?? 'project',
    modules,
    coOccurrences,
  };
}
