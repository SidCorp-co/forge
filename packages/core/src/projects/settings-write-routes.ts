import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { assertOrgRoleOnProject, loadProjectAccess } from '../lib/authz.js';
import { isEnabled } from '../lib/feature-flags.js';
import type { AuthVars } from '../middleware/auth.js';
import { pipelineConfigPatchSchema } from '../pipeline/pipeline-config-schema.js';
import { updatePipelineConfig } from '../pipeline/pipeline-config-service.js';
import { ENVIRONMENTS_WRITE_SHAPE_MESSAGE } from './environments.js';
import {
  environmentsHttpError,
  readEnvironments,
  updateEnvironments,
} from './environments-service.js';
import { pipelineConfigHttpError } from './pipeline-config-http.js';
import {
  badRequest,
  flatten,
  forbidden,
  idParamSchema,
  pipelineFlagOff,
  refuseByName,
} from './route-errors.js';

// The two settings documents a screen writes, under one contract: a write says what it read
// (`base`) and what it wants changed (`patch`), the server compares at the paths the patch
// names, and the write is applied whole or refused whole. Each document has exactly one door,
// and neither accepts a whole document: sent whole, it carries away every key the sender did
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

export const PIPELINE_CONFIG_WRITE_SHAPE_MESSAGE =
  "a pipeline config write is `{ base, patch }`: `patch` holds only the keys you are changing (`null` deletes one) and `base` is the `pipelineConfig` that `GET /api/projects/:id/pipeline-config` answered. A bare document is refused, because a document sent whole replaced every key the sender did not resend — which is how one settings section discarded another section's saved change.";

projectSettingsWriteRoutes.patch(
  '/:id/pipeline-config',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(flatten(result.error));
  }),
  zValidator(
    'json',
    writeShape(PIPELINE_CONFIG_WRITE_SHAPE_MESSAGE, pipelineConfigPatchSchema),
    (result) => {
      if (result.success) return;
      refuseByName(result.error, PIPELINE_CONFIG_WRITE_SHAPE_MESSAGE, 'CONFIG_PATCH_SHAPE');
      throw badRequest(flatten(result.error));
    },
  ),
  async (c) => {
    if (!isEnabled('pipelineControl')) throw pipelineFlagOff();

    const { id } = c.req.valid('param');
    const { base, patch } = c.req.valid('json');

    const access = await loadProjectAccess(id, c.get('userId'));
    assertOrgRoleOnProject(access, 'admin', 'org admin required');

    try {
      return c.json(await updatePipelineConfig({ projectId: id, patch, base }));
    } catch (err) {
      throw pipelineConfigHttpError(err);
    }
  },
);

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
