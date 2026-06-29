import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { orgInvitations, organizations, users } from '../db/schema.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { consumeOrgInvitationToken } from './invitations.js';

// Mirror of projects/invitations-routes.ts for the org tier. Mounted at
// /api/org-invitations; the shared /invite/accept web page picks this
// endpoint when the email link carries `kind=org`.

const badRequest = (code: string, message: string) =>
  new HTTPException(400, { message, cause: { code } });

const gone = (code: string, message: string) =>
  new HTTPException(410, { message, cause: { code } });

const notFound = (code: string, message: string) =>
  new HTTPException(404, { message, cause: { code } });

export const orgInvitationRoutes = new Hono<{ Variables: AuthVars }>();

orgInvitationRoutes.get('/:token', async (c) => {
  const token = c.req.param('token');
  if (!token || token.length === 0) {
    throw badRequest('INVALID_TOKEN', 'invalid invitation token');
  }

  const [row] = await db
    .select({
      email: orgInvitations.email,
      role: orgInvitations.role,
      expiresAt: orgInvitations.expiresAt,
      acceptedAt: orgInvitations.acceptedAt,
      orgName: organizations.name,
      inviterEmail: users.email,
    })
    .from(orgInvitations)
    .innerJoin(organizations, eq(organizations.id, orgInvitations.orgId))
    .innerJoin(users, eq(users.id, orgInvitations.inviterId))
    .where(eq(orgInvitations.token, token))
    .limit(1);

  if (!row) throw notFound('INVALID_TOKEN', 'invitation not found');
  if (row.acceptedAt !== null) throw gone('ALREADY_ACCEPTED', 'invitation already accepted');
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    throw gone('EXPIRED_TOKEN', 'invitation has expired');
  }

  return c.json({
    orgName: row.orgName,
    inviterEmail: row.inviterEmail,
    role: row.role,
    email: row.email,
    expiresAt: row.expiresAt,
  });
});

orgInvitationRoutes.post('/:token/accept', requireAuth(), async (c) => {
  const token = c.req.param('token');
  if (!token || token.length === 0) {
    throw badRequest('INVALID_TOKEN', 'invalid invitation token');
  }

  const userId = c.get('userId');
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    throw new HTTPException(401, { message: 'user not found', cause: { code: 'UNAUTHENTICATED' } });
  }

  const result = await consumeOrgInvitationToken(token, { userId: user.id, email: user.email });

  switch (result.status) {
    case 'invalid':
      throw notFound('INVALID_TOKEN', 'invitation not found');
    case 'expired':
      throw gone('EXPIRED_TOKEN', 'invitation has expired');
    case 'already_accepted':
      throw gone('ALREADY_ACCEPTED', 'invitation already accepted');
    case 'email_mismatch':
      throw new HTTPException(403, {
        message: 'invitation was sent to a different email address',
        cause: { code: 'INVITATION_EMAIL_MISMATCH' },
      });
    case 'ok':
      return c.json({ orgId: result.orgId, role: result.role });
  }
});

// POST /api/org-invitations/:token/decline — ISS-597.
// Sets dismissedAt. Idempotent. Email-match guard mirrors accept.
orgInvitationRoutes.post('/:token/decline', requireAuth(), async (c) => {
  const token = c.req.param('token');
  if (!token || token.length === 0) {
    throw badRequest('INVALID_TOKEN', 'invalid invitation token');
  }

  const userId = c.get('userId');
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    throw new HTTPException(401, { message: 'user not found', cause: { code: 'UNAUTHENTICATED' } });
  }

  const [updated] = await db
    .update(orgInvitations)
    .set({ dismissedAt: new Date() })
    .where(
      and(
        eq(orgInvitations.token, token),
        sql`lower(${orgInvitations.email}) = lower(${user.email})`,
        isNull(orgInvitations.acceptedAt),
      ),
    )
    .returning({ token: orgInvitations.token });

  if (!updated) throw notFound('NOT_FOUND', 'invitation not found or email mismatch');
  return c.json({ dismissed: true });
});
