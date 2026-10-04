import {
  MODULE_BODY_LIMIT,
  MODULE_LANDINGS_SHOWN,
  type ModuleActiveIssue,
  type ModuleDetail,
  type ModuleFact,
  type ModuleFeedbackRef,
  type ModuleIssuesRead,
  type ModulePurpose,
  type ModuleRollupResponse,
  type ModuleRollupRow,
} from '@forge/contracts/modules';
import type { ActorAgency } from '@forge/contracts/permissions';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';
import { activeIssuePrefix, listIssueStanding } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { notFound } from '../middleware/route-errors.js';
import { loadDeclaredEdges } from './module-diagram-source.js';
import { moduleDrift } from './module-drift.js';
import { levelCouplings, moduleRollup, readIssueModuleSets } from './module-rollup.js';
import {
  activityDays,
  couplingsOf,
  deriveStandings,
  keyPathsOf,
  type LandingRow,
  landingsOf,
  type ModuleNode,
  modulePaths,
  moduleRefs,
  type OpenIssue,
  railOrder,
  subtreesOf,
  summaryOf,
  type TraceRow,
} from './module-standing.js';
import { listFeedbackAs } from './ports.js';

interface ModuleViewer {
  userId: string;
  agency: ActorAgency;
}

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];
const idList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

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

