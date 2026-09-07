/**
 * ISS-950 (Tier 3c of ISS-587) — the reads behind the four generated diagrams, and only the reads.
 *
 * Every module attribute comes from `labels` and every fact about a module comes from the
 * knowledge node it is bound to through `labels.knowledge_entry_id` (ISS-947). `issue_labels` is
 * read here for exactly one thing, the context diagram's edge weights, which is the one use the
 * issue admits; a generated diagram that read tags for anything else would be the wrong shape.
 */

import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { issueLabels, knowledgeEdges, knowledgeEntries, labels, projects } from '../db/schema.js';
import type {
  CoOccurrence,
  DeclaredModuleEdge,
  ModuleDiagramSnapshot,
  ModuleSnapshot,
} from './module-diagrams.js';

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

// cm:guard the pair is ordered by id in the join condition (`b.label_id > a.label_id`), so the self-join yields each unordered pair once — drop it and every edge is drawn twice, in both directions, and the count doubles with it.
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

/**
 * The declared half of the context diagram.
 *
 * `knowledge_edges` is a triple store of strings, so an edge names a module the only way it can —
 * by text. Both ends must resolve to a module of this project or the row is not an edge between
 * modules and is dropped; a triple resolving one end only would draw an arrow to a node that is
 * not on the diagram.
 */
async function loadDeclaredEdges(
  projectId: string,
  modules: ModuleSnapshot[],
): Promise<DeclaredModuleEdge[]> {
  if (modules.length === 0) return [];
  const byText = new Map<string, string>();
  for (const module of modules) {
    byText.set(module.slug.toLowerCase(), module.id);
    byText.set(module.name.toLowerCase(), module.id);
  }

  // cm:guard a retracted edge is one whose `valid_until` has passed, and it must not be drawn — the retraction is the only way a declared edge is ever withdrawn, and a reader that ignores it shows a coupling somebody has already said is gone.
  const rows = await db
    .select({
      subject: knowledgeEdges.subject,
      predicate: knowledgeEdges.predicate,
      object: knowledgeEdges.object,
    })
    .from(knowledgeEdges)
    .where(
      and(
        eq(knowledgeEdges.projectId, projectId),
        or(isNull(knowledgeEdges.validUntil), gt(knowledgeEdges.validUntil, new Date())),
      ),
    );

  const edges: DeclaredModuleEdge[] = [];
  for (const row of rows) {
    const fromId = byText.get(row.subject.trim().toLowerCase());
    const toId = byText.get(row.object.trim().toLowerCase());
    if (!fromId || !toId || fromId === toId) continue;
    edges.push({ fromId, toId, predicate: row.predicate });
  }
  return edges;
}

/** The whole of what the four generators read, taken at one moment from live rows. */
export async function loadModuleDiagramSnapshot(projectId: string): Promise<ModuleDiagramSnapshot> {
  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  const modules = await loadModules(projectId);
  const [coOccurrences, declaredEdges] = await Promise.all([
    loadCoOccurrences(projectId),
    loadDeclaredEdges(projectId, modules),
  ]);

  return {
    projectName: project?.name ?? 'project',
    modules,
    coOccurrences,
    declaredEdges,
  };
}
