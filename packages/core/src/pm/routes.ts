import { zValidator } from '@hono/zod-validator';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { comments, issues, notifications, pmDecisions } from '../db/schema.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { type SpawnPmSessionResult, spawnPmSession } from './spawner.js';

const projectIdParam = z.object({ projectId: z.uuid() });

const respondParam = z.object({ projectId: z.uuid(), decisionId: z.uuid() });

const respondBody = z
  .object({
    choice: z.enum(['approve', 'defer', 'reassign', 'reject', 'free_text']),
    payload: z.record(z.string(), z.unknown()).optional(),
    comment: z.string().max(10_000).optional(),
  })
  .strict();

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const conflict = (message: string, code: string) =>
  new HTTPException(409, { message, cause: { code } });

const tooManyRequests = (message: string, code: string) =>
  new HTTPException(429, { message, cause: { code } });

function reasonToCode(reason: Exclude<SpawnPmSessionResult, { ok: true }>['reason']): string {
  return reason.toUpperCase().replace(/-/g, '_');
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
    if (!access.role && access.ownerId !== userId) {
      throw forbidden('not a project member');
    }
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
 *
 * The follow-up spawn always goes through `spawnPmSession` so the gate /
 * rate-limit / dedup guards apply consistently. Operator-reply spawns
 * bypass the rate limit (per spawner config) — matching the operator
 * /run endpoint's intent that humans can always force a turn.
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
    if (!access.role && access.ownerId !== userId) {
      throw forbidden('not a project member');
    }

    const [decision] = await db
      .select({ id: pmDecisions.id, eventRef: pmDecisions.eventRef })
      .from(pmDecisions)
      .where(and(eq(pmDecisions.id, decisionId), eq(pmDecisions.projectId, projectId)))
      .limit(1);
    if (!decision) throw notFound('pm decision not found');

    const issueIds = extractIssueIds(decision.eventRef);

    const body = formatOperatorReply({ choice, payload, comment });
    for (const issueId of issueIds) {
      // Verify the issue still belongs to this project before commenting —
      // a stale event_ref could otherwise leak comments cross-project.
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

    // Mark every escalation notification for this decision as read. Body is
    // the JSON envelope written by `forge_pm.escalate`; we cast to jsonb to
    // extract `decisionId`. Multiple rows possible if the same escalation
    // was re-broadcast (defensive — current escalate writes one).
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
      // The reply itself succeeded (comments + notifications) — surface the
      // suppression reason so the UI can warn rather than 500. Disabled /
      // already-active are legitimate operator-visible states.
      logger.info(
        { projectId, decisionId, reason: spawn.reason },
        'pm-respond: follow-up spawn suppressed',
      );
      return c.json({ ok: true, jobId: null, reason: spawn.reason });
    }
    return c.json({ ok: true, jobId: spawn.jobId });
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
