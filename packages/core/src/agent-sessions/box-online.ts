// An offline box carries no turn, so every session read states its box's state from here (ISS-1228).

import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';

/** `null` where the session names no box, or one core no longer holds. */
export function boxOnlineOf(deviceStatus: string | null | undefined): boolean | null {
  return deviceStatus == null ? null : deviceStatus === 'online';
}

export async function loadBoxStatuses(
  deviceIds: ReadonlyArray<string | null>,
): Promise<Map<string, string>> {
  const ids = [...new Set(deviceIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: devices.id, status: devices.status })
    .from(devices)
    .where(inArray(devices.id, ids));
  return new Map(rows.map((r) => [r.id, r.status]));
}
