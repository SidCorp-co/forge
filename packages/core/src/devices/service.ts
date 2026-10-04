import { randomBytes } from 'node:crypto';
import { DEVICE_MACHINE, RUNNER_PROVISION_MACHINE } from '@forge/contracts/runner-machine';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  deviceLoginCodes,
  deviceSkills,
  devices,
  pairingCodes,
  type RunnerProvisionStatus,
  runners,
  skillActivityEvents,
  skills,
} from '../db/schema.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { type KernelActor, transition } from '../lifecycle/transition.js';
import {
  deleteDeviceRunners,
  mirrorHeartbeatToRunners,
  setRunnerProvisionDetail,
} from '../runners/index.js';
import { emitEvent } from '../outbox/index.js';
import { insertRunnerEvent } from '../runners/runner-events.js';
import { recordSkillActivityEvent, resolvePacketIdForHash } from '../skills/activity.js';
import { revokeDeviceCredentials } from './credential.js';
import type { DevicePatch } from './heartbeat-patch.js';
import { heartbeatPool } from './pool-read-report.js';

/** A device's name or disabled switch; null when the device is gone. */
export async function updateDevice(
  id: string,
  patch: { name?: string; disabledAt?: Date | null },
) {
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

/** A device is revoked: its status, its runners and its credentials go together. */
export async function revokeDevice(id: string, actor: KernelActor): Promise<void> {
  await db.transaction(async (tx) => {
    await transition(tx, DEVICE_MACHINE, {
      to: 'revoked',
      where: eq(devices.id, id),
      actor,
      source: 'device-revoke',
      returning: ['id'],
    });
    await deleteDeviceRunners(tx, [id]);
  });
  await revokeDeviceCredentials(id);
}

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIR_CODE_TTL_MS = 5 * 60 * 1000;

function generatePairingCode(): string {
  const bytes = randomBytes(10);
  let chars = '';
  for (let i = 0; i < 10; i++) {
    // biome-ignore lint/style/noNonNullAssertion: randomBytes guarantees byte access
    chars += CROCKFORD_ALPHABET[bytes[i]! & 0x1f];
  }
  return `${chars.slice(0, 2)}-${chars.slice(2, 6)}-${chars.slice(6, 10)}`;
}

/** A 5-minute pairing code for the project, retried on collision; null when every try collided. */
export async function mintPairingCode(input: {
  projectId: string;
  userId: string;
  grantEpoch: number;
}): Promise<{ code: string; expiresAt: Date } | null> {
  const expiresAt = new Date(Date.now() + PAIR_CODE_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generatePairingCode();
    try {
      await db.insert(pairingCodes).values({ code, ...input, expiresAt });
      return { code, expiresAt };
    } catch (err: unknown) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return null;
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

export type ReportedSkill = {
  skillId: string;
  installedHash: string;
  installedVersion?: number | undefined;
  observedSha?: string | undefined;
  shadowedBy?: string | undefined;
};

/** A device's skill sync report: each installed hash is upserted and each pruned name removed. */
export async function applySkillReport(input: {
  projectId: string;
  deviceId: string;
  reported: readonly ReportedSkill[];
  pruned: readonly string[];
}): Promise<void> {
  const syncedAt = new Date();
  for (const entry of input.reported) {
    await applyReportedSkill({
      projectId: input.projectId,
      deviceId: input.deviceId,
      syncedAt,
      entry,
    });
  }
  for (const name of input.pruned) {
    await recordPrunedSkill({ projectId: input.projectId, deviceId: input.deviceId, name });
  }
}

/** A device's failed skill sync is recorded, unless its last failure said the same. */
export async function recordSkillSyncFailure(input: {
  projectId: string;
  deviceId: string;
  error: string;
}): Promise<void> {
  const { projectId, deviceId, error } = input;
  await db.transaction(async (tx) => {
    const [last] = await tx
      .select({ reason: skillActivityEvents.reason })
      .from(skillActivityEvents)
      .where(
        and(
          eq(skillActivityEvents.eventType, 'device.sync.failed'),
          eq(skillActivityEvents.projectId, projectId),
          eq(skillActivityEvents.deviceId, deviceId),
        ),
      )
      .orderBy(desc(skillActivityEvents.occurredAt))
      .limit(1);
    if (last?.reason === error) return;

    await recordSkillActivityEvent(tx, {
      eventType: 'device.sync.failed',
      actor: `runner:${deviceId}`,
      trigger: 'poll',
      projectId,
      deviceId,
      reason: error,
      outcome: 'failed',
    });
  });
}

async function applyReportedSkill(input: {
  projectId: string;
  deviceId: string;
  syncedAt: Date;
  entry: ReportedSkill;
}): Promise<void> {
  const { projectId, deviceId, syncedAt, entry } = input;
  const nextObservedSha = entry.observedSha ?? null;
  const nextShadowedBy = entry.shadowedBy ?? null;

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        installedHash: deviceSkills.installedHash,
        observedSha: deviceSkills.observedSha,
        shadowedBy: deviceSkills.shadowedBy,
      })
      .from(deviceSkills)
      .where(
        and(
          eq(deviceSkills.deviceId, deviceId),
          eq(deviceSkills.projectId, projectId),
          eq(deviceSkills.skillId, entry.skillId),
        ),
      )
      .for('update')
      .limit(1);

    const hashChanged = !existing || existing.installedHash !== entry.installedHash;
    const observedChanged = existing
      ? existing.observedSha !== nextObservedSha
      : nextObservedSha !== null;
    const shadowChanged = existing
      ? existing.shadowedBy !== nextShadowedBy
      : nextShadowedBy !== null;

    await tx
      .insert(deviceSkills)
      .values({
        deviceId,
        projectId,
        skillId: entry.skillId,
        installedHash: entry.installedHash,
        installedVersion: entry.installedVersion ?? null,
        syncedAt,
        observedSha: nextObservedSha,
        shadowedBy: nextShadowedBy,
      })
      .onConflictDoUpdate({
        target: [deviceSkills.deviceId, deviceSkills.projectId, deviceSkills.skillId],
        set: {
          installedHash: entry.installedHash,
          installedVersion: entry.installedVersion ?? null,
          syncedAt,
          observedSha: nextObservedSha,
          shadowedBy: nextShadowedBy,
        },
      });

    const appliedPacketId = await resolvePacketIdForHash(
      tx,
      projectId,
      entry.skillId,
      entry.installedHash,
    );

    if (hashChanged) {
      await recordSkillActivityEvent(tx, {
        eventType: 'device.skill.applied',
        actor: `runner:${deviceId}`,
        trigger: 'poll',
        projectId,
        skillId: entry.skillId,
        deviceId,
        ...(appliedPacketId ? { packetId: appliedPacketId } : {}),
        ...(existing?.installedHash !== undefined ? { beforeHash: existing.installedHash } : {}),
        afterHash: entry.installedHash,
        outcome: 'ok',
      });
    }

    if (nextShadowedBy !== null) {
      if (shadowChanged || observedChanged) {
        await recordSkillActivityEvent(tx, {
          eventType: 'device.skill.shadowed',
          actor: `runner:${deviceId}`,
          trigger: 'poll',
          projectId,
          skillId: entry.skillId,
          deviceId,
          ...(existing?.observedSha ? { beforeHash: existing.observedSha } : {}),
          ...(nextObservedSha !== null ? { afterHash: nextObservedSha } : {}),
          deltaSummary: nextShadowedBy,
          outcome: 'ok',
        });
      }
    } else if (observedChanged || shadowChanged) {
      await recordSkillActivityEvent(tx, {
        eventType: 'device.skill.observed',
        actor: `runner:${deviceId}`,
        trigger: 'poll',
        projectId,
        skillId: entry.skillId,
        deviceId,
        ...(appliedPacketId ? { packetId: appliedPacketId } : {}),
        ...(existing?.observedSha ? { beforeHash: existing.observedSha } : {}),
        ...(nextObservedSha !== null ? { afterHash: nextObservedSha } : {}),
        outcome: 'ok',
      });
    }
  });
}

/**
 * A pruned skill is reported by NAME (the runner has no id for a manifest entry that no longer
 * exists), so it is resolved to the project's skill row first. The device_skills row and the event
 * go in one transaction; an unresolvable name still gets an event with a null skillId.
 */
async function recordPrunedSkill(input: {
  projectId: string;
  deviceId: string;
  name: string;
}): Promise<void> {
  const [skill] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        eq(skills.scope, 'project'),
        eq(skills.projectId, input.projectId),
        eq(skills.name, input.name),
      ),
    )
    .limit(1);

  await db.transaction(async (tx) => {
    if (skill) {
      await tx
        .delete(deviceSkills)
        .where(
          and(
            eq(deviceSkills.deviceId, input.deviceId),
            eq(deviceSkills.projectId, input.projectId),
            eq(deviceSkills.skillId, skill.id),
          ),
        );
    }
    await recordSkillActivityEvent(tx, {
      eventType: 'device.skill.pruned',
      actor: `runner:${input.deviceId}`,
      trigger: 'poll',
      projectId: input.projectId,
      ...(skill ? { skillId: skill.id } : {}),
      deviceId: input.deviceId,
      deltaSummary: input.name,
      outcome: 'ok',
    });
  });
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