async function readNodes(projectId: string): Promise<(ModuleNode & { color: string })[]> {
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

const snapshotOf = (n: ModuleNode) => ({
  id: n.id,
  name: n.name,
  slug: n.slug,
  parentId: n.parentId,
  node: null,
});

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

async function readLatestLandings(projectId: string, prefix: string | null): Promise<LandingRow[]> {
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

async function readRecentLandings(
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

async function readTraces(projectId: string): Promise<TraceRow[]> {
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

async function readActivity(
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

async function readIssueSeqs(projectId: string, moduleIds: readonly string[]): Promise<number[]> {
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

const openIssuesOf = (rows: Awaited<ReturnType<typeof listIssueStanding>>): OpenIssue[] =>
  rows.issues.map((i) => ({ key: i.key, title: i.title, status: i.status, standing: i.standing }));

const issuesReadOf = (list: Awaited<ReturnType<typeof listIssueStanding>>): ModuleIssuesRead => ({
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
  const [latest, declared] = await Promise.all([
    readLatestLandings(projectId, prefix),
    loadDeclaredEdges(projectId, nodes.map(snapshotOf)),
  ]);
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
    couplings: levelCouplings({ nodes, declared, issueModules }),
    unassigned: counts.unassigned,
    issuesRead: issuesReadOf(list),
  };
}

interface EntryRaw {
  id: string;
  slug: string;
  title: string;
  body: string;
  updated_at: string;
  archived_at: string | null;
}

async function readEntry(projectId: string, entryId: string): Promise<EntryRaw | null> {
  const [row] = rowsOf<EntryRaw>(
    await db.execute(sql`
      SELECT id, slug, title, body, updated_at, archived_at
        FROM knowledge_entries WHERE id = ${entryId} AND project_id = ${projectId}`),
  );
  return row ?? null;
}

const NO_ENTRY = 'no knowledge entry is linked to this module';

function purposeOf(entry: EntryRaw | null, linked: boolean): ModuleFact<ModulePurpose> {
  if (!linked) return { available: false, reason: NO_ENTRY };
  if (!entry) return { available: false, reason: 'the linked knowledge entry cannot be read' };
  if (entry.archived_at)
    return { available: false, reason: 'the linked knowledge entry is archived' };
  const body =
    entry.body.length > MODULE_BODY_LIMIT ? entry.body.slice(0, MODULE_BODY_LIMIT) : entry.body;
  return {
    available: true,
    value: {
      entrySlug: entry.slug,
      title: entry.title,
      summary: summaryOf(entry.body) || entry.title,
      body,
      bodyTruncated: entry.body.length > MODULE_BODY_LIMIT,
      updatedAt: new Date(entry.updated_at).toISOString(),
    },
  };
}

function keyPathsFact(entry: EntryRaw | null, linked: boolean): ModuleFact<string[]> {
  if (!linked) return { available: false, reason: NO_ENTRY };
  if (!entry || entry.archived_at) {
    return { available: false, reason: 'the linked knowledge entry is not readable' };
  }
  const paths = keyPathsOf(entry.body);
  if (paths.length === 0) {
    return { available: false, reason: 'the knowledge entry cites no file path in code spans' };
  }
  return { available: true, value: paths };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLOSED_FEEDBACK = new Set(['verified', 'declined']);

async function openFeedbackOf(
  projectId: string,
  viewer: ModuleViewer,
  issueKeys: ReadonlySet<string>,
): Promise<ModuleFeedbackRef[]> {
  const answer = await listFeedbackAs(viewer, projectId);
  if (!answer.ok) {
    throw new Error(
      `modules/detail: the feedback list refused: ${answer.refusals.map((r) => r.code).join(', ')}`,
    );
  }
  return answer.list.feedback
    .filter((f) => !CLOSED_FEEDBACK.has(f.phase))
    .filter(
      (f) =>
        (f.target.type === 'issue' && issueKeys.has(f.target.key)) ||
        (f.route?.route === 'issue' && f.route.key !== null && issueKeys.has(f.route.key)),
    )
    .map((f) => ({ key: f.key, title: f.title, phase: f.phase }));
}

export async function moduleDetailOf(
  projectId: string,
  ref: string,
  viewer: ModuleViewer,
  now: Date = new Date(),
): Promise<ModuleDetail> {
  const nodes = await readNodes(projectId);
  const node = UUID.test(ref) ? nodes.find((n) => n.id === ref) : nodes.find((n) => n.slug === ref);
  if (!node) {
    throw notFound(`module ${ref} not found in this project: pass a module slug or its label id`);
  }

  const subtree = subtreesOf(nodes).get(node.id) ?? [node.id];
  const prefix = await activeIssuePrefix(projectId);
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 13));
  const [list, traces, latest, landings, activity, seqs, entry, drift, declared] =
    await Promise.all([
      listIssueStanding(projectId, 'open', { userId: viewer.userId }),
      readTraces(projectId),
      readLatestLandings(projectId, prefix),
      readRecentLandings(projectId, subtree, prefix),
      readActivity(projectId, subtree, since),
      readIssueSeqs(projectId, subtree),
      node.knowledgeEntryId ? readEntry(projectId, node.knowledgeEntryId) : Promise.resolve(null),
      moduleDrift(projectId),
      loadDeclaredEdges(projectId, nodes.map(snapshotOf)),
    ]);

  const open = openIssuesOf(list);
  const standing = deriveStandings({ nodes, openIssues: open, latestLandings: latest, traces }).get(
    node.id,
  );
  if (!standing) throw new Error(`modules/detail: module ${node.id} has no standing`);

  const refs = moduleRefs(nodes);
  const paths = modulePaths(nodes);
  const within = new Set(subtree);
  const issues = railOrder(
    open.filter((i) => i.standing.module !== null && within.has(i.standing.module.id)),
  ).map(
    (i): ModuleActiveIssue => ({
      key: i.key,
      title: i.title,
      status: i.status,
      tone: i.standing.tone,
      step: i.standing.step,
      attentionGroup: i.standing.attentionGroup,
      waitingOn: i.standing.waitingOn,
      modulePath: i.standing.module?.path ?? '',
    }),
  );

  const observed = drift.undeclared.map((e) => ({
    aId: e.a.labelId,
    bId: e.b.labelId,
    issueCount: e.issueCount,
    recentIssueKeys: e.recentIssueSeqs.map((s) => formatIssueRef(prefix, s)),
  }));
  const keys = new Set(seqs.map((s) => formatIssueRef(prefix, s)));
  const feedback = await openFeedbackOf(projectId, viewer, keys);

  const linked = node.knowledgeEntryId !== null;
  const parent = node.parentId ? (refs.get(node.parentId) ?? null) : null;
  const self = refs.get(node.id);
  if (!self) throw new Error(`modules/detail: module ${node.id} has no ref`);
  const days = activityDays(activity, now);

  return {
    module: {
      ...self,
      color: node.color,
      description: node.description,
      parent,
      children: nodes
        .filter((n) => n.parentId === node.id)
        .map((n) => refs.get(n.id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined),
    },
    standing,
    purpose: purposeOf(entry, linked),
    keyPaths: keyPathsFact(entry, linked),
    couplings: couplingsOf(node.id, refs, declared, observed),
    landings: { total: landings.total, recent: landingsOf(landings.recent, paths) },
    activity: { days, total: days.reduce((n, d) => n + d.events, 0) },
    issues,
    feedback,
    contracts: { available: false, reason: 'a contract names no module in its interface document' },
    owner: { available: false, reason: 'a module label records no owner' },
    issuesRead: issuesReadOf(list),
  };
}
