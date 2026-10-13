import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/describe.js';
import { zValidator } from '../api-reference/validator.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { BODY_FORMATS } from './formats.js';
import { prepareBodyOrThrow } from './http-error.js';
import { parseBody } from './parse.js';
import { bodyPreviewSchema, previewBody } from './routes-reference.js';

export const bodyRoutes = new Hono<{ Variables: AuthVars }>();
bodyRoutes.use('*', requireAuth(), assertEmailVerified());

const previewSchema = z
  .object({
    raw: z.string().max(100_000),
    format: z.enum(BODY_FORMATS).optional(),
  })
  .strict();

bodyRoutes.post(
  '/preview',
  previewBody,
  zValidator('json', previewSchema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
    }
  }),
  (c) => {
    const { raw, format } = c.req.valid('json');
    const prepared = prepareBodyOrThrow({ raw, format });
    return c.json(
      answer(bodyPreviewSchema, {
        body: prepared.body,
        format: prepared.format,
        warnings: prepared.warnings,
        text: prepared.text,
        nodes: prepared.format === 'html' ? parseBody(prepared.body) : null,
      }),
    );
  },
);
