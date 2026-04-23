import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from './password.js';

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(8).max(1024),
});

export const authRoutes = new Hono();

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
      const [row] = await db
        .insert(users)
        .values({ email, passwordHash })
        .returning({ userId: users.id, email: users.email });
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
