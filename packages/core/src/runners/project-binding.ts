// A project's claude-code runners as the project's Runners screen binds and lists them: one row per
// (project, device), its provisioning queued on bind.

import { RUNNER_MACHINE, RUNNER_PROVISION_MACHINE } from '@forge/contracts/runner-machine';
import type { RunnerRefusalCode } from '@forge/contracts/runners';
import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { devices, runners } from '../db/schema.js';
import { refuser } from '../lib/refusal.js';
import { type KernelActor, transition } from '../lifecycle/index.js';
import { emitEvent } from '../outbox/index.js';
import { runnersPorts } from './ports.js';
import { insertRunnerEvent } from './runner-events.js';
import { upsertDeviceRunner } from './writes.js';

/** The device pools serving the project, with device identity and provision status. */
export async function listProjectRunnerPools(projectId: string) {
  return db
    .select({
      runnerId: runners.id,
      deviceId: runners.deviceId,
      deviceName: devices.name,
      platform: devices.platform,
      deviceStatus: devices.status,
      // The version the device's binary reported is this runner's; read from the device rather
      // than mirrored, so a missed heartbeat cannot leave two copies disagreeing (ISS-1119).
      agentVersion: devices.agentVersion,
      // A disabled device's runner still heartbeats online; this says why it receives no jobs.
      deviceDisabledAt: devices.disabledAt,
      runnerStatus: runners.status,
      lastError: runners.lastError,
      limitReason: runners.limitReason,
      rateLimitedUntil: runners.rateLimitedUntil,
      limitDetail: runners.limitDetail,
      repoPath: runners.repoPath,
      branch: runners.branch,
      labels: runners.labels,
      lastSeenAt: runners.lastSeenAt,
      provisionStatus: runners.provisionStatus,
      provisionDetail: runners.provisionDetail,
      provisionedAt: runners.provisionedAt,
      poolRead: runners.poolRead,
      // ISS-1118 — whether a resident master for this project runs on the box.
      residentMaster: runnersPorts().residentMasterSql(runners.deviceId, runners.projectId),
    })
    .from(runners)
    .leftJoin(devices, eq(devices.id, runners.deviceId))
    .where(and(eq(runners.projectId, projectId), eq(runners.type, 'claude-code')))
    .orderBy(runners.createdAt);
}

/** The device a bind names, or null. */
async function deviceForBind(deviceId: string) {
  const [row] = await db
    .select({
      id: devices.id,
      ownerId: devices.ownerId,
      name: devices.name,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return row ?? null;
}

const refuseBind = refuser<RunnerRefusalCode>('RUNNER_REFUSED');

/** The device `deviceId` when `userId` owns it; a device is put on a project only by its owner. */
export async function ownedDeviceForBind(deviceId: string, userId: string) {
  const device = await deviceForBind(deviceId);
  if (!device) {
    throw new HTTPException(404, {
      message: 'device not found',
      cause: { code: 'DEVICE_NOT_FOUND' },
    });
  }
  if (device.ownerId !== userId) {
    throw refuseBind(
      'DEVICE_BIND_FORBIDDEN',
      `device ${deviceId} is not yours to bind; only its owner can put it on a project`,
      '/deviceId',
    );
  }
  return device;
}

/** Whether runner `runnerId` belongs to the project. */
export async function projectHasRunner(projectId: string, runnerId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.id, runnerId), eq(runners.projectId, projectId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Bind a device to the project as its claude-code runner: upsert the row, re-queue provisioning,
 * take the device's liveness, then audit the bind as the runner's first status event. Null when
 * the upsert returned no row.
 */
export async function bindDeviceRunner(input: {
  projectId: string;
  device: { id: string; name: string; status: string; lastSeenAt: Date | null };
  capabilities: Record<string, unknown> | undefined;
  checkout: { repoPath?: string | null | undefined; branch?: string | null | undefined };
  actor: KernelActor;
}) {
  const status: 'online' | 'offline' =
    input.device.status === 'online' && input.device.lastSeenAt ? 'online' : 'offline';
  const now = new Date();
  const runner = await db.transaction(async (tx) => {
    const row = await upsertDeviceRunner(tx, {
      projectId: input.projectId,
      deviceId: input.device.id,
      name: input.device.name,
      capabilities: input.capabilities ?? {},
      capabilitiesSent: input.capabilities,
      checkout: input.checkout,
      status,
      now,
    });
    if (!row) return null;
    // A re-bind re-queues provisioning (path or url may have changed); an operator's drain or
    // disable is left standing.
    await transition(tx, RUNNER_PROVISION_MACHINE, {
      to: 'queued',
      where: eq(runners.id, row.id),
      reason: 'bind',
      actor: input.actor,
      source: 'runner-bind',
      returning: ['id'],
    });
    const live = await transition(tx, RUNNER_MACHINE, {
      to: status,
      from: status === 'online' ? 'offline' : 'online',
      where: eq(runners.id, row.id),
      reason: 'bind',
      actor: input.actor,
      source: 'runner-bind',
      returning: ['id'],
    });
    if (row.deviceId) {
      await emitEvent(tx, 'runner.provisionRequested', {
        projectId: row.projectId,
        deviceId: row.deviceId,
        runnerId: row.id,
      });
    }
    return live.rows.length > 0 ? { ...row, status } : row;
  });
  if (!runner) return null;

  // ISS-381 (2.3) — an event per bind is informative, unlike the per-tick heartbeat site.
  await insertRunnerEvent(db, {
    runnerId: runner.id,
    projectId: runner.projectId,
    oldStatus: null,
    newStatus: runner.status,
    reason: 'bind',
  });
  return runner;
}
