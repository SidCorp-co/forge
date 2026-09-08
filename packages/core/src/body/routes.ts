/**
 * The two reads a body COMPOSER needs, plus the one a MANDATE decision needs.
 *
 * ISS-967: web renders component bodies but cannot parse or validate one — the
 * scanner and the registry are core-internal by `public.ts`'s ISS-898 guard,
 * and `packages/web-v2` has no dependency on `@forge/core`. Without these two
 * routes the browser's only options are a second scanner and a second
 * component list, which is exactly the drift the registry exists to avoid.
 *
 * ISS-969 added `adoption`. It lives HERE rather than under `/projects/:id`
 * because it is a read ABOUT bodies — it counts `format` and `template` and
 * resolves `states[stage].bodyPolicy` — and `projects/routes.ts` was already
 * at the archmap fan-out limit, which is the gate saying the same thing.
 *
 * None of the three touches a row. `preview` is `prepareBody` on bytes nobody
 * stored, so what the pane draws and what a save would store come from one
 * function, including the refusal.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { ADOPTION_DEFAULT_WINDOW_DAYS, readBodyAdoption } from './adoption.js';
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

// cm:why the window is capped at 90 days rather than left open: the read groups over the largest table in the schema, and a caller asking for all of time is asking for a seq scan `comments_stage_created_at_idx` cannot serve
const adoptionQuerySchema = z.object({
  projectId: z.uuid(),
  days: z.coerce.number().int().min(1).max(90).optional(),
});

/**
 * ISS-969 — the number a mandate decision is made against.
 *
 * Member-gated, and deliberately NOT behind the `pipelineControl` flag that
 * hides the config screens: the whole point of the figure is that it is
 * readable before anyone has decided to configure anything.
 */
bodyRoutes.get(
  '/adoption',
  zValidator('query', adoptionQuerySchema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
    }
  }),
  async (c) => {
    const { projectId, days } = c.req.valid('query');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    if (!access.role) {
      throw new HTTPException(403, {
        message: 'not a project member',
        cause: { code: 'FORBIDDEN' },
      });
    }
    return c.json(await readBodyAdoption(projectId, days ?? ADOPTION_DEFAULT_WINDOW_DAYS));
  },
);

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
