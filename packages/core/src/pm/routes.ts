import { redactedMessage } from '@forge/observability';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { db } from '../db/client.js';
import { issues, pmConfig, pmDecisions, pmPolicies } from '../db/schema.js';
import { assertRoleFor, loadProjectAccess } from '../lib/authz.js';
import { fromPage, listResponse } from '../lib/pagination.js';
import { logger } from '../logger.js';
import { deleteMemory, indexMemoryBestEffort } from '../memory/indexer.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  restActor,
  restAuthored,
} from '../middleware/auth.js';
import { closeEscalationTasks } from '../notifications/close-escalation.js';
import { hooks } from '../pipeline/hooks.js';
import { postOperatorReply } from './decisions-service.js';
import {
  configPatchSchema,
  createPolicy,
  decisionListSchema,
  decisionsQuerySchema,
  deletePolicy,
  listDecisions,
  listPolicies,
  pmConfigSchema,
  policyCreateSchema,
  policyListSchema,
  policyPatchSchema,
  policySchema,
  readPmConfig,
  respondBody,
  respondEscalation,
  respondedSchema,
  runPm,
  updatePmConfig,
  updatePolicy,
} from './routes-reference.js';
import { PM_NO_PROMPT_MESSAGE, type SpawnPmSessionResult, spawnPmSession } from './spawner.js';

const projectIdParam = z.object({ projectId: z.uuid() });

const projectAndIdParam = z.object({ projectId: z.uuid(), id: z.uuid() });

const respondParam = z.object({ projectId: z.uuid(), decisionId: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

/** A refused operator spawn: rate limit 429, no pool prompt 422, every other guard 409. */
function spawnRefusal(reason: SpawnRefusalReason) {
  const status = reason === 'rate-limited' ? 429 : reason === 'pool-job-no-prompt' ? 422 : 409;
  const message = reason === 'pool-job-no-prompt' ? PM_NO_PROMPT_MESSAGE : reason;
  return new HTTPException(status, { message, cause: { code: SPAWN_REFUSAL_CODES[reason] } });
}

type SpawnRefusalReason = Exclude<SpawnPmSessionResult, { ok: true }>['reason'];

const SPAWN_REFUSAL_CODES: Record<SpawnRefusalReason, string> = {
  disabled: 'DISABLED',
  'trigger-masked': 'TRIGGER_MASKED',
  'rate-limited': 'RATE_LIMITED',
  'pool-job-no-prompt': 'POOL_JOB_NO_PROMPT',
};

function detachIndex(fn: () => Promise<void>): void {
  queueMicrotask(() => {
    fn().catch((err) => {
      logger.warn({ err: redactedMessage(err) }, 'pm.routes: detached memory index task failed');
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
  runPm,
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertRoleFor(access, 'member', 'run its project manager');
    const result = await spawnPmSession({
      projectId,
      cause: 'operator',
      actorUserId: userId,
    });
    if (!result.ok) {
      throw spawnRefusal(result.reason);
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
  respondEscalation,
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
    assertRoleFor(access, 'member', "answer its project manager's escalations");

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

      const inserted = await postOperatorReply({ issueId, userId, body });
      if (!inserted) continue;
      await hooks.emit('commentCreated', {
        issueId,
        projectId,
        actor: restActor(c),
        authored: restAuthored(c),
        commentId: inserted.id,
        body: inserted.body,
        parentId: inserted.parentId,
      });
    }

    await closeEscalationTasks(projectId, decisionId);

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
      return c.json(answer(respondedSchema, { ok: true, jobId: null, reason: spawn.reason }));
    }
    return c.json(answer(respondedSchema, { ok: true, jobId: spawn.jobId }));
  },
);

pmRoutes.get(
  '/:projectId/pm/config',
  readPmConfig,
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertRoleFor(access, 'viewer', "read its project manager's settings");

    const [existing] = await db
      .select()
      .from(pmConfig)
      .where(eq(pmConfig.projectId, projectId))
      .limit(1);
    if (existing) return c.json(answer(pmConfigSchema, existing));

    const [inserted] = await db
      .insert(pmConfig)
      .values({ projectId })
      .onConflictDoNothing({ target: pmConfig.projectId })
      .returning();
    if (inserted) return c.json(answer(pmConfigSchema, inserted));

    const [row] = await db
      .select()
      .from(pmConfig)
      .where(eq(pmConfig.projectId, projectId))
      .limit(1);
    if (!row) throw new HTTPException(500, { message: 'pm_config lazy-create failed' });
    return c.json(answer(pmConfigSchema, row));
  },
);

pmRoutes.put(
  '/:projectId/pm/config',
  updatePmConfig,
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
    assertRoleFor(access, 'admin', "change its project manager's settings");

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
    return c.json(answer(pmConfigSchema, updated));
  },
);

pmRoutes.get(
  '/:projectId/pm/policies',
  listPolicies,
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertRoleFor(access, 'viewer', "read its project manager's policies");

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
    return c.json(answer(policyListSchema, rows));
  },
);

pmRoutes.post(
  '/:projectId/pm/policies',
  createPolicy,
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
    assertRoleFor(access, 'admin', 'add a project manager policy to it');

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

    return c.json(answer(policySchema, inserted), 201);
  },
);

pmRoutes.patch(
  '/:projectId/pm/policies/:id',
  updatePolicy,
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
    assertRoleFor(access, 'admin', "change its project manager's policies");

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

    return c.json(answer(policySchema, updated));
  },
);

pmRoutes.delete(
  '/:projectId/pm/policies/:id',
  deletePolicy,
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectAndIdParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, id } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertRoleFor(access, 'admin', "delete its project manager's policies");

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

pmRoutes.get(
  '/:projectId/pm/decisions',
  listDecisions,
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
    assertRoleFor(access, 'viewer', "read its project manager's decisions");

    const conditions = [eq(pmDecisions.projectId, projectId)];
    if (cause) conditions.push(eq(pmDecisions.cause, cause));
    const where = and(...conditions);

    const [totalRow] = await db.select({ n: count() }).from(pmDecisions).where(where);

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

    return c.json(
      answer(decisionListSchema, listResponse(c, rows, totalRow?.n ?? 0, fromPage(page, pageSize))),
    );
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
