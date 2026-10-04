import type {
  ModuleAttributionCounts,
  ModuleCounts,
  ModuleLevelCoupling,
  ModuleRollupRow,
} from '@forge/contracts/modules';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, issues, labels } from '../db/schema.js';
import { issueArchiveSide } from '../issues/index.js';

/**
 * ISS-949 — the backlog read by module instead of by issue.
 *
 * Everything here is derived from `issue_labels` joined to `kind='module'` labels. There is no
 * second store of module membership and this must not become one: `resolveModuleIdsTolerant`
 * answers "which issues are in module X" and `listModulesForIssues` answers "which modules is
 * issue Y in"; this answers the third question, across all modules at once.
 */

export const DEFAULT_ACTIVE_WITHIN_DAYS = 30;

type ModuleCountsRow = Omit<
  ModuleRollupRow,
  'path' | 'description' | 'knowledgeEntryId' | 'standing'
>;

interface ModuleCountsResponse {
  activeWithinDays: number;
  generatedAt: string;
  modules: ModuleCountsRow[];
  unassigned: ModuleCounts;
}

type AttributionRow = {
  issueId: string;
  labelId: string | null;
  isPrimary: boolean | null;
  state: CountedState;
  recentlyActive: boolean;
};

// cm:why closed is shipped and dropped is not work (workflow `issue-lifecycle`); every other status,
// `awaiting_release` and `draft` among them, is open, as `issues/standing-read.ts:scopeCounts` counts.
type CountedState = 'open' | 'closed' | 'dropped';

const emptyCounts = (): ModuleCounts => ({
  total: 0,
  open: 0,
  closed: 0,
  dropped: 0,
  recentlyActive: 0,
});

async function readAttributions(
  projectId: string,
  activeWithinDays: number,
): Promise<AttributionRow[]> {
  const moduleIds = db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.projectId, projectId), eq(labels.kind, 'module')));

  return db
    .select({
      issueId: issues.id,
      labelId: issueLabels.labelId,
      isPrimary: issueLabels.isPrimary,
      state: sql<CountedState>`CASE ${issues.status} WHEN 'closed' THEN 'closed' WHEN 'dropped' THEN 'dropped' ELSE 'open' END`,
      recentlyActive: sql<boolean>`${issues.updatedAt} >= now() - make_interval(days => ${activeWithinDays})`,
    })
    .from(issues)
    .leftJoin(
      issueLabels,
      and(eq(issueLabels.issueId, issues.id), inArray(issueLabels.labelId, moduleIds)),
    )
    .where(eq(issues.projectId, projectId));
}

function add(counts: ModuleCounts, row: AttributionRow): void {
  counts.total += 1;
  counts[row.state] += 1;
  if (row.recentlyActive) counts.recentlyActive += 1;
}

function countsOf(rows: readonly AttributionRow[]): ModuleCounts {
  const out = emptyCounts();
  for (const row of rows) add(out, row);
  return out;
}

/**
 * Depth-first, alphabetical within each level — the order the screen indents by, and the order
 * `descendantsOf` walks. A module whose parent is not a module of this project is a root: the
 * hierarchy has to stay reachable even when a row points somewhere it should not.
 */
