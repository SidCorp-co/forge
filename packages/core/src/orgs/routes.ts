import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import { memberLenses, orgMemberRoles } from '../db/schema.js';
import { mailDeliveryEnabled, sendMail } from '../integrations/mail/index.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { buildInvitationLink, escapeInvitationHtml } from '../lib/invitation.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { logger } from '../observability/logger.js';
import { actorFor, orgResource, requireOrgCan, requireOrgHeld } from '../permissions/index.js';
import { agentAccountRoutes } from './agent-accounts-routes.js';
import { issueOrgInvitationToken } from './invitations.js';
import {
  listOrgProjects,
  listPendingOrgInvitations,
  orgInvitationContext,
  orgMemberRole,
  orgOwnerCount,
  orgProjectCount,
  userIdByEmail,
} from './read.js';
import { refuse } from './refuse.js';
import {
  addExistingOrgMember,
  changeOrgMember,
  createTeamOrg,
  deleteOrg,
  dropOrgMember,
  isPersonalOrg,
  listOrgMembers,
  listOrgsForUser,
  revokeOrgInvitation,
  updateOrg,
} from './service.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message = 'not found', code = 'NOT_FOUND') =>
  new HTTPException(404, { message, cause: { code } });

const createOrgSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, or hyphens')
    .min(3)
    .max(64),
  name: z.string().trim().min(1).max(200),
});

const patchOrgSchema = z
  .object({ name: z.string().trim().min(1).max(200).optional() })
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: z.enum(orgMemberRoles),
});

// Both fields optional; at least one required. `role` = permission change (with
// owner-tier guards below); `lenses` = soft working-lens assignment (ISS
// role-aware chat) — orthogonal, deduped, no permission effect.
const patchMemberSchema = z
  .object({
    role: z.enum(orgMemberRoles).optional(),
    lenses: z.array(z.enum(memberLenses)).max(memberLenses.length).optional(),
  })
  .refine((o) => o.role !== undefined || o.lenses !== undefined, {
    message: 'role or lenses required',
  });

const orgParamSchema = z.object({ orgId: z.uuid() });
const memberParamSchema = z.object({ orgId: z.uuid(), userId: z.uuid() });

export const orgRoutes = new Hono<{ Variables: AuthVars }>();

orgRoutes.use('*', requireAuth(), assertEmailVerified());

// My orgs + my role. The personal org is included (isPersonal flag lets the
// UI pin/sort it).
orgRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  return c.json(await listOrgsForUser(userId));
});

orgRoutes.post(
  '/',
  zValidator('json', createOrgSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { slug, name } = c.req.valid('json');
    const userId = c.get('userId');
    try {
      const created = await createTeamOrg(userId, { slug, name });
      return c.json({ ...created, role: 'owner' as const }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw refuse('SLUG_TAKEN', 'this org slug is already taken; pick another', '/slug');
      }
      throw err;
    }
  },
);

orgRoutes.patch(
  '/:orgId',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  zValidator('json', patchOrgSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    await requireOrgCan(actorFor(userId), 'org.own', orgResource(orgId));

    const updated = await updateOrg(orgId, patch);
    if (!updated) throw notFound('organization not found');
    return c.json(updated);
  },
);

// Delete a TEAM org: owner-only, refused while any project still lives in it
// (move or delete projects first) and always refused for personal orgs.
orgRoutes.delete(
  '/:orgId',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const userId = c.get('userId');

    await requireOrgCan(actorFor(userId), 'org.own', orgResource(orgId));
    if (await isPersonalOrg(orgId)) {
      throw refuse('PERSONAL_ORG_IMMUTABLE', 'a personal org cannot be deleted');
    }
    if ((await orgProjectCount(orgId)) > 0) {
      throw refuse(
        'ORG_NOT_EMPTY',
        'the org still has projects; delete or move its projects first',
      );
    }

    await deleteOrg(orgId);
    return c.body(null, 204);
  },
);

// In-org transparency: any org member can SEE which projects the org holds
// (name+slug only) — access to a project's content still requires an
// effective role on it.
orgRoutes.get(
  '/:orgId/projects',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const userId = c.get('userId');

    await requireOrgCan(actorFor(userId), 'org.read', orgResource(orgId));

    return c.json(await listOrgProjects(orgId));
  },
);

orgRoutes.get(
  '/:orgId/members',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const userId = c.get('userId');

    await requireOrgCan(actorFor(userId), 'org.read', orgResource(orgId));

    return c.json(await listOrgMembers(orgId));
  },
);

// Direct-add an EXISTING user by email (v1 — no email-token flow at the org
// tier; project invitations keep theirs). Granting `owner` requires owner.
orgRoutes.post(
  '/:orgId/members',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  zValidator('json', addMemberSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const { email, role } = c.req.valid('json');
    const callerId = c.get('userId');

    const caller = await requireOrgCan(actorFor(callerId), 'org.admin', orgResource(orgId));
    if (role === 'owner') requireOrgHeld(orgId, caller.role, 'org.own');
    if (await isPersonalOrg(orgId)) {
      throw refuse('PERSONAL_ORG_IMMUTABLE', 'a personal org cannot have additional members');
    }

    const targetId = await userIdByEmail(email);

    // No account yet → fall back to an email-token invitation (accepting
    // after signup inserts the membership). 'owner' is never invitable.
    if (!targetId) {
      if (role === 'owner') {
        throw refuse(
          'OWNER_NOT_INVITABLE',
          'the owner role cannot be granted by email invitation; invite as admin and promote once they join',
          '/role',
        );
      }
      const invite = await orgInvitationContext(orgId, callerId);
      const { token, expiresAt } = await issueOrgInvitationToken({
        orgId,
        inviterId: callerId,
        email,
        role,
      });
      try {
        await sendOrgInvitationEmail(email, {
          orgName: invite.orgName ?? 'an organization',
          inviterEmail: invite.inviterEmail ?? 'a teammate',
          token,
        });
      } catch (sendErr) {
        logger.error({ err: sendErr, orgId, email }, 'failed to send org invitation email');
      }
      const body: { invited: true; expiresAt: Date; token?: string } = { invited: true, expiresAt };
      if (env.SMTP_DEBUG || env.NODE_ENV === 'test') body.token = token;
      return c.json(body, 202);
    }

    const inserted = await addExistingOrgMember(orgId, targetId, role);
    if (!inserted) throw refuse('ALREADY_MEMBER', 'this user is already an org member', '/email');
    return c.json(
      { userId: inserted.userId, role: inserted.role, createdAt: inserted.createdAt, email },
      201,
    );
  },
);

