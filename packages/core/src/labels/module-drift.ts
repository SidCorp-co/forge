/**
 * ISS-951 (Tier 3d of ISS-589) — the drift between the module graph the issue stream shows and
 * the one the taxonomy declares.
 *
 * Two edge sets over the same nodes. **Observed**: two modules attributed to the same issue, a
 * self-join of `issue_labels` scoped to `kind='module'` on both sides. **Declared**: one module
 * is the other's ancestor through `labels.parent_id`, transitively — a subtree is declared to
 * hang together. What is observed and not declared is a coupling nobody wrote down, and it is
 * reported as a signal: 200, no threshold that fails, and no gate reads it. A detector that could
 * fail a build would be answered by declaring edges nobody means.
 */

import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { issueLabels, issues, labels } from '../db/schema.js';

export interface ModuleDriftNode {
  labelId: string;
  name: string;
  slug: string | null;
  knowledgeEntryId: string | null;
}

export interface ModuleDriftEdge {
  a: ModuleDriftNode;
  b: ModuleDriftNode;
  issueCount: number;
  primaryAnchoredIssueCount: number;
  recentIssueSeqs: number[];
  nearestCommonAncestor: ModuleDriftNode | null;
}

export interface ModuleDriftDeclaredEdge {
  a: ModuleDriftNode;
  b: ModuleDriftNode;
  issueCount: number;
}

export interface ModuleDriftResponse {
  generatedAt: string;
  // cm:guard the layer is part of the answer, not documentation — `.arch.json`'s 63 modules are source-path globs and `cm:edge` is file-to-file, both a lower layer gated elsewhere. A consumer that reads this report as a statement about source paths is reading the wrong graph, and only this field tells it apart.
  layer: 'module-taxonomy';
  minCoOccurrence: number;
  declaration: {
    state: 'present' | 'absent';
    source: 'label-hierarchy';
    edgeCount: number;
  };
  observed: {
    moduleCount: number;
    edgeCount: number;
    belowThresholdEdgeCount: number;
  };
  undeclared: ModuleDriftEdge[];
  unobserved: ModuleDriftDeclaredEdge[];
  agreedEdgeCount: number;
}

export interface ObservedModuleEdge {
  aLabelId: string;
  bLabelId: string;
  issueCount: number;
  primaryAnchoredIssueCount: number;
  recentIssueSeqs: number[];
}

export interface ModuleNodeRow extends ModuleDriftNode {
  parentId: string | null;
}

const RECENT_ISSUE_SAMPLE = 5;

/**
 * Every unordered pair of modules that share an issue, with the weight of the pair.
 *
 * `b.label_id > a.label_id` is what makes the pair unordered: without it every pair arrives twice
 * and the self-join also matches each row against itself. `primaryAnchoredIssueCount` is the
 * primary×secondary half of the co-occurrence the epic defines — the remainder of `issueCount` is
 * secondary×secondary, and a consumer can tell them apart without a second query.
 */
export async function observedModuleEdges(projectId: string): Promise<ObservedModuleEdge[]> {
  const right = alias(issueLabels, 'right_label');
  const leftModule = alias(labels, 'left_module');
  const rightModule = alias(labels, 'right_module');

  // cm:guard `count(*)` IS the issue count only because `issue_labels` is keyed on `(issue_id, label_id)` — that PK is what makes one row per issue per pair, so a schema change that dropped it would turn every weight in this report into a junction-row count without a single test noticing.
  // cm:guard both sides re-check `kind='module'` and `project_id` — `issue_labels` cannot see either, so dropping one side's join condition admits a plain label as a module (ISS-593 keeps them in one table) and dropping `project_id` admits another project's taxonomy through a shared issue.
  const rows = await db
    .select({
      aLabelId: issueLabels.labelId,
      bLabelId: right.labelId,
      issueCount: sql<number>`count(*)::int`,
      primaryAnchoredIssueCount: sql<number>`count(*) filter (where ${issueLabels.isPrimary} or ${right.isPrimary})::int`,
      recentIssueSeqs: sql<
        number[]
      >`(array_agg(${issues.issSeq} order by ${issues.issSeq} desc))[1:${sql.raw(String(RECENT_ISSUE_SAMPLE))}]`,
    })
    .from(issueLabels)
    .innerJoin(
      right,
      and(eq(right.issueId, issueLabels.issueId), sql`${right.labelId} > ${issueLabels.labelId}`),
    )
    .innerJoin(issues, eq(issues.id, issueLabels.issueId))
    .innerJoin(
      leftModule,
      and(
        eq(leftModule.id, issueLabels.labelId),
        eq(leftModule.kind, 'module'),
        eq(leftModule.projectId, projectId),
      ),
    )
    .innerJoin(
      rightModule,
      and(
        eq(rightModule.id, right.labelId),
        eq(rightModule.kind, 'module'),
        eq(rightModule.projectId, projectId),
      ),
    )
    .groupBy(issueLabels.labelId, right.labelId);

  return rows.map((r) => ({
    aLabelId: r.aLabelId,
    bLabelId: r.bLabelId,
    issueCount: Number(r.issueCount),
    primaryAnchoredIssueCount: Number(r.primaryAnchoredIssueCount),
    recentIssueSeqs: (r.recentIssueSeqs ?? []).map(Number),
  }));
}

