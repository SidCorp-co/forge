import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { type AuthVars, readAuthUser, requireAuth } from '../middleware/auth.js';
import { consumeInvitationToken } from './invitation-token.js';
import { listPendingInvitationsFor, projectInvitationByToken } from './read.js';
import { refuse } from './refuse.js';
import { declineProjectInvitation } from './service.js';

const badRequest = (code: string, message: string) =>
  new HTTPException(400, { message, cause: { code } });

const gone = (code: string, message: string) =>
  new HTTPException(410, { message, cause: { code } });

const notFound = (code: string, message: string) =>
  new HTTPException(404, { message, cause: { code } });

export const invitationRoutes = new Hono<{ Variables: AuthVars }>();

// GET /api/invitations/pending — ISS-597.
// Unified list of pending project + org invitations for the authed user.
// MUST be registered BEFORE /:token or Hono will match token='pending'.
invitationRoutes.get('/pending', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const user = await readAuthUser(userId);
  if (!user) {
    throw new HTTPException(401, { message: 'user not found', cause: { code: 'UNAUTHENTICATED' } });
  }

  return c.json(await listPendingInvitationsFor(user.email));
});

invitationRoutes.get('/:token', async (c) => {
  const token = c.req.param('token');
  if (!token || token.length === 0) {
    throw badRequest('INVALID_TOKEN', 'invalid invitation token');
  }

  const row = await projectInvitationByToken(token);

  if (!row) throw notFound('INVALID_TOKEN', 'invitation not found');
  if (row.acceptedAt !== null) {
    throw gone('ALREADY_ACCEPTED', 'invitation already accepted');
  }
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    throw gone('EXPIRED_TOKEN', 'invitation has expired');
  }

  return c.json({
    projectName: row.projectName,
    inviterEmail: row.inviterEmail,
    role: row.role,
    email: row.email,
    expiresAt: row.expiresAt,
  });
});

invitationRoutes.post('/:token/accept', requireAuth(), async (c) => {
  const token = c.req.param('token');
  if (!token || token.length === 0) {
    throw badRequest('INVALID_TOKEN', 'invalid invitation token');
  }

  const userId = c.get('userId');

  const user = await readAuthUser(userId);
  if (!user) {
    throw new HTTPException(401, {
      message: 'user not found',
      cause: { code: 'UNAUTHENTICATED' },
    });
  }

  const result = await consumeInvitationToken(token, { userId, email: user.email });

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
      return c.json({ projectId: result.projectId, role: result.role });
  }
});

// POST /api/invitations/:token/decline — ISS-597.
// Sets dismissedAt. Idempotent. Email-match guard mirrors accept.
invitationRoutes.post('/:token/decline', requireAuth(), async (c) => {
  const token = c.req.param('token');
  if (!token || token.length === 0) {
    throw badRequest('INVALID_TOKEN', 'invalid invitation token');
  }

  const userId = c.get('userId');
  const user = await readAuthUser(userId);
  if (!user) {
    throw new HTTPException(401, { message: 'user not found', cause: { code: 'UNAUTHENTICATED' } });
  }

  if (!(await declineProjectInvitation(token, user.email))) throw notFound('NOT_FOUND', 'invitation not found or email mismatch');
  return c.json({ dismissed: true });
});
