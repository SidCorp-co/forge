import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { type AuthVars, readAuthUser, requireAuth } from '../middleware/auth.js';
import { consumeOrgInvitationToken } from './invitations.js';
import { orgInvitationByToken } from './read.js';
import { refuse } from './refuse.js';
import { declineOrgInvitation } from './service.js';

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

  const row = await orgInvitationByToken(token);

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
  const email = (await readAuthUser(userId))?.email ?? null;
  if (email === null) {
    throw new HTTPException(401, { message: 'user not found', cause: { code: 'UNAUTHENTICATED' } });
  }

  const result = await consumeOrgInvitationToken(token, { userId, email });

  switch (result.status) {
    case 'invalid':
      throw notFound('INVALID_TOKEN', 'invitation not found');
    case 'expired':
      throw gone('EXPIRED_TOKEN', 'invitation has expired');
    case 'already_accepted':
      throw gone('ALREADY_ACCEPTED', 'invitation already accepted');
    case 'email_mismatch':
      throw refuse(
        'INVITATION_EMAIL_MISMATCH',
        'this invitation was sent to a different email address; sign in with the address it was sent to',
      );
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
  const email = (await readAuthUser(userId))?.email ?? null;
  if (email === null) {
    throw new HTTPException(401, { message: 'user not found', cause: { code: 'UNAUTHENTICATED' } });
  }

  if (!(await declineOrgInvitation(token, email))) {
    throw notFound('NOT_FOUND', 'invitation not found or email mismatch');
  }
  return c.json({ dismissed: true });
});
