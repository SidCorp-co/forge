// The module map's reads (ISS-1256): the pillar (one row per business module, a count per type over
// its subtree, open issues as the only health figure, and the Unplaced row), one module's tree (its
// terms, rules, capabilities, requirements, decisions and references, each with its relations, its
// re-check and how often agents read it, and its issues in flight), and the one line per module every
// agent's Tier-0 map carries. Every figure is a read of what agents and people wrote; nothing is
// inferred, and an unplaced record is listed as a gap, never refused.

import {
  MODULE_MAP_BRANCHES,
  MODULE_MAP_READS_WINDOW_DAYS,
  MODULE_MAP_UNPLACED_SHOWN,
  type ModuleLandingMap,
  type ModuleMapBranch,
  type ModuleMapCounts,
  type ModuleMapLine,
  type ModuleMapModuleRef,
  type ModuleMapNode,
  type ModuleMapNodeType,
  type ModuleMapRecheck,
  type ModuleMapRelationView,
  type ModulePillarResponse,
  type ModuleTreeResponse,
  type ModuleUnplacedItem,
  type TermAliases,
  type TermNamedBy,
} from '@forge/contracts/module-map';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { listIssueStanding } from '../issues/index.js';
import { cardFreshness } from '../lessons/index.js';
import { doorCallsOf } from '../lib/door-catalog.js';
import {
  capabilityModules,
  type MapModule,
  type MapModules,
  mapModules,
  moduleNamed,
} from './module-map-nodes.js';

const DAY_MS = 86_400_000;

/** One record as the map reads it, before it is shaped for the pillar or the tree. */
interface Item {
  type: ModuleMapBranch | 'knowledge' | 'lesson';
  ref: string;
  /** The id a read of it is recorded by, where it differs from `ref` (a requirement's, not REQ-n). */
  readRef?: string;
  title: string;
  moduleId: string | null;
  body?: string | null;
  status?: string | null;
  term?: { aliases?: TermAliases; namedBy?: TermNamedBy } | null | undefined;
  recheck?: ModuleMapRecheck | null;
  agency?: 'human' | 'agent' | 'imported' | null;
}

interface EntryRaw {
  slug: string;
  kind: string;
  title: string;
  body: string;
  module_id: string | null;
  term: Item['term'];
  recheck_due: ModuleMapRecheck | null;
  confidence: string;
  authored_by: 'human' | 'agent' | 'imported';
}

async function knowledgeItems(projectId: string): Promise<Item[]> {
  const rows = rowsOf<EntryRaw>(
    await db.execute(sql`
      SELECT slug, kind, title, left(body, 400) AS body, module_id, term,
             metadata->'recheckDue' AS recheck_due, confidence, authored_by
        FROM knowledge_entries
       WHERE project_id = ${projectId} AND archived_at IS NULL AND kind <> 'lesson'
       ORDER BY title`),
  );
  return rows.map((r) => ({
    type: r.kind === 'glossary' ? 'term' : r.kind === 'rule' ? 'rule' : 'knowledge',
    ref: r.slug,
    title: r.title,
    moduleId: r.module_id,
    body: r.body,
    status: r.confidence === 'deprecated' ? 'deprecated' : 'active',
    term: r.term,
    recheck: r.recheck_due,
    agency: r.authored_by,
  }));
}

