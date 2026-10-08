import type { DeviceRefusalCode } from '@forge/contracts/devices';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readBoxToken } from '../credentials/device-credential.js';
import type { TurnTokenOrigin } from '../credentials/pat-format.js';
import type { Device } from '../db/schema.js';
import { refuser } from '../lib/refusal.js';
import { parseBearerHeader } from './bearer.js';
import { declareGate } from './declared-gate.js';

type AuthedDevice = Device;

export type DeviceVars = { device: AuthedDevice };

const unauth = (message: string) =>
  new HTTPException(401, { message, cause: { code: 'UNAUTHENTICATED' } });

const NOT_A_DEVICE_CREDENTIAL =
  'this route needs the credential a paired box was issued — the token presented ' +
  'carries no device, so it speaks for a person or an agent rather than a machine. ' +
  'Run `forge login` on the box to be issued one. Device tokens minted before Forge ' +
  'unified its credentials no longer verify anywhere and must be replaced the same way.';

const refuse = refuser<DeviceRefusalCode>('DEVICE_REFUSED');

const HANDED_TO: Record<TurnTokenOrigin['door'], string> = {
  'box-session': "a chat session's turn",
  'assistant-turn': "the Assistant's turn",
  agreement: 'the write of one agreed proposal',
};

/**
 * A token core handed a chat is tied to the box it runs on and acts for the person it answers; it
 * is never the box (REQ-30 BC-4), so a route only a box calls refuses it by name.
 */
const notABox = (door: TurnTokenOrigin['door']) =>
  refuse(
    'TURN_CREDENTIAL_NOT_A_BOX',
    `this token was minted for ${HANDED_TO[door]}, to act as the person it answers, and is never a paired box's credential, so this route, which only a box calls, refuses it; nothing was done`,
  );

export const requireDevice = (): MiddlewareHandler<{ Variables: DeviceVars }> => {
  return declareGate('requireDevice', async (c, next) => {
    const parsed = parseBearerHeader(c);
    if (parsed.kind === 'absent') throw unauth('authentication required');
    if (parsed.kind === 'malformed') throw unauth('invalid authorization header');

    const read = await readBoxToken(parsed.token);
    if (read?.kind === 'handed') throw notABox(read.origin.door);
    if (!read) throw unauth(NOT_A_DEVICE_CREDENTIAL);

    c.set('device', read.device);
    await next();
  });
};
