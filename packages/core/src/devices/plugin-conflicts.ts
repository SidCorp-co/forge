/**
 * The plugin pins a project cannot have on the boxes it shares (REQ-26): for each box serving the
 * project, every marketplace the project pins that the projects on that box pin at more than one
 * commit. A box holds one clone per marketplace, so `GET /devices/me/plugins` sends it no pin there
 * (`lib/plugin-designation.ts:unionPluginDesignations`); this read is where a person is told so, on
 * the project's plugin settings, instead of the box choosing in silence. Both reads judge by
 * `lib/plugin-designation.ts:boxPinConflicts`, so they cannot disagree.
 */

import type { PluginPinConflict } from '@forge/contracts/plugins';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, projects, runners } from '../db/schema.js';
import { boxPinConflicts, readBoxDesignations } from '../lib/plugin-designation.js';

interface BoxProject {
  deviceId: string;
  deviceName: string;
  slug: string;
  projectId: string;
  agentConfig: unknown;
}

/**
 * The conflicts on each box that involve one of `projectId`'s own pins; pure over the rows. A
 * project on a shared box whose stored list is unreadable refuses the read by name
 * (`PLUGIN_DESIGNATIONS_INVALID`), as the box's own read is refused.
 */
export function pinConflictsOf(
  projectId: string,
  rows: readonly BoxProject[],
): PluginPinConflict[] {
  const out: PluginPinConflict[] = [];
  const boxes = [...new Set(rows.map((r) => r.deviceId))];
  for (const deviceId of boxes) {
    const onBox = rows.filter((r) => r.deviceId === deviceId);
    const mine = onBox.find((r) => r.projectId === projectId);
    if (!mine) continue;
    for (const [marketplace, pins] of boxPinConflicts(readBoxDesignations(onBox))) {
      if (!pins.some((p) => p.project === mine.slug)) continue;
      out.push({ device: { id: deviceId, name: mine.deviceName }, marketplace, pins });
    }
  }
  return out.sort(
    (a, b) =>
      a.device.name.localeCompare(b.device.name) || a.marketplace.localeCompare(b.marketplace),
  );
}

async function boxProjectsOf(projectId: string): Promise<BoxProject[]> {
  const mine = await db
    .select({ deviceId: runners.deviceId })
    .from(runners)
    .where(and(eq(runners.projectId, projectId), eq(runners.type, 'claude-code')));
  const ids = [...new Set(mine.flatMap((r) => (r.deviceId ? [r.deviceId] : [])))];
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      deviceId: runners.deviceId,
      deviceName: devices.name,
      slug: projects.slug,
      projectId: projects.id,
      agentConfig: projects.agentConfig,
    })
    .from(runners)
    .innerJoin(projects, eq(projects.id, runners.projectId))
    .innerJoin(devices, eq(devices.id, runners.deviceId))
    .where(and(inArray(runners.deviceId, ids), eq(runners.type, 'claude-code')));
  return rows.flatMap((r) => (r.deviceId ? [{ ...r, deviceId: r.deviceId }] : []));
}

/** The pin conflicts `projectId` has on the boxes it shares. */
export async function readPluginConflicts(projectId: string): Promise<PluginPinConflict[]> {
  return pinConflictsOf(projectId, await boxProjectsOf(projectId));
}
