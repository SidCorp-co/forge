/**
 * ISS-40 PR-E — HTTP CRUD for issue_dependencies edges, exposed to non-PM
 * clients (web UI).
 *
 * ISS-889 — the edge write itself lives in `dependency-service.ts`, which refuses its rules in
 * the envelope. What stays here is transport: authz against the project role.
 */

import type { DependencyRefusalCode } from '@forge/contracts/issues';
import { Hono } from 'hono';
import { z } from 'zod';
import { issueDependencyKinds } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { badRequest, idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { safeRecordActivity } from '../pipeline/activity.js';
import {
  dependencyEdgeById,
  issueProjectsOf,
  loadIssueDependencyEdges,
} from './dependency-read.js';
import {
  deleteIssueDependency,
  type SetIssueDependencyInput,
  setIssueDependency,
} from './dependency-service.js';
import {
  issueRouteIdParamSchema,
  projectScopeQuerySchema,
  resolveIssueRouteRef,
} from './issue-route-ref.js';

const refuse = refuser<DependencyRefusalCode>('DEPENDENCY_REFUSED');

const edgeParamSchema = z.object({ id: z.uuid(), edgeId: z.uuid() });

const createBodySchema = z
  .object({
    dependsOnId: z.uuid(),
    kind: z.enum(issueDependencyKinds).default('blocks'),
    reason: z.string().trim().min(1).max(2000).optional(),
    validUntil: z.iso.datetime().optional(),
  })
  .strict();

export const issueDependencyRoutes = new Hono<{ Variables: AuthVars }>();
issueDependencyRoutes.use('*', requireAuth(), assertEmailVerified());

/**
 * GET /api/issues/:id/dependencies — returns both directions of the graph
 * for the issue. `outgoing` = edges where this issue is `from` (it blocks /
 * relates-to others). `incoming` = edges where this issue is `to` (it is
 * blocked by / depends-on others).
 */
issueDependencyRoutes.get(
  '/:id/dependencies',
  zValidator('param', issueRouteIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', projectScopeQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: rawId } = c.req.valid('param');
    const { projectId: projectIdQuery } = c.req.valid('query');
    const userId = c.get('userId');

    const issue = await resolveIssueRouteRef(rawId, projectIdQuery, userId);

    return c.json(await loadIssueDependencyEdges(issue.id, issue.projectId));
  },
);

/**
 * POST /api/issues/:id/dependencies — declare that this issue depends on
 * `dependsOnId`. Stored as the edge `(from=dependsOnId, to=id, kind=...)`,
 * matching the dispatcher's `kind='blocks'` convention (`from` blocks `to`).
 *
 * Idempotent on the unique edge.
 */
issueDependencyRoutes.post(
  '/:id/dependencies',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', createBodySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: toIssueId } = c.req.valid('param');
    const { dependsOnId: fromIssueId, kind, reason, validUntil } = c.req.valid('json');
    const userId = c.get('userId');

    if (fromIssueId === toIssueId) {
      throw refuse(
        'SELF_DEP',
        'an issue cannot depend on itself: name two different issues',
        '/dependsOnId',
      );
    }

    const sides = await issueProjectsOf([fromIssueId, toIssueId]);
    if (sides.length !== 2) throw notFound('one or both issues not found');
    const [a, b] = sides;
    if (!a || !b) throw notFound('one or both issues not found');
    if (a.projectId !== b.projectId) {
      throw refuse(
        'CROSS_PROJECT',
        'both issues of an edge are in one project; cross-project edges are not supported',
        '/dependsOnId',
      );
    }

    const access = await loadProjectAccess(a.projectId, userId);
    requireHeld(access, 'project.write');

    const input: SetIssueDependencyInput = {
      projectId: a.projectId,
      fromIssueId,
      toIssueId,
      kind,
      reason,
      validUntil,
    };
    const result = await setIssueDependency(input, {
      actor: restActor(c),
      createdById: userId,
    });
    return c.json(result, result.created ? 201 : 200);
  },
);

/**
 * DELETE /api/issues/:id/dependencies/:edgeId — remove an edge. The `:id`
 * param is required so we can scope membership to the project; we then
 * verify the edge actually involves that issue.
 */
issueDependencyRoutes.delete(
  '/:id/dependencies/:edgeId',
  zValidator('param', edgeParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: issueId, edgeId } = c.req.valid('param');
    const userId = c.get('userId');

    const edge = await dependencyEdgeById(edgeId);
    if (!edge) throw notFound('edge not found');

    // Membership check BEFORE the EDGE_MISMATCH check — otherwise a non-member
    // who pairs an arbitrary `:edgeId` with their own `:id` learns whether the
    // edge exists (404 vs 400 vs 403 leaks state).
    const access = await loadProjectAccess(edge.projectId, userId);
    requireHeld(access, 'project.write');

    if (edge.fromIssueId !== issueId && edge.toIssueId !== issueId) {
      throw badRequest({ message: 'edge does not involve this issue' }, 'EDGE_MISMATCH');
    }

    await deleteIssueDependency(edge);

    const removedPayload = {
      edgeId,
      fromIssueId: edge.fromIssueId,
      toIssueId: edge.toIssueId,
      kind: edge.kind,
    };
    const actor = restActor(c);
    await Promise.all([
      safeRecordActivity({
        issueId: edge.fromIssueId,
        actor,
        action: 'issue.dependency.removed',
        payload: removedPayload,
      }),
      safeRecordActivity({
        issueId: edge.toIssueId,
        actor,
        action: 'issue.dependency.removed',
        payload: removedPayload,
      }),
    ]);

    return c.json({ deleted: true });
  },
);