async function recordItems(projectId: string): Promise<Item[]> {
  const [reqs, decisions, refs, lessons] = await Promise.all([
    db.execute(sql`
      SELECT 'REQ-' || req_seq AS ref, id::text AS read_ref, title, module_id, status
        FROM requirements WHERE project_id = ${projectId} AND status <> 'dropped'
       ORDER BY req_seq`),
    // a decision is the map's when it is placed, or a person's left unplaced (an agent's pass logs
    // are decisions too, and folded away as every decision read folds them)
    db.execute(sql`
      SELECT c.id::text AS ref, left(coalesce(c.decision->>'decision', c.body), 200) AS title,
             c.module_id, c.body
        FROM comments c
        LEFT JOIN issues i ON i.id = c.issue_id
        LEFT JOIN requirements r ON r.id = c.requirement_id
        LEFT JOIN project_workflows w ON w.id = c.workflow_id
        LEFT JOIN feedback f ON f.id = c.feedback_id
        LEFT JOIN users u ON u.id = c.author_id
       WHERE c.intent = 'decision'
         AND coalesce(i.project_id, r.project_id, w.project_id, f.project_id) = ${projectId}::uuid
         AND (c.module_id IS NOT NULL
              OR (c.author_device_id IS NULL AND coalesce(u.kind, 'human') = 'human'))
       ORDER BY c.created_at DESC`),
    db.execute(sql`
      SELECT id::text AS ref, title, module_id, why AS body
        FROM reference_sources
       WHERE project_id = ${projectId} AND removed_at IS NULL ORDER BY priority, title`),
    db.execute(sql`
      SELECT 'L-' || number AS ref, sentence AS title, module_id, status
        FROM lessons
       WHERE project_id = ${projectId} AND status IN ('proposed', 'approved', 'held')
       ORDER BY number`),
  ]);
  type Raw = {
    ref: string;
    read_ref?: string;
    title: string;
    module_id: string | null;
    status?: string;
    body?: string;
  };
  const of = (type: Item['type'], rows: unknown) =>
    rowsOf<Raw>(rows as never).map(
      (r): Item => ({
        type,
        ref: r.ref,
        ...(r.read_ref ? { readRef: r.read_ref } : {}),
        title: r.title,
        moduleId: r.module_id,
        status: r.status ?? null,
        body: r.body ?? null,
      }),
    );
  return [
    ...of('requirement', reqs),
    ...of('decision', decisions),
    ...of('reference', refs),
    ...of('lesson', lessons),
  ];
}

function capabilityItems(modules: MapModules): Item[] {
  return capabilityModules(modules).map(({ card, module }) => ({
    type: 'capability',
    ref: card.id,
    title: card.purpose,
    moduleId: module?.id ?? null,
  }));
}

const emptyCounts = (): ModuleMapCounts => ({
  term: 0,
  rule: 0,
  capability: 0,
  requirement: 0,
  decision: 0,
  reference: 0,
  knowledge: 0,
  lesson: 0,
});

const refOf = (m: MapModule): ModuleMapModuleRef => ({
  id: m.id,
  slug: m.slug,
  name: m.name,
  path: m.path,
});

/** Open issues by the module each is placed in (its primary module), and those placed in none. */
async function openIssues(projectId: string) {
  const list = await listIssueStanding(projectId, 'open', new Date(), 10_000);
  return list.issues.map((i) => ({
    key: i.key,
    title: i.title,
    status: i.status,
    moduleId: i.standing.module?.id ?? null,
  }));
}

/** GET /api/projects/:id/modules/map. */
export async function readModulePillar(
  projectId: string,
  now: Date = new Date(),
): Promise<ModulePillarResponse> {
  const modules = await mapModules(projectId);
  const [entries, records, issues] = await Promise.all([
    knowledgeItems(projectId),
    recordItems(projectId),
    openIssues(projectId),
  ]);
  const items = [...entries, ...records, ...capabilityItems(modules)];
  const roots = modules.list.filter((m) => m.parentId === null);
  const byRoot = new Map(roots.map((r) => [r.id, { counts: emptyCounts(), open: 0 }]));
  const unplaced = { counts: emptyCounts(), open: 0, items: [] as ModuleUnplacedItem[] };
  const shown = new Map<string, number>();
  const rootOf = (id: string | null) => (id ? modules.byId.get(id)?.rootId : undefined);
  const list = (item: ModuleUnplacedItem) => {
    const n = shown.get(item.type) ?? 0;
    if (n < MODULE_MAP_UNPLACED_SHOWN) unplaced.items.push(item);
    shown.set(item.type, n + 1);
  };
  for (const item of items) {
    const root = rootOf(item.moduleId);
    const row = root ? byRoot.get(root) : undefined;
    if (row) {
      row.counts[item.type] += 1;
      continue;
    }
    unplaced.counts[item.type] += 1;
    list({ type: item.type, ref: item.ref, title: item.title });
  }
  for (const issue of issues) {
    const root = rootOf(issue.moduleId);
    const row = root ? byRoot.get(root) : undefined;
    if (row) row.open += 1;
    else {
      unplaced.open += 1;
      list({ type: 'issue', ref: issue.key, title: issue.title });
    }
  }
  return {
    generatedAt: now.toISOString(),
    branches: MODULE_MAP_BRANCHES,
    modules: roots.map((r) => ({
      module: refOf(r),
      description: r.description,
      counts: byRoot.get(r.id)?.counts ?? emptyCounts(),
      openIssues: byRoot.get(r.id)?.open ?? 0,
    })),
    unplaced: { counts: unplaced.counts, openIssues: unplaced.open, items: unplaced.items },
  };
}

