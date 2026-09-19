import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AuthVars } from '../middleware/auth.js';
import {
  RETIRED_PROJECT_FACTS_CONFIG_MESSAGE,
  RETIRED_PROJECT_FACTS_MESSAGE,
} from './project-facts.js';

const idParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const gone = () =>
  new HTTPException(410, {
    message: `${RETIRED_PROJECT_FACTS_MESSAGE} ${RETIRED_PROJECT_FACTS_CONFIG_MESSAGE} Read this project's prose with GET /api/projects/:id/knowledge, one entry with GET /api/projects/:id/knowledge/:slug, and write one with PUT /api/projects/:id/knowledge/:slug.`,
    cause: { code: 'PROJECT_FACTS_RETIRED' },
  });

export const projectFactsRoutes = new Hono<{ Variables: AuthVars }>();

const param = zValidator('param', idParamSchema, (result) => {
  if (!result.success) throw badRequest(z.flattenError(result.error));
});

projectFactsRoutes.get('/:id/project-facts', param, () => {
  throw gone();
});

projectFactsRoutes.patch('/:id/project-facts', param, () => {
  throw gone();
});
