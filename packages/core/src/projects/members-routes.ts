import { PROJECT_PERMISSIONS, type ProjectPermission } from '@forge/contracts/permissions';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import { projectMemberRoles } from '../db/schema.js';
import { loadOrgRole, loadProjectAccess } from '../lib/authz.js';
import { RefusalError } from '../lib/refusal.js';
import {
  type AuthVars,
  assertEmailVerified,
  readAuthUser,
  requireAuth,
} from '../middleware/auth.js';
import { badRequest, forbidden } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { logger } from '../observability/logger.js';
import { requireHeld } from '../permissions/index.js';
import { sendInvitationEmail } from './invitation-email.js';
import { issueInvitationToken } from './invitation-token.js';
import {
  accountIdByEmail,
  listPendingProjectInvitations,
  listProjectMembers,
  projectMemberRole,
  projectName,
} from './read.js';
import { projectsPorts } from './ports.js';
import { refuse } from './refuse.js';
import {
  addProjectMemberIfAbsent,
  changeProjectMember,
  dropProjectMember,
  revokeProjectInvitation,
} from './service.js';

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
    if (!result.success) throw badRequest(result.error);
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
    return c.json(await listProjectMembers(projectId));
  },
);

memberRoutes.get(
  '/:projectId/members/invitations',
  zValidator('param', projectParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'members.admin');

    const rows = await listPendingProjectInvitations(projectId);

    // Never leak `token` (the accept secret / PK). Surface an `expired` flag so
    // the UI can hint at stale invites that are still cancellable.
    const now = Date.now();
    return c.json(rows.map((r) => ({ ...r, expired: new Date(r.expiresAt).getTime() < now })));
  },
);

memberRoutes.post(
  '/:projectId/members',
  zValidator('param', projectParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  zValidator('json', directAddSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
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
      throw refuse(
        'NOT_ORG_MEMBER',
        'this user is not a member of the org, so they are added by email invitation, not directly',
        '/userId',
      );
    }

    const inserted = await addProjectMemberIfAbsent(projectId, targetUserId, role);
    if (!inserted)
      throw refuse('ALREADY_MEMBER', 'this user is already a member of the project', '/userId');

    const target = await readAuthUser(targetUserId);
    return c.json(
      {
        userId: inserted.userId,
        projectId: inserted.projectId,
        role: inserted.role,
        createdAt: inserted.createdAt,
        email: target?.email ?? null,
      },
      201,
    );
  },
);

memberRoutes.post(
  '/:projectId/members/invite',
  zValidator('param', projectParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  zValidator('json', inviteSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
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
    const name = await projectName(projectId);
    if (name === null) throw notFound('NOT_FOUND', 'project not found');
    const project = { name };

    const inviter = await readAuthUser(inviterId);
    if (!inviter) throw forbidden('inviter not found');

    const existingUserId = await accountIdByEmail(email);

    if (existingUserId) {
      if ((await projectMemberRole(projectId, existingUserId)) !== null) {
        throw refuse(
          'ALREADY_MEMBER',
          'a user with this email is already a member of the project',
          '/email',
        );
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
    if (existingUserId) {
      try {
        await projectsPorts().notifyInvitee({
          userId: existingUserId,
          projectId,
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
    if (!result.success) throw badRequest(result.error);
  }),
  zValidator('json', patchMemberSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { projectId, userId: targetUserId } = c.req.valid('param');
    const { role, grants } = c.req.valid('json');
    const callerId = c.get('userId');

    const access = await loadProjectAccess(projectId, callerId);
    requireHeld(access, 'members.admin');
    const refused = grantRefusals(grants ?? []);
    if (refused.length > 0) throw new RefusalError(refused, 'MEMBER_GRANT_UNKNOWN_PERMISSION');

    if ((await projectMemberRole(projectId, targetUserId)) === null)
      throw notFound('NOT_FOUND', 'membership not found');

    const updated = await changeProjectMember(projectId, targetUserId, {
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
    if (!result.success) throw badRequest(result.error);
  }),
  zValidator('query', revokeInvitationQuerySchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { email } = c.req.valid('query');
    const callerId = c.get('userId');

    const access = await loadProjectAccess(projectId, callerId);
    requireHeld(access, 'members.admin');

    if (!(await revokeProjectInvitation(projectId, email)))
      throw notFound('INVITATION_NOT_FOUND', 'pending invitation not found');

    return c.body(null, 204);
  },
);

memberRoutes.delete(
  '/:projectId/members/:userId',
  zValidator('param', memberParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { projectId, userId: targetUserId } = c.req.valid('param');
    const callerId = c.get('userId');

    const access = await loadProjectAccess(projectId, callerId);
    const selfLeave = targetUserId === callerId;
    if (!selfLeave) {
      requireHeld(access, 'members.admin');
    }

    if ((await projectMemberRole(projectId, targetUserId)) === null)
      throw notFound('NOT_FOUND', 'membership not found');

    await dropProjectMember(projectId, targetUserId);

    return c.body(null, 204);
  },
);
