/**
 * The rows the Requirements list reads, each with its areas' names, and whether a runner is bound to
 * the project (FB-77), in the one statement that reads the rows: the list runs on every page load's
 * Needs-you count, once per project, so neither fact is a statement of its own.
 */

import { requirementKey } from '@forge/contracts/requirements';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirements } from '../db/schema-requirements.js';
import { standingsOf } from './standing-read.js';

export async function listRowsOf(projectId: string) {
  const held = await db
    .select({
      row: requirements,
      areaName: sql<string | null>`(SELECT a.name FROM requirement_areas a
                  WHERE a.id = ${requirements.areaId} AND a.project_id = ${projectId})`,
      proposedAreaName: sql<string | null>`(SELECT a.name FROM requirement_areas a
                  WHERE a.id = ${requirements.proposedAreaId} AND a.project_id = ${projectId})`,
      runnerBound: sql<boolean>`EXISTS (SELECT 1 FROM runners WHERE project_id = ${projectId})`,
    })
    .from(requirements)
    .where(eq(requirements.projectId, projectId))
    .orderBy(desc(requirements.reqSeq));
  const areas = new Map<string, string>();
  for (const h of held) {
    if (h.row.areaId && h.areaName !== null) areas.set(h.row.areaId, h.areaName);
    if (h.row.proposedAreaId && h.proposedAreaName !== null) {
      areas.set(h.row.proposedAreaId, h.proposedAreaName);
    }
  }
  return {
    rows: held.map((h) => h.row),
    areas: areas as ReadonlyMap<string, string>,
    runnerBound: held[0]?.runnerBound === true,
  };
}

/**
 * Every requirement's standing as no viewer reads it, keyed by id with its key and title: the one
 * standing read (REQ-48 BC-8) and the steward's sweep, where nothing reads as anyone's own.
 */
export async function requirementStandingsOf(projectId: string) {
  const { rows, runnerBound } = await listRowsOf(projectId);
  const standings = await standingsOf(projectId, rows, null, undefined, { runnerBound });
  return rows.flatMap((r) => {
    const standing = standings.get(r.id);
    return standing ? [{ id: r.id, key: requirementKey(r.reqSeq), title: r.title, standing }] : [];
  });
}
