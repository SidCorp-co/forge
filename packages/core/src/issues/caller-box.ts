// The box a caller acts from, as the run lane names a holder: the device itself, or the device the
// caller's token belongs to. One reader, so the lease a box writes and the move it makes later name
// the same box.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { actorFor } from '../permissions/index.js';

export interface CallerBox {
  /** The paired box, or null where the caller is a person or a token bound to no box. */
  deviceId: string | null;
  /** The token the call came with, or null for a session or a device credential. */
  tokenId: string | null;
}

export async function callerBoxOf(
  actorUserId: string | null,
  deviceId: string | null,
): Promise<CallerBox> {
  const tokenId = actorUserId ? actorFor(actorUserId).tokenId : null;
  if (deviceId) return { deviceId, tokenId };
  if (!tokenId) return { deviceId: null, tokenId: null };
  const rows = (await db.execute(
    sql`SELECT device_id FROM personal_access_tokens WHERE id = ${tokenId}`,
  )) as unknown as Array<{ device_id: string | null }>;
  return { deviceId: rows[0]?.device_id ?? null, tokenId };
}
