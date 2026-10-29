import {
  INSTANCE_SETTINGS_PATCH_SHAPE,
  instanceSettingsPatchSchema,
} from '@forge/contracts/instance-settings';
import { Hono } from 'hono';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { noQuery, strictBody } from '../middleware/zod-validator.js';
import { readInstanceSettings, writeInstanceSettings } from './service.js';

/** `/api/admin/instance-settings`: an instance admin reads and sets what the instance says of itself. */
export const instanceSettingsRoutes = new Hono<{ Variables: AuthVars }>();
instanceSettingsRoutes.use(
  '/instance-settings',
  requireAuth(),
  assertEmailVerified(),
  requireAdmin(),
);

instanceSettingsRoutes.get('/instance-settings', noQuery, async (c) =>
  c.json(await readInstanceSettings()),
);

instanceSettingsRoutes.patch(
  '/instance-settings',
  strictBody(instanceSettingsPatchSchema, INSTANCE_SETTINGS_PATCH_SHAPE),
  async (c) => c.json(await writeInstanceSettings(c.req.valid('json'), c.get('userId'))),
);
