import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RULES } from '../config/rate-limits.js';
import { db } from '../db/client.js';
import { ensurePersonalOrg } from '../orgs/service.js';
import { users } from '../db/schema.js';
import { logger } from '../logger.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { sendVerificationEmail } from './email.js';
import { hashPassword } from './password.js';
import { MIN_PASSWORD_SCORE, evaluatePasswordStrength } from './password-strength.js';
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

    // Strength check uses email as a personal input so `alex@studio.com`
    // refusing a password of "alex123" is automatic. Length floor stays in
    // the zod schema (8 chars) so an empty/short password trips earlier
    // with field-level feedback; this catches the dictionary cases zxcvbn
    // is built for.
    const strength = evaluatePasswordStrength(password, [email]);
    if (strength.score < MIN_PASSWORD_SCORE) {
      throw new HTTPException(400, {
        message: 'Password is too weak',
        cause: {
          code: 'WEAK_PASSWORD',
          details: {
            fieldErrors: {
              password: [strength.warning || 'Password is too easy to guess'],
            },
            score: strength.score,
            suggestions: strength.suggestions,
          },
        },
      });
    }

    const passwordHash = await hashPassword(password);

    try {
      // User + personal org are one atomic unit — a half-provisioned user
      // (no personal org) would 500 every project create later.
      const row = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(users)
          .values({ email, passwordHash })
          .returning({ userId: users.id, email: users.email });
        const created = inserted[0];
        if (!created) {
          throw new Error('register: insert returned no row');
        }
        await ensurePersonalOrg(tx, created.userId, created.email);
        return created;
      });

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
