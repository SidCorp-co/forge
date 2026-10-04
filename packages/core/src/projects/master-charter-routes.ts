import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest, idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireCan } from '../permissions/index.js';
import { parseMasterCharterWrite } from './master-charter.js';
import {
  declareCharter,
  type MasterCharter,
  readCharterVersions,
  readCurrentCharter,
} from './master-charter-service.js';

/**
 * What a project's master is for, and the rules that bind it (ISS-1313).
 *
 * Two reads and one write. The reads are open to anything holding access to the
 * project, a master's own token included — reading is the whole point. The
 * write takes charter.write, which a token holds only where its grant names it,
 * so a master's own token cannot rewrite the charter that binds it.
 */
export const masterCharterRoutes = new Hono<{ Variables: AuthVars }>();
masterCharterRoutes.use('*', requireAuth(), assertEmailVerified());

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
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid project id');
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    await requireCan({ userId: c.get('userId') }, 'project.read', id);

    const charter = await readCurrentCharter(id);
    if (!charter) return c.json(UNDECLARED);
    return c.json({ declared: true, ...serialise(charter) });
  },
);

masterCharterRoutes.get(
  '/:id/master-charter/versions',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid project id');
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    await requireCan({ userId: c.get('userId') }, 'project.read', id);

    const versions = await readCharterVersions(id);
    return c.json({ versions: versions.map(serialise), returned: versions.length });
  },
);

masterCharterRoutes.put(
  '/:id/master-charter',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid project id');
  }),
  zValidator('json', z.unknown()),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await requireCan({ userId }, 'charter.write', id, 'writing the master charter');

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
