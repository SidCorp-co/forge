import type { PmRefusalCode } from '@forge/contracts/pm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { postIssueNotice } from '../comments/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { fromPage, listResponse } from '../lib/pagination.js';
import { refuser } from '../lib/refusal.js';
import { deleteMemory, indexMemoryBestEffort } from '../memory/indexer.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  restActor,
  restAuthored,
} from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { closeEscalationTasks } from '../notifications/close-escalation.js';
import { logger } from '../observability/logger.js';
import { requireHeld } from '../permissions/index.js';
import { decisionInProject, issueIsInProject, listPmDecisions, listPmPolicies } from './read.js';
import {
  createPmPolicy,
  deletePmPolicy,
  ensurePmConfig,
  updatePmConfig,
  updatePmPolicy,
} from './service.js';
import { PM_NO_PROMPT_MESSAGE, type SpawnPmSessionResult, spawnPmSession } from './spawner.js';

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

const refuse = refuser<PmRefusalCode>('PM_REFUSED');

const SPAWN_REFUSALS = {
  disabled: ['DISABLED', 'PM is disabled for this project; enable it in the project settings.'],
  'trigger-masked': ['TRIGGER_MASKED', 'this trigger is masked in the project PM settings.'],
  'pool-job-no-prompt': ['POOL_JOB_NO_PROMPT', PM_NO_PROMPT_MESSAGE],
} as const satisfies Record<string, readonly [PmRefusalCode, string]>;

/** A refused operator spawn: a rate limit is transport 429, every other guard the envelope. */
function spawnRefusal(reason: Exclude<SpawnPmSessionResult, { ok: true }>['reason']) {
  if (reason === 'rate-limited') {
    return new HTTPException(429, { message: reason, cause: { code: 'RATE_LIMITED' } });
  }
  const [code, detail] = SPAWN_REFUSALS[reason];
  return refuse(code, detail);
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
 * PM job is in flight is refused.
 */
pmRoutes.post(
  '/:projectId/pm/run',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.write');
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
 * decision referenced (memory indexer auto-embeds via the `comment.created`
 * event), marks the matching `pm_escalation` notification rows as read, and
 * spawns a follow-up PM session with `cause='operator-reply'`.
 */
pmRoutes.post(
  '/:projectId/pm/escalations/:decisionId/respond',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', respondParam, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', respondBody, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId, decisionId } = c.req.valid('param');
    const { choice, payload, comment } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.write');

    const decision = await decisionInProject(projectId, decisionId);
    if (!decision) throw notFound('pm decision not found');

    const issueIds = extractIssueIds(decision.eventRef);

    const body = formatOperatorReply({ choice, payload, comment });
    for (const issueId of issueIds) {
      if (!(await issueIsInProject(issueId, projectId))) continue;

      await postIssueNotice({
        issueId,
        authorId: userId,
        body,
        intent: 'decision',
        announce: { actor: restActor(c), authored: restAuthored(c) },
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
      return c.json({ ok: true, jobId: null, reason: spawn.reason });
    }
    return c.json({ ok: true, jobId: spawn.jobId });
  },
);

pmRoutes.get(
  '/:projectId/pm/config',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const row = await ensurePmConfig(projectId);
    if (!row) throw new HTTPException(500, { message: 'pm_config lazy-create failed' });
    return c.json(row);
  },
);

pmRoutes.put(
  '/:projectId/pm/config',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', configPatchSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.admin');

    const updated = await updatePmConfig(projectId, patch);
    if (!updated) throw new HTTPException(500, { message: 'pm_config update failed' });
    return c.json(updated);
  },
);

pmRoutes.get(
  '/:projectId/pm/policies',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    return c.json(await listPmPolicies(projectId));
  },
);

pmRoutes.post(
  '/:projectId/pm/policies',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', policyCreateSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const input = c.req.valid('json');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.admin');

    const inserted = await createPmPolicy(projectId, input);
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
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', policyPatchSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId, id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.admin');

    const updated = await updatePmPolicy(projectId, id, patch);
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
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId, id } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.admin');

    if (!(await deletePmPolicy(projectId, id))) throw notFound('pm_policy not found');

    detachIndex(async () => {
      await deleteMemory(projectId, 'policy', id);
    });
    return c.body(null, 204);
  },
);

pmRoutes.get(
  '/:projectId/pm/decisions',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', projectIdParam, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', decisionsQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { page, pageSize, cause } = c.req.valid('query');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const { rows, total } = await listPmDecisions(projectId, { cause, page, pageSize });
    return c.json(listResponse(c, rows, total, fromPage(page, pageSize)));
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

export { pmReadRoutes } from './read-routes.js';
