/**
 * The dependency / parent-child graph a planner inspects when reasoning
 * about blockers, parallelism and epic structure. Every edge comes from
 * `issue_dependencies` (kind = blocks / relates / duplicates / parent).
 *
 * - no root → the whole project graph, capped at `PM_GRAPH_MAX_NODES`, with
 *   `truncated` + `remainingNodes` saying what was left out (ISS-145).
 * - a root → BFS to `depth`, undirected over both edge directions, cycles
 *   guarded by a visited set.
 */

import { and, count, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueDependencyKind, issueDependencies, issues } from '../db/schema.js';
import { issueArchiveSide } from './archive.js';

const PM_GRAPH_MAX_NODES = 200;
export const PM_GRAPH_MAX_DEPTH = 5;
export const PM_GRAPH_DEFAULT_DEPTH = 2;

type GraphEdge = {
  from: string;
  to: string;
  kind: IssueDependencyKind;
};

type PmGraphQuery = {
  projectId: string;
  rootIssueId?: string | undefined;
  depth: number;
};

const NODE_COLUMNS = {
  id: issues.id,
  status: issues.status,
  priority: issues.priority,
  assigneeId: issues.assigneeId,
};

const EDGE_COLUMNS = {
  from: issueDependencies.fromIssueId,
  to: issueDependencies.toIssueId,
  kind: issueDependencies.kind,
};

/** The whole-project view, capped at `PM_GRAPH_MAX_NODES`. It is discovery, so an archived issue
 *  is not a node of it (ISS-1237). */
async function wholeGraph(projectId: string, depth: number) {
  const scope = and(eq(issues.projectId, projectId), ...issueArchiveSide(false));
  const [countRow] = await db.select({ total: count() }).from(issues).where(scope);
  const totalNodes = Number(countRow?.total ?? 0);
  const truncated = totalNodes > PM_GRAPH_MAX_NODES;
  const nodes = await db.select(NODE_COLUMNS).from(issues).where(scope).limit(PM_GRAPH_MAX_NODES);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = (
    await db
      .select(EDGE_COLUMNS)
      .from(issueDependencies)
      .where(eq(issueDependencies.projectId, projectId))
  ).filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  return {
    nodes,
    edges,
    rootIssueId: null,
    depth,
    truncated,
    remainingNodes: truncated ? totalNodes - PM_GRAPH_MAX_NODES : 0,
  };
}

/** BFS from one root to `depth`, undirected over both edge directions. */
async function rootGraph(projectId: string, rootIssueId: string, depth: number) {
  const visited = new Set<string>([rootIssueId]);
  let frontier = [rootIssueId];
  const edgesByKey = new Map<string, GraphEdge>();
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const touching = await db
      .select(EDGE_COLUMNS)
      .from(issueDependencies)
      .where(
        and(
          eq(issueDependencies.projectId, projectId),
          or(
            inArray(issueDependencies.fromIssueId, frontier),
            inArray(issueDependencies.toIssueId, frontier),
          ),
        ),
      );
    const next: string[] = [];
    for (const e of touching) {
      edgesByKey.set(`${e.from}:${e.to}:${e.kind}`, e);
      for (const id of [e.from, e.to]) {
        if (visited.has(id)) continue;
        visited.add(id);
        next.push(id);
      }
    }
    frontier = next;
  }
  const nodes = await db
    .select(NODE_COLUMNS)
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.id, [...visited])));
  return {
    nodes,
    edges: [...edgesByKey.values()],
    rootIssueId,
    depth,
    truncated: false,
    remainingNodes: 0,
  };
}

/** The project's dependency graph, whole or BFS'd out from one root. */
export function readPmGraph({ projectId, rootIssueId, depth }: PmGraphQuery) {
  return rootIssueId ? rootGraph(projectId, rootIssueId, depth) : wholeGraph(projectId, depth);
}
