/**
 * ISS-40 PR-E — HTTP CRUD for issue_dependencies edges. Mirrors the writes
 * already covered by `forge_pm.set_dependency` MCP, but exposed to non-PM
 * clients (web UI). Cycle detection runs DFS on `kind='blocks'` edges before
 * insert so the dispatcher's Layer 2 cannot deadlock on a cyclic graph.
 */

import { zValidator } from '@hono/zod-validator';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type Db, db } from '../db/client.js';
import { issueDependencies, issueDependencyKinds, issues } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { safeRecordActivity } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { loadIssueDependencyEdges } from './dependency-read.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';

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
type DependencyReadExecutor = Pick<Db, 'select'>;

async function detectCycle(
  projectId: string,
  start: string,
  target: string,
  executor: DependencyReadExecutor = db,
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
    const children = await executor
      .select({ to: issueDependencies.toIssueId })
      .from(issueDependencies)
      .where(
        and(
          eq(issueDependencies.projectId, projectId),
          eq(issueDependencies.fromIssueId, node),
          eq(issueDependencies.kind, 'blocks'),
          or(isNull(issueDependencies.validUntil), gt(issueDependencies.validUntil, sql`now()`)),
        ),
      );
    for (const c of children) {
      if (c.to === target) return 'cycle';
      if (!visited.has(c.to)) stack.push({ node: c.to, depth: depth + 1 });
    }
  }
  return null;
}

async function finalizeDependencyChange(input: {
  action: 'added' | 'removed' | 'updated';
  edgeId: string;
  projectId: string;
  fromIssueId: string;
  toIssueId: string;
  kind: (typeof issueDependencyKinds)[number];
  actorId: string;
  reason?: string;
  validUntil?: string;
}): Promise<void> {
  await hooks.emit('dependencyChanged', {
    projectId: input.projectId,
    edgeId: input.edgeId,
    fromIssueId: input.fromIssueId,
    toIssueId: input.toIssueId,
    kind: input.kind,
  });
  const payload = {
    edgeId: input.edgeId,
    fromIssueId: input.fromIssueId,
    toIssueId: input.toIssueId,
    kind: input.kind,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.validUntil ? { validUntil: input.validUntil } : {}),
  };
  const actor = { type: 'user' as const, id: input.actorId };
  await Promise.all([
    safeRecordActivity({
      issueId: input.fromIssueId,
      actor,
      action: `issue.dependency.${input.action}`,
      payload,
    }),
    safeRecordActivity({
      issueId: input.toIssueId,
      actor,
      action: `issue.dependency.${input.action}`,
      payload,
    }),
  ]);
  if (input.kind === 'blocks' || input.kind === 'decomposes') {
    // cm:guard publish decompose health for its `from` parent — only the parent derives decomposeChildrenPending, while blocks gates `to`; selecting the child leaves a waiting parent stale
    const healthIssueId = input.kind === 'decomposes' ? input.fromIssueId : input.toIssueId;
    await publishPipelineHealthChanged(input.projectId, [healthIssueId]);
  }
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

    // cm:guard resolve the role through `loadProjectAccess`, never by reading `project_members` directly: an org admin/owner holds project `admin` on every project their org owns WITHOUT a membership row (`orgDerivedProjectRole`), so a raw row lookup 403s them. Measured on forge-beta 2026-08-23: 25 of 25 issues on the Issues page, 50 failed requests per load, for the org's own admin.
    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const { outgoing, incoming } = await loadIssueDependencyEdges(id);

    return c.json({
      outgoing,
      incoming,
    });
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
      .select({ id: issues.id, projectId: issues.projectId, status: issues.status })
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
      throw badRequest(
        { message: 'cross-project edges not supported via this route' },
        'CROSS_PROJECT',
      );
    }
    const access = await loadProjectAccess(a.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    const mutation = await db.transaction(async (tx) => {
      if (kind === 'blocks') {
        // cm:guard serialize `blocks` mutations per project and re-read the source after the lock — a concurrent drop otherwise expires its old edges, then this stale request creates a new impossible dropped-blocker edge that strands its dependent
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${a.projectId}))`);
      }

      const currentSides = await tx
        .select({ id: issues.id, projectId: issues.projectId, status: issues.status })
        .from(issues)
        .where(inArray(issues.id, [fromIssueId, toIssueId]));
      if (currentSides.length !== 2) throw notFound('one or both issues not found');
      const currentFrom = currentSides.find((side) => side.id === fromIssueId);

      let [existing] = await tx
        .select({ id: issueDependencies.id, validUntil: issueDependencies.validUntil })
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
      const finalValidUntil =
        validUntil === undefined ? (existing?.validUntil ?? null) : new Date(validUntil);
      const edgeIsActive = finalValidUntil === null || finalValidUntil > new Date();

      if (kind === 'blocks' && edgeIsActive) {
        if (currentFrom?.status === 'dropped') {
          throw badRequest(
            { message: 'a dropped issue cannot block another issue' },
            'DROPPED_BLOCKER',
          );
        }
        const cycle = await detectCycle(a.projectId, toIssueId, fromIssueId, tx);
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

      if (!existing) {
        const [inserted] = await tx
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
        if (inserted) return { id: inserted.id, created: true, updated: false };
        [existing] = await tx
          .select({ id: issueDependencies.id, validUntil: issueDependencies.validUntil })
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
        if (!existing)
          throw new HTTPException(500, { message: 'conflict but no existing row found' });
      }

      const patch: { reason?: string; validUntil?: Date } = {};
      if (reason !== undefined) patch.reason = reason;
      if (validUntil !== undefined) patch.validUntil = new Date(validUntil);
      const updated = Object.keys(patch).length > 0;
      if (updated) {
        await tx.update(issueDependencies).set(patch).where(eq(issueDependencies.id, existing.id));
      }
      return { id: existing.id, created: false, updated };
    });

    if (mutation.created || mutation.updated) {
      await finalizeDependencyChange({
        action: mutation.created ? 'added' : 'updated',
        edgeId: mutation.id,
        projectId: a.projectId,
        fromIssueId,
        toIssueId,
        kind,
        actorId: userId,
        ...(reason !== undefined ? { reason } : {}),
        ...(validUntil !== undefined ? { validUntil } : {}),
      });
    }
    return c.json(
      { id: mutation.id, created: mutation.created, updated: mutation.updated },
      mutation.created ? 201 : 200,
    );
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
    const access = await loadProjectAccess(edge.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    if (edge.fromIssueId !== issueId && edge.toIssueId !== issueId) {
      throw badRequest({ message: 'edge does not involve this issue' }, 'EDGE_MISMATCH');
    }

    await db.delete(issueDependencies).where(eq(issueDependencies.id, edgeId));

    await finalizeDependencyChange({
      action: 'removed',
      edgeId,
      projectId: edge.projectId,
      fromIssueId: edge.fromIssueId,
      toIssueId: edge.toIssueId,
      kind: edge.kind,
      actorId: userId,
    });

    return c.json({ deleted: true });
  },
);

/** Exported for reuse by the MCP `forge_pm.set_dependency` tool. */
export { detectCycle };
