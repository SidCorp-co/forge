// The REST find (ISS-1256): one search over every record type of a project, the hit opened with the
// read it records, and the gaps the misses left. `forge_find` reads the same `runFind`.

import { findGapsQuerySchema, findOpenQuerySchema, findQuerySchema } from '@forge/contracts/find';
import { requestReader } from '../lib/authz.js';
import { RULES } from '../lib/rate-limits.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  restAuthored,
} from '../middleware/auth.js';
import { gatedRoutes } from '../middleware/gated-routes.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { recordReached } from '../run-context/index.js';
import { readFindGaps } from './gaps.js';
import { openHit } from './open.js';
import { runFind } from './service.js';

export const findRoutes = gatedRoutes<{ Variables: AuthVars }>(
  requireAuth(),
  assertEmailVerified(),
);

const READ = requiresOnParam('project.read', 'id');

// a POST, as every search door with a body is: its calls are logged, so the door use counts them
findRoutes.post(
  '/:id/find',
  rateLimit(() => RULES.knowledgeSearch, { name: 'find' }),
  zValidator('param', idParamSchema),
  READ,
  zValidator('json', findQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { result } = await runFind({
      projectId: id,
      projectIds: [id],
      query: c.req.valid('json'),
      reader: requestReader(c.get('userId')),
      askedBy: restAuthored(c) === 'agent' ? 'agent' : 'person',
    });
    return c.json(result);
  },
);

findRoutes.get(
  '/:id/find/open',
  zValidator('param', idParamSchema),
  READ,
  zValidator('query', findOpenQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { opened, found } = await openHit({
      projectId: id,
      projectIds: [id],
      id: c.req.valid('query').id,
    });
    recordReached(c, id, 'get', found);
    return c.json(opened);
  },
);

findRoutes.get(
  '/:id/find/gaps',
  zValidator('param', idParamSchema),
  READ,
  zValidator('query', findGapsQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await readFindGaps(id, c.req.valid('query').days));
  },
);