interface RelationRaw {
  id: string;
  from_slug: string;
  from_kind: string;
  kind: 'used_in' | 'governs' | 'from' | 'anchored_at';
  to_type: ModuleMapNodeType;
  to_ref: string;
  written_name: string | null;
  written_agency: 'human' | 'agent';
  created_at: string;
}

async function relationRows(projectId: string): Promise<RelationRaw[]> {
  return rowsOf<RelationRaw>(
    await db.execute(sql`
      SELECT r.id, e.slug AS from_slug, e.kind AS from_kind, r.kind, r.to_type, r.to_ref,
             u.display_name AS written_name, r.written_agency, r.created_at
        FROM knowledge_relations r
        JOIN knowledge_entries e ON e.id = r.from_entry_id AND e.archived_at IS NULL
        LEFT JOIN users u ON u.id = r.written_by
       WHERE r.project_id = ${projectId}
       ORDER BY r.created_at`),
  );
}

/**
 * The reads over the window, keyed `<type>:<ref>` as the tree's nodes read them: every source that
 * reached a run or was opened through find (`run_context_reaches`, a person's open outside any run
 * included, ISS-1256), a capability's door calls and a reference's citations beside them.
 */
async function readCounts(projectId: string, since: Date): Promise<Map<string, number>> {
  const [reaches, citations, calls] = await Promise.all([
    db.execute(sql`
      SELECT kind, ref, count(*)::int AS n FROM run_context_reaches
       WHERE project_id = ${projectId} AND created_at >= ${since.toISOString()}::timestamptz
       GROUP BY kind, ref`),
    db.execute(sql`
      SELECT source_id::text AS ref, count(*)::int AS n FROM reference_citations
       WHERE project_id = ${projectId} AND cited_at >= ${since.toISOString()}::timestamptz
       GROUP BY source_id`),
    doorCallsOf(projectId, MODULE_MAP_READS_WINDOW_DAYS),
  ]);
  const out = new Map<string, number>();
  const add = (key: string, n: number) => out.set(key, (out.get(key) ?? 0) + n);
  // a term is a knowledge entry and a rule a rule entry, both read by slug
  for (const r of rowsOf<{ kind: string; ref: string; n: number }>(reaches)) {
    add(`${r.kind === 'rule' ? 'knowledge' : r.kind}:${r.ref}`, r.n);
  }
  for (const r of rowsOf<{ ref: string; n: number }>(citations)) add(`reference:${r.ref}`, r.n);
  for (const [door, n] of calls) add(`capability:${door}`, n);
  return out;
}

/** The key a node's reads are counted under: a term or rule by slug, a requirement by its id. */
const readKey = (type: ModuleMapBranch, item: Item): string =>
  type === 'term' || type === 'rule'
    ? `knowledge:${item.ref}`
    : `${type}:${item.readRef ?? item.ref}`;

const firstLine = (body: string | null | undefined): string | null => {
  const line = body
    ?.split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));
  return line ? line.slice(0, 200) : null;
};

