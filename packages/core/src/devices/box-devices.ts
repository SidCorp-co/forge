/**
 * The devices a Forge Box may run on (ISS-1276): a project's bound devices, the device a run is
 * declared on, and one device's stored box health. Reads only; the slot rule decides
 * (`run-slots-read.ts:readBoxAllocation`).
 */

import { RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, devices, runners } from '../db/schema.js';
import { readStoredBoxHealth, type StoredBoxHealth } from './box-health.js';

export interface BoxDevice {
  id: string;
  ownerId: string;
  online: boolean;
  health: StoredBoxHealth | null;
}

const columns = {
  id: devices.id,
  ownerId: devices.ownerId,
  status: devices.status,
  boxHealth: devices.boxHealth,
  boxHealthAt: devices.boxHealthAt,
};

const asBoxDevice = (r: {
  id: string;
  ownerId: string;
  status: string;
  boxHealth: unknown;
  boxHealthAt: Date | null;
}): BoxDevice => ({
  id: r.id,
  ownerId: r.ownerId,
  online: r.status === 'online',
  health: readStoredBoxHealth(r.boxHealth, r.boxHealthAt),
});

/** The devices bound to a project that are not disabled. */
export async function projectBoxDevices(projectId: string): Promise<BoxDevice[]> {
  const rows = await db
    .selectDistinct(columns)
    .from(runners)
    .innerJoin(devices, eq(devices.id, runners.deviceId))
    .where(
      and(
        eq(runners.projectId, projectId),
        eq(runners.type, 'claude-code'),
        isNull(devices.disabledAt),
      ),
    );
  return rows.map(asBoxDevice);
}

/** One device with its stored box health; null where there is none. */
export async function boxDeviceOf(deviceId: string): Promise<BoxDevice | null> {
  const [row] = await db.select(columns).from(devices).where(eq(devices.id, deviceId)).limit(1);
  return row ? asBoxDevice(row) : null;
}

/** The device a run is declared on, where `runId` is a run session of `projectId`. */
export async function runDeviceOf(runId: string, projectId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return null;
  const [row] = await db
    .select({ deviceId: agentSessions.deviceId })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, runId),
        eq(agentSessions.kind, RUN_SESSION_KIND),
        eq(agentSessions.projectId, projectId),
      ),
    )
    .limit(1);
  return row?.deviceId ?? null;
}