/** The project's modules, with the parent edge the declared graph is closed over. */
export async function moduleNodes(projectId: string): Promise<ModuleNodeRow[]> {
  return db
    .select({
      labelId: labels.id,
      name: labels.name,
      slug: labels.slug,
      knowledgeEntryId: labels.knowledgeEntryId,
      parentId: labels.parentId,
    })
    .from(labels)
    .where(and(eq(labels.projectId, projectId), eq(labels.kind, 'module')))
    .orderBy(labels.name);
}

// cm:guard the separator must be a character no uuid can contain — the key is split back apart in `driftFromSets` to name the two ends of a declared edge, so a separator that could appear inside a label id would silently truncate one of them.
const PAIR_SEP = '|';
const pairKey = (a: string, b: string): string =>
  a < b ? `${a}${PAIR_SEP}${b}` : `${b}${PAIR_SEP}${a}`;

/**
 * Every ancestor↔descendant pair, and each node's ancestor chain.
 *
 * The walk is bounded by a seen-set exactly as `module-service.ts` bounds its own: the FK permits
 * a cycle, and a corrupted chain must answer the request rather than spin.
 */
export function closeHierarchy(nodes: ModuleNodeRow[]): {
  declaredPairs: Set<string>;
  ancestorsOf: Map<string, string[]>;
} {
  const parentOf = new Map(nodes.map((n) => [n.labelId, n.parentId] as const));
  const declaredPairs = new Set<string>();
  const ancestorsOf = new Map<string, string[]>();

  for (const node of nodes) {
    const chain: string[] = [];
    const seen = new Set<string>([node.labelId]);
    let cursor = parentOf.get(node.labelId) ?? null;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(cursor);
      declaredPairs.add(pairKey(node.labelId, cursor));
      cursor = parentOf.get(cursor) ?? null;
    }
    ancestorsOf.set(node.labelId, chain);
  }

  return { declaredPairs, ancestorsOf };
}

/**
 * The module the two both hang under, nearest first, or null when their subtrees are unrelated.
 *
 * This is what keeps the detector out of the sibling question: two children of one parent are not
 * declared connected — the taxonomy says they are both parts of something, never that they relate
 * to each other — so their pair stays in `undeclared` and carries the parent that explains it.
 */
export function nearestCommonAncestorId(
  ancestorsOf: Map<string, string[]>,
  a: string,
  b: string,
): string | null {
  const bChain = new Set(ancestorsOf.get(b) ?? []);
  for (const candidate of ancestorsOf.get(a) ?? []) {
    if (bChain.has(candidate)) return candidate;
  }
  return null;
}

export interface ModuleDriftInput {
  nodes: ModuleNodeRow[];
  observed: ObservedModuleEdge[];
  minCoOccurrence: number;
  generatedAt: string;
}

/**
 * The set difference, both ways.
 *
 * `undeclared` is the signal: observed at or above the threshold, and no ancestry between the two.
 * `unobserved` is the same difference read the other way — declared, and the issue stream has
 * never linked them (or not often enough to count) — which is the half that says a declared edge
 * may have gone cold. A pair that co-occurred once is neither: it lands in
 * `belowThresholdEdgeCount`, because one issue touching two modules is a coincidence and a
 * detector that called it a finding would report noise forever.
 */
