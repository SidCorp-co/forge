import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { type IssueDependencyKind, issueDependencies, issues } from '../../db/schema.js';
import {
  type DeviceScopedMcpToolFactory,
  assertDeviceOwnerIsMember,
  zodToMcpSchema,
} from './lib.js';

/**
 * `forge_pm.graph` (Epic 3, ISS-19) — dependency / parent-child graph that
 * the PM agent inspects when reasoning about blockers, parallelism, and
 * epic decomposition. Combines `issue_dependencies` rows (kind = blocks /
 * relates / duplicates / parent) with the implicit `issues.parent_issue_id`
 * edge (`kind: 'parent'`).
 *
 * - `rootIssueId` omitted → return the whole project graph, capped at
 *   `MAX_NODES` (truncated:true if hit).
 * - `rootIssueId` set → BFS to `depth` (default 2, max 4), undirected over
 *   both edge tables. Cycles are guarded by a visited set.
 */

const MAX_NODES = 200;
const MAX_DEPTH = 4;
const DEFAULT_DEPTH = 2;

const inputSchema = z
  .object({
    projectId: z.uuid(),
    rootIssueId: z.uuid().optional(),
    depth: z.number().int().min(1).max(MAX_DEPTH).default(DEFAULT_DEPTH),
  })
  .strict();

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

export const forgePmGraphTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_pm.graph',
  description:
    'Dependency + parent graph for a project. Without rootIssueId returns the full graph (capped at 200 nodes). With rootIssueId runs BFS to `depth` (default 2, max 4). Read-only; requires project membership.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, input.projectId);

    if (!input.rootIssueId) {
      const allNodes = await db
        .select({
          id: issues.id,
          status: issues.status,
          priority: issues.priority,
          assigneeId: issues.assigneeId,
          parentIssueId: issues.parentIssueId,
        })
        .from(issues)
        .where(eq(issues.projectId, input.projectId))
        .limit(MAX_NODES + 1);

      const truncated = allNodes.length > MAX_NODES;
      const nodes = allNodes.slice(0, MAX_NODES);
      const nodeIds = new Set(nodes.map((n) => n.id));

      const depEdges = await db
        .select({
          from: issueDependencies.fromIssueId,
          to: issueDependencies.toIssueId,
          kind: issueDependencies.kind,
        })
        .from(issueDependencies)
        .where(eq(issueDependencies.projectId, input.projectId));

      const edges: GraphEdge[] = depEdges
        .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
        .map((e) => ({ from: e.from, to: e.to, kind: e.kind }));

      for (const n of nodes) {
        if (n.parentIssueId && nodeIds.has(n.parentIssueId)) {
          edges.push({ from: n.id, to: n.parentIssueId, kind: 'parent' });
        }
      }

      return {
        nodes: nodes.map((n) => ({
          id: n.id,
          status: n.status,
          priority: n.priority,
          assigneeId: n.assigneeId,
        })),
        edges,
        rootIssueId: null,
        depth: input.depth,
        truncated,
      };
    }

    // BFS from rootIssueId, undirected, depth-limited.
    const visited = new Set<string>([input.rootIssueId]);
    let frontier = new Set<string>([input.rootIssueId]);
    const allEdges: GraphEdge[] = [];

    for (let d = 0; d < input.depth && frontier.size > 0; d++) {
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
            eq(issueDependencies.projectId, input.projectId),
            // Either side of the edge touches the frontier — drizzle has no
            // native `OR(IN, IN)` helper here; emit two queries via inArray.
            inArray(issueDependencies.fromIssueId, frontierIds),
          ),
        );
      const dependencyEdgesReverse = await db
        .select({
          from: issueDependencies.fromIssueId,
          to: issueDependencies.toIssueId,
          kind: issueDependencies.kind,
        })
        .from(issueDependencies)
        .where(
          and(
            eq(issueDependencies.projectId, input.projectId),
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

      // parent edges: child → parent (frontier child) and child → parent (frontier parent)
      const childRows = await db
        .select({ id: issues.id, parentIssueId: issues.parentIssueId })
        .from(issues)
        .where(
          and(
            eq(issues.projectId, input.projectId),
            inArray(issues.id, frontierIds),
            isNotNull(issues.parentIssueId),
          ),
        );
      const parentRows = await db
        .select({ id: issues.id, parentIssueId: issues.parentIssueId })
        .from(issues)
        .where(
          and(
            eq(issues.projectId, input.projectId),
            inArray(issues.parentIssueId, frontierIds),
          ),
        );
      for (const r of [...childRows, ...parentRows]) {
        if (!r.parentIssueId) continue;
        allEdges.push({ from: r.id, to: r.parentIssueId, kind: 'parent' });
        for (const id of [r.id, r.parentIssueId]) {
          if (!visited.has(id)) {
            visited.add(id);
            nextFrontier.add(id);
          }
        }
      }

      frontier = nextFrontier;
    }

    // Dedupe edges (BFS may collect the same edge from both directions).
    const edgeKey = (e: GraphEdge) => `${e.from}:${e.to}:${e.kind}`;
    const dedupedEdges = Array.from(
      new Map(allEdges.map((e) => [edgeKey(e), e])).values(),
    );

    const nodeRows = await db
      .select({
        id: issues.id,
        status: issues.status,
        priority: issues.priority,
        assigneeId: issues.assigneeId,
      })
      .from(issues)
      .where(
        and(eq(issues.projectId, input.projectId), inArray(issues.id, [...visited])),
      );

    const nodes: GraphNode[] = nodeRows.map((r) => ({
      id: r.id,
      status: r.status,
      priority: r.priority,
      assigneeId: r.assigneeId,
    }));

    return {
      nodes,
      edges: dedupedEdges,
      rootIssueId: input.rootIssueId,
      depth: input.depth,
      truncated: false,
    };
  },
});
