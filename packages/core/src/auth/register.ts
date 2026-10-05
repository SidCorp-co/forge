import type { AuthRefusalCode } from '@forge/contracts/auth';
import { ZxcvbnFactory, type ZxcvbnResult } from '@zxcvbn-ts/core';
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common';
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { env } from '../config/env.js';
import { RULES } from '../config/rate-limits.js';
import { mailDeliveryEnabled, sendMail } from '../integrations/mail/index.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { refuser } from '../lib/refusal.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { zValidator } from '../middleware/zod-validator.js';
import { logger } from '../observability/logger.js';
import { hashPassword } from './password.js';
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
        cause: { code: 'BAD_REQUEST', details: result.error },
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
          details: [
            {
              code: 'WEAK_PASSWORD',
              path: '/password',
              detail: [strength.warning || 'Password is too easy to guess', ...strength.suggestions]
                .filter(Boolean)
                .join(' '),
            },
          ],
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

function buildVerificationLink(token: string): string {
  // Link must hit the API origin (where /api/auth/verify lives), NOT the web
  // origin. With subdomain-split deploys (web=forge-beta.example.com,
  // api=forge-beta-api.example.com) APP_BASE_URL is the web URL, so we fall
  // through to OAUTH_REDIRECT_BASE which already names the API origin.
  // Single-origin deploys leave OAUTH_REDIRECT_BASE unset → APP_BASE_URL.
  const apiBase = (env.OAUTH_REDIRECT_BASE ?? env.APP_BASE_URL).replace(/\/+$/, '');
  return `${apiBase}/api/auth/verify?token=${encodeURIComponent(token)}`;
}

async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const link = buildVerificationLink(token);

  if (!mailDeliveryEnabled()) {
    logger.info({ to, link }, 'email verification (debug/no-SMTP — not sent)');
    return;
  }

  await sendMail({
    to,
    subject: 'Verify your email',
    text: `Verify your email by opening this link (valid for 24 hours):\n\n${link}\n`,
    html: `<p>Verify your email by opening this link (valid for 24 hours):</p><p><a href="${link}">${link}</a></p>`,
  });
}

let factory: ZxcvbnFactory | null = null;
function getFactory(): ZxcvbnFactory {
  if (factory) return factory;
  factory = new ZxcvbnFactory({
    translations: zxcvbnEnPackage.translations,
    graphs: zxcvbnCommonPackage.adjacencyGraphs,
    dictionary: {
      ...zxcvbnCommonPackage.dictionary,
      ...zxcvbnEnPackage.dictionary,
    },
  });
  return factory;
}

const MIN_PASSWORD_SCORE = 2;

interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  /** Best single-line piece of feedback to surface, e.g. "Add another word or two." */
  warning: string;
  suggestions: string[];
}

function evaluatePasswordStrength(password: string, userInputs: string[] = []): PasswordStrength {
  const result: ZxcvbnResult = getFactory().check(password, userInputs);
  return {
    score: result.score,
    warning: result.feedback.warning ?? '',
    suggestions: result.feedback.suggestions ?? [],
  };
}