/** GET /api/projects/:id/modules/:module/map, and `module.get`: one module's tree. */
export async function readModuleTree(
  projectId: string,
  ref: string,
  now: Date = new Date(),
): Promise<ModuleTreeResponse> {
  const modules = await mapModules(projectId);
  const module = moduleNamed(modules, ref, '/module');
  const within = new Set(
    modules.list
      .filter((m) => m.path === module.path || m.path.startsWith(`${module.path}/`))
      .map((m) => m.id),
  );
  const since = new Date(now.getTime() - MODULE_MAP_READS_WINDOW_DAYS * DAY_MS);
  const [entries, records, issues, relations, reads, freshness] = await Promise.all([
    knowledgeItems(projectId),
    recordItems(projectId),
    openIssues(projectId),
    relationRows(projectId),
    readCounts(projectId, since),
    cardFreshness(),
  ]);
  const capabilities = capabilityItems(modules);
  const all = [...entries, ...records, ...capabilities];
  const owed = new Map(
    freshness.filter((f) => f.recheckOwed).map((f) => [f.cardId, f.recheckOwed]),
  );
  const nodeType = (t: Item['type']): ModuleMapNodeType | null =>
    t === 'knowledge' || t === 'lesson' ? null : t;
  const index = new Map(
    all.flatMap((i) => {
      const t = nodeType(i.type);
      return t ? [[`${t}:${i.ref}`, i] as const] : [];
    }),
  );
  const pathOf = (id: string | null) => (id ? (modules.byId.get(id)?.path ?? null) : null);
  const other = (type: ModuleMapNodeType, ref: string): ModuleMapRelationView['other'] => {
    const lookup = type === 'requirement' ? ref.split(' ')[0] : ref;
    const found = index.get(`${type}:${lookup}`);
    return {
      type,
      ref,
      title: found?.title ?? null,
      module: found ? pathOf(found.moduleId) : null,
    };
  };
  const relationsOf = (item: Item, type: ModuleMapBranch): ModuleMapRelationView[] => {
    const views: ModuleMapRelationView[] = [];
    if (item.moduleId) {
      views.push({
        id: null,
        kind: 'belongs_to',
        direction: 'out',
        other: {
          type: 'module',
          ref: pathOf(item.moduleId) ?? '',
          title: modules.byId.get(item.moduleId)?.name ?? null,
          module: pathOf(item.moduleId),
        },
        writtenBy: null,
        at: null,
      });
    }
    for (const r of relations) {
      const fromType: ModuleMapBranch = r.from_kind === 'glossary' ? 'term' : 'rule';
      const by = { name: r.written_name, agency: r.written_agency };
      const at = new Date(r.created_at).toISOString();
      if (fromType === type && r.from_slug === item.ref && (type === 'term' || type === 'rule')) {
        views.push({
          id: r.id,
          kind: r.kind,
          direction: 'out',
          other: other(r.to_type, r.to_ref),
          writtenBy: by,
          at,
        });
      }
      const target = r.to_type === 'requirement' ? r.to_ref.split(' ')[0] : r.to_ref;
      if (r.to_type === type && target === item.ref) {
        views.push({
          id: r.id,
          kind: r.kind,
          direction: 'in',
          other: other(fromType, r.from_slug),
          writtenBy: by,
          at,
        });
      }
    }
    return views;
  };
  const branches = Object.fromEntries(
    MODULE_MAP_BRANCHES.map((b) => [b, [] as ModuleMapNode[]]),
  ) as Record<ModuleMapBranch, ModuleMapNode[]>;
  for (const item of all) {
    if (item.type === 'knowledge' || item.type === 'lesson') continue;
    if (!item.moduleId || !within.has(item.moduleId)) continue;
    const type = item.type;
    const cardOwed = type === 'capability' ? owed.get(item.ref) : undefined;
    branches[type].push({
      type,
      ref: item.ref,
      title: item.title,
      summary: type === 'capability' ? null : firstLine(item.body),
      module: pathOf(item.moduleId) ?? module.path,
      status: item.status ?? null,
      ...(type === 'term' && item.term?.aliases ? { aliases: item.term.aliases } : {}),
      ...(type === 'term' && item.term?.namedBy ? { namedBy: item.term.namedBy } : {}),
      writtenBy: item.agency ? { agency: item.agency } : null,
      relations: relationsOf(item, type),
      recheck: cardOwed
        ? { since: cardOwed.since, by: cardOwed.by, matched: [] }
        : (item.recheck ?? null),
      reads: reads.get(readKey(type, item)) ?? 0,
    });
  }
  const inFlight = issues
    .filter((i) => i.moduleId && within.has(i.moduleId))
    .map((i) => ({
      key: i.key,
      title: i.title,
      status: i.status,
      module: pathOf(i.moduleId) ?? '',
    }));
  const parent = module.parentId ? modules.byId.get(module.parentId) : undefined;
  return {
    module: {
      ...refOf(module),
      description: module.description,
      parent: parent ? refOf(parent) : null,
      children: modules.list.filter((m) => m.parentId === module.id).map(refOf),
    },
    branches,
    inFlight,
    openIssues: inFlight.length,
    readsWindowDays: MODULE_MAP_READS_WINDOW_DAYS,
    generatedAt: now.toISOString(),
  };
}

/**
 * One line per business module for a Tier-0 map: its slug, name, purpose, terms, rules and open
 * issues, the modules with most open work first (where agents are working), then by name.
 */
