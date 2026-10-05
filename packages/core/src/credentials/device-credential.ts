import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Device, devices } from '../db/schema.js';
import { verifyPat } from './pat.js';
import { isPatLike } from './pat-format.js';
import type { PatScope } from './pat-scope.js';

/** A live box credential, and the fence its token carries: the projects it was minted for. */
export async function verifyDeviceToken(
  plaintext: unknown,
): Promise<{ device: Device; scope: PatScope } | null> {
  if (typeof plaintext !== 'string' || !isPatLike(plaintext)) return null;

  const verified = await verifyPat(plaintext);
  const row = verified?.row;
  if (!row?.deviceId) return null;

  const [device] = await db.select().from(devices).where(eq(devices.id, row.deviceId)).limit(1);
  if (!device || device.status === 'revoked') return null;
  const projectIds = row.boundProjectId ? [row.boundProjectId] : (row.projectIds ?? []);
  return {
    device,
    scope: {
      projectIds,
      tokenId: row.id,
      userId: row.userId,
      grant: row.permissions ?? null,
      scopes: row.scopes,
    },
  };
}

export async function verifyDeviceCredential(plaintext: unknown): Promise<Device | null> {
  return (await verifyDeviceToken(plaintext))?.device ?? null;
}
