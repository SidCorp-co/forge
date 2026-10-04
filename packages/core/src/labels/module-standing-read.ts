import {
  MODULE_LANDINGS_SHOWN,
  type ModuleIssuesRead,
  type ModuleRollupResponse,
  type ModuleRollupRow,
  modulePaths,
} from '@forge/contracts/modules';
import type { ActorAgency } from '@forge/contracts/permissions';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';
import { activeIssuePrefix, listIssueStanding } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { levelCouplings, moduleRollup, readIssueModuleSets } from './module-rollup.js';
import {
  deriveStandings,
  type LandingRow,
  type ModuleNode,
  type OpenIssue,
  type TraceRow,
} from './module-standing.js';

export interface ModuleViewer {
  userId: string;
  agency: ActorAgency;
}

const primaryModules = (projectId: string): SQL => sql`
  pm AS (
    SELECT DISTINCT ON (il.issue_id) il.issue_id, il.label_id
      FROM issue_labels il
      JOIN labels l ON l.id = il.label_id AND l.kind = 'module' AND l.project_id = ${projectId}
     ORDER BY il.issue_id, il.is_primary DESC, l.name
  )`;

interface NodeRaw {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  description: string | null;
  knowledge_entry_id: string | null;
  color: string;
}

export async function readNodes(projectId: string): Promise<(ModuleNode & { color: string })[]> {
  const rows = rowsOf<NodeRaw>(
    await db.execute(sql`
      SELECT id, name, slug, parent_id, description, knowledge_entry_id, color
        FROM labels WHERE project_id = ${projectId} AND kind = 'module' ORDER BY name`),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    parentId: r.parent_id,
    description: r.description,
    knowledgeEntryId: r.knowledge_entry_id,
    color: r.color,
  }));
}

interface LandingRaw {
  module_id: string;
  iss_seq: number;
  title: string;
  merged_at: string;
  merged_commit_sha: string | null;
  merged_target: string | null;
  merged_landing: string | null;
  release_version: string | null;
}

const landingFrom = (r: LandingRaw, prefix: string | null): LandingRow => ({
  moduleId: r.module_id,
  issueKey: formatIssueRef(prefix, r.iss_seq),
  title: r.title,
  landedAt: new Date(r.merged_at).toISOString(),
  commitSha: r.merged_commit_sha,
  target: r.merged_target,
  landing: r.merged_landing,
  release: r.release_version,
});

export async function readLatestLandings(
  projectId: string,
  prefix: string | null,
): Promise<LandingRow[]> {
  const rows = rowsOf<LandingRaw>(
    await db.execute(sql`
      WITH ${primaryModules(projectId)}
      SELECT DISTINCT ON (pm.label_id) pm.label_id AS module_id, i.iss_seq, i.title, i.merged_at,
             i.merged_commit_sha, i.merged_target, i.merged_landing, r.release_version
        FROM issues i
        JOIN pm ON pm.issue_id = i.id
        LEFT JOIN pipeline_runs r ON r.id = i.release_batch_run_id
       WHERE i.project_id = ${projectId} AND i.archived_at IS NULL AND i.merged_at IS NOT NULL
       ORDER BY pm.label_id, i.merged_at DESC, i.iss_seq DESC`),
  );
  return rows.map((r) => landingFrom(r, prefix));
}

export async function readRecentLandings(
  projectId: string,
  moduleIds: readonly string[],
  prefix: string | null,
): Promise<{ total: number; recent: LandingRow[] }> {
  const [totalRow] = rowsOf<{ total: number }>(
    await db.execute(sql`
      WITH ${primaryModules(projectId)}
      SELECT count(*)::int AS total
        FROM issues i JOIN pm ON pm.issue_id = i.id
       WHERE i.project_id = ${projectId} AND i.archived_at IS NULL AND i.merged_at IS NOT NULL
         AND pm.label_id IN (${idList(moduleIds)})`),
  );
  const rows = rowsOf<LandingRaw>(
    await db.execute(sql`
      WITH ${primaryModules(projectId)}
      SELECT pm.label_id AS module_id, i.iss_seq, i.title, i.merged_at,
             i.merged_commit_sha, i.merged_target, i.merged_landing, r.release_version
        FROM issues i
        JOIN pm ON pm.issue_id = i.id
        LEFT JOIN pipeline_runs r ON r.id = i.release_batch_run_id
       WHERE i.project_id = ${projectId} AND i.archived_at IS NULL AND i.merged_at IS NOT NULL
         AND pm.label_id IN (${idList(moduleIds)})
       ORDER BY i.merged_at DESC, i.iss_seq DESC
       LIMIT ${MODULE_LANDINGS_SHOWN}`),
  );
  return { total: totalRow?.total ?? 0, recent: rows.map((r) => landingFrom(r, prefix)) };
}

