import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { readEnvironmentState } from './environment-state-read.js';
import { readProjectDocument } from './service.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';

const projectParam = z.object({ id: z.uuid() });
const environmentParam = z.object({
  id: z.uuid(),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
});

const refuseParam = (r: { success: boolean }) => {
  if (!r.success) {
    throw new HTTPException(400, {
      message: 'a project id is a uuid and an environment name matches ^[a-z][a-z0-9-]{0,62}$',
      cause: { code: 'BAD_REQUEST' },
    });
  }
};

async function storedDocument(projectId: string) {
  const stored = await readProjectDocument(projectId);
  if (!stored) {
    throw new HTTPException(404, {
      message: `project ${projectId} has declared no project document, so it names no environment`,
      cause: { code: 'PROJECT_DOCUMENT_NOT_FOUND' },
    });
  }
  return stored;
}

export const environmentStateRoutes = new Hono<{ Variables: AuthVars }>();
environmentStateRoutes.use('/:id/environments/*', requireAuth(), assertEmailVerified());

environmentStateRoutes.get(
  '/:id/environments/state',
  zValidator('param', projectParam, refuseParam),
  async (c) => {
    const { id } = c.req.valid('param');
    await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
    const { revision, document } = await storedDocument(id);
    const environments = await Promise.all(
      Object.entries(document.environments).map(([name, declaration]) =>
        readEnvironmentState(id, document, { name, declaration }),
      ),
    );
    return c.json({ revision, environments });
  },
);

environmentStateRoutes.get(
  '/:id/environments/:name/state',
  zValidator('param', environmentParam, refuseParam),
  async (c) => {
    const { id, name } = c.req.valid('param');
    await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
    const { revision, document } = await storedDocument(id);
    const decl = Object.hasOwn(document.environments, name)
      ? document.environments[name]
      : undefined;
    if (!decl) {
      const declared = Object.keys(document.environments).join(', ') || 'none';
      throw new HTTPException(404, {
        message: `project document revision ${revision} declares no environment \`${name}\` (declared: ${declared})`,
        cause: { code: 'ENVIRONMENT_NOT_FOUND' },
      });
    }
    return c.json(await readEnvironmentState(id, document, { name, declaration: decl }));
  },
);
