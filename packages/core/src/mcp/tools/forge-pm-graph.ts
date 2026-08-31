/**
 * `forge_pm.graph` (Epic 3, ISS-19) — dependency / parent-child graph that
 * the PM agent inspects when reasoning about blockers, parallelism, and
 * epic decomposition. Every edge comes from `issue_dependencies`
 * (kind = blocks / relates / duplicates / parent).
 *
 * - `rootIssueId` omitted → return the whole project graph, capped at
 *   `MAX_NODES`. Returns `truncated:true` + `remainingNodes:N` when the
 *   project has more than `MAX_NODES` issues (ISS-145).
 * - `rootIssueId` set → BFS to `depth` (default 2, max 5). Undirected over
 *   both edge tables. Cycles are guarded by a visited set.
 *
 * ISS-145: handler body extracted into `pmGraphHandler` and consumed by
 * both the legacy shim factory below and the consolidated
 * `forge_project_pm` dispatcher.
 */

import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { PM_GRAPH_DEFAULT_DEPTH, PM_GRAPH_MAX_DEPTH, readPmGraph } from '../../pm/graph-service.js';
import { assertDeviceOwnerIsMember } from './project-authz.js';

export const pmGraphInputSchema = z
  .object({
    projectId: z.uuid(),
    rootIssueId: z.uuid().optional(),
    depth: z.number().int().min(1).max(PM_GRAPH_MAX_DEPTH).default(PM_GRAPH_DEFAULT_DEPTH),
  })
  .strict();

export async function pmGraphHandler(device: Device, input: z.infer<typeof pmGraphInputSchema>) {
  await assertDeviceOwnerIsMember(device, input.projectId);
  return readPmGraph(input);
}
