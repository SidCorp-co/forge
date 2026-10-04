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
