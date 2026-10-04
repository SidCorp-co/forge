/**
 * `GET|PUT /api/projects/:id/content-language`: the language agents write this project's prose in.
 * The value lives in the project document (`contentLanguage`, `keepTermsInEnglish`); this door reads
 * it resolved and writes just that pair at the revision read.
 */

import {
  CONTENT_LANGUAGE_WRITE_SHAPE,
  type ContentLanguageView,
  contentLanguageOf,
  contentLanguageWriteSchema,
} from '@forge/contracts/content-language';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { readContentLanguage, writeContentLanguage } from './content-language.js';

export const contentLanguageRoutes = new Hono<{ Variables: AuthVars }>();

contentLanguageRoutes.use('/:id/content-language', requireAuth(), assertEmailVerified());

const projectParam = zValidator('param', z.object({ id: z.uuid() }), (r) => {
  if (!r.success) {
    throw new HTTPException(400, {
      message: 'invalid path: the project id is a uuid',
      cause: { code: 'BAD_REQUEST' },
    });
  }
});

contentLanguageRoutes.get('/:id/content-language', projectParam, async (c) => {
  const { id } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  return c.json(await readContentLanguage(id));
});

contentLanguageRoutes.put(
  '/:id/content-language',
  projectParam,
  strictBody(contentLanguageWriteSchema, CONTENT_LANGUAGE_WRITE_SHAPE),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await requireCan(actorFor(userId), 'project.admin', projectResource(id));
    const outcome = await writeContentLanguage({
      projectId: id,
      userId,
      write: c.req.valid('json'),
    });
    if (!outcome.ok) return refused(c, outcome.refusals, 'CONTENT_LANGUAGE_REFUSED');
    const view: ContentLanguageView = {
      ...contentLanguageOf(outcome.held.document),
      revision: outcome.held.revision,
    };
    return c.json(view);
  },
);
