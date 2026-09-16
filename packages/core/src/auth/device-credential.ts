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

export async function verifyDeviceCredential(plaintext: unknown): Promise<Device | null> {
  if (typeof plaintext !== 'string' || !isPatLike(plaintext)) return null;

  const verified = await verifyPat(plaintext);
  const deviceId = verified?.row.deviceId;
  if (!deviceId) return null;

  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device || device.status === 'revoked') return null;
  return device;
}
