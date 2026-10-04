import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { applyTemplate } from './apply.js';
import { domainTemplateByKey, listDomainTemplates } from './read.js';
import { requireHeld } from '../permissions/index.js';

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
  return c.json(await listDomainTemplates());
});

domainTemplateRoutes.get(
  '/:key',
  zValidator('param', keyParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { key } = c.req.valid('param');
    const row = await domainTemplateByKey(key);
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
    requireHeld(access, 'project.admin');

    return c.json(await applyTemplate({ projectId, templateKey, actorUserId: userId }));
  },
);
