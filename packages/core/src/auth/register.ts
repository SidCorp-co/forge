import type { AuthRefusalCode } from '@forge/contracts/auth';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RULES } from '../config/rate-limits.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { refuser } from '../lib/refusal.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { zValidator } from '../middleware/zod-validator.js';
import { logger } from '../observability/logger.js';
import { sendVerificationEmail } from './email.js';
import { hashPassword } from './password.js';
import { evaluatePasswordStrength, MIN_PASSWORD_SCORE } from './password-strength.js';
import { registerSchema } from './request-schemas.js';
import { registerUser } from './service.js';
import { issueVerificationToken } from './verification-token.js';

const refuse = refuser<AuthRefusalCode>('AUTH_REFUSED');

export const authRoutes = new Hono();

authRoutes.use(
  '/register',
  rateLimit(() => RULES.authRegister, { name: 'authRegister' }),
);

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
      const row = await registerUser(email, passwordHash);

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
        throw refuse(
          'EMAIL_ALREADY_REGISTERED',
          'this email is already registered; sign in instead',
          '/email',
        );
      }
      throw err;
    }
  },
);
