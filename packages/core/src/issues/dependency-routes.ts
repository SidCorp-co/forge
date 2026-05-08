/**
 * ISS-40 PR-E — HTTP CRUD for issue_dependencies edges. Mirrors the writes
 * already covered by `forge_pm.set_dependency` MCP, but exposed to non-PM
 * clients (web UI). Cycle detection runs DFS on `kind='blocks'` edges before
 * insert so the dispatcher's Layer 2 cannot deadlock on a cyclic graph.
 */

import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issueDependencies, issueDependencyKinds, issues, projectMembers } from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { safeRecordActivity } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';

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

const CYCLE_DEPTH_CAP = 100;

/**
 * DFS forward from `start` following only `kind='blocks'` edges. If we reach
 * `target`, returns `'cycle'`. Caps depth defensively.
 */
async function detectCycle(
  start: string,
  target: string,
): Promise<'cycle' | 'depth_exceeded' | null> {
  if (start === target) return 'cycle';
  const visited = new Set<string>();
  const stack: Array<{ node: string; depth: number }> = [{ node: start, depth: 0 }];
  while (stack.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: length checked
    const { node, depth } = stack.pop()!;
    if (depth > CYCLE_DEPTH_CAP) return 'depth_exceeded';
    if (visited.has(node)) continue;
    visited.add(node);
    const children = await db
      .select({ to: issueDependencies.toIssueId })
      .from(issueDependencies)
      .where(
        and(
          eq(issueDependencies.fromIssueId, node),
          eq(issueDependencies.kind, 'blocks'),
        ),
      );
    for (const c of children) {
      if (c.to === target) return 'cycle';
      if (!visited.has(c.to)) stack.push({ node: c.to, depth: depth + 1 });
    }
  }
  return null;
}

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

    const [member] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(eq(projectMembers.projectId, issue.projectId), eq(projectMembers.userId, userId)),
      )
      .limit(1);
    if (!member) throw forbidden('not a project member');

    const outgoing = await db
      .select()
      .from(issueDependencies)
      .where(eq(issueDependencies.fromIssueId, id));
    const incoming = await db
      .select()
      .from(issueDependencies)
      .where(eq(issueDependencies.toIssueId, id));

    return c.json({ outgoing, incoming });
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
    if (a.projectId !== b.projectId) {
      // Project membership is checked against the `to` issue's project below.
      // We allow cross-project edges in principle (PM may model org-wide
      // blockers), but for the user-facing route we require both sides in
      // the same project to keep the auth model simple.
      throw badRequest({ message: 'cross-project edges not supported via this route' }, 'CROSS_PROJECT');
    }

    const [member] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, a.projectId), eq(projectMembers.userId, userId)))
      .limit(1);
    if (!member) throw forbidden('not a project member');

    if (kind === 'blocks') {
      const cycle = await detectCycle(toIssueId, fromIssueId);
      if (cycle === 'cycle') {
        throw conflict('cycle detected — adding this edge would form a loop', 'CYCLE_DETECTED', {
          fromIssueId,
          toIssueId,
        });
      }
      if (cycle === 'depth_exceeded') {
        throw conflict('cycle detection depth exceeded', 'CYCLE_DEPTH_EXCEEDED');
      }
    }

    const inserted = await db
      .insert(issueDependencies)
      .values({
        projectId: a.projectId,
        fromIssueId,
        toIssueId,
        kind,
        reason: reason ?? null,
        createdById: userId,
        validUntil: validUntil ? new Date(validUntil) : null,
      })
      .onConflictDoNothing({
        target: [
          issueDependencies.projectId,
          issueDependencies.fromIssueId,
          issueDependencies.toIssueId,
          issueDependencies.kind,
        ],
      })
      .returning({ id: issueDependencies.id });

    if (inserted.length > 0) {
      const edgeId = inserted[0]?.id;
      if (!edgeId) throw new HTTPException(500, { message: 'insert returned no row' });
      await hooks.emit('dependencyChanged', {
        projectId: a.projectId,
        edgeId,
        fromIssueId,
        toIssueId,
        kind,
      });
      const dependencyPayload: Record<string, unknown> = {
        edgeId,
        fromIssueId,
        toIssueId,
        kind,
        ...(reason ? { reason } : {}),
      };
      const actor = { type: 'user' as const, id: userId };
      await Promise.all([
        safeRecordActivity({
          issueId: fromIssueId,
          actor,
          action: 'issue.dependency.added',
          payload: dependencyPayload,
        }),
        safeRecordActivity({
          issueId: toIssueId,
          actor,
          action: 'issue.dependency.added',
          payload: dependencyPayload,
        }),
      ]);
      return c.json({ id: edgeId, created: true }, 201);
    }

    const [existing] = await db
      .select({ id: issueDependencies.id })
      .from(issueDependencies)
      .where(
        and(
          eq(issueDependencies.projectId, a.projectId),
          eq(issueDependencies.fromIssueId, fromIssueId),
          eq(issueDependencies.toIssueId, toIssueId),
          eq(issueDependencies.kind, kind),
        ),
      )
      .limit(1);
    if (!existing) throw new HTTPException(500, { message: 'conflict but no existing row found' });
    return c.json({ id: existing.id, created: false });
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
    const [member] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(eq(projectMembers.projectId, edge.projectId), eq(projectMembers.userId, userId)),
      )
      .limit(1);
    if (!member) throw forbidden('not a project member');

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

/** Exported for reuse by the MCP `forge_pm.set_dependency` tool. */
export { detectCycle };