orgRoutes.get(
  '/:orgId/invitations',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const userId = c.get('userId');
    await requireOrgCan(actorFor(userId), 'org.admin', orgResource(orgId));

    const rows = await listPendingOrgInvitations(orgId);

    const now = Date.now();
    return c.json(rows.map((r) => ({ ...r, expired: new Date(r.expiresAt).getTime() < now })));
  },
);

orgRoutes.delete(
  '/:orgId/invitations',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  zValidator(
    'query',
    z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) }),
    (result) => {
      if (!result.success) throw badRequest(result.error);
    },
  ),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const { email } = c.req.valid('query');
    const userId = c.get('userId');
    await requireOrgCan(actorFor(userId), 'org.admin', orgResource(orgId));

    if (!(await revokeOrgInvitation(orgId, email))) {
      throw notFound('pending invitation not found', 'INVITATION_NOT_FOUND');
    }
    return c.body(null, 204);
  },
);

orgRoutes.patch(
  '/:orgId/members/:userId',
  zValidator('param', memberParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  zValidator('json', patchMemberSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { orgId, userId: targetUserId } = c.req.valid('param');
    const { role, lenses } = c.req.valid('json');
    const callerId = c.get('userId');

    const caller = await requireOrgCan(actorFor(callerId), 'org.admin', orgResource(orgId));

    const targetRole = await orgMemberRole(orgId, targetUserId);
    if (!targetRole) throw notFound('membership not found');

    // Owner-tier + last-owner guards apply ONLY to a permission `role` change.
    // A lenses-only patch is a soft attribute (no permission effect), so it must
    // NOT be blocked on an owner-tier target.
    if (role !== undefined) {
      // Touching the owner tier (granting or revoking) is owner-only.
      if (role === 'owner' || targetRole === 'owner') requireOrgHeld(orgId, caller.role, 'org.own');
      if (targetRole === 'owner' && role !== 'owner') {
        if ((await orgOwnerCount(orgId)) <= 1) {
          throw refuse(
            'LAST_OWNER',
            'the org must keep at least one owner; promote another owner first',
          );
        }
      }
    }

    const updated = await changeOrgMember(orgId, targetUserId, { role, lenses });
    if (!updated) throw notFound('membership not found');
    return c.json({
      userId: updated.userId,
      role: updated.role,
      lenses: updated.lenses,
      createdAt: updated.createdAt,
    });
  },
);

orgRoutes.delete(
  '/:orgId/members/:userId',
  zValidator('param', memberParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { orgId, userId: targetUserId } = c.req.valid('param');
    const callerId = c.get('userId');

    const selfLeave = targetUserId === callerId;
    const caller = await requireOrgCan(
      actorFor(callerId),
      selfLeave ? 'org.read' : 'org.admin',
      orgResource(orgId),
    );

    const targetRole = await orgMemberRole(orgId, targetUserId);
    if (!targetRole) throw notFound('membership not found');

    if (targetRole === 'owner') {
      if (!selfLeave) requireOrgHeld(orgId, caller.role, 'org.own');
      if ((await orgOwnerCount(orgId)) <= 1) {
        throw refuse(
          'LAST_OWNER',
          'the org must keep at least one owner; promote another owner first',
        );
      }
    }

    await dropOrgMember(orgId, targetUserId);
    return c.body(null, 204);
  },
);

orgRoutes.route('/', agentAccountRoutes);

export { orgInvitationRoutes } from './invitations-routes.js';

interface OrgInvitationEmailContext {
  orgName: string;
  inviterEmail: string;
  token: string;
}

/** The project invitation's transport and link landing; `kind=org` selects the org accept endpoint on the web accept page. */
async function sendOrgInvitationEmail(to: string, ctx: OrgInvitationEmailContext): Promise<void> {
  const link = `${buildInvitationLink(ctx.token)}&kind=org`;

  if (!mailDeliveryEnabled()) {
    logger.info({ to, link }, 'org invitation (debug/no-SMTP — not sent)');
    return;
  }

  const subject = `You're invited to join ${ctx.orgName} on Forge`;
  const bodyText = `${ctx.inviterEmail} invited you to join the "${ctx.orgName}" organization on Forge.\n\nAccept the invitation by opening this link (valid for 7 days):\n\n${link}\n`;
  const safeOrgName = escapeInvitationHtml(ctx.orgName);
  const safeInviterEmail = escapeInvitationHtml(ctx.inviterEmail);
  const safeLink = escapeInvitationHtml(link);
  const bodyHtml = `<p><strong>${safeInviterEmail}</strong> invited you to join the "<strong>${safeOrgName}</strong>" organization on Forge.</p><p>Accept the invitation by opening this link (valid for 7 days):</p><p><a href="${safeLink}">${safeLink}</a></p>`;

  await sendMail({
    to,
    subject,
    text: bodyText,
    html: bodyHtml,
  });
}
