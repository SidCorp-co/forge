import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { gatedRoutes } from '../middleware/gated-routes.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { parseMasterCharterWrite } from './master-charter.js';
import {
  declareCharter,
  type MasterCharter,
  readCurrentCharter,
} from './master-charter-service.js';

/**
 * What a project's master is for, and the rules that bind it (ISS-1313).
 *
 * Two reads and one write. The reads are open to anything holding access to the
 * project, a master's own token included — reading is the whole point. The
 * write takes charter.write, which a full token holds where its holder's role
 * does and a named token only where its grant names it (REQ-27 BC-4).
 */
export const masterCharterRoutes = gatedRoutes<{ Variables: AuthVars }>(
  requireAuth(),
  assertEmailVerified(),
);

const serialise = (charter: MasterCharter) => ({
  version: charter.version,
  goal: charter.goal,
  rules: charter.rules,
  declaredBy: charter.declaredBy,
  declaredAt: charter.declaredAt.toISOString(),
});

/** What a project that has declared nothing answers with — 200, not 404. */
const UNDECLARED = {
  declared: false as const,
  version: null,
  goal: null,
  rules: [] as string[],
  declaredBy: null,
  declaredAt: null,
};

masterCharterRoutes.get(
  '/:id/master-charter',
  zValidator('param', idParamSchema, invalid('invalid project id')),
  requiresOnParam('project.read', 'id'),
  noQuery,
  async (c) => {
    const { id } = c.req.valid('param');

    const charter = await readCurrentCharter(id);
    if (!charter) return c.json(UNDECLARED);
    return c.json({ declared: true, ...serialise(charter) });
  },
);

masterCharterRoutes.put(
  '/:id/master-charter',
  zValidator('param', idParamSchema, invalid('invalid project id')),
  requiresOnParam('charter.write', 'id'),
  zValidator('json', z.unknown()),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const parsed = parseMasterCharterWrite(c.req.valid('json'));
    if (!parsed.ok) {
      throw new HTTPException(400, {
        message: parsed.refusal.message,
        cause: { code: 'MASTER_CHARTER_SHAPE', details: { field: parsed.refusal.field } },
      });
    }

    const { charter, created } = await declareCharter({
      projectId: id,
      userId,
      write: parsed.value,
    });
    return c.json({ declared: true, created, ...serialise(charter) });
  },
);
