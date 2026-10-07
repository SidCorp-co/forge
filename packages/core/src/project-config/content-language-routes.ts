/**
 * `GET /api/projects/:id/content-language`: the language agents write this project's prose in,
 * resolved from the project document (`contentLanguage`, `keepTermsInEnglish`), which is the one
 * place it is written.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { readContentLanguage } from './content-language.js';

export const contentLanguageRoutes = new Hono<{ Variables: AuthVars }>();

contentLanguageRoutes.use('/:id/content-language', requireAuth(), assertEmailVerified());

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

contentLanguageRoutes.get('/:id/content-language', projectParam, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  return c.json(await readContentLanguage(id));
});
