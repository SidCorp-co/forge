/**
 * Registering a box: the `devices` row, and nothing secret (ISS-932).
 *
 * This used to be inseparable from minting the box's credential — one call
 * returned a row and a plaintext. Splitting them is what lets pairing hand out
 * a PAT or an agent's AAT (`devices/credential.ts`) while the registry keeps
 * its one job: recording which machine this is, so a re-pair from the same
 * host rotates the row it already has instead of leaving a ghost.
 */

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
// cm:guard the reuse lookup is scoped to (ownerId, machineId) and must stay so. Keyed on the fingerprint alone, pairing a host would MOVE whichever row already claimed it — handing the new principal the previous owner's `runners` bindings, and with them work on projects they were never given. Two rows for one host under two principals is the honest answer; one row that changes hands is a takeover with the paperwork filed.
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
