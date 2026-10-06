// The per-issue facts the standing read joins in: criteria tallies, requirement, module and feedback.

import { modulePaths } from '@forge/contracts/modules';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
import { readCurrentDrafts } from './criteria/storefront-draft.js';

interface CriteriaRaw {
  issue_id: string;
  verdict: 'pass' | 'short' | 'fail' | 'skipped' | null;
  bc_code: string | null;
  identity_kind: string | null;
  storefront_workflow_id: string | null;
  storefront_draft_version: string | null;
  stands: boolean;
}

// a passing verdict on a storefront draft passes only while the source still holds that
// draft: one the source moved past, or cannot be read back, is not counted passing, so the list
// never says every criterion passed of an issue the release hold keeps (FB-56)
export async function criteriaOf(
  projectId: string,
  ids: readonly string[],
): Promise<CriteriaRaw[]> {
  if (ids.length === 0) return [];
  const rows = rowsOf<Omit<CriteriaRaw, 'stands'>>(
    await db.execute(sql`
      SELECT c.issue_id, v.verdict, rc.code AS bc_code, v.identity_kind,
             v.storefront_workflow_id, v.storefront_draft_version
        FROM issue_criteria c
        LEFT JOIN requirement_criteria rc ON rc.id = c.requirement_criterion_id
        LEFT JOIN LATERAL (
          SELECT cv.verdict, cv.identity_kind, cv.storefront_workflow_id, cv.storefront_draft_version
            FROM criterion_verdicts cv
           WHERE cv.criterion_id = c.id
           ORDER BY cv.created_at DESC, cv.id DESC
           LIMIT 1
        ) v ON true
       WHERE c.issue_id IN (${idList(ids)}) AND c.retired_at IS NULL
       ORDER BY c.issue_id, c.position, c.n`),
  );
  const drafts = rows.flatMap((r) =>
    r.identity_kind === 'storefront_draft' && r.storefront_workflow_id
      ? [r.storefront_workflow_id]
      : [],
  );
  const current = await readCurrentDrafts(projectId, drafts);
  return rows.map((r) => ({
    ...r,
    stands:
      r.identity_kind !== 'storefront_draft' ||
      (!!r.storefront_workflow_id &&
        current({
          workflowId: r.storefront_workflow_id,
          draftVersion: r.storefront_draft_version ?? '',
        }).corroboration === 'corroborated'),
  }));
}

export interface RequirementRaw {
  id: string;
  req_seq: number;
  title: string;
  current_revision: number | null;
}

export async function requirementsOf(ids: readonly string[]): Promise<Map<string, RequirementRaw>> {
  if (ids.length === 0) return new Map();
  const rows = rowsOf<RequirementRaw>(
    await db.execute(
      sql`SELECT r.id, r.req_seq, r.title, r.current_revision
            FROM requirements r WHERE r.id IN (${idList(ids)})`,
    ),
  );
  return new Map(rows.map((r) => [r.id, r]));
}

interface ModuleRaw {
  issue_id: string | null;
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  is_primary: boolean | null;
}

/** Each issue's module: its primary module label, else its first; the path runs from the root. */
export async function modulesOf(projectId: string, ids: readonly string[]) {
  const out = new Map<string, { id: string; path: string; name: string }>();
  if (ids.length === 0) return out;
  const [all, links] = await Promise.all([
    db.execute(sql`
      SELECT NULL::uuid AS issue_id, id, name, slug, parent_id, NULL::boolean AS is_primary
        FROM labels WHERE project_id = ${projectId} AND kind = 'module'`),
    db.execute(sql`
      SELECT il.issue_id, l.id, l.name, l.slug, l.parent_id, il.is_primary
        FROM issue_labels il JOIN labels l ON l.id = il.label_id
       WHERE il.issue_id IN (${idList(ids)}) AND l.kind = 'module'
       ORDER BY il.is_primary DESC, l.name`),
  ]);
  const paths = modulePaths(
    rowsOf<ModuleRaw>(all).map((m) => ({ id: m.id, slug: m.slug, parentId: m.parent_id })),
  );
  for (const l of rowsOf<ModuleRaw>(links)) {
    if (!l.issue_id || out.has(l.issue_id)) continue;
    out.set(l.issue_id, { id: l.id, path: paths.get(l.id) ?? l.slug, name: l.name });
  }
  return out;
}

export async function feedbackOf(ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = rowsOf<{ issue_id: string; fb_seq: number }>(
    await db.execute(sql`
      SELECT c.issue_id, f.fb_seq FROM feedback_route_issues c JOIN feedback f ON f.id = c.feedback_id
       WHERE c.issue_id IN (${idList(ids)}) ORDER BY f.fb_seq`),
  );
  for (const r of rows) out.set(r.issue_id, [...(out.get(r.issue_id) ?? []), `FB-${r.fb_seq}`]);
  return out;
}
