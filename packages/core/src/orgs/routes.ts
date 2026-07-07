import { zValidator } from '@hono/zod-validator';
import { and, count, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import {
  memberLenses,
  orgInvitations,
  orgMemberRoles,
  organizationMembers,
  organizations,
  projects,
  users,
} from '../db/schema.js';
import { assertOrgAccess, orgRoleAtLeast } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { sendOrgInvitationEmail } from '../projects/invitation-email.js';
import { issueOrgInvitationToken } from './invitations.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message = 'not found', code = 'NOT_FOUND') =>
  new HTTPException(404, { message, cause: { code } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const conflict = (message: string, code: string, hint?: string) =>
  new HTTPException(409, { message, cause: { code, ...(hint ? { hint } : {}) } });

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
  const rows = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      isPersonal: organizations.isPersonal,
      role: organizationMembers.role,
      createdAt: organizations.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(eq(organizationMembers.userId, userId));
  return c.json(rows);
});

orgRoutes.post(
  '/',
  zValidator('json', createOrgSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { slug, name } = c.req.valid('json');
    const userId = c.get('userId');
    try {
      const created = await db.transaction(async (tx) => {
        const [org] = await tx
          .insert(organizations)
          .values({ slug, name, isPersonal: false, createdBy: userId })
          .returning({
            id: organizations.id,
            slug: organizations.slug,
            name: organizations.name,
            isPersonal: organizations.isPersonal,
            createdAt: organizations.createdAt,
          });
        if (!org) throw new Error('organizations: insert returned no row');
        await tx.insert(organizationMembers).values({ orgId: org.id, userId, role: 'owner' });
        return org;
      });
      return c.json({ ...created, role: 'owner' as const }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('slug already taken', 'SLUG_TAKEN');
      }
      throw err;
    }
  },
);

orgRoutes.patch(
  '/:orgId',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', patchOrgSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    await assertOrgAccess(orgId, userId, 'owner');

    const [updated] = await db
      .update(organizations)
      .set({ ...(patch.name !== undefined ? { name: patch.name } : {}) })
      .where(eq(organizations.id, orgId))
      .returning({
        id: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
        isPersonal: organizations.isPersonal,
        createdAt: organizations.createdAt,
      });
    if (!updated) throw notFound('organization not found');
    return c.json(updated);
  },
);

// Delete a TEAM org: owner-only, refused while any project still lives in it
// (move or delete projects first) and always refused for personal orgs.
orgRoutes.delete(
  '/:orgId',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const userId = c.get('userId');

    const org = await assertOrgAccess(orgId, userId, 'owner');
    if (org.isPersonal) {
      throw conflict('personal org cannot be deleted', 'PERSONAL_ORG_IMMUTABLE');
    }
    const [projectCount] = await db
      .select({ n: count() })
      .from(projects)
      .where(eq(projects.orgId, orgId));
    if (Number(projectCount?.n ?? 0) > 0) {
      throw conflict(
        'org still has projects',
        'ORG_NOT_EMPTY',
        'delete or move its projects first',
      );
    }

    await db.delete(organizations).where(eq(organizations.id, orgId));
    return c.body(null, 204);
  },
);

// In-org transparency: any org member can SEE which projects the org holds
// (name+slug only) — access to a project's content still requires an
// effective role on it.
orgRoutes.get(
  '/:orgId/projects',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const userId = c.get('userId');

    await assertOrgAccess(orgId, userId, 'member');

    const rows = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        archivedAt: projects.archivedAt,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .where(eq(projects.orgId, orgId));
    return c.json(rows);
  },
);

orgRoutes.get(
  '/:orgId/members',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const userId = c.get('userId');

    await assertOrgAccess(orgId, userId, 'member');

    const rows = await db
      .select({
        userId: organizationMembers.userId,
        email: users.email,
        role: organizationMembers.role,
        lenses: organizationMembers.lenses,
        createdAt: organizationMembers.createdAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.orgId, orgId));
    return c.json(rows);
  },
);

// Direct-add an EXISTING user by email (v1 — no email-token flow at the org
// tier; project invitations keep theirs). Granting `owner` requires owner.
orgRoutes.post(
  '/:orgId/members',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', addMemberSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const { email, role } = c.req.valid('json');
    const callerId = c.get('userId');

    const caller = await assertOrgAccess(orgId, callerId, 'admin');
    if (role === 'owner' && caller.role !== 'owner') {
      throw forbidden('only an org owner can grant the owner role');
    }
    if (caller.isPersonal) {
      throw conflict('personal org cannot have additional members', 'PERSONAL_ORG_IMMUTABLE');
    }

    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // No account yet → fall back to an email-token invitation (accepting
    // after signup inserts the membership). 'owner' is never invitable.
    if (!target) {
      if (role === 'owner') {
        throw forbidden('the owner role cannot be granted by email invitation');
      }
      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      const [inviter] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, callerId))
        .limit(1);
      const { token, expiresAt } = await issueOrgInvitationToken({
        orgId,
        inviterId: callerId,
        email,
        role,
      });
      try {
        await sendOrgInvitationEmail(email, {
          orgName: org?.name ?? 'an organization',
          inviterEmail: inviter?.email ?? 'a teammate',
          token,
        });
      } catch (sendErr) {
        logger.error({ err: sendErr, orgId, email }, 'failed to send org invitation email');
      }
      const body: { invited: true; expiresAt: Date; token?: string } = { invited: true, expiresAt };
      if (env.SMTP_DEBUG || env.NODE_ENV === 'test') body.token = token;
      return c.json(body, 202);
    }

    const [inserted] = await db
      .insert(organizationMembers)
      .values({ orgId, userId: target.id, role })
      .onConflictDoNothing()
      .returning({
        userId: organizationMembers.userId,
        role: organizationMembers.role,
        createdAt: organizationMembers.createdAt,
      });
    if (!inserted) throw conflict('user is already an org member', 'ALREADY_MEMBER');
    return c.json({ ...inserted, email }, 201);
  },
);

