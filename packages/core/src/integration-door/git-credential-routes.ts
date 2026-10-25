/**
 * `POST /api/devices/me/git-credential` — the runner's git credential helper
 * asks here, once per git invocation, for an hour-long credential that reaches one repository.
 *
 * A helper is the only shape that works: the credential expires in an hour, jobs do not, and the
 * provision side-channel delivers once. Any source host that declares a `gitCredential` is served
 * here (ISS-50): a GitHub App's installation token, or for a host reached only through Forge's git
 * relay (GitLab), a relay ticket — a connection's own token is never answered to a runner at or
 * past the relay (REQ-73 BC-5; older ones under `host-credential.ts:PRE_RELAY_RUNNER_AMNESTY`).
 * Nothing is stored on the box and nothing is stored here — the grant is computed from the device's
 * runners and the project's binding every time it is asked for.
 */

import { withArticle } from '@forge/contracts/articles';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { mintGitCredentialForDevice } from '../integrations/source-host/index.js';
import { logger } from '../lib/logger.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';

export const deviceGitCredentialRoutes = new Hono<{ Variables: DeviceVars }>();

const askBody = z
  .object({
    host: z.string().trim().min(1).max(255),
    path: z.string().trim().min(1).max(500),
    protocol: z.string().trim().max(20).optional(),
  })
  .strict();

deviceGitCredentialRoutes.post(
  '/me/git-credential',
  requireDevice(),
  zValidator('json', askBody, invalid('host and path are required')),
  async (c) => {
    const device = c.get('device');
    const { host, path, protocol } = c.req.valid('json');

    if (protocol && protocol !== 'https') {
      throw new HTTPException(400, {
        message: `git asked for ${withArticle(protocol)} credential; this helper issues HTTPS credentials only`,
      });
    }

    const grant = await mintGitCredentialForDevice({
      deviceId: device.id,
      agentVersion: device.agentVersion ?? null,
      host,
      path,
    });
    if (grant.preRelay) {
      logger.warn(
        {
          deviceId: device.id,
          agentVersion: device.agentVersion ?? null,
          repository: grant.repository,
        },
        'git-credential: served the connection token to a runner older than the relay (PRE_RELAY_RUNNER_AMNESTY)',
      );
    }
    logger.info(
      {
        deviceId: device.id,
        projectId: grant.projectId,
        repository: grant.repository,
        expiresAt: grant.expiresAt,
      },
      'git-credential: handed out an hour-long git credential',
    );
    return c.json({
      username: grant.username,
      password: grant.password,
      expiresAt: grant.expiresAt,
    });
  },
);
