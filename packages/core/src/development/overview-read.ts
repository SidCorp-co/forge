import type {
  DevelopmentOverview,
  OverviewContractsSignal,
  OverviewMasterSignal,
} from '@forge/contracts/development-overview';
import {
  OVERVIEW_WINDOW_DAYS,
  OVERVIEW_WINDOWS_SHOWN,
} from '@forge/contracts/development-overview';
import type { IssueStandingRow } from '@forge/contracts/issue-standing';
import type { WorkStep } from '@forge/contracts/issue-vocabulary';
import { slotsNoteOf } from '@forge/contracts/master-standing';
import { modulePaths } from '@forge/contracts/modules';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { listIssueStanding, STANDING_LIMIT, type StandingViewer } from '../issues/standing-read.js';
import { readMasterStanding } from '../masters/read.js';
import {
  type ContractChangeFact,
  flowOf,
  type LaneFacts,
  type ModuleFact,
  modulesOf,
  movingOf,
  OPEN_CONTRACT_CHANGE,
  type ProposedVersionFact,
  stuckOf,
} from './overview.js';

const terminalSessions = sql.join(
  terminalAgentSessionStatuses.map((s) => sql`${s}`),
  sql`, `,
);

const CI_UNAVAILABLE =
  'Core stores check runs for pull requests only, never for a branch head, so it holds no reading of dev itself.';
const POST_MERGE_UNAVAILABLE =
  'A push to a gated branch carries its post-merge jobs on GitHub; core receives no event for them and stores none.';

async function laneFacts(
  projectId: string,
  rows: readonly IssueStandingRow[],
): Promise<Map<string, LaneFacts>> {
  const moving = rows.filter((r) => r.standing.attentionGroup === 'moving');
  const out = new Map<string, LaneFacts>();
  if (moving.length === 0) return out;
  const ids = idList(moving.map((r) => r.id));
  const found = rowsOf<{
    id: string;
    steps: { step: WorkStep; startedAt: string; endedAt: string | null }[] | null;
    box: string | null;
    acquired_at: string | null;
  }>(
    await db.execute(sql`
      SELECT i.id, w.steps, d.name AS box, l.acquired_at
        FROM issues i
        LEFT JOIN issue_work_state w ON w.issue_id = i.id
        LEFT JOIN issue_leases l
               ON l.project_id = i.project_id AND l.issue_key = 'ISS-' || i.iss_seq -- ISS-992:canonical
              AND EXISTS (SELECT 1 FROM agent_sessions s
                           WHERE s.id = l.session_id AND s.status NOT IN (${terminalSessions}))
        LEFT JOIN devices d ON d.id = l.device_id
       WHERE i.project_id = ${projectId} AND i.id IN (${ids})`),
  );
  const keyOf = new Map(moving.map((r) => [r.id, r.key]));
  for (const f of found) {
    const key = keyOf.get(f.id);
    if (!key) continue;
    out.set(key, {
      steps: f.steps ?? [],
      box: f.box,
      acquiredAt: f.acquired_at ? new Date(f.acquired_at).toISOString() : null,
    });
  }
  return out;
}

interface ModuleRaw {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
}

async function moduleFacts(projectId: string) {
  const [labels, shipped, loose] = await Promise.all([
    db.execute(sql`
      SELECT id, name, slug, parent_id FROM labels
       WHERE project_id = ${projectId} AND kind = 'module'`),
    db.execute(sql`
      WITH att AS (
        SELECT DISTINCT ON (il.issue_id) il.issue_id, l.id AS module_id
          FROM issue_labels il
          JOIN labels l ON l.id = il.label_id AND l.kind = 'module'
          JOIN issues i ON i.id = il.issue_id AND i.project_id = ${projectId}
         ORDER BY il.issue_id, il.is_primary DESC, l.name)
      SELECT att.module_id, count(*)::int AS shipped, max(i.merged_at) AS last_landing
        FROM att JOIN issues i ON i.id = att.issue_id
       WHERE i.status = 'closed' AND i.archived_at IS NULL
       GROUP BY att.module_id`),
    db.execute(sql`
      SELECT count(*)::int AS shipped, max(i.merged_at) AS last_landing
        FROM issues i
       WHERE i.project_id = ${projectId} AND i.status = 'closed' AND i.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id = il.label_id
                          WHERE il.issue_id = i.id AND l.kind = 'module')`),
  ]);
  const all = rowsOf<ModuleRaw>(labels);
  const paths = modulePaths(all.map((m) => ({ id: m.id, slug: m.slug, parentId: m.parent_id })));
  const stat = new Map(
    rowsOf<{ module_id: string; shipped: number; last_landing: string | null }>(shipped).map(
      (s) => [s.module_id, s],
    ),
  );
  const iso = (t: string | null | undefined) => (t ? new Date(t).toISOString() : null);
  const modules: ModuleFact[] = all.map((m) => ({
    id: m.id,
    path: paths.get(m.id) ?? m.slug,
    name: m.name,
    shipped: stat.get(m.id)?.shipped ?? 0,
    lastLandingAt: iso(stat.get(m.id)?.last_landing),
  }));
  const [none] = rowsOf<{ shipped: number; last_landing: string | null }>(loose);
  return {
    modules,
    unassigned: { shipped: none?.shipped ?? 0, lastLandingAt: iso(none?.last_landing) },
  };
}

