import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';

/** The git credential a box was provisioned with, by reference. */
export async function stampGitCredentialRef(deviceId: string, ref: string): Promise<void> {
  await db.update(devices).set({ gitCredentialRef: ref }).where(eq(devices.id, deviceId));
}

/** How many job panes the box's master declared it runs. */
export async function setMaxJobPanes(deviceId: string, maxJobPanes: number): Promise<void> {
  await db.update(devices).set({ maxJobPanes }).where(eq(devices.id, deviceId));
}