export async function moduleMapLines(projectId: string): Promise<ModuleMapLine[]> {
  const [modules, entries, issues] = await Promise.all([
    mapModules(projectId),
    knowledgeItems(projectId),
    openIssues(projectId),
  ]);
  const roots = modules.list.filter((m) => m.parentId === null);
  const tally = new Map(roots.map((r) => [r.id, { terms: 0, rules: 0, open: 0 }]));
  const rowOf = (id: string | null) => {
    const root = id ? modules.byId.get(id)?.rootId : undefined;
    return root ? tally.get(root) : undefined;
  };
  for (const e of entries) {
    const row = rowOf(e.moduleId);
    if (row && e.type === 'term') row.terms += 1;
    if (row && e.type === 'rule') row.rules += 1;
  }
  for (const i of issues) {
    const row = rowOf(i.moduleId);
    if (row) row.open += 1;
  }
  return roots
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      terms: tally.get(r.id)?.terms ?? 0,
      rules: tally.get(r.id)?.rules ?? 0,
      openIssues: tally.get(r.id)?.open ?? 0,
    }))
    .sort((a, b) => b.openIssues - a.openIssues || a.name.localeCompare(b.name));
}

/**
 * Where a landing's work sits on the map, for the merge mark's answer (ISS-1256 r5): the module the
 * issue is placed in with its terms, rules and re-checks owed, how many business modules hold none,
 * and the call that records a term or rule. The landing is the moment work finishes, where the
 * teaching has to sit: the cards that said "when work finishes, add terms" were never open then.
 * Read only: the issue's module is the one an agent or person placed it in, never one derived here.
 */
export async function landingMapOf(projectId: string, issueId: string): Promise<ModuleLandingMap> {
  const [modules, entries, placed] = await Promise.all([
    mapModules(projectId),
    knowledgeItems(projectId),
    db.execute(sql`
      SELECT l.id FROM issue_labels il JOIN labels l ON l.id = il.label_id
       WHERE il.issue_id = ${issueId} AND l.kind = 'module'
       ORDER BY il.is_primary DESC, l.name LIMIT 1`),
  ]);
  const roots = modules.list.filter((m) => m.parentId === null);
  const named = entries.filter((e) => e.type === 'term' || e.type === 'rule');
  const holding = new Set(
    named.map((e) => (e.moduleId ? modules.byId.get(e.moduleId)?.rootId : undefined)),
  );
  const empty = roots.filter((r) => !holding.has(r.id)).length;
  const id = rowsOf<{ id: string }>(placed)[0]?.id;
  const module = id ? modules.byId.get(id) : undefined;
  const base = `/api/projects/${projectId}`;
  const write = (slug: string) =>
    `PUT ${base}/knowledge/<slug> { kind: 'glossary', module: '${slug}', title, body, term: { aliases, namedBy }, anchor: 'file.ts:symbol' }, a rule with kind 'rule' and its source, scope and recheckWhen`;
  const counts = { total: roots.length, empty };
  if (!module) {
    return {
      module: null,
      modules: counts,
      said: `This issue sits in no module, and ${empty} of ${roots.length} modules hold no term or rule. Place it (PUT ${base}/modules/placements { type: 'issue', ref: '${issueId}', module }), then record each term a person named and each rule this work settled under that module: ${write('<module>')}.`,
    };
  }
  const within = (e: Item) => {
    const path = e.moduleId ? modules.byId.get(e.moduleId)?.path : undefined;
    return path !== undefined && (path === module.path || path.startsWith(`${module.path}/`));
  };
  const here = named.filter(within);
  const terms = here.filter((e) => e.type === 'term').length;
  const rules = here.length - terms;
  const recheckOwed = here.filter((e) => e.recheck).length;
  const owes =
    recheckOwed > 0
      ? `, ${recheckOwed} owing a re-check (fix each: GET ${base}/modules/${module.slug}/map)`
      : '';
  return {
    module: { slug: module.slug, name: module.name, path: module.path, terms, rules, recheckOwed },
    modules: counts,
    said: `${module.name} holds ${terms} ${terms === 1 ? 'term' : 'terms'} and ${rules} ${rules === 1 ? 'rule' : 'rules'}${owes}. Record each term a person named and each rule this work settled there: ${write(module.slug)}.`,
  };
}