export function driftFromSets(input: ModuleDriftInput): ModuleDriftResponse {
  const { nodes, observed, minCoOccurrence, generatedAt } = input;
  const nodeOf = new Map<string, ModuleDriftNode>(
    nodes.map((n) => [
      n.labelId,
      { labelId: n.labelId, name: n.name, slug: n.slug, knowledgeEntryId: n.knowledgeEntryId },
    ]),
  );
  const { declaredPairs, ancestorsOf } = closeHierarchy(nodes);
  const observedCountOf = new Map(observed.map((e) => [pairKey(e.aLabelId, e.bLabelId), e]));

  const undeclared: ModuleDriftEdge[] = [];
  let belowThresholdEdgeCount = 0;
  let agreedEdgeCount = 0;

  for (const edge of observed) {
    const a = nodeOf.get(edge.aLabelId);
    const b = nodeOf.get(edge.bLabelId);
    if (!a || !b) continue;
    const declared = declaredPairs.has(pairKey(edge.aLabelId, edge.bLabelId));
    if (declared) {
      agreedEdgeCount++;
      continue;
    }
    if (edge.issueCount < minCoOccurrence) {
      belowThresholdEdgeCount++;
      continue;
    }
    const ancestorId = nearestCommonAncestorId(ancestorsOf, edge.aLabelId, edge.bLabelId);
    undeclared.push({
      ...orderPair(a, b),
      issueCount: edge.issueCount,
      primaryAnchoredIssueCount: edge.primaryAnchoredIssueCount,
      recentIssueSeqs: edge.recentIssueSeqs,
      nearestCommonAncestor: (ancestorId && nodeOf.get(ancestorId)) || null,
    });
  }

  const unobserved: ModuleDriftDeclaredEdge[] = [];
  for (const key of declaredPairs) {
    const observedEdge = observedCountOf.get(key);
    if (observedEdge && observedEdge.issueCount >= minCoOccurrence) continue;
    const [aId, bId] = key.split(PAIR_SEP);
    const a = aId === undefined ? undefined : nodeOf.get(aId);
    const b = bId === undefined ? undefined : nodeOf.get(bId);
    if (!a || !b) continue;
    unobserved.push({ ...orderPair(a, b), issueCount: observedEdge?.issueCount ?? 0 });
  }

  undeclared.sort(
    (x, y) =>
      y.issueCount - x.issueCount ||
      x.a.name.localeCompare(y.a.name) ||
      x.b.name.localeCompare(y.b.name),
  );
  unobserved.sort((x, y) => x.a.name.localeCompare(y.a.name) || x.b.name.localeCompare(y.b.name));

  return {
    generatedAt,
    layer: 'module-taxonomy',
    minCoOccurrence,
    declaration: {
      // cm:why "nothing is declared" is a legal and common state, so it is a named state rather than an empty list: a project that never built a hierarchy gets its observed graph and is told the declaration is absent, which reads differently from a full declaration that happens to agree with everything.
      state: nodes.some((n) => n.parentId !== null) ? 'present' : 'absent',
      source: 'label-hierarchy',
      edgeCount: declaredPairs.size,
    },
    observed: {
      moduleCount: nodes.length,
      edgeCount: observed.length,
      belowThresholdEdgeCount,
    },
    undeclared,
    unobserved,
    agreedEdgeCount,
  };
}

const orderPair = (
  a: ModuleDriftNode,
  b: ModuleDriftNode,
): { a: ModuleDriftNode; b: ModuleDriftNode } =>
  a.name.localeCompare(b.name) <= 0 ? { a, b } : { a: b, b: a };

export async function moduleDrift(
  projectId: string,
  options: { minCoOccurrence?: number } = {},
): Promise<ModuleDriftResponse> {
  const minCoOccurrence = options.minCoOccurrence ?? 2;
  const [nodes, observed] = await Promise.all([
    moduleNodes(projectId),
    observedModuleEdges(projectId),
  ]);
  return driftFromSets({
    nodes,
    observed,
    minCoOccurrence,
    generatedAt: new Date().toISOString(),
  });
}
