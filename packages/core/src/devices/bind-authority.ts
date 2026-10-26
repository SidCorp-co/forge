/**
 * A device is bound to a project only where the account that paired it is a member of the project
 * or its organization: any other box would be handed this project's jobs, checkout and credentials.
 */

import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';
import { effectiveProjectRole } from '../lib/authz.js';

export async function ownerHoldsProject(ownerId: string, projectId: string): Promise<boolean> {
  const access = await effectiveProjectRole(ownerId, projectId);
  return access !== null && (access.role !== null || access.orgRole !== null);
}

export function deviceNotHeld(deviceId: string, projectId: string): HTTPException {
  return new HTTPException(403, {
    message: `Device ${deviceId} cannot be bound to this project: the account that paired it is a member of neither the project nor its organization. Bind a device paired by a member, or invite the account that paired this one first.`,
    cause: { code: 'DEVICE_NOT_HELD', details: { deviceId, projectId } },
  });
}

export async function assertDeviceBindable(deviceId: string, projectId: string): Promise<void> {
  const [device] = await db
    .select({ ownerId: devices.ownerId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) {
    throw new HTTPException(404, {
      message: 'device not found',
      cause: { code: 'DEVICE_NOT_FOUND' },
    });
  }
  if (!(await ownerHoldsProject(device.ownerId, projectId))) {
    throw deviceNotHeld(deviceId, projectId);
  }
}