interface TraceRaw {
  module_id: string;
  req_seq: number;
  title: string;
  bc_code: string | null;
}

export async function readTraces(projectId: string): Promise<TraceRow[]> {
  const rows = rowsOf<TraceRaw>(
    await db.execute(sql`
      WITH ${primaryModules(projectId)}
      SELECT DISTINCT pm.label_id AS module_id, r.req_seq, r.title, rc.code AS bc_code
        FROM issues i
        JOIN pm ON pm.issue_id = i.id
        JOIN requirements r ON r.id = i.requirement_id
        LEFT JOIN issue_criteria c ON c.issue_id = i.id AND c.retired_at IS NULL
        LEFT JOIN requirement_criteria rc ON rc.id = c.requirement_criterion_id
       WHERE i.project_id = ${projectId} AND i.archived_at IS NULL`),
  );
  return rows.map((r) => ({
    moduleId: r.module_id,
    reqSeq: r.req_seq,
    reqTitle: r.title,
    criterion: r.bc_code,
  }));
}

export async function readActivity(
  projectId: string,
  moduleIds: readonly string[],
  since: Date,
): Promise<{ day: string; events: number }[]> {
  return rowsOf<{ day: string; events: number }>(
    await db.execute(sql`
      WITH ${primaryModules(projectId)}
      SELECT to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS events
        FROM activity_log a
        JOIN issues i ON i.id = a.issue_id
        JOIN pm ON pm.issue_id = i.id
       WHERE i.project_id = ${projectId} AND i.archived_at IS NULL
         AND pm.label_id IN (${idList(moduleIds)})
         AND a.created_at >= ${sqlTimestamp(since)}
       GROUP BY 1`),
  );
}

export async function readIssueSeqs(
  projectId: string,
  moduleIds: readonly string[],
): Promise<number[]> {
  const rows = rowsOf<{ iss_seq: number }>(
    await db.execute(sql`
      WITH ${primaryModules(projectId)}
      SELECT i.iss_seq
        FROM issues i JOIN pm ON pm.issue_id = i.id
       WHERE i.project_id = ${projectId} AND i.archived_at IS NULL
         AND pm.label_id IN (${idList(moduleIds)})`),
  );
  return rows.map((r) => r.iss_seq);
}

export const openIssuesOf = (rows: Awaited<ReturnType<typeof listIssueStanding>>): OpenIssue[] =>
  rows.issues.map((i) => ({ key: i.key, title: i.title, status: i.status, standing: i.standing }));

export const issuesReadOf = (
  list: Awaited<ReturnType<typeof listIssueStanding>>,
): ModuleIssuesRead => ({
  returned: list.issues.length,
  open: list.counts.open,
});

export async function moduleRollupWithStanding(
  projectId: string,
  activeWithinDays: number,
  viewer: ModuleViewer,
): Promise<ModuleRollupResponse> {
  const [counts, nodes, list, prefix, traces, issueModules] = await Promise.all([
    moduleRollup(projectId, activeWithinDays),
    readNodes(projectId),
    listIssueStanding(projectId, 'open', { userId: viewer.userId }),
    activeIssuePrefix(projectId),
    readTraces(projectId),
    readIssueModuleSets(projectId),
  ]);
  const latest = await readLatestLandings(projectId, prefix);
  const standings = deriveStandings({
    nodes,
    openIssues: openIssuesOf(list),
    latestLandings: latest,
    traces,
  });
  const paths = modulePaths(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const modules = counts.modules.map((row): ModuleRollupRow => {
    const node = byId.get(row.id);
    const standing = standings.get(row.id);
    if (!node || !standing) {
      throw new Error(`modules/rollup: module ${row.id} has counts but no label row or standing`);
    }
    return {
      ...row,
      path: paths.get(row.id) ?? node.slug,
      description: node.description,
      knowledgeEntryId: node.knowledgeEntryId,
      standing,
    };
  });
  return {
    activeWithinDays: counts.activeWithinDays,
    generatedAt: counts.generatedAt,
    modules,
    couplings: levelCouplings({ nodes, issueModules }),
    unassigned: counts.unassigned,
    issuesRead: issuesReadOf(list),
  };
}
