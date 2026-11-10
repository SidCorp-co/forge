import {
  INSTANCE_SETTINGS_PATCH_SHAPE,
  instanceSettingsPatchSchema,
} from '@forge/contracts/instance-settings';
import { PLUGIN_ARCHIVE_COMMIT_HEADER } from '@forge/contracts/plugins';
import { Hono } from 'hono';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { type PrincipalVars, requirePat } from '../middleware/require-pat.js';
import { noQuery, strictBody } from '../middleware/zod-validator.js';
import { requiresInstanceAdmin, requiresNoPermission } from '../permissions/index.js';
import { designatedPluginArchive } from './plugin-archive.js';
import { readInstanceSettings, writeInstanceSettings } from './service.js';

/** `/api/admin/instance-settings`: an instance admin reads and sets what the instance says of itself. */
export const instanceSettingsRoutes = new Hono<{ Variables: AuthVars }>();
instanceSettingsRoutes.use(
  '/instance-settings',
  requireAuth(),
  assertEmailVerified(),
  requiresInstanceAdmin('what this Forge instance says of itself, owned by no project'),
);

instanceSettingsRoutes.get('/instance-settings', noQuery, async (c) =>
  c.json(await readInstanceSettings()),
);

instanceSettingsRoutes.patch(
  '/instance-settings',
  strictBody(instanceSettingsPatchSchema, INSTANCE_SETTINGS_PATCH_SHAPE),
  async (c) => c.json(await writeInstanceSettings(c.req.valid('json'), c.get('userId'))),
);

/**
 * `/api/install/plugin.tar.gz`: the forge plugin `install-plugin.sh` unpacks (REQ-25 BC-4). Its
 * source is private, so a token is asked for; it is the instance's one designated commit, the same
 * for every caller, so any token of this instance opens it, read-only ones included.
 */
export const pluginArchiveRoutes = new Hono<{ Variables: PrincipalVars }>();

pluginArchiveRoutes.get(
  '/install/plugin.tar.gz',
  async (c, next) => {
    c.set('patRequestClass', 'read');
    await next();
  },
  requirePat(),
  requiresNoPermission(
    "the instance's designated forge plugin commit, the same for every token holder; a token is asked for because the plugin's source is private",
  ),
  noQuery,
  async (c) => {
    const archive = await designatedPluginArchive();
    return c.body(new Uint8Array(archive.bytes), 200, {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="forge-plugin-${archive.commit.slice(0, 12)}.tar.gz"`,
      'cache-control': 'private, no-store',
      [PLUGIN_ARCHIVE_COMMIT_HEADER]: archive.commit,
    });
  },
);