function orderModules(
  rows: readonly { id: string; name: string; parentId: string | null }[],
): { id: string; depth: number }[] {
  const ids = new Set(rows.map((r) => r.id));
  const byParent = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    const key = row.parentId && ids.has(row.parentId) ? row.parentId : '';
    byParent.set(key, [...(byParent.get(key) ?? []), row]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const out: { id: string; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string, depth: number): void => {
    for (const row of byParent.get(parent) ?? []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ id: row.id, depth });
      walk(row.id, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

/** Every module below `id`, at any depth. */
function descendantsOf(childrenOf: Map<string, string[]>, id: string): string[] {
  const out: string[] = [];
  const queue = [...(childrenOf.get(id) ?? [])];
  const seen = new Set<string>(queue);
  while (queue.length > 0) {
    const next = queue.shift() as string;
    out.push(next);
    for (const child of childrenOf.get(next) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return out;
}

function attributionsFor(
  ids: readonly string[],
  byModule: Map<string, AttributionRow[]>,
  exclude: { primary: ReadonlySet<string>; secondary: ReadonlySet<string> },
): ModuleAttributionCounts {
  const seen = { primary: new Set(exclude.primary), secondary: new Set(exclude.secondary) };
  const kept: { primary: AttributionRow[]; secondary: AttributionRow[] } = {
    primary: [],
    secondary: [],
  };
  for (const id of ids) {
    for (const row of byModule.get(id) ?? []) {
      const kind = row.isPrimary ? 'primary' : 'secondary';
      if (seen[kind].has(row.issueId)) continue;
      seen[kind].add(row.issueId);
      kept[kind].push(row);
    }
  }
  return { primary: countsOf(kept.primary), secondary: countsOf(kept.secondary) };
}

function issueIdsBy(rows: readonly AttributionRow[], primary: boolean): Set<string> {
  return new Set(rows.filter((r) => r.isPrimary === primary).map((r) => r.issueId));
}

function sumCounts(a: ModuleCounts, b: ModuleCounts): ModuleCounts {
  return {
    total: a.total + b.total,
    open: a.open + b.open,
    closed: a.closed + b.closed,
    dropped: a.dropped + b.dropped,
    recentlyActive: a.recentlyActive + b.recentlyActive,
  };
}

export async function moduleRollup(
  projectId: string,
  activeWithinDays = DEFAULT_ACTIVE_WITHIN_DAYS,
): Promise<ModuleCountsResponse> {
  const moduleRows = await db
    .select({
      id: labels.id,
      name: labels.name,
      slug: labels.slug,
      color: labels.color,
      parentId: labels.parentId,
    })
    .from(labels)
    .where(and(eq(labels.projectId, projectId), eq(labels.kind, 'module')));

  const attributions = await readAttributions(projectId, activeWithinDays);

  const byModule = new Map<string, AttributionRow[]>();
  const unattributed: AttributionRow[] = [];
  for (const row of attributions) {
    if (row.labelId === null) unattributed.push(row);
    else byModule.set(row.labelId, [...(byModule.get(row.labelId) ?? []), row]);
  }

  const childrenOf = new Map<string, string[]>();
  const ids = new Set(moduleRows.map((m) => m.id));
  for (const m of moduleRows) {
    if (!m.parentId || !ids.has(m.parentId)) continue;
    childrenOf.set(m.parentId, [...(childrenOf.get(m.parentId) ?? []), m.id]);
  }

  const byId = new Map(moduleRows.map((m) => [m.id, m]));
  const modules = orderModules(moduleRows).map(({ id, depth }): ModuleCountsRow => {
    const module = byId.get(id) as (typeof moduleRows)[number];
    const ownRows = byModule.get(id) ?? [];
    const own = attributionsFor([id], byModule, { primary: new Set(), secondary: new Set() });
    const inherited = attributionsFor(descendantsOf(childrenOf, id), byModule, {
      primary: issueIdsBy(ownRows, true),
      secondary: issueIdsBy(ownRows, false),
    });
    return {
      id,
      name: module.name,
      slug: module.slug,
      color: module.color,
      parentId: module.parentId,
      depth,
      own,
      inherited,
      rollup: {
        primary: sumCounts(own.primary, inherited.primary),
        secondary: sumCounts(own.secondary, inherited.secondary),
      },
    };
  });

  return {
    activeWithinDays,
    generatedAt: new Date().toISOString(),
    modules,
    unassigned: countsOf(unattributed),
  };
}

/** Each unarchived issue's module labels, for issues that carry at least one. */
export async function readIssueModuleSets(projectId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ issueId: issueLabels.issueId, labelId: issueLabels.labelId })
    .from(issueLabels)
    .innerJoin(
      labels,
      and(eq(labels.id, issueLabels.labelId), eq(labels.kind, 'module'), eq(labels.projectId, projectId)),
    )
    .innerJoin(issues, and(eq(issues.id, issueLabels.issueId), ...issueArchiveSide(false)));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.issueId, [...(out.get(r.issueId) ?? []), r.labelId]);
  return out;
}

interface LevelCouplingInput {
  nodes: readonly { id: string; parentId: string | null }[];
  declared: readonly { fromId: string; toId: string }[];
  issueModules: ReadonlyMap<string, readonly string[]>;
}

/** Each module's chain to its root, itself first; bounded like `orderModules`, so a cycle ends. */
function chainsOf(nodes: LevelCouplingInput['nodes']): Map<string, string[]> {
  const parentOf = new Map(nodes.map((n) => [n.id, n.parentId] as const));
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    const chain = [n.id];
    const seen = new Set(chain);
    let at = n.parentId;
    while (at !== null && parentOf.has(at) && !seen.has(at)) {
      chain.push(at);
      seen.add(at);
      at = parentOf.get(at) ?? null;
    }
    out.set(n.id, chain);
  }
  return out;
}

interface Meeting {
  parentId: string | null;
  /** The sibling holding the first module. */
  from: string;
  /** The sibling holding the second. */
  to: string;
}

/**
 * Where a coupling between two modules shows: between the two children of their nearest common
 * ancestor that hold them, or between their two roots. Null when one module is the other's
 * ancestor, which the hierarchy already declares.
 */
function meetingOf(chains: Map<string, string[]>, x: string, y: string): Meeting | null {
  const cx = chains.get(x);
  const cy = chains.get(y);
  if (!cx || !cy) return null;
  const inY = new Set(cy);
  const i = cx.findIndex((id) => inY.has(id));
  if (i === -1) {
    return { parentId: null, from: cx[cx.length - 1] as string, to: cy[cy.length - 1] as string };
  }
  const j = cy.indexOf(cx[i] as string);
  if (i === 0 || j === 0) return null;
  return { parentId: cx[i] as string, from: cx[i - 1] as string, to: cy[j - 1] as string };
}

/**
 * ISS-183 — the couplings a module map draws at each level of the tree. Every declared edge and
 * every issue carrying two modules lands on exactly one sibling pair, so a level's edges are the
 * couplings of everything beneath its modules, and nothing is counted at two levels.
 */
export function levelCouplings(input: LevelCouplingInput): ModuleLevelCoupling[] {
  const chains = chainsOf(input.nodes);
  const byKey = new Map<string, ModuleLevelCoupling>();
  const entry = (m: Meeting): { row: ModuleLevelCoupling; forward: boolean } => {
    const forward = m.from < m.to;
    const [aId, bId] = forward ? [m.from, m.to] : [m.to, m.from];
    const key = `${m.parentId ?? ''}|${aId}|${bId}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        parentId: m.parentId,
        aId,
        bId,
        declaredAToB: 0,
        declaredBToA: 0,
        sharedIssues: 0,
        weight: 0,
        twoWay: false,
      };
      byKey.set(key, row);
    }
    return { row, forward };
  };

  for (const e of input.declared) {
    const m = meetingOf(chains, e.fromId, e.toId);
    if (!m) continue;
    const { row, forward } = entry(m);
    if (forward) row.declaredAToB += 1;
    else row.declaredBToA += 1;
  }

  for (const moduleIds of input.issueModules.values()) {
    const touched = new Set<ModuleLevelCoupling>();
    for (let i = 0; i < moduleIds.length; i++) {
      for (let j = i + 1; j < moduleIds.length; j++) {
        const m = meetingOf(chains, moduleIds[i] as string, moduleIds[j] as string);
        if (m) touched.add(entry(m).row);
      }
    }
    for (const row of touched) row.sharedIssues += 1;
  }

  return [...byKey.values()]
    .map((r) => ({
      ...r,
      weight: r.declaredAToB + r.declaredBToA + r.sharedIssues,
      twoWay: r.declaredAToB > 0 && r.declaredBToA > 0,
    }))
    .sort((x, y) => (x.parentId ?? '').localeCompare(y.parentId ?? '') || y.weight - x.weight);
}