async function masterSignal(projectId: string): Promise<OverviewMasterSignal> {
  const [[row], standing] = await Promise.all([
    db
      .execute(sql`
        SELECT count(*)::int AS masters
          FROM agent_sessions
         WHERE project_id = ${projectId} AND kind = 'master' AND status NOT IN (${terminalSessions})`)
      .then((r) => rowsOf<{ masters: number }>(r)),
    readMasterStanding(projectId),
  ]);
  return {
    masters: row?.masters ?? 0,
    state: standing.state,
    slots: standing.slots,
    slotsNote: slotsNoteOf(standing),
  };
}

async function proposedVersions(projectId: string): Promise<ProposedVersionFact[]> {
  const found = rowsOf<{
    slug: string;
    contract_slug: string;
    version: string;
    classification: string;
    recorded_at: string;
  }>(
    await db.execute(sql`
      SELECT p.slug, v.contract_slug, v.version, v.classification, v.recorded_at
        FROM contract_versions v JOIN projects p ON p.id = v.provider_project_id
       WHERE v.provider_project_id = ${projectId} AND v.approval = 'proposed'
       ORDER BY v.recorded_at DESC`),
  );
  if (found.length === 0) return [];
  return found.map((v) => {
    const ref = `${v.slug}/${v.contract_slug}`;
    return {
      contract: ref,
      version: v.version,
      classification: v.classification,
      recordedAt: new Date(v.recorded_at).toISOString(),
    };
  });
}

async function contractChanges(projectId: string): Promise<ContractChangeFact[]> {
  const found = rowsOf<{
    fb_seq: number;
    title: string;
    due_at: string;
    status: string;
    slug: string;
    contract_slug: string;
    contract_version: string;
  }>(
    await db.execute(sql`
      SELECT f.fb_seq, f.title, f.due_at, f.status, p.slug, f.contract_slug, f.contract_version
        FROM feedback f JOIN projects p ON p.id = f.contract_provider_project_id
       WHERE f.project_id = ${projectId} AND f.kind = 'contract_change' AND f.due_at IS NOT NULL
       ORDER BY f.due_at`),
  );
  return found.map((f) => ({
    feedback: `FB-${f.fb_seq}`,
    contract: `${f.slug}/${f.contract_slug}`,
    version: f.contract_version,
    title: f.title,
    dueAt: new Date(f.due_at).toISOString(),
    status: f.status,
  }));
}

function contractsSignal(
  changes: readonly ContractChangeFact[],
  proposed: readonly ProposedVersionFact[],
): OverviewContractsSignal {
  const open = changes.filter((c) => OPEN_CONTRACT_CHANGE.includes(c.status));
  return {
    windows: open.slice(0, OVERVIEW_WINDOWS_SHOWN).map((c) => ({
      contract: c.contract,
      version: c.version,
      dueAt: c.dueAt,
      feedback: c.feedback,
    })),
    openWindows: open.length,
    awaitingApproval: proposed.length,
  };
}

export async function readDevelopmentOverview(
  projectId: string,
  viewer: StandingViewer | null,
  now: Date = new Date(),
): Promise<DevelopmentOverview> {
  const [open, closed] = await Promise.all([
    listIssueStanding(projectId, 'open', viewer, now),
    listIssueStanding(projectId, 'closed', viewer, now),
  ]);
  const rows = [...open.issues, ...closed.issues];
  const [lanes, mods, master, proposed, changes] = await Promise.all([
    laneFacts(projectId, open.issues),
    moduleFacts(projectId),
    masterSignal(projectId),
    proposedVersions(projectId),
    contractChanges(projectId),
  ]);
  const oldest = closed.issues.at(-1);
  const cutoff = now.getTime() - OVERVIEW_WINDOW_DAYS * 86_400_000;
  return {
    generatedAt: now.toISOString(),
    signals: {
      ci: { available: false, reason: CI_UNAVAILABLE },
      postMerge: { available: false, reason: POST_MERGE_UNAVAILABLE },
      contracts: contractsSignal(changes, proposed),
      master,
    },
    flow: flowOf(rows, now),
    moving: movingOf(open.issues, lanes, now),
    stuck: stuckOf(open.issues),
    modules: modulesOf(open.issues, mods.modules, mods.unassigned),
    coverage: {
      open: open.counts.open,
      openRead: open.returned,
      limit: STANDING_LIMIT,
      flowTruncated:
        closed.returned >= closed.limit &&
        oldest !== undefined &&
        new Date(oldest.standing.touchedAt).getTime() >= cutoff,
    },
  };
}
