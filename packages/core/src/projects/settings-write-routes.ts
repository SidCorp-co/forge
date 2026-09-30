import { Hono } from 'hono';
import { z } from 'zod';
import { assertOrgRoleOnProject, loadProjectAccess } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { ENVIRONMENTS_WRITE_SHAPE_MESSAGE } from './environments.js';
import {
  environmentsHttpError,
  readEnvironments,
  updateEnvironments,
} from './environments-service.js';
import { badRequest, flatten, forbidden, idParamSchema, refuseByName } from './route-errors.js';

// The settings document a screen writes, under one contract: a write says what it read
// (`base`) and what it wants changed (`patch`), the server compares at the paths the patch
// names, and the write is applied whole or refused whole. The document has exactly one door,
// and it does not accept a whole document: sent whole, it carries away every key the sender did
// not resend, which is how two sections of one settings page discard each other (ISS-1170).

export const projectSettingsWriteRoutes = new Hono<{ Variables: AuthVars }>();

/** `{ base, patch }`, refused by name where a caller sends the document itself. */
function writeShape<T extends z.ZodType>(message: string, patch: T) {
  return z
    .unknown()
    .superRefine((raw, ctx) => {
      const body = raw as Record<string, unknown> | null;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        ctx.addIssue({ code: 'custom', message });
        return;
      }
      if (!('patch' in body) || !('base' in body)) {
        ctx.addIssue({ code: 'custom', message });
      }
    })
    .pipe(z.object({ base: z.record(z.string(), z.unknown()), patch }).strict());
}

projectSettingsWriteRoutes.get(
  '/:id/environments',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(flatten(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const access = await loadProjectAccess(id, c.get('userId'));
    if (!access.role) throw forbidden('not a project member');
    try {
      return c.json({ environments: await readEnvironments(id) });
    } catch (err) {
      throw environmentsHttpError(err);
    }
  },
);

projectSettingsWriteRoutes.patch(
  '/:id/environments',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(flatten(result.error));
  }),
  zValidator(
    'json',
    writeShape(ENVIRONMENTS_WRITE_SHAPE_MESSAGE, z.record(z.string(), z.unknown())),
    (result) => {
      if (result.success) return;
      refuseByName(result.error, ENVIRONMENTS_WRITE_SHAPE_MESSAGE, 'ENVIRONMENTS_WRITE_SHAPE');
      throw badRequest(flatten(result.error));
    },
  ),
  async (c) => {
    const { id } = c.req.valid('param');
    const { base, patch } = c.req.valid('json');
    const access = await loadProjectAccess(id, c.get('userId'));
    assertOrgRoleOnProject(access, 'admin', 'org admin required');
    try {
      return c.json(await updateEnvironments({ projectId: id, patch, base }));
    } catch (err) {
      throw environmentsHttpError(err);
    }
  },
);
