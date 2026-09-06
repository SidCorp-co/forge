/**
 * Verifying the credential a paired box holds (ISS-932).
 *
 * The successor to `auth/deviceToken.ts`, which owned a second argon2 secret
 * living in `devices.token_hash`. There is no second secret now: a box holds an
 * ordinary PAT or AAT whose `device_id` names it, so this reads the token
 * through `verifyPat` and returns the row that column points at.
 *
 * One function, three callers — `requireDevice`, `requireUserOrDevice` and the
 * `/ws` upgrade — because a box's identity must not be resolved two ways.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Device, devices } from '../db/schema.js';
import { verifyPat } from './pat.js';
import { isPatLike } from './pat-format.js';

// cm:guard deliberately NOT routed through `authenticatePat`, so a box's traffic does not charge the per-token REST bucket. Device surfaces carried no rate limit at all before ISS-932 (the argon2 device token had none), the pool is polled once per binding per tick, and `/ws` authenticates once for a connection that then lives for hours — metering any of those through the human-sized `RULES.patPerToken` knob would throttle a fleet on a number an operator tuned for a person. The token's own `rate_limit_max` is still pinned at mint (`devices/credential.ts`) for the surfaces that DO meter.
export async function verifyDeviceCredential(plaintext: unknown): Promise<Device | null> {
  if (typeof plaintext !== 'string' || !isPatLike(plaintext)) return null;

  const verified = await verifyPat(plaintext);
  const deviceId = verified?.row.deviceId;
  if (!deviceId) return null;

  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  // cm:guard revoking a box and revoking its token are two writes, and this is the one that fails closed if the other did not land. Trusting the token alone leaves an unpaired machine authenticated for as long as its credential outlives the revoke.
  if (!device || device.status === 'revoked') return null;
  return device;
}
