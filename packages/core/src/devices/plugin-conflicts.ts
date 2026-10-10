/**
 * The plugin pins a project cannot have on the boxes it shares (REQ-26 BC-2): for each box serving
 * the project, every plugin the project designates that another project on the same box pins at a
 * different commit. A box holds one clone per marketplace, so `GET /devices/me/plugins` sends it no
 * pin for such a plugin (`lib/plugin-designation.ts:unionPluginDesignations`); this read is where a
 * person is told so, on the project's plugin settings, instead of the box choosing in silence.
 */

import type { PluginPinConflict } from '@forge/contracts/plugins';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import { devices, projects, runners } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { readPluginDesignations } from '../lib/plugin-designation.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';

interface BoxProject {
  deviceId: string;
  deviceName: string;
  slug: string;
  projectId: string;
  agentConfig: unknown;
}

/** The conflicts on each box that involve `projectId`'s own designations; pure over the rows. */
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
    const pins = new Map<string, { project: string; ref: string }[]>();
    for (const r of onBox) {
      const read = readPluginDesignations(r.agentConfig, r.slug);
      if (!read.ok) continue;
      for (const d of read.designations) {
        if (!d.pinnedRef) continue;
        const key = `${d.marketplace}::${d.name}`;
        pins.set(key, [...(pins.get(key) ?? []), { project: r.slug, ref: d.pinnedRef }]);
      }
    }
    for (const [key, list] of pins) {
      if (new Set(list.map((p) => p.ref)).size < 2) continue;
      if (!list.some((p) => p.project === mine.slug)) continue;
      const [marketplace = '', name = ''] = key.split('::');
      out.push({
        device: { id: deviceId, name: mine.deviceName },
        marketplace,
        name,
        pins: [...list].sort((a, b) => a.project.localeCompare(b.project)),
      });
    }
  }
  return out;
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

export const projectPluginConflictRoutes = new Hono<{ Variables: AuthVars }>();

projectPluginConflictRoutes.get(
  '/:id/plugin-conflicts',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', idParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    requireHeld(await loadProjectAccess(id, c.get('userId')), 'project.read');
    return c.json({ conflicts: pinConflictsOf(id, await boxProjectsOf(id)) });
  },
);
