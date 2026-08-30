/**
 * ISS-40 PR-E — HTTP CRUD for issue_dependencies edges, exposed to non-PM
 * clients (web UI).
 *
 * ISS-889 — the edge write itself lives in `dependency-service.ts`, shared
 * with MCP. What stays here is transport: authz against the project role, and
 * the mapping from the service's neutral error codes to this surface's
 * status codes and wording.
 */

import { zValidator } from '@hono/zod-validator';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issueDependencies, issueDependencyKinds, issues } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { safeRecordActivity } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { loadIssueDependencyEdges } from './dependency-read.js';
import {
  IssueDependencyError,
  type SetIssueDependencyInput,
  setIssueDependency,
} from './dependency-service.js';

const idParamSchema = z.object({ id: z.uuid() });
const edgeParamSchema = z.object({ id: z.uuid(), edgeId: z.uuid() });

const createBodySchema = z
  .object({
    dependsOnId: z.uuid(),
    kind: z.enum(issueDependencyKinds).default('blocks'),
    reason: z.string().trim().min(1).max(2000).optional(),
    validUntil: z.iso.datetime().optional(),
  })
  .strict();

const badRequest = (details: unknown, code = 'BAD_REQUEST') =>
  new HTTPException(400, { message: 'Invalid input', cause: { code, details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const conflict = (message: string, code: string, details?: unknown) =>
  new HTTPException(409, { message, cause: { code, details } });

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
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [issue] = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, id))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    // cm:guard resolve the role through `loadProjectAccess`, never by reading `project_members` directly: an org admin/owner holds project `admin` on every project their org owns WITHOUT a membership row (`orgDerivedProjectRole`), so a raw row lookup 403s them. Measured on forge-beta 2026-08-23: 25 of 25 issues on the Issues page, 50 failed requests per load, for the org's own admin.
    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    return c.json(await loadIssueDependencyEdges(id, issue.projectId));
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
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', createBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: toIssueId } = c.req.valid('param');
    const { dependsOnId: fromIssueId, kind, reason, validUntil } = c.req.valid('json');
    const userId = c.get('userId');

    // cm:guard reject the self-edge BEFORE the sides lookup — `inArray` de-duplicates the two ids, so a self-edge comes back as ONE row and the length check below answers 404 instead of 400 SELF_DEP (caught by dependency-routes-e2e)
    if (fromIssueId === toIssueId) {
      throw badRequest({ message: 'self-edge not allowed' }, 'SELF_DEP');
    }

    const sides = await db
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(inArray(issues.id, [fromIssueId, toIssueId]));
    if (sides.length !== 2) throw notFound('one or both issues not found');
    const [a, b] = sides;
    if (!a || !b) throw notFound('one or both issues not found');
    // cm:why both sides must share a project so membership can be checked ONCE, against `a` — the service refuses a mismatch as well, but only against the projectId it is handed, and this route has to choose that value before it can authorize anything
    if (a.projectId !== b.projectId) {
      throw badRequest(
        { message: 'cross-project edges not supported via this route' },
        'CROSS_PROJECT',
      );
    }

    const access = await loadProjectAccess(a.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    const input: SetIssueDependencyInput = {
      projectId: a.projectId,
      fromIssueId,
      toIssueId,
      kind,
      reason,
      validUntil,
    };
    try {
      const result = await setIssueDependency(input, {
        actor: { type: 'user', id: userId },
        createdById: userId,
      });
      return c.json(result, result.created ? 201 : 200);
    } catch (err) {
      throw toHttpDependencyError(err, input);
    }
  },
);

// cm:edge lockstep -> packages/core/src/issues/dependency-service.ts — every IssueDependencyErrorCode needs a case here; an unmapped one falls through as a 500 with the raw code as its message
function toHttpDependencyError(err: unknown, input: SetIssueDependencyInput): unknown {
  if (!(err instanceof IssueDependencyError)) return err;
  const { fromIssueId, toIssueId } = input;
  switch (err.code) {
    case 'SELF_DEP':
      return badRequest({ message: 'self-edge not allowed' }, 'SELF_DEP');
    case 'NOT_FOUND':
      return notFound('one or both issues not found');
    case 'CROSS_PROJECT':
      return badRequest(
        { message: 'cross-project edges not supported via this route' },
        'CROSS_PROJECT',
      );
    case 'CYCLE_DETECTED':
      return conflict('cycle detected — adding this edge would form a loop', 'CYCLE_DETECTED', {
        fromIssueId,
        toIssueId,
      });
    case 'CYCLE_DEPTH_EXCEEDED':
      return conflict('cycle detection depth exceeded', 'CYCLE_DEPTH_EXCEEDED');
    default:
      return new HTTPException(500, { message: err.code });
  }
}

/**
 * DELETE /api/issues/:id/dependencies/:edgeId — remove an edge. The `:id`
 * param is required so we can scope membership to the project; we then
 * verify the edge actually involves that issue.
 */
issueDependencyRoutes.delete(
  '/:id/dependencies/:edgeId',
  zValidator('param', edgeParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId, edgeId } = c.req.valid('param');
    const userId = c.get('userId');

    const [edge] = await db
      .select()
      .from(issueDependencies)
      .where(eq(issueDependencies.id, edgeId))
      .limit(1);
    if (!edge) throw notFound('edge not found');

    // Membership check BEFORE the EDGE_MISMATCH check — otherwise a non-member
    // who pairs an arbitrary `:edgeId` with their own `:id` learns whether the
    // edge exists (404 vs 400 vs 403 leaks state).
    const access = await loadProjectAccess(edge.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    if (edge.fromIssueId !== issueId && edge.toIssueId !== issueId) {
      throw badRequest({ message: 'edge does not involve this issue' }, 'EDGE_MISMATCH');
    }

    await db.delete(issueDependencies).where(eq(issueDependencies.id, edgeId));

    await hooks.emit('dependencyChanged', {
      projectId: edge.projectId,
      edgeId,
      fromIssueId: edge.fromIssueId,
      toIssueId: edge.toIssueId,
      kind: edge.kind,
    });

    const removedPayload = {
      edgeId,
      fromIssueId: edge.fromIssueId,
      toIssueId: edge.toIssueId,
      kind: edge.kind,
    };
    const actor = { type: 'user' as const, id: userId };
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