orgRoutes.get(
  '/:orgId/invitations',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const userId = c.get('userId');
    await assertOrgAccess(orgId, userId, 'admin');

    const rows = await db
      .select({
        email: orgInvitations.email,
        role: orgInvitations.role,
        expiresAt: orgInvitations.expiresAt,
        createdAt: orgInvitations.createdAt,
        inviterEmail: users.email,
      })
      .from(orgInvitations)
      .innerJoin(users, eq(users.id, orgInvitations.inviterId))
      .where(and(eq(orgInvitations.orgId, orgId), isNull(orgInvitations.acceptedAt)));

    // Never leak `token` (the accept secret / PK).
    const now = Date.now();
    return c.json(rows.map((r) => ({ ...r, expired: new Date(r.expiresAt).getTime() < now })));
  },
);

orgRoutes.delete(
  '/:orgId/invitations',
  zValidator('param', orgParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator(
    'query',
    z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) }),
    (result) => {
      if (!result.success) throw badRequest(z.flattenError(result.error));
    },
  ),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const { email } = c.req.valid('query');
    const userId = c.get('userId');
    await assertOrgAccess(orgId, userId, 'admin');

    const deleted = await db
      .delete(orgInvitations)
      .where(
        and(
          eq(orgInvitations.orgId, orgId),
          eq(orgInvitations.email, email),
          isNull(orgInvitations.acceptedAt),
        ),
      )
      .returning({ token: orgInvitations.token });
    if (deleted.length === 0) {
      throw notFound('pending invitation not found', 'INVITATION_NOT_FOUND');
    }
    return c.body(null, 204);
  },
);

orgRoutes.patch(
  '/:orgId/members/:userId',
  zValidator('param', memberParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', patchMemberSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId, userId: targetUserId } = c.req.valid('param');
    const { role, lenses } = c.req.valid('json');
    const callerId = c.get('userId');

    const caller = await assertOrgAccess(orgId, callerId, 'admin');

    const [target] = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)),
      )
      .limit(1);
    if (!target) throw notFound('membership not found');

    // Owner-tier + last-owner guards apply ONLY to a permission `role` change.
    // A lenses-only patch is a soft attribute (no permission effect), so it must
    // NOT be blocked on an owner-tier target.
    if (role !== undefined) {
      // Touching the owner tier (granting or revoking) is owner-only.
      if ((role === 'owner' || target.role === 'owner') && caller.role !== 'owner') {
        throw forbidden('only an org owner can change owner-tier roles');
      }
      if (target.role === 'owner' && role !== 'owner') {
        const [ownerCount] = await db
          .select({ n: count() })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, 'owner')));
        if (Number(ownerCount?.n ?? 0) <= 1) {
          throw conflict('org must keep at least one owner', 'LAST_OWNER');
        }
      }
    }

    const [updated] = await db
      .update(organizationMembers)
      .set({
        ...(role !== undefined ? { role } : {}),
        // Dedupe so a member never carries a lens twice.
        ...(lenses !== undefined ? { lenses: Array.from(new Set(lenses)) } : {}),
      })
      .where(
        and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)),
      )
      .returning({
        userId: organizationMembers.userId,
        role: organizationMembers.role,
        lenses: organizationMembers.lenses,
        createdAt: organizationMembers.createdAt,
      });
    if (!updated) throw notFound('membership not found');
    return c.json(updated);
  },
);

orgRoutes.delete(
  '/:orgId/members/:userId',
  zValidator('param', memberParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { orgId, userId: targetUserId } = c.req.valid('param');
    const callerId = c.get('userId');

    const selfLeave = targetUserId === callerId;
    const caller = await assertOrgAccess(orgId, callerId, selfLeave ? 'member' : 'admin');

    const [target] = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)),
      )
      .limit(1);
    if (!target) throw notFound('membership not found');

    if (target.role === 'owner') {
      if (!selfLeave && caller.role !== 'owner') {
        throw forbidden('only an org owner can remove an owner');
      }
      const [ownerCount] = await db
        .select({ n: count() })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, 'owner')));
      if (Number(ownerCount?.n ?? 0) <= 1) {
        throw conflict('org must keep at least one owner', 'LAST_OWNER');
      }
    }

    await db
      .delete(organizationMembers)
      .where(
        and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)),
      );
    return c.body(null, 204);
  },
);
