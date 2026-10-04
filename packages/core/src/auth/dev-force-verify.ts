import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import { forbidden } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { verificationByEmail } from './read.js';
import { forceVerifyEmail } from './service.js';

export const devForceVerifyRoutes = new Hono();

const bodySchema = z.object({ email: z.string().email() });

devForceVerifyRoutes.post(
  '/dev/force-verify',
  async (_c, next) => {
    if (env.NODE_ENV === 'production') {
      throw new HTTPException(404, {
        message: 'not found',
        cause: { code: 'NOT_FOUND' },
      });
    }
    await next();
  },
  zValidator('json', bodySchema, (result) => {
    if (!result.success) {
      throw new HTTPException(400, {
        message: 'invalid email',
        cause: { code: 'BAD_REQUEST' },
      });
    }
  }),
  async (c) => {
    const parsed = c.req.valid('json');

    const allowed = (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!allowed.includes(parsed.email.toLowerCase())) {
      throw forbidden('email not allow-listed');
    }

    const row = await verificationByEmail(parsed.email);
    if (!row) {
      throw new HTTPException(404, {
        message: 'user not found',
        cause: { code: 'USER_NOT_FOUND' },
      });
    }

    if (row.emailVerifiedAt === null) {
      await forceVerifyEmail(row.id);
    }

    return c.json({ verified: true, alreadyVerified: row.emailVerifiedAt !== null });
  },
);
