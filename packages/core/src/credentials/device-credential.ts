import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Device, devices } from '../db/schema.js';
import { verifyPat } from './pat.js';
import { isPatLike, type TurnTokenOrigin, turnTokenOrigin } from './pat-format.js';
import type { PatScope } from './pat-scope.js';

/**
 * What a token bound to a paired box is: the box's own credential, or one core handed a chat — a
 * session's turn token, the Assistant's turn token, an agreed proposal's token — which is tied to
 * the box it runs on but acts for the person it answers, and is never the box (REQ-30 BC-4). A
 * handed token is admitted as a token wherever a token is, so the chat write rule reads it there.
 */
export type BoxToken =
  | { kind: 'box'; device: Device; scope: PatScope }
  | { kind: 'handed'; origin: TurnTokenOrigin };

export async function readBoxToken(plaintext: unknown): Promise<BoxToken | null> {
  if (typeof plaintext !== 'string' || !isPatLike(plaintext)) return null;

  const verified = await verifyPat(plaintext);
  const row = verified?.row;
  if (!row?.deviceId) return null;
  const origin = turnTokenOrigin(row.name);
  if (origin) return { kind: 'handed', origin };

  const [device] = await db.select().from(devices).where(eq(devices.id, row.deviceId)).limit(1);
  if (!device || device.status === 'revoked') return null;
  const projectIds = row.boundProjectId ? [row.boundProjectId] : (row.projectIds ?? []);
  return {
    kind: 'box',
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

/** A live box credential, and the fence its token carries: the projects it was minted for. */
export async function verifyDeviceToken(
  plaintext: unknown,
): Promise<{ device: Device; scope: PatScope } | null> {
  const read = await readBoxToken(plaintext);
  return read?.kind === 'box' ? { device: read.device, scope: read.scope } : null;
}

export async function verifyDeviceCredential(plaintext: unknown): Promise<Device | null> {
  return (await verifyDeviceToken(plaintext))?.device ?? null;
}
