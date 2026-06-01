import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import {
  projectInvitations,
  projectMemberRoles,
  projectMembers,
  projects,
  users,
} from '../db/schema.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { sendInvitationEmail } from './invitation-email.js';
import { issueInvitationToken } from './invitation-token.js';

// Subset of projectMemberRoles usable as invite target / role assignment.
// 'owner' is reserved for project creation / dedicated transfer flow.
const assignableRoles = projectMemberRoles.filter((r) => r !== 'owner') as Array<
  Exclude<(typeof projectMemberRoles)[number], 'owner'>
>;

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: z.enum(assignableRoles as [string, ...string[]]),
});

const patchRoleSchema = z.object({
  role: z.enum(assignableRoles as [string, ...string[]]),
});

const projectParamSchema = z.object({ projectId: z.uuid() });
const memberParamSchema = z.object({ projectId: z.uuid(), userId: z.uuid() });

// Revoke targets a pending invitation by email (query param, not path — avoids
// putting an `@`/`.`-laden email in the URL path).
const revokeInvitationQuerySchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, {
    message: 'Invalid input',
    cause: { code: 'BAD_REQUEST', details },
  });

const notFound = (code = 'NOT_FOUND', message = 'not found') =>
  new HTTPException(404, { message, cause: { code } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

async function loadProjectAndCallerRole(projectId: string, userId: string) {
  const [project] = await db
    .select({ id: projects.id, name: projects.name, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw notFound('NOT_FOUND', 'project not found');

  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);

  return { project, role: member?.role ?? null };
}

function isOwner(role: string | null, project: { ownerId: string }, userId: string) {
  return role === 'owner' || project.ownerId === userId;
}

function isOwnerOrAdmin(role: string | null, project: { ownerId: string }, userId: string) {
  return isOwner(role, project, userId) || role === 'admin';
}

export const memberRoutes = new Hono<{ Variables: AuthVars }>();

memberRoutes.use('*', requireAuth(), assertEmailVerified());

memberRoutes.get(
  '/:projectId/members',
  zValidator('param', projectParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const { project, role } = await loadProjectAndCallerRole(projectId, userId);
    if (!role && project.ownerId !== userId) throw forbidden('not a project member');

    const rows = await db
      .select({
        userId: projectMembers.userId,
        email: users.email,
        role: projectMembers.role,
        createdAt: projectMembers.createdAt,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId));

    return c.json(rows);
  },
);

memberRoutes.get(
  '/:projectId/members/invitations',
  zValidator('param', projectParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const { project, role } = await loadProjectAndCallerRole(projectId, userId);
    if (!isOwnerOrAdmin(role, project, userId)) {
      throw forbidden('requires owner or admin');
    }

    const rows = await db
      .select({
        email: projectInvitations.email,
        role: projectInvitations.role,
        expiresAt: projectInvitations.expiresAt,
        createdAt: projectInvitations.createdAt,
        inviterEmail: users.email,
      })
      .from(projectInvitations)
      .innerJoin(users, eq(users.id, projectInvitations.inviterId))
      .where(
        and(eq(projectInvitations.projectId, projectId), isNull(projectInvitations.acceptedAt)),
      );

    // Never leak `token` (the accept secret / PK). Surface an `expired` flag so
    // the UI can hint at stale invites that are still cancellable.
    const now = Date.now();
    return c.json(
      rows.map((r) => ({ ...r, expired: new Date(r.expiresAt).getTime() < now })),
    );
  },
);

memberRoutes.post(
  '/:projectId/members/invite',
  zValidator('param', projectParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', inviteSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { email, role } = c.req.valid('json') as {
      email: string;
      role: (typeof assignableRoles)[number];
    };
    const inviterId = c.get('userId');

    const { project, role: callerRole } = await loadProjectAndCallerRole(projectId, inviterId);
    if (!isOwnerOrAdmin(callerRole, project, inviterId)) {
      throw forbidden('requires owner or admin');
    }

    const [inviter] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, inviterId))
      .limit(1);
    if (!inviter) throw forbidden('inviter not found');

    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existingUser) {
      const [existingMember] = await db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, existingUser.id)),
        )
        .limit(1);
      if (existingMember) {
        throw new HTTPException(409, {
          message: 'user is already a member',
          cause: { code: 'ALREADY_MEMBER' },
        });
      }
    }

    const { token, expiresAt } = await issueInvitationToken({
      projectId,
      inviterId,
      email,
      role,
    });

    try {
      await sendInvitationEmail(email, {
        projectName: project.name,
        inviterEmail: inviter.email,
        token,
      });
    } catch (sendErr) {
      logger.error({ err: sendErr, projectId, email }, 'failed to send project invitation email');
    }

    const body: { expiresAt: Date; token?: string } = { expiresAt };
    if (env.SMTP_DEBUG || env.NODE_ENV === 'test') {
      body.token = token;
    }
    return c.json(body, 201);
  },
);

