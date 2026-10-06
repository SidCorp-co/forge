// One module's detail: its standing, purpose, key paths, couplings, landings, activity and feedback.

import {
  MODULE_BODY_LIMIT,
  type ModuleActiveIssue,
  type ModuleDetail,
  type ModuleFact,
  type ModuleFeedbackRef,
  type ModulePurpose,
  modulePaths,
} from '@forge/contracts/modules';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { activeIssuePrefix, listIssueStanding } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { notFound } from '../middleware/route-errors.js';
import { moduleDrift } from './module-drift.js';
import {
  activityDays,
  couplingsOf,
  deriveStandings,
  keyPathsOf,
  landingsOf,
  moduleRefs,
  railOrder,
  subtreesOf,
  summaryOf,
} from './module-standing.js';
import {
  issuesReadOf,
  type ModuleViewer,
  openIssuesOf,
  readActivity,
  readIssueSeqs,
  readLatestLandings,
  readNodes,
  readRecentLandings,
  readTraces,
} from './module-standing-read.js';
import { listFeedbackAs } from './ports.js';

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
        (f.route?.route === 'issue' &&
          f.route.carriers.some((c) => c.key !== null && issueKeys.has(c.key))),
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
  const [list, traces, latest, landings, activity, seqs, entry, drift] = await Promise.all([
    listIssueStanding(projectId, 'open', { userId: viewer.userId }),
    readTraces(projectId),
    readLatestLandings(projectId, prefix),
    readRecentLandings(projectId, subtree, prefix),
    readActivity(projectId, subtree, since),
    readIssueSeqs(projectId, subtree),
    node.knowledgeEntryId ? readEntry(projectId, node.knowledgeEntryId) : Promise.resolve(null),
    moduleDrift(projectId),
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
    couplings: couplingsOf(node.id, refs, observed),
    landings: { total: landings.total, recent: landingsOf(landings.recent, paths) },
    activity: { days, total: days.reduce((n, d) => n + d.events, 0) },
    issues,
    feedback,
    contracts: { available: false, reason: 'a contract names no module in its interface document' },
    owner: { available: false, reason: 'a module label records no owner' },
    issuesRead: issuesReadOf(list),
  };
}
