import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  comments,
  issues,
  notifications,
  pmConfig,
  pmDecisions,
  pmPolicies,
} from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { setTotalCount } from '../lib/pagination.js';
import { logger } from '../logger.js';
import { deleteMemory, indexMemoryBestEffort } from '../memory/indexer.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { type SpawnPmSessionResult, spawnPmSession } from './spawner.js';

const projectIdParam = z.object({ projectId: z.uuid() });

const projectAndIdParam = z.object({ projectId: z.uuid(), id: z.uuid() });

const respondParam = z.object({ projectId: z.uuid(), decisionId: z.uuid() });

const respondBody = z
  .object({
    choice: z.enum(['approve', 'defer', 'reassign', 'reject', 'free_text']),
    payload: z.record(z.string(), z.unknown()).optional(),
    comment: z.string().max(10_000).optional(),
  })
  .strict();

const eventTriggersSchema = z
  .object({
    jobFailed: z.boolean(),
    pipelineStalled: z.boolean(),
    needsInfo: z.boolean(),
    queuePressure: z.boolean(),
    graphChanged: z.boolean(),
  })
  .strict();

const configPatchSchema = z
  .object({
    enabled: z.boolean(),
    cadenceCron: z.string().trim().min(1).max(120).nullable(),
    eventTriggers: eventTriggersSchema,
    customInstructions: z.string().trim().max(8000).nullable(),
    modelOverride: z.string().trim().min(1).max(120).nullable(),
    maxRunsPerHour: z.number().int().min(1).max(60),
  })
  .partial()
  .strict();

const policyCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    body: z.string().trim().min(1).max(8000),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

const policyPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    body: z.string().trim().min(1).max(8000),
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(1000),
  })
  .partial()
  .strict();

const decisionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  cause: z.string().trim().min(1).max(120).optional(),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const conflict = (message: string, code: string) =>
  new HTTPException(409, { message, cause: { code } });

const tooManyRequests = (message: string, code: string) =>
  new HTTPException(429, { message, cause: { code } });

function reasonToCode(reason: Exclude<SpawnPmSessionResult, { ok: true }>['reason']): string {
  return reason.toUpperCase().replace(/-/g, '_');
}

function detachIndex(fn: () => Promise<void>): void {
  queueMicrotask(() => {
    fn().catch((err) => {
      logger.warn({ err: (err as Error).message }, 'pm.routes: detached memory index task failed');
    });
  });
}

export const pmRoutes = new Hono<{ Variables: AuthVars }>();

/**
 * Operator endpoint — force a PM run for a project. Requires project
 * membership. Operator-cause spawns bypass both the trigger mask and the
 * `max_runs_per_hour` rate limit so a human can always force a run during
 * triage. The dedup unique index still applies — a second click while a
 * PM job is in flight returns 409.
 */
pmRoutes.post(
  '/:projectId/pm/run',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');
    const result = await spawnPmSession({
      projectId,
      cause: 'operator',
      actorUserId: userId,
    });
    if (!result.ok) {
      const code = reasonToCode(result.reason);
      if (result.reason === 'rate-limited') {
        throw tooManyRequests(result.reason, code);
      }
      throw conflict(result.reason, code);
    }
    return c.json({ ok: true, jobId: result.jobId });
  },
);

/**
 * Operator response to a PM escalation. Posts a comment on each issue the
 * decision referenced (memory indexer auto-embeds via the `commentCreated`
 * hook), marks the matching `pm_escalation` notification rows as read, and
 * spawns a follow-up PM session with `cause='operator-reply'`.
 */
