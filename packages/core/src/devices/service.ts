import { DEVICE_MACHINE, RUNNER_PROVISION_MACHINE } from '@forge/contracts/runner-machine';
import { and, eq, gt, isNull, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { deviceLoginCodes, devices, type RunnerProvisionStatus, runners } from '../db/schema.js';
import { deviceRoom, roomManager, userRoom } from '../lib/rooms.js';
import { type KernelActor, transition } from '../lifecycle/index.js';
import { emitEvent } from '../outbox/index.js';
import {
  deleteDeviceRunners,
  insertRunnerEvent,
  mirrorHeartbeatToRunners,
  setRunnerProvisionDetail,
} from '../runners/index.js';
import { revokeDeviceCredentials } from './credential.js';
import type { DevicePatch } from './heartbeat-patch.js';
import { heartbeatPool } from './pool-read-report.js';

/** A device's name or disabled switch; null when the device is gone. */
export async function updateDevice(id: string, patch: { name?: string; disabledAt?: Date | null }) {
  const [updated] = await db.update(devices).set(patch).where(eq(devices.id, id)).returning({
    id: devices.id,
    name: devices.name,
    platform: devices.platform,
    status: devices.status,
    disabledAt: devices.disabledAt,
    lastSeenAt: devices.lastSeenAt,
    pairedAt: devices.pairedAt,
  });
  return updated ?? null;
}

/**
 * The one revoke path: the boxes `where` names move to `revoked`, and their runners and every live
 * credential issued to them go in the same transaction, so no revoked box keeps a token that
 * answers. Each box and its owner are told once it commits. `credentialsOf` names boxes whose
 * credentials go even when they already stood revoked. Answers the ids that moved.
 */
export async function revokeDevices(args: {
  where: SQL;
  actor: KernelActor;
  source: string;
  reason?: string;
  credentialsOf?: readonly string[];
}): Promise<string[]> {
  const moved = await db.transaction(async (tx) => {
    const { rows } = await transition(tx, DEVICE_MACHINE, {
      to: 'revoked',
      where: args.where,
      reason: args.reason ?? null,
      actor: args.actor,
      source: args.source,
      returning: ['id', 'ownerId'],
    });
    const ids = rows.map((r) => r.id);
    await deleteDeviceRunners(tx, ids);
    await revokeDeviceCredentials(tx, [...new Set([...ids, ...(args.credentialsOf ?? [])])]);
    return rows;
  });
  for (const { id, ownerId } of moved) {
    const event = { event: 'device.revoked', data: { deviceId: id } };
    roomManager.publish(userRoom(ownerId), event);
    roomManager.publish(deviceRoom(id), event);
  }
  return moved.map((r) => r.id);
}

/** A device is revoked by its owner: its status, its runners and its credentials go together. */
export async function revokeDevice(id: string, actor: KernelActor): Promise<void> {
  await revokeDevices({
    where: eq(devices.id, id),
    actor,
    source: 'device-revoke',
    credentialsOf: [id],
  });
}
/**
 * A heartbeat lands: the device row takes the patch and goes online, the pool report is stored,
 * and the device's runners follow it online. Null when the device row is gone.
 */
export async function recordHeartbeat(
  deviceId: string,
  patch: DevicePatch,
  pool: unknown,
): Promise<{ poolAck: Record<string, unknown> } | null> {
  const [updated] = await db
    .update(devices)
    .set(patch)
    .where(eq(devices.id, deviceId))
    .returning({ id: devices.id });
  if (!updated) return null;
  await transition(db, DEVICE_MACHINE, {
    to: 'online',
    from: 'offline',
    where: eq(devices.id, deviceId),
    actor: { type: 'runner', id: deviceId },
    source: 'device-heartbeat',
    returning: ['id'],
  });
  const { ack } = await heartbeatPool(pool, deviceId);

  const transitioned = await mirrorHeartbeatToRunners(deviceId);
  for (const r of transitioned) {
    await insertRunnerEvent(db, {
      runnerId: r.id,
      projectId: r.project_id,
      oldStatus: r.old_status,
      newStatus: 'online',
      reason: 'device_heartbeat',
    });
  }
  return { poolAck: ack };
}

/** A device's own runner moves to a provisioning status; null when the runner is not its. */
export async function reportProvisionStatus(input: {
  deviceId: string;
  runnerId: string;
  status: RunnerProvisionStatus;
  detail: string | null;
}) {
  const mine = and(eq(runners.id, input.runnerId), eq(runners.deviceId, input.deviceId));
  const runner = await db.transaction(async (tx) => {
    await transition(tx, RUNNER_PROVISION_MACHINE, {
      to: input.status,
      where: mine,
      reason: input.detail,
      actor: { type: 'runner', id: input.deviceId },
      source: 'provision-status',
      returning: ['id'],
    });
    const [row] = await setRunnerProvisionDetail(tx, mine, input.detail, input.status === 'ready');
    if (row) {
      await emitEvent(tx, 'runner.provisionStatus', {
        projectId: row.projectId,
        runnerId: row.id,
        deviceId: input.deviceId,
        status: input.status,
        detail: input.detail,
      });
    }
    return row;
  });
  return runner ?? null;
}

/** A login code is stored under its hash; null when the hash collided with a live one. */
export async function insertLoginCode(
  values: Omit<typeof deviceLoginCodes.$inferInsert, 'id'>,
): Promise<string | null> {
  const [row] = await db
    .insert(deviceLoginCodes)
    .values(values)
    .onConflictDoNothing({ target: deviceLoginCodes.codeHash })
    .returning({ id: deviceLoginCodes.id });
  return row?.id ?? null;
}

/** A pending, unexpired login code is approved by a user; null when no such code is waiting. */
export async function approveLoginCode(
  codeHash: string,
  approval: { userId: string; agentUserId: string | null; grantEpoch: number },
) {
  const [row] = await db
    .update(deviceLoginCodes)
    .set({
      approvedUserId: approval.userId,
      agentUserId: approval.agentUserId,
      approvedAt: sql`now()`,
      grantEpoch: approval.grantEpoch,
    })
    .where(
      and(
        eq(deviceLoginCodes.codeHash, codeHash),
        isNull(deviceLoginCodes.approvedUserId),
        isNull(deviceLoginCodes.consumedAt),
        gt(deviceLoginCodes.expiresAt, sql`now()`),
      ),
    )
    .returning({
      id: deviceLoginCodes.id,
      deviceLabel: deviceLoginCodes.deviceLabel,
      devicePlatform: deviceLoginCodes.devicePlatform,
      deviceHostname: deviceLoginCodes.deviceHostname,
      createdIp: deviceLoginCodes.createdIp,
      createdUserAgent: deviceLoginCodes.createdUserAgent,
      createdAt: deviceLoginCodes.createdAt,
      expiresAt: deviceLoginCodes.expiresAt,
    });
  return row ?? null;
}

/** An approved, unexpired login code is consumed once; null when there is none to consume. */
export async function consumeLoginCode(codeHash: string) {
  const [row] = await db
    .update(deviceLoginCodes)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(deviceLoginCodes.codeHash, codeHash),
        sql`approved_user_id IS NOT NULL`,
        isNull(deviceLoginCodes.consumedAt),
        gt(deviceLoginCodes.expiresAt, sql`now()`),
      ),
    )
    .returning({
      id: deviceLoginCodes.id,
      approvedUserId: deviceLoginCodes.approvedUserId,
      agentUserId: deviceLoginCodes.agentUserId,
      deviceLabel: deviceLoginCodes.deviceLabel,
      devicePlatform: deviceLoginCodes.devicePlatform,
      machineId: deviceLoginCodes.machineId,
      grantEpoch: deviceLoginCodes.grantEpoch,
    });
  return row ?? null;
}
