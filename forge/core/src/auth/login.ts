import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { setAuthCookie } from './cookie.js';
import { signUserToken } from './jwt.js';
import { verifyPassword } from './password.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(1).max(1024),
});

export const loginRoutes = new Hono();

loginRoutes.post(
  '/local',
  zValidator('json', loginSchema, (result) => {
    if (!result.success) {
      throw new HTTPException(400, {
        message: 'Invalid login input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(result.error) },
      });
    }
  }),
  async (c) => {
    const { email, password } = c.req.valid('json');

    // Generic 401 for unknown email AND bad password — no user enumeration.
    const invalidCredentials = () =>
      new HTTPException(401, {
        message: 'invalid credentials',
        cause: { code: 'INVALID_CREDENTIALS' },
      });

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) throw invalidCredentials();

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw invalidCredentials();

    const token = await signUserToken(user.id);
    setAuthCookie(c, token);

    return c.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerifiedAt !== null,
      },
      emailVerificationRequired: user.emailVerifiedAt === null,
    });
  },
);
