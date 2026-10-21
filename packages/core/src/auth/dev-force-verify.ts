import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { answer } from '../api-reference/declare/describe.js';
import { declaresInput } from '../api-reference/declare/validator.js';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { emailVerificationTokens, users } from '../db/schema.js';
import { forcedSchema, forceVerify, forceVerifySchema } from './dev-force-verify-reference.js';

export const devForceVerifyRoutes = new Hono();

devForceVerifyRoutes.post(
  '/dev/force-verify',
  forceVerify,
  declaresInput('json', forceVerifySchema),
  async (c) => {
    if (env.NODE_ENV === 'production') {
      throw new HTTPException(404, {
        message: 'not found',
        cause: { code: 'NOT_FOUND' },
      });
    }

    let parsed: { email: string };
    try {
      const json = await c.req.json();
      const result = forceVerifySchema.safeParse(json);
      if (!result.success) {
        throw new HTTPException(400, {
          message: 'The field email is not an email address.',
          cause: { code: 'BAD_REQUEST' },
        });
      }
      parsed = result.data;
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      throw new HTTPException(400, {
        message: 'The body is not JSON.',
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

    return c.json(
      answer(forcedSchema, { verified: true, alreadyVerified: row.emailVerifiedAt !== null }),
    );
  },
);