memberRoutes.patch(
  '/:projectId/members/:userId',
  zValidator('param', memberParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', patchRoleSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { projectId, userId: targetUserId } = c.req.valid('param');
    const { role } = c.req.valid('json') as { role: (typeof assignableRoles)[number] };
    const callerId = c.get('userId');

    const { project, role: callerRole } = await loadProjectAndCallerRole(projectId, callerId);
    if (!isOwner(callerRole, project, callerId)) {
      throw forbidden('not a project owner');
    }

    const [target] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)))
      .limit(1);
    if (!target) throw notFound('NOT_FOUND', 'membership not found');

    if (target.role === 'owner' || project.ownerId === targetUserId) {
      throw new HTTPException(409, {
        message: 'cannot change owner role',
        cause: { code: 'OWNER_ROLE_IMMUTABLE', hint: 'transfer ownership first' },
      });
    }

    const [updated] = await db
      .update(projectMembers)
      .set({ role })
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)))
      .returning({
        userId: projectMembers.userId,
        projectId: projectMembers.projectId,
        role: projectMembers.role,
        createdAt: projectMembers.createdAt,
      });
    if (!updated) throw notFound('NOT_FOUND', 'membership not found');

    return c.json(updated);
  },
);

memberRoutes.delete(
  '/:projectId/members/invitations',
  zValidator('param', projectParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('query', revokeInvitationQuerySchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { email } = c.req.valid('query');
    const callerId = c.get('userId');

    const { project, role: callerRole } = await loadProjectAndCallerRole(projectId, callerId);
    if (!isOwnerOrAdmin(callerRole, project, callerId)) {
      throw forbidden('requires owner or admin');
    }

    const deleted = await db
      .delete(projectInvitations)
      .where(
        and(
          eq(projectInvitations.projectId, projectId),
          eq(projectInvitations.email, email),
          isNull(projectInvitations.acceptedAt),
        ),
      )
      .returning({ token: projectInvitations.token });
    if (deleted.length === 0) throw notFound('INVITATION_NOT_FOUND', 'pending invitation not found');

    return c.body(null, 204);
  },
);

memberRoutes.delete(
  '/:projectId/members/:userId',
  zValidator('param', memberParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { projectId, userId: targetUserId } = c.req.valid('param');
    const callerId = c.get('userId');

    const { project, role: callerRole } = await loadProjectAndCallerRole(projectId, callerId);
    const selfLeave = targetUserId === callerId;
    if (!selfLeave && !isOwner(callerRole, project, callerId)) {
      throw forbidden('not a project owner');
    }

    const [target] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)))
      .limit(1);
    if (!target) throw notFound('NOT_FOUND', 'membership not found');

    if (target.role === 'owner' || project.ownerId === targetUserId) {
      throw new HTTPException(409, {
        message: 'cannot remove project owner',
        cause: { code: 'OWNER_REMOVAL_BLOCKED', hint: 'transfer ownership first' },
      });
    }

    await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)));

    return c.body(null, 204);
  },
);
