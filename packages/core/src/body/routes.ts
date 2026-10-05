import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { BODY_FORMATS } from './formats.js';
import { prepareBodyOrThrow } from './http-error.js';
import { parseBody } from './parse.js';

export const bodyRoutes = new Hono<{ Variables: AuthVars }>();
bodyRoutes.use('*', requireAuth(), assertEmailVerified());

const previewSchema = z
  .object({
    raw: z.string().max(100_000),
    format: z.enum(BODY_FORMATS).optional(),
  })
  .strict();

bodyRoutes.post('/preview', zValidator('json', previewSchema), (c) => {
  const { raw, format } = c.req.valid('json');
  const prepared = prepareBodyOrThrow({ raw, format });
  return c.json({
    body: prepared.body,
    format: prepared.format,
    warnings: prepared.warnings,
    text: prepared.text,
    nodes: prepared.format === 'html' ? parseBody(prepared.body) : null,
  });
});
