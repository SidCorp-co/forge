import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Device, type DevicePlatform, devices } from '../db/schema.js';
import { hashMachineId } from './credential.js';

export interface RegisterDeviceInput {
  ownerId: string;
  name: string;
  platform: DevicePlatform;
  agentVersion?: string | null;
  capabilities?: unknown;
  /** Raw stable machine id (e.g. /etc/machine-id) — hashed before storage. */
  machineId?: string | null;
}

/**
 * The box's registry row, rotated in place when this machine has one already.
 *
 * Keyed on the machine fingerprint, the way Consul and Tailscale key node
 * identity, so the row's id — and therefore every `runners` binding, `jobs`
 * and `agent_sessions` reference to it — survives a re-pair.
 */
export async function registerDevice(input: RegisterDeviceInput): Promise<Device> {
  const machineIdHash = input.machineId ? hashMachineId(input.machineId) : null;

  if (machineIdHash) {
    const [existing] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(
        and(
          eq(devices.ownerId, input.ownerId),
          eq(devices.machineId, machineIdHash),
          ne(devices.status, 'revoked'),
        ),
      )
      .limit(1);

    if (existing) {
      const [rotated] = await db
        .update(devices)
        .set({
          name: input.name,
          platform: input.platform,
          status: 'offline',
          ...(input.agentVersion !== undefined ? { agentVersion: input.agentVersion } : {}),
          ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
        })
        .where(eq(devices.id, existing.id))
        .returning();
      if (!rotated) throw new Error('registerDevice: rotate returned no row');
      return rotated;
    }
  }

  const [device] = await db
    .insert(devices)
    .values({
      ownerId: input.ownerId,
      name: input.name,
      platform: input.platform,
      agentVersion: input.agentVersion ?? null,
      capabilities: input.capabilities ?? null,
      machineId: machineIdHash,
    })
    .returning();
  if (!device) throw new Error('registerDevice: insert returned no row');
  return device;
}
