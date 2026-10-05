import { Hono } from 'hono';
import { z } from 'zod';
import type { IssueStatus } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { listResponse } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest, idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { hydrateAgentSessionsForIssues } from './agent-sessions-hydrator.js';
import { hydrateCreatorsForIssues } from './creator.js';
import { loadIssueDependencyEdgesForIssues } from './dependency-read.js';
import { hydrateHeldForIssues } from './held-hydrator.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import { listModulesForIssues } from './label-service.js';
import { serializeRestListRow } from './list-projection.js';
import { latestFailedJobByIssue, listIssues, sumCostByIssue } from './list-service.js';
import { pipelineHealthUnderived, safeHydratePipelineHealthForIssues } from './pipeline-health.js';
import { issueListFilterFields } from './request-schemas.js';
import { refuseLegacyStatusFields } from './status-input.js';

export type { IssueBuckets } from './list-service.js';
export type { IssueSort } from './sort.js';
export { issueSortValues } from './sort.js';

const searchQuerySchema = z
  .object({
    ...issueListFilterFields,
    q: z.string().trim().min(1).max(200).optional(),
    assignee: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    withCost: z.coerce.boolean().optional().default(false),
    withFailureInfo: z.coerce.boolean().optional().default(false),
    withPipelineHealth: z.coerce.boolean().optional().default(false),
    withBuckets: z.coerce.boolean().optional().default(false),
    withDependencies: z.coerce.boolean().optional().default(false),
    withModules: z.coerce.boolean().optional().default(false),
  })
  .strict();

export const searchRoutes = new Hono<{ Variables: AuthVars }>();
searchRoutes.use('*', requireAuth(), assertEmailVerified());

searchRoutes.get(
  '/:id/issues/search',
  zValidator('param', idParamSchema),
  zValidator('query', searchQuerySchema, (r) => {
    if (!r.success) {
      refuseLegacyStatusFields(r.data, 'query', ['status', 'statusNot']);
    }
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const q = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const listed = await listIssues(projectId, { ...q, search: q.q, assigneeId: q.assignee }, q);
    if (!listed.ok) throw badRequest({ [listed.field]: listed.message });
    const { rows, total, buckets } = listed;

    const searchPrefix = await activeIssuePrefix(projectId);
    let serialized: Record<string, unknown>[] = rows.map((r) => ({
      ...serializeRestListRow(r, searchPrefix),
    }));

    if (q.withCost && serialized.length > 0) {
      const costMap = await sumCostByIssue(serialized.map((r) => r.id as string));
      serialized = serialized.map((r) => ({
        ...r,
        estimatedCost: costMap.get(r.id as string) ?? 0,
      }));
    }

    if (q.withFailureInfo && serialized.length > 0) {
      const failMap = await latestFailedJobByIssue(serialized.map((r) => r.id as string));
      serialized = serialized.map((r) => ({
        ...r,
        failureInfo: failMap.get(r.id as string) ?? null,
      }));
    }

    if (q.withPipelineHealth && serialized.length > 0) {
      const healthMap = await safeHydratePipelineHealthForIssues(
        projectId,
        serialized.map((r) => r.id as string),
      );
      serialized = serialized.map((r) => ({
        ...r,
        // ISS-1273 — `safeHydratePipelineHealthForIssues` answers an EMPTY map when the loader
        // throws, so this arm is reachable. `{ stage }` alone is the shape the issue was filed
        // against: the status column the caller already had, served back as computed health.
        pipelineHealth:
          healthMap.get(r.id as string) ?? pipelineHealthUnderived(r.status as IssueStatus),
      }));
    }

    if (q.withModules && serialized.length > 0) {
      const moduleMap = await listModulesForIssues(serialized.map((r) => r.id as string));
      serialized = serialized.map((r) => ({
        ...r,
        modules: moduleMap.get(r.id as string) ?? [],
      }));
    }

    if (q.withDependencies && serialized.length > 0) {
      const depMap = await loadIssueDependencyEdgesForIssues(
        serialized.map((r) => r.id as string),
        projectId,
      );
      serialized = serialized.map((r) => ({
        ...r,
        dependencies: depMap.get(r.id as string) ?? { outgoing: [], incoming: [] },
      }));
    }

    if (serialized.length > 0) {
      const creatorMap = await hydrateCreatorsForIssues(
        serialized.map((r) => ({
          id: r.id as string,
          createdById: r.createdById as string,
          createdByDeviceId: r.createdByDeviceId as string | null,
        })),
      );
      serialized = serialized.map((r) => ({
        ...r,
        ...creatorMap.get(r.id as string),
      }));
    }

    const withBuckets = <T>(env: T) => (buckets ? { ...env, buckets } : env);

    if (!q.withAgentSessions || serialized.length === 0) {
      return c.json(withBuckets(listResponse(c, serialized, total, q)));
    }

    const ids = serialized.map((r) => r.id as string);
    const [map, heldMap] = await Promise.all([
      hydrateAgentSessionsForIssues(projectId, ids),
      hydrateHeldForIssues(ids),
    ]);
    return c.json(
      withBuckets(
        listResponse(
          c,
          serialized.map((r) => {
            const bucket = map.get(r.id as string);
            const hold = heldMap.get(r.id as string);
            return {
              ...r,
              agentSessions: bucket?.agentSessions ?? [],
              agentStatus: bucket?.agentStatus ?? null,
              held: hold?.held,
              lastCheckInAt: hold?.lastCheckInAt,
            };
          }),
          total,
          q,
        ),
      ),
    );
  },
);
