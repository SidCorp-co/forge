import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';

/** The plugin version a paired box last named in `x-forge-plugin`, and when (ISS-1104). */
export async function recordDevicePluginVersion(deviceId: string, version: string): Promise<void> {
  await db
    .update(devices)
    .set({ pluginVersion: version, pluginSeenAt: sql`now()` })
    .where(eq(devices.id, deviceId));
}
