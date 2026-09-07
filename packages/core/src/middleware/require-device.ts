/**
 * The gate for a paired box (ISS-932).
 *
 * A device is a registry row, not a credential: what authenticates here is an
 * ordinary PAT or AAT whose `device_id` names the box. The device principal is
 * still its own — `userId` is deliberately left unset so every handler that
 * authorizes through `loadProjectAccess(_, userId)` fails closed unless it
 * honours the device explicitly.
 */

import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyDeviceCredential } from '../auth/device-credential.js';
import type { Device } from '../db/schema.js';
import { parseBearerHeader } from './bearer.js';

export type AuthedDevice = Device;

export type DeviceVars = { device: AuthedDevice };

const unauth = (message: string) =>
  new HTTPException(401, { message, cause: { code: 'UNAUTHENTICATED' } });

// cm:guard the message names the CLASS and the remedy, mirroring `DEVICE_TOKEN_REFUSAL` on `/mcp` in the other direction. The two credentials Forge now has are the same species and differ only by `device_id`, so "invalid token" would send an operator hunting for an expired PAT when what they hold is a perfectly good one that was never issued to a box. Every runner paired before ISS-932 holds a token that no longer verifies anywhere and reads THIS line to learn it must re-run `forge login`.
export const NOT_A_DEVICE_CREDENTIAL =
  'this route needs the credential a paired box was issued — the token presented ' +
  'carries no device, so it speaks for a person or an agent rather than a machine. ' +
  'Run `forge login` on the box to be issued one. Device tokens minted before Forge ' +
  'unified its credentials no longer verify anywhere and must be replaced the same way.';

export const requireDevice = (): MiddlewareHandler<{ Variables: DeviceVars }> => {
  return async (c, next) => {
    const parsed = parseBearerHeader(c);
    if (parsed.kind === 'absent') throw unauth('authentication required');
    if (parsed.kind === 'malformed') throw unauth('invalid authorization header');

    const device = await verifyDeviceCredential(parsed.token);
    if (!device) throw unauth(NOT_A_DEVICE_CREDENTIAL);

    c.set('device', device);
    await next();
  };
};
