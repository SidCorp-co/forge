import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { emailVerificationTokens, users } from '../db/schema.js';

export const devForceVerifyRoutes = new Hono();

const bodySchema = z.object({ email: z.string().email() });

devForceVerifyRoutes.post('/dev/force-verify', async (c) => {
  if (env.NODE_ENV === 'production') {
    throw new HTTPException(404, {
      message: 'not found',
      cause: { code: 'NOT_FOUND' },
    });
  }

  let parsed: { email: string };
  try {
    const json = await c.req.json();
    const result = bodySchema.safeParse(json);
    if (!result.success) {
      throw new HTTPException(400, {
        message: 'invalid email',
        cause: { code: 'BAD_REQUEST' },
      });
    }
    parsed = result.data;
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    throw new HTTPException(400, {
      message: 'invalid body',
      cause: { code: 'BAD_REQUEST' },
    });
  }

  const allowed = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(parsed.email.toLowerCase())) {
    throw new HTTPException(403, {
      message: 'email not allow-listed',
      cause: { code: 'FORBIDDEN' },
    });
  }

  const [row] = await db
    .select({ id: users.id, emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(sql`lower(${users.email}) = ${parsed.email.toLowerCase()}`)
    .limit(1);
  if (!row) {
    throw new HTTPException(404, {
      message: 'user not found',
      cause: { code: 'USER_NOT_FOUND' },
    });
  }

  if (row.emailVerifiedAt === null) {
    await db.transaction(async (tx) => {
      await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, row.id));
      await tx.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, row.id));
    });
  }

  return c.json({ verified: true, alreadyVerified: row.emailVerifiedAt !== null });
});
