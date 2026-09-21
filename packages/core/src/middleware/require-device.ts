import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyDeviceCredential } from '../auth/device-credential.js';
import type { Device } from '../db/schema.js';
import { parseBearerHeader } from './bearer.js';

export type AuthedDevice = Device;

export type DeviceVars = { device: AuthedDevice };

const unauth = (message: string) =>
  new HTTPException(401, { message, cause: { code: 'UNAUTHENTICATED' } });

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
