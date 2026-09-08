/**
 * `POST /api/devices/me/git-credential` — the runner's git credential helper
 * asks here, once per git invocation, for a token that reaches one repository.
 *
 * A helper is the only shape that works: an installation token expires in an
 * hour, jobs do not, and the provision side-channel delivers once. Nothing is
 * stored on the box and nothing is stored here — the grant is computed from the
 * device's runners and the project's binding every time it is asked for.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { logger } from '../logger.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { GitCredentialError, mintGitCredentialForDevice } from './github-app-credential.js';

export const deviceGitCredentialRoutes = new Hono<{ Variables: DeviceVars }>();

const askBody = z
  .object({
    host: z.string().trim().min(1).max(255),
    path: z.string().trim().min(1).max(500),
    protocol: z.string().trim().max(20).optional(),
  })
  .strict();

// cm:edge protocol -> packages/runner/crates/forge-runner/src/cmd/git_credential.rs — the response field names ARE git's credential-helper keys, so a rename here silently stops authenticating git rather than failing a type check.
deviceGitCredentialRoutes.post(
  '/me/git-credential',
  requireDevice(),
  zValidator('json', askBody, (result) => {
    if (!result.success) throw new HTTPException(400, { message: 'host and path are required' });
  }),
  async (c) => {
    const device = c.get('device');
    if (device.status === 'revoked')
      throw new HTTPException(401, { message: 'this device is revoked' });
    const { host, path, protocol } = c.req.valid('json');

    // cm:guard refuse a non-HTTPS ask rather than answering it — a token handed over cleartext http is a leaked token, and git offers no way to learn afterwards that it travelled in the clear.
    if (protocol && protocol !== 'https') {
      throw new HTTPException(400, {
        message: `git asked for a ${protocol} credential; this helper issues HTTPS credentials only`,
      });
    }

    try {
      const grant = await mintGitCredentialForDevice({ deviceId: device.id, host, path });
      // cm:guard log the repository and the expiry, NEVER the grant — this line is the only record that a token was issued, and the scrubber cannot rescue a password a handler chose to print.
      logger.info(
        {
          deviceId: device.id,
          projectId: grant.projectId,
          repository: grant.repository,
          expiresAt: grant.expiresAt,
        },
        'git-credential: minted an installation token',
      );
      return c.json({
        username: grant.username,
        password: grant.password,
        expiresAt: grant.expiresAt,
      });
    } catch (err) {
      if (err instanceof GitCredentialError) {
        throw new HTTPException(err.status as 400, { message: err.message });
      }
      throw err;
    }
  },
);
