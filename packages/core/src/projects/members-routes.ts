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
import { PROJECT_PERMISSIONS, type ProjectPermission } from '@forge/contracts/permissions';
import { loadOrgRole, loadProjectAccess } from '../lib/authz.js';
import { RefusalError } from '../lib/refusal.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest, forbidden } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { emitNotification } from '../notifications/emit.js';
import {
  addProjectMembers,
  removeProjectMember,
  requireHeld,
  updateProjectMember,
} from '../permissions/index.js';
import { sendInvitationEmail } from './invitation-email.js';
import { issueInvitationToken } from './invitation-token.js';

// Every project role is assignable (admin|member|viewer) — there is no
// project 'owner' anymore; the org tier carries ownership.
const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: z.enum(projectMemberRoles),
});

// Direct-add (no email-token round trip) — only for users who are ALREADY a
// member of the project's org; everyone else goes through the invite flow.
const directAddSchema = z.object({
  userId: z.uuid(),
  role: z.enum(projectMemberRoles),
});

// `grants` replaces the membership's grant whole: the permissions it holds on this project beyond
// its role, each a name from `@forge/contracts/permissions:PROJECT_PERMISSIONS`.
const patchMemberSchema = z
  .object({
    role: z.enum(projectMemberRoles).optional(),
    grants: z.array(z.string()).optional(),
  })
  .refine((b) => b.role !== undefined || b.grants !== undefined, {
    message: 'send role, grants or both',
  });

function grantRefusals(grants: readonly string[]) {
  return grants.flatMap((g, i) =>
    (PROJECT_PERMISSIONS as readonly string[]).includes(g)
      ? []
      : [
          {
            code: 'MEMBER_GRANT_UNKNOWN_PERMISSION',
            path: `/grants/${i}`,
            detail: `"${g}" is not a project permission; a grant names permissions from: ${PROJECT_PERMISSIONS.join(', ')}.`,
          },
        ],
  );
}

const projectParamSchema = z.object({ projectId: z.uuid() });
const memberParamSchema = z.object({ projectId: z.uuid(), userId: z.uuid() });

// Revoke targets a pending invitation by email (query param, not path — avoids
// putting an `@`/`.`-laden email in the URL path).
const revokeInvitationQuerySchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
});

const notFound = (code = 'NOT_FOUND', message = 'not found') =>
  new HTTPException(404, { message, cause: { code } });

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

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    // `kind` and `displayName` are here because an agent account IS a project
    // member (ISS-932) and a reader that is only told its synthesized address
    // cannot name it (ISS-1137) — which is why the issue list's creator filter
    // offered every agent as a fake person for as long as it did.
    const rows = await db
      .select({
        userId: projectMembers.userId,
        email: users.email,
        displayName: users.displayName,
        kind: users.kind,
        role: projectMembers.role,
        grants: projectMembers.grants,
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

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'members.admin');

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
    return c.json(rows.map((r) => ({ ...r, expired: new Date(r.expiresAt).getTime() < now })));
  },
);

memberRoutes.post(
  '/:projectId/members',
  zValidator('param', projectParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', directAddSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { userId: targetUserId, role } = c.req.valid('json');
    const callerId = c.get('userId');

    const access = await loadProjectAccess(projectId, callerId);
    requireHeld(access, 'members.admin');

    // Same-org guard: direct-add skips the email handshake, which is only
    // safe for someone the org has already vetted.
    const targetOrgRole = await loadOrgRole(access.orgId, targetUserId);
    if (!targetOrgRole) {
      throw new HTTPException(409, {
        message: 'user is not a member of this org — use the email invite',
        cause: { code: 'NOT_ORG_MEMBER' },
      });
    }

    const [inserted] = await addProjectMembers(db, [{ userId: targetUserId, projectId, role }], {
      ifAbsent: true,
    });
    if (!inserted) {
      throw new HTTPException(409, {
        message: 'user is already a member',
        cause: { code: 'ALREADY_MEMBER' },
      });
    }

    const [email] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);
    return c.json(
      {
        userId: inserted.userId,
        projectId: inserted.projectId,
        role: inserted.role,
        createdAt: inserted.createdAt,
        email: email?.email ?? null,
      },
      201,
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
      role: (typeof projectMemberRoles)[number];
    };
    const inviterId = c.get('userId');

    const access = await loadProjectAccess(projectId, inviterId);
    requireHeld(access, 'members.admin');
    const [project] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw notFound('NOT_FOUND', 'project not found');

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

    // ISS-597: notify registered invitees in-app so they see the invite
    // in the bell without needing the email. Unregistered users (no userId
    // FK) get email only — the pending list surfaces the invite once they sign up.
    if (existingUser) {
      try {
        await emitNotification({
          userId: existingUser.id,
          projectId,
          type: 'invitation_received',
          title: `${inviter.email} invited you to ${project.name} as ${role}`,
        });
      } catch (notifyErr) {
        logger.error({ err: notifyErr, projectId, email }, 'failed to emit invitation_received');
      }
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
  zValidator('json', patchMemberSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { projectId, userId: targetUserId } = c.req.valid('param');
    const { role, grants } = c.req.valid('json');
    const callerId = c.get('userId');

    const access = await loadProjectAccess(projectId, callerId);
    requireHeld(access, 'members.admin');
    const refused = grantRefusals(grants ?? []);
    if (refused.length > 0) throw new RefusalError(refused, 'MEMBER_GRANT_UNKNOWN_PERMISSION');

    const [target] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)))
      .limit(1);
    if (!target) throw notFound('NOT_FOUND', 'membership not found');

    const updated = await updateProjectMember(db, projectId, targetUserId, {
      role,
      grants: grants as ProjectPermission[] | undefined,
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

    const access = await loadProjectAccess(projectId, callerId);
    requireHeld(access, 'members.admin');

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
    if (deleted.length === 0)
      throw notFound('INVITATION_NOT_FOUND', 'pending invitation not found');

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

    const access = await loadProjectAccess(projectId, callerId);
    const selfLeave = targetUserId === callerId;
    if (!selfLeave) {
      requireHeld(access, 'members.admin');
    }

    const [target] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)))
      .limit(1);
    if (!target) throw notFound('NOT_FOUND', 'membership not found');

    await removeProjectMember(db, projectId, targetUserId);

    return c.body(null, 204);
  },
);
