/**
 * The dependency / parent-child graph the PM agent inspects when reasoning
 * about blockers, parallelism and epic decomposition. Every edge comes from
 * `issue_dependencies` (kind = blocks / relates / duplicates / parent).
 *
 * - no root → the whole project graph, capped at `PM_GRAPH_MAX_NODES`, with
 *   `truncated` + `remainingNodes` saying what was left out (ISS-145).
 * - a root → BFS to `depth`, undirected over both edge directions, cycles
 *   guarded by a visited set.
 */

import { and, count, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueDependencyKind, issueDependencies, issues } from '../db/schema.js';

export const PM_GRAPH_MAX_NODES = 200;
export const PM_GRAPH_MAX_DEPTH = 5;
export const PM_GRAPH_DEFAULT_DEPTH = 2;

type GraphEdge = {
  from: string;
  to: string;
  kind: IssueDependencyKind;
};

type GraphNode = {
  id: string;
  status: string;
  priority: string;
  assigneeId: string | null;
};

export type PmGraphQuery = {
  projectId: string;
  rootIssueId?: string | undefined;
  depth: number;
};

/** The project's dependency graph, whole or BFS'd out from one root. */
export async function readPmGraph({ projectId, rootIssueId, depth }: PmGraphQuery) {
  if (!rootIssueId) {
    const [countRow] = (await db
      .select({ total: count() })
      .from(issues)
      .where(eq(issues.projectId, projectId))) as Array<{ total: number } | undefined>;

    const totalNodes = Number(countRow?.total ?? 0);
    const truncated = totalNodes > PM_GRAPH_MAX_NODES;
    const remainingNodes = truncated ? totalNodes - PM_GRAPH_MAX_NODES : 0;

    const nodes = await db
      .select({
        id: issues.id,
        status: issues.status,
        priority: issues.priority,
        assigneeId: issues.assigneeId,
      })
      .from(issues)
      .where(eq(issues.projectId, projectId))
      .limit(PM_GRAPH_MAX_NODES);

    const nodeIds = new Set(nodes.map((n) => n.id));

    const depEdges = await db
      .select({
        from: issueDependencies.fromIssueId,
        to: issueDependencies.toIssueId,
        kind: issueDependencies.kind,
      })
      .from(issueDependencies)
      .where(eq(issueDependencies.projectId, projectId));

    const edges: GraphEdge[] = depEdges
      .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
      .map((e) => ({ from: e.from, to: e.to, kind: e.kind }));

    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        status: n.status,
        priority: n.priority,
        assigneeId: n.assigneeId,
      })),
      edges,
      rootIssueId: null,
      depth: depth,
      truncated,
      remainingNodes,
    };
  }

  const visited = new Set<string>([rootIssueId]);
  let frontier = new Set<string>([rootIssueId]);
  const allEdges: GraphEdge[] = [];

  for (let d = 0; d < depth && frontier.size > 0; d++) {
    const frontierIds = [...frontier];
    const nextFrontier = new Set<string>();

    const dependencyEdges = await db
      .select({
        from: issueDependencies.fromIssueId,
        to: issueDependencies.toIssueId,
        kind: issueDependencies.kind,
      })
      .from(issueDependencies)
      .where(
        and(
          eq(issueDependencies.projectId, projectId),
          inArray(issueDependencies.fromIssueId, frontierIds),
        ),
      );
    // cm:why two queries, not one: an edge counts when EITHER end touches the frontier, and drizzle has no `OR(IN, IN)` builder — a single `inArray` on one column silently makes the BFS directional and drops every blocker reached from its far side
    const dependencyEdgesReverse = await db
      .select({
        from: issueDependencies.fromIssueId,
        to: issueDependencies.toIssueId,
        kind: issueDependencies.kind,
      })
      .from(issueDependencies)
      .where(
        and(
          eq(issueDependencies.projectId, projectId),
          inArray(issueDependencies.toIssueId, frontierIds),
        ),
      );
    for (const e of [...dependencyEdges, ...dependencyEdgesReverse]) {
      allEdges.push(e);
      for (const id of [e.from, e.to]) {
        if (!visited.has(id)) {
          visited.add(id);
          nextFrontier.add(id);
        }
      }
    }

    frontier = nextFrontier;
  }

  const edgeKey = (e: GraphEdge) => `${e.from}:${e.to}:${e.kind}`;
  const dedupedEdges = Array.from(new Map(allEdges.map((e) => [edgeKey(e), e])).values());

  const nodeRows = await db
    .select({
      id: issues.id,
      status: issues.status,
      priority: issues.priority,
      assigneeId: issues.assigneeId,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.id, [...visited])));

  const nodes: GraphNode[] = nodeRows.map((r) => ({
    id: r.id,
    status: r.status,
    priority: r.priority,
    assigneeId: r.assigneeId,
  }));

  return {
    nodes,
    edges: dedupedEdges,
    rootIssueId: rootIssueId,
    depth: depth,
    truncated: false,
    remainingNodes: 0,
  };
}
