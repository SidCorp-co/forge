import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyDeviceToken, type Device } from '../auth/deviceToken.js';

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
    const header = c.req.header('authorization');
    if (!header) throw unauth('UNAUTHENTICATED', 'authentication required');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const token = match?.[1]?.trim();
    if (!token) throw unauth('UNAUTHENTICATED', 'invalid authorization header');

    const device = await verifyDeviceToken(token);
    if (!device) throw unauth('UNAUTHENTICATED', 'invalid device token');

    c.set('device', device);
    await next();
  };
};