pmRoutes.post(
  '/:projectId/pm/escalations/:decisionId/respond',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', respondParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', respondBody, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, decisionId } = c.req.valid('param');
    const { choice, payload, comment } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    const [decision] = await db
      .select({ id: pmDecisions.id, eventRef: pmDecisions.eventRef })
      .from(pmDecisions)
      .where(and(eq(pmDecisions.id, decisionId), eq(pmDecisions.projectId, projectId)))
      .limit(1);
    if (!decision) throw notFound('pm decision not found');

    const issueIds = extractIssueIds(decision.eventRef);

    const body = formatOperatorReply({ choice, payload, comment });
    for (const issueId of issueIds) {
      const [issue] = await db
        .select({ id: issues.id, projectId: issues.projectId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1);
      if (!issue || issue.projectId !== projectId) continue;

      const [inserted] = await db
        .insert(comments)
        .values({ issueId, authorId: userId, body, parentId: null })
        .returning({ id: comments.id, body: comments.body, parentId: comments.parentId });
      if (!inserted) continue;
      await hooks.emit('commentCreated', {
        issueId,
        projectId,
        actor: { type: 'user', id: userId },
        commentId: inserted.id,
        body: inserted.body,
        parentId: inserted.parentId,
      });
    }

    const readRows = await db
      .update(notifications)
      .set({ read: true })
      .where(
        and(
          eq(notifications.type, 'pm_escalation'),
          eq(notifications.projectId, projectId),
          eq(notifications.read, false),
          sql`(${notifications.body}::jsonb->>'decisionId') = ${decisionId}`,
        ),
      )
      .returning({ id: notifications.id, userId: notifications.userId });
    for (const row of readRows) {
      await hooks.emit('notificationRead', { notificationId: row.id, userId: row.userId });
    }

    const spawn = await spawnPmSession({
      projectId,
      cause: 'operator-reply',
      eventRef: { decisionId, choice, payload: payload ?? {} },
      actorUserId: userId,
    });

    if (!spawn.ok) {
      logger.info(
        { projectId, decisionId, reason: spawn.reason },
        'pm-respond: follow-up spawn suppressed',
      );
      return c.json({ ok: true, jobId: null, reason: spawn.reason });
    }
    return c.json({ ok: true, jobId: spawn.jobId });
  },
);

// ------------------ pm_config (Epic 6) ------------------

pmRoutes.get(
  '/:projectId/pm/config',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    const [existing] = await db
      .select()
      .from(pmConfig)
      .where(eq(pmConfig.projectId, projectId))
      .limit(1);
    if (existing) return c.json(existing);

    const [inserted] = await db
      .insert(pmConfig)
      .values({ projectId })
      .onConflictDoNothing({ target: pmConfig.projectId })
      .returning();
    if (inserted) return c.json(inserted);

    const [row] = await db
      .select()
      .from(pmConfig)
      .where(eq(pmConfig.projectId, projectId))
      .limit(1);
    if (!row) throw new HTTPException(500, { message: 'pm_config lazy-create failed' });
    return c.json(row);
  },
);

pmRoutes.put(
  '/:projectId/pm/config',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', configPatchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'project admin required');

    await db
      .insert(pmConfig)
      .values({ projectId })
      .onConflictDoNothing({ target: pmConfig.projectId });

    const [updated] = await db
      .update(pmConfig)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(pmConfig.projectId, projectId))
      .returning();
    if (!updated) throw new HTTPException(500, { message: 'pm_config update failed' });
    return c.json(updated);
  },
);

// ------------------ pm_policies (Epic 6) ------------------

pmRoutes.get(
  '/:projectId/pm/policies',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    const rows = await db
      .select({
        id: pmPolicies.id,
        projectId: pmPolicies.projectId,
        name: pmPolicies.name,
        body: pmPolicies.body,
        enabled: pmPolicies.enabled,
        priority: pmPolicies.priority,
        createdAt: pmPolicies.createdAt,
        updatedAt: pmPolicies.updatedAt,
      })
      .from(pmPolicies)
      .where(eq(pmPolicies.projectId, projectId))
      .orderBy(desc(pmPolicies.priority), desc(pmPolicies.createdAt));
    return c.json(rows);
  },
);

