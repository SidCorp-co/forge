/**
 * The one read a body composer needs.
 *
 * It touches no row: `preview` is `prepareBody` on bytes nobody stored, so what
 * the pane draws and what a save would store come from one function, including
 * the refusal.
 *
 * `GET /components` and `GET /projects/:id/body-adoption` stood here until
 * 2026-09-14, when the component vocabulary and the per-stage mandate it fed
 * were removed — the registry served one dropdown and the number counted a rule
 * no project ever turned on.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
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
      warnings: prepared.warnings,
      text: prepared.text,
      // cm:why the tree is parsed from the PREPARED bytes, not the typed ones: the pane must draw what the row would hold, and `serializeBody` wraps loose prose in `<p>` and drops what the sanitizer removed
      nodes: prepared.format === 'html' ? parseBody(prepared.body) : null,
    });
  },
);
