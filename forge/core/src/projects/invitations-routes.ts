import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projectInvitations, projects, users } from '../db/schema.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { consumeInvitationToken } from './invitation-token.js';

const badRequest = (code: string, message: string) =>
  new HTTPException(400, { message, cause: { code } });

const gone = (code: string, message: string) =>
  new HTTPException(410, { message, cause: { code } });

const notFound = (code: string, message: string) =>
  new HTTPException(404, { message, cause: { code } });

export const invitationRoutes = new Hono<{ Variables: AuthVars }>();

invitationRoutes.get('/:token', async (c) => {
  const token = c.req.param('token');
  if (!token || token.length === 0) {
    throw badRequest('INVALID_TOKEN', 'invalid invitation token');
  }

  const [row] = await db
    .select({
      email: projectInvitations.email,
      role: projectInvitations.role,
      expiresAt: projectInvitations.expiresAt,
      acceptedAt: projectInvitations.acceptedAt,
      projectName: projects.name,
      inviterEmail: users.email,
    })
    .from(projectInvitations)
    .innerJoin(projects, eq(projects.id, projectInvitations.projectId))
    .innerJoin(users, eq(users.id, projectInvitations.inviterId))
    .where(eq(projectInvitations.token, token))
    .limit(1);

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

  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    throw new HTTPException(401, {
      message: 'user not found',
      cause: { code: 'UNAUTHENTICATED' },
    });
  }

  const result = await consumeInvitationToken(token, { userId: user.id, email: user.email });

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
      return c.json({ projectId: result.projectId, role: result.role });
  }
});
