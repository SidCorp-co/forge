import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { type Device, verifyDeviceToken } from '../auth/deviceToken.js';
import { parseBearerHeader } from './bearer.js';

export type AuthedDevice = Device;

export type DeviceVars = { device: AuthedDevice };

type UnauthCode = 'UNAUTHENTICATED';

const unauth = (code: UnauthCode, message: string) =>
  new HTTPException(401, { message, cause: { code } });

/**
 * Authenticates a device principal via `Authorization: Bearer <token>`.
 *
 * Device tokens are header-only — there is no cookie fallback because
 * devices are not browsers. Tokens are verified via `verifyDeviceToken`
 * (argon2 over prefix-indexed lookup).
 *
 * On success: `c.get('device')` returns the Device row.
 * On failure (missing/malformed header, invalid token, revoked device):
 *   throws `HTTPException(401, { cause: { code: 'UNAUTHENTICATED' } })`.
 *
 * Does NOT populate `c.get('user')` — device and user principals are distinct.
 */
export const requireDevice = (): MiddlewareHandler<{ Variables: DeviceVars }> => {
  return async (c, next) => {
    const parsed = parseBearerHeader(c);
    if (parsed.kind === 'absent') throw unauth('UNAUTHENTICATED', 'authentication required');
    if (parsed.kind === 'malformed')
      throw unauth('UNAUTHENTICATED', 'invalid authorization header');
    const token = parsed.token;

    const device = await verifyDeviceToken(token);
    if (!device) throw unauth('UNAUTHENTICATED', 'invalid device token');

    c.set('device', device);
    await next();
  };
};
