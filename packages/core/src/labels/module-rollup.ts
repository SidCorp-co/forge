import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, issues, labels } from '../db/schema.js';
import { TERMINAL_FOR_DISPATCH } from '../issues/apply-transition.js';

/**
 * ISS-949 — the backlog read by module instead of by issue.
 *
 * Everything here is derived from `issue_labels` joined to `kind='module'` labels. There is no
 * second store of module membership and this must not become one: `resolveModuleIdsTolerant`
 * answers "which issues are in module X" and `listModulesForIssues` answers "which modules is
 * issue Y in"; this answers the third question, across all modules at once.
 */

export const DEFAULT_ACTIVE_WITHIN_DAYS = 30;

export interface ModuleCounts {
  total: number;
  open: number;
  closed: number;
  recentlyActive: number;
}

/**
 * ISS-949 — primary and secondary attributions are counted apart and never summed. An issue
 * contributes to its primary module's `primary` and to each secondary module's `secondary`, so a
 * consumer reading one block knows which attribution it is looking at.
 */
export interface ModuleAttributionCounts {
  primary: ModuleCounts;
  secondary: ModuleCounts;
}

export interface ModuleRollupRow {
  id: string;
  name: string;
  slug: string | null;
  color: string;
  parentId: string | null;
  depth: number;
  /** Issues attributed to this module itself. */
  own: ModuleAttributionCounts;
  /** Issues attributed to a descendant and not already in `own` for the same attribution kind. */
  inherited: ModuleAttributionCounts;
  /** `own + inherited`, which holds exactly because `inherited` excludes what `own` already has. */
  rollup: ModuleAttributionCounts;
}

export interface ModuleRollupResponse {
  activeWithinDays: number;
  generatedAt: string;
  modules: ModuleRollupRow[];
  /** Issues carrying no module attribution at all — their own bucket, never assigned anywhere. */
  unassigned: ModuleCounts;
}

type AttributionRow = {
  issueId: string;
  labelId: string | null;
  isPrimary: boolean | null;
  closed: boolean;
  recentlyActive: boolean;
};

const emptyCounts = (): ModuleCounts => ({ total: 0, open: 0, closed: 0, recentlyActive: 0 });

// cm:why the read is per ATTRIBUTION rather than a grouped count because the parent rollup dedupes by issue: an issue that is a secondary on both a parent and its child would otherwise be counted twice in the parent's own+inherited, and counts cannot express identity
async function readAttributions(
  projectId: string,
  activeWithinDays: number,
): Promise<AttributionRow[]> {
  const moduleIds = db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.projectId, projectId), eq(labels.kind, 'module')));

  // cm:guard the join is narrowed to MODULE junction rows, not to junction rows — narrowing after the join instead gives an issue carrying only a plain label a NULL row of its own, and that row is what the unattributed bucket is read from, so holding a plain label and holding nothing would read identically
  return db
    .select({
      issueId: issues.id,
      labelId: issueLabels.labelId,
      isPrimary: issueLabels.isPrimary,
      closed: sql<boolean>`${issues.status} in ${[...TERMINAL_FOR_DISPATCH]}`,
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
  if (row.closed) counts.closed += 1;
  else counts.open += 1;
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
  // cm:guard the seen set bounds the walk — `parentId` is acyclic only because `module-service.ts`
  // refuses a cycle, and a row written around that route would recurse forever here.
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
    recentlyActive: a.recentlyActive + b.recentlyActive,
  };
}

export async function moduleRollup(
  projectId: string,
  activeWithinDays = DEFAULT_ACTIVE_WITHIN_DAYS,
): Promise<ModuleRollupResponse> {
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
  // cm:guard a module with no issues is a row of zeroes, never an absent row — a caller cannot tell a missing row from an empty module, so the ordered taxonomy drives the output and the attributions only fill it in
  const modules = orderModules(moduleRows).map(({ id, depth }): ModuleRollupRow => {
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
