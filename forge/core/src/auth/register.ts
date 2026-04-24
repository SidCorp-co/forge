import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RULES } from '../config/rate-limits.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { logger } from '../logger.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { sendVerificationEmail } from './email.js';
import { hashPassword } from './password.js';
import { issueVerificationToken } from './verification-token.js';

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(8).max(1024),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const authRoutes = new Hono();

authRoutes.use('/register', rateLimit(RULES.authRegister, { name: 'authRegister' }));

authRoutes.post(
  '/register',
  zValidator('json', registerSchema, (result) => {
    if (!result.success) {
      throw new HTTPException(400, {
        message: 'Invalid registration input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(result.error) },
      });
    }
  }),
  async (c) => {
    const { email, password } = c.req.valid('json');
    const passwordHash = await hashPassword(password);

    try {
      const inserted = await db
        .insert(users)
        .values({ email, passwordHash })
        .returning({ userId: users.id, email: users.email });
      const row = inserted[0];
      if (!row) {
        throw new Error('register: insert returned no row');
      }

      try {
        const token = await issueVerificationToken(row.userId);
        await sendVerificationEmail(row.email, token);
      } catch (sendErr) {
        // Email delivery failure must not roll back registration. User can
        // still log in; resend endpoint is planned as a follow-up.
        logger.error({ err: sendErr, userId: row.userId }, 'failed to send verification email');
      }

      return c.json(row, 201);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new HTTPException(409, {
          message: 'Email already registered',
          cause: { code: 'CONFLICT' },
        });
      }
      throw err;
    }
  },
);

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}
