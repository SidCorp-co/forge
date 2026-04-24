import { zValidator } from '@hono/zod-validator';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { type IssueStatus, issueStatuses, issues, projectMembers, projects } from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  REOPEN_CAP,
  canTransition,
  getAllowedTransitions,
  isReopenEntry,
} from '../pipeline/state-machine.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

const transitionBodySchema = z
  .object({
    toStatus: z.enum(issueStatuses),
    reason: z.string().trim().min(1).max(2000).optional(),
    override: z.boolean().optional().default(false),
  })
  .strict();

const idParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = () =>
  new HTTPException(404, { message: 'issue not found', cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string, code = 'FORBIDDEN') =>
  new HTTPException(403, { message, cause: { code } });

export const transitionRoutes = new Hono<{ Variables: AuthVars }>();

transitionRoutes.use('*', requireAuth(), assertEmailVerified());

transitionRoutes.post(
  '/:id/transition',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', transitionBodySchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { toStatus, reason, override } = c.req.valid('json');
    const userId = c.get('userId');

    const [issue] = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        status: issues.status,
        reopenCount: issues.reopenCount,
      })
      .from(issues)
      .where(eq(issues.id, id))
      .limit(1);
    if (!issue) throw notFound();

    const fromStatus = issue.status as IssueStatus;

    const [member] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, issue.projectId), eq(projectMembers.userId, userId)))
      .limit(1);
    if (!member) throw forbidden('not a project member');

    if (fromStatus === toStatus) {
      throw new HTTPException(409, {
        message: 'issue already in toStatus',
        cause: { code: 'NO_OP', details: { status: fromStatus } },
      });
    }

    if (!canTransition(fromStatus, toStatus)) {
      throw new HTTPException(409, {
        message: `illegal transition from ${fromStatus} to ${toStatus}`,
        cause: {
          code: 'ILLEGAL_TRANSITION',
          details: {
            from: fromStatus,
            to: toStatus,
            allowed: getAllowedTransitions(fromStatus),
          },
        },
      });
    }

    const reopening = isReopenEntry(fromStatus, toStatus);

    if (reopening) {
      if (issue.reopenCount >= REOPEN_CAP && !override) {
        throw new HTTPException(422, {
          message: `reopen cap reached (${REOPEN_CAP})`,
          cause: {
            code: 'REOPEN_CAP_EXCEEDED',
            details: { reopenCount: issue.reopenCount, max: REOPEN_CAP },
          },
        });
      }
      if (override) {
        const [project] = await db
          .select({ ownerId: projects.ownerId })
          .from(projects)
          .where(eq(projects.id, issue.projectId))
          .limit(1);
        const isOwner = (project && project.ownerId === userId) || member.role === 'owner';
        if (!isOwner) throw forbidden('override requires project owner', 'OVERRIDE_DENIED');
      }
    }

    // Conditional UPDATE gates on current status so concurrent transitions
    // can't both win. activity_log write is owned by F5; do not insert here.
    const [updated] = await db
      .update(issues)
      .set({
        status: toStatus,
        reopenCount: reopening ? sql`${issues.reopenCount} + 1` : issues.reopenCount,
        updatedAt: sql`now()`,
      })
      .where(and(eq(issues.id, id), eq(issues.status, fromStatus)))
      .returning({
        id: issues.id,
        status: issues.status,
        reopenCount: issues.reopenCount,
        updatedAt: issues.updatedAt,
      });

    if (!updated) {
      throw new HTTPException(409, {
        message: 'issue status changed concurrently',
        cause: { code: 'STALE_TRANSITION', details: { from: fromStatus, to: toStatus } },
      });
    }

    roomManager.publish(projectRoom(issue.projectId), {
      event: 'issue.statusChanged',
      data: {
        issueId: updated.id,
        from: fromStatus,
        to: toStatus,
        reopenCount: updated.reopenCount,
        actorId: userId,
        reason: reason ?? null,
        at: updated.updatedAt,
      },
    });

    return c.json({
      id: updated.id,
      status: updated.status,
      reopenCount: updated.reopenCount,
      transitionedAt: updated.updatedAt,
    });
  },
);
