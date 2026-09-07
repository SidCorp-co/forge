/**
 * The two reads a body COMPOSER needs, and nothing else.
 *
 * ISS-967: web renders component bodies but cannot parse or validate one — the
 * scanner and the registry are core-internal by `public.ts`'s ISS-898 guard,
 * and `packages/web-v2` has no dependency on `@forge/core`. Without these two
 * routes the browser's only options are a second scanner and a second
 * component list, which is exactly the drift the registry exists to avoid.
 *
 * Neither route touches a row. `preview` is `prepareBody` on bytes nobody
 * stored, so what the pane draws and what a save would store come from one
 * function, including the refusal.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { BODY_FORMATS } from './formats.js';
import { prepareBodyOrThrow } from './http-error.js';
import { parseBody } from './parse.js';
import { describeRegistry } from './registry-view.js';

export const bodyRoutes = new Hono<{ Variables: AuthVars }>();
bodyRoutes.use('*', requireAuth(), assertEmailVerified());

const previewSchema = z
  .object({
    raw: z.string().max(100_000),
    format: z.enum(BODY_FORMATS).optional(),
  })
  .strict();

bodyRoutes.get('/components', (c) => c.json({ items: describeRegistry() }));

bodyRoutes.post(
  '/preview',
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
    return c.json({
      body: prepared.body,
      format: prepared.format,
      template: prepared.template,
      warnings: prepared.warnings,
      text: prepared.text,
      // cm:why the tree is parsed from the PREPARED bytes, not the typed ones: the pane must draw what the row would hold, and `serializeBody` wraps loose prose in `<p>` and drops what the sanitizer removed
      nodes: prepared.format === 'html' ? parseBody(prepared.body) : null,
    });
  },
);
