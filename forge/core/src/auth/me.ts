import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';

export const meRoutes = new Hono<{ Variables: AuthVars }>();

meRoutes.use('/me', requireAuth());

meRoutes.get('/me', async (c) => {
  const userId = c.get('userId');
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      isCeo: users.isCeo,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) {
    throw new HTTPException(401, {
      message: 'user not found',
      cause: { code: 'UNAUTHENTICATED' },
    });
  }

  return c.json(row);
});