pmRoutes.post(
  '/:projectId/pm/policies',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', policyCreateSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const input = c.req.valid('json');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'project admin required');

    const [inserted] = await db
      .insert(pmPolicies)
      .values({
        projectId,
        name: input.name,
        body: input.body,
        enabled: input.enabled ?? true,
        priority: input.priority ?? 0,
      })
      .returning({
        id: pmPolicies.id,
        projectId: pmPolicies.projectId,
        name: pmPolicies.name,
        body: pmPolicies.body,
        enabled: pmPolicies.enabled,
        priority: pmPolicies.priority,
        createdAt: pmPolicies.createdAt,
        updatedAt: pmPolicies.updatedAt,
      });
    if (!inserted) throw new HTTPException(500, { message: 'pm_policy insert failed' });

    detachIndex(() =>
      indexMemoryBestEffort({
        projectId,
        source: 'policy',
        sourceRef: inserted.id,
        text: inserted.body,
        metadata: { name: inserted.name, priority: inserted.priority },
      }),
    );

    return c.json(inserted, 201);
  },
);

pmRoutes.patch(
  '/:projectId/pm/policies/:id',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectAndIdParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', policyPatchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'project admin required');

    const [updated] = await db
      .update(pmPolicies)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(pmPolicies.id, id), eq(pmPolicies.projectId, projectId)))
      .returning({
        id: pmPolicies.id,
        projectId: pmPolicies.projectId,
        name: pmPolicies.name,
        body: pmPolicies.body,
        enabled: pmPolicies.enabled,
        priority: pmPolicies.priority,
        createdAt: pmPolicies.createdAt,
        updatedAt: pmPolicies.updatedAt,
      });
    if (!updated) throw notFound('pm_policy not found');

    if (patch.body !== undefined || patch.name !== undefined || patch.priority !== undefined) {
      detachIndex(() =>
        indexMemoryBestEffort({
          projectId,
          source: 'policy',
          sourceRef: updated.id,
          text: updated.body,
          metadata: { name: updated.name, priority: updated.priority },
        }),
      );
    }

    return c.json(updated);
  },
);

pmRoutes.delete(
  '/:projectId/pm/policies/:id',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectAndIdParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, id } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'project admin required');

    const deleted = await db
      .delete(pmPolicies)
      .where(and(eq(pmPolicies.id, id), eq(pmPolicies.projectId, projectId)))
      .returning({ id: pmPolicies.id });
    if (deleted.length === 0) throw notFound('pm_policy not found');

    detachIndex(async () => {
      await deleteMemory(projectId, 'policy', id);
    });
    return c.body(null, 204);
  },
);

// ------------------ pm_decisions (Epic 6 read) ------------------

pmRoutes.get(
  '/:projectId/pm/decisions',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', decisionsQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { page, pageSize, cause } = c.req.valid('query');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    const conditions = [eq(pmDecisions.projectId, projectId)];
    if (cause) conditions.push(eq(pmDecisions.cause, cause));
    const where = and(...conditions);

    const [totalRow] = await db.select({ n: count() }).from(pmDecisions).where(where);
    setTotalCount(c, totalRow?.n ?? 0);

    const rows = await db
      .select({
        id: pmDecisions.id,
        projectId: pmDecisions.projectId,
        cause: pmDecisions.cause,
        summary: pmDecisions.summary,
        actions: pmDecisions.actions,
        confidence: pmDecisions.confidence,
        modelTier: pmDecisions.modelTier,
        tookMs: pmDecisions.tookMs,
        createdAt: pmDecisions.createdAt,
      })
      .from(pmDecisions)
      .where(where)
      .orderBy(desc(pmDecisions.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return c.json(rows);
  },
);

function extractIssueIds(eventRef: unknown): string[] {
  if (!eventRef || typeof eventRef !== 'object') return [];
  const raw = (eventRef as { issueIds?: unknown }).issueIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

function formatOperatorReply(input: {
  choice: string;
  payload: Record<string, unknown> | undefined;
  comment: string | undefined;
}): string {
  const lines = [`**Operator reply** — \`${input.choice}\``];
  if (input.comment) {
    lines.push('', input.comment);
  }
  if (input.payload && Object.keys(input.payload).length > 0) {
    lines.push('', '```json', JSON.stringify(input.payload, null, 2), '```');
  }
  return lines.join('\n');
}
