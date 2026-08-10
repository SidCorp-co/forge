import { zValidator } from '@hono/zod-validator';
import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { domainTemplates } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  TemplateInvalidManifestError,
  TemplateNotFoundError,
  applyTemplate,
} from './apply.js';

const keyParamSchema = z.object({ key: z.string().trim().min(1).max(200) });

const applyBodySchema = z
  .object({
    projectId: z.uuid(),
    templateKey: z.string().trim().min(1).max(200),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const domainTemplateRoutes = new Hono<{ Variables: AuthVars }>();
domainTemplateRoutes.use('*', requireAuth(), assertEmailVerified());

domainTemplateRoutes.get('/', async (c) => {
  const rows = await db.select().from(domainTemplates).orderBy(asc(domainTemplates.key));
  return c.json(rows);
});

domainTemplateRoutes.get(
  '/:key',
  zValidator('param', keyParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { key } = c.req.valid('param');
    const [row] = await db
      .select()
      .from(domainTemplates)
      .where(eq(domainTemplates.key, key))
      .limit(1);
    if (!row) throw notFound('domain template not found');
    return c.json(row);
  },
);

domainTemplateRoutes.post(
  '/apply',
  zValidator('json', applyBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, templateKey } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'insufficient permission');

    try {
      const result = await applyTemplate({ projectId, templateKey, actorUserId: userId });
      return c.json(result);
    } catch (err) {
      if (err instanceof TemplateNotFoundError) {
        throw notFound(err.message);
      }
      if (err instanceof TemplateInvalidManifestError) {
        throw new HTTPException(500, {
          message: 'template manifest is invalid; contact an administrator',
          cause: { code: 'TEMPLATE_INVALID' },
        });
      }
      throw err;
    }
  },
);
