import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  deviceLoginCodes,
  devices,
  organizationMembers,
  projects,
  runners,
  users,
} from '../db/schema.js';
import { DEVICE_LIST_COLUMNS } from './device-columns.js';

/** A device's owner and status; null when there is no such device. */
export async function deviceOwnership(id: string) {
  const [device] = await db
    .select({ ownerId: devices.ownerId, status: devices.status })
    .from(devices)
    .where(eq(devices.id, id))
    .limit(1);
  return device ?? null;
}

/** The devices a user owns, newest pairing first; narrowed to those running in `orgId` when given. */
export async function listOwnedDevices(userId: string, orgId: string | undefined) {
  return orgId
    ? db
        .selectDistinct(DEVICE_LIST_COLUMNS)
        .from(devices)
        .innerJoin(runners, eq(runners.deviceId, devices.id))
        .innerJoin(projects, eq(projects.id, runners.projectId))
        .where(and(eq(devices.ownerId, userId), eq(projects.orgId, orgId)))
        .orderBy(desc(devices.pairedAt))
    : db
        .select(DEVICE_LIST_COLUMNS)
        .from(devices)
        .where(eq(devices.ownerId, userId))
        .orderBy(desc(devices.pairedAt));
}

/** A device's claude-code runners with each project's slug and name and its provisioning state. */
export async function listDeviceRunners(deviceId: string) {
  return db
    .select({
      runnerId: runners.id,
      projectId: runners.projectId,
      slug: projects.slug,
      name: projects.name,
      repoPath: runners.repoPath,
      branch: runners.branch,
      status: runners.status,
      lastSeenAt: runners.lastSeenAt,
      provisionStatus: runners.provisionStatus,
      provisionDetail: runners.provisionDetail,
      provisionedAt: runners.provisionedAt,
    })
    .from(runners)
    .innerJoin(projects, eq(projects.id, runners.projectId))
    .where(and(eq(runners.deviceId, deviceId), eq(runners.type, 'claude-code')));
}

/** The slug and agent config of every project a device runs claude-code for. */
export async function deviceProjectAgentConfigs(deviceId: string) {
  return db
    .select({ slug: projects.slug, agentConfig: projects.agentConfig })
    .from(runners)
    .innerJoin(projects, eq(projects.id, runners.projectId))
    .where(and(eq(runners.deviceId, deviceId), eq(runners.type, 'claude-code')));
}

/**
 * An organisation's devices among `visibleIds`, whoever paired them. `capabilities` and the gate
 * report are a box's own diagnostics and are not read. `array_agg` is not DISTINCT: one runner per
 * (project, device, type) by `runners_project_device_type_uq`, so one name per assignment, where
 * DISTINCT would collapse two same-named projects `runnerCount` still counts as two (ISS-1162).
 */
export async function listOrgDevices(orgId: string, visibleIds: string[]) {
  return db
    .select({
      id: devices.id,
      name: devices.name,
      platform: devices.platform,
      agentVersion: devices.agentVersion,
      agentCommit: devices.agentCommit,
      status: devices.status,
      disabledAt: devices.disabledAt,
      lastSeenAt: devices.lastSeenAt,
      pairedAt: devices.pairedAt,
      createdAt: devices.createdAt,
      ownerId: devices.ownerId,
      runnerCount: sql<number>`count(${runners.id})::int`,
      projectNames: sql<string[]>`array_agg(${projects.name} order by ${projects.name})`,
    })
    .from(devices)
    .innerJoin(runners, eq(runners.deviceId, devices.id))
    .innerJoin(projects, eq(projects.id, runners.projectId))
    .where(and(inArray(projects.id, visibleIds), eq(projects.orgId, orgId)))
    .groupBy(devices.id)
    .orderBy(desc(devices.pairedAt));
}

/** The queued claude-code runners on a device. */
export async function queuedProvisionRows(deviceId: string) {
  return db
    .select({
      runnerId: runners.id,
      projectId: runners.projectId,
      slug: projects.slug,
      repoPath: runners.repoPath,
      branch: runners.branch,
    })
    .from(runners)
    .innerJoin(projects, eq(projects.id, runners.projectId))
    .where(
      and(
        eq(runners.deviceId, deviceId),
        eq(runners.type, 'claude-code'),
        eq(runners.provisionStatus, 'queued'),
      ),
    );
}

/** A user's kind and the org they belong to; null when there is no such user in any org. */
export async function userKindAndOrg(userId: string) {
  const [row] = await db
    .select({ id: users.id, kind: users.kind, orgId: organizationMembers.orgId })
    .from(users)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

/** Whether a user row still exists. */
export async function userExists(userId: string): Promise<boolean> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  return user !== undefined;
}

/** Where a login code stands: approved by whom, consumed when, expiring when; null when unknown. */
export async function loginCodeState(codeHash: string) {
  const [row] = await db
    .select({
      approvedUserId: deviceLoginCodes.approvedUserId,
      consumedAt: deviceLoginCodes.consumedAt,
      expiresAt: deviceLoginCodes.expiresAt,
    })
    .from(deviceLoginCodes)
    .where(eq(deviceLoginCodes.codeHash, codeHash))
    .limit(1);
  return row ?? null;
}
