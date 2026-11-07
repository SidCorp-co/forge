import {
  AGREEMENT_RESTORE_SHAPE,
  AGREEMENT_SLUG,
  AGREEMENT_SLUG_MAX,
  AGREEMENT_WRITE_SHAPE,
  AGREEMENTS_QUERY_SHAPE,
  agreementRestoreSchema,
  agreementsQuerySchema,
  agreementWriteSchema,
} from '@forge/contracts/agreements';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { recordReached } from '../run-context/index.js';
import {
  readAgreement,
  readAgreements,
  restoreAgreement,
  taskOf,
  writeAgreement,
} from './service.js';

/**
 * A project's working agreements (REQ-90): read by anyone who reads the project, each resolved for
 * the task named; changed only by a project admin. A box credential's read is recorded against its
 * run (run-context), so a run's received agreements include those it fetched.
 */
export const agreementRoutes = new Hono<{ Variables: AuthVars }>();

agreementRoutes.use('/:id/agreements', requireAuth(), assertEmailVerified());
agreementRoutes.use('/:id/agreements/*', requireAuth(), assertEmailVerified());

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);
const slugParam = zValidator(
  'param',
  z.object({
    id: z.uuid(),
    slug: z.string().min(1).max(AGREEMENT_SLUG_MAX).regex(AGREEMENT_SLUG),
  }),
  invalid(
    `invalid path: /api/projects/<project uuid>/agreements/<slug>, the slug kebab-case, 1-${AGREEMENT_SLUG_MAX} characters`,
    'AGREEMENT_SLUG_INVALID',
  ),
);
const READ = requiresOnParam('project.read', 'id');
const ADMIN = requiresOnParam('project.admin', 'id');

agreementRoutes.get(
  '/:id/agreements',
  projectParam,
  READ,
  zValidator('query', agreementsQuerySchema, invalid(`invalid query: ${AGREEMENTS_QUERY_SHAPE}`)),
  async (c) => {
    const { id } = c.req.valid('param');
    const view = await readAgreements(id, await taskOf(id, c.req.valid('query')));
    recordReached(c, id, 'get', {
      agreements: view.agreements.map((a) => ({ slug: a.slug, revision: a.effective.revision })),
    });
    return c.json(view);
  },
);

agreementRoutes.get('/:id/agreements/:slug', slugParam, READ, noQuery, async (c) => {
  const { id, slug } = c.req.valid('param');
  const view = await readAgreement(id, slug);
  recordReached(c, id, 'get', {
    agreements: [{ slug: view.slug, revision: view.effective.revision }],
  });
  return c.json(view);
});

agreementRoutes.put(
  '/:id/agreements/:slug',
  slugParam,
  ADMIN,
  strictBody(agreementWriteSchema, AGREEMENT_WRITE_SHAPE),
  async (c) => {
    const { id, slug } = c.req.valid('param');
    return c.json(await writeAgreement(id, slug, c.req.valid('json'), c.get('userId')));
  },
);

agreementRoutes.post(
  '/:id/agreements/:slug/restore',
  slugParam,
  ADMIN,
  strictBody(agreementRestoreSchema, AGREEMENT_RESTORE_SHAPE),
  async (c) => {
    const { id, slug } = c.req.valid('param');
    return c.json(await restoreAgreement(id, slug, c.req.valid('json'), c.get('userId')));
  },
);
