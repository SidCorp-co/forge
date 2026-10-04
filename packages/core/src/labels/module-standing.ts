import type { IssueStandingRow, IssueWaitingKind } from '@forge/contracts/issue-standing';
import {
  MODULE_ACTIVITY_DAYS,
  MODULE_KEY_PATHS_SHOWN,
  MODULE_OPEN_KINDS,
  type ModuleActivityDay,
  type ModuleAttentionGroup,
  type ModuleCoupling,
  type ModuleLanding,
  type ModuleOpenKind,
  type ModuleRef,
  type ModuleRequirementTrace,
  type ModuleStanding,
  modulePaths,
} from '@forge/contracts/modules';
import type { WaitingOn } from '@forge/contracts/standing';

export interface ModuleNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  description: string | null;
  knowledgeEntryId: string | null;
}

export type OpenIssue = Pick<IssueStandingRow, 'key' | 'title' | 'status'> & {
  standing: Pick<
    IssueStandingRow['standing'],
    'attentionGroup' | 'waitingOn' | 'module' | 'touchedAt' | 'tone' | 'step'
  >;
};

export interface LandingRow {
  moduleId: string;
  issueKey: string;
  title: string;
  landedAt: string;
  commitSha: string | null;
  target: string | null;
  landing: string | null;
  release: string | null;
}

export interface TraceRow {
  moduleId: string;
  reqSeq: number;
  reqTitle: string;
  criterion: string | null;
}

export function moduleRefs(nodes: readonly ModuleNode[]): Map<string, ModuleRef> {
  const paths = modulePaths(nodes);
  return new Map(
    nodes.map((n) => [
      n.id,
      { id: n.id, slug: n.slug, name: n.name, path: paths.get(n.id) ?? n.slug },
    ]),
  );
}

export function subtreesOf(
  nodes: readonly Pick<ModuleNode, 'id' | 'parentId'>[],
): Map<string, string[]> {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId || !ids.has(n.parentId)) continue;
    children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id]);
  }
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    const seen = new Set([n.id]);
    const queue = [n.id];
    while (queue.length > 0) {
      for (const child of children.get(queue.shift() as string) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        queue.push(child);
      }
    }
    out.set(n.id, [...seen]);
  }
  return out;
}

const HEADLINE_ORDER: ModuleOpenKind[] = ['needs_you', 'stuck', 'moving'];

const newest = (a: OpenIssue, b: OpenIssue) =>
  b.standing.touchedAt.localeCompare(a.standing.touchedAt) || a.key.localeCompare(b.key);

function waitingOf(
  open: readonly OpenIssue[],
  byKind: Record<ModuleOpenKind, number>,
): { leadIssue: string | null; waitingOn: WaitingOn<IssueWaitingKind> } {
  for (const kind of HEADLINE_ORDER) {
    const lead = open.filter((i) => i.standing.attentionGroup === kind).sort(newest)[0];
    if (lead) return { leadIssue: lead.key, waitingOn: lead.standing.waitingOn };
  }
  const parts = [
    byKind.queued > 0 ? `${byKind.queued} queued` : null,
    byKind.paused > 0 ? `${byKind.paused} paused` : null,
  ].filter((p): p is string => p !== null);
  return {
    leadIssue: null,
    waitingOn: {
      kind: 'none',
      who: 'Nobody',
      act: parts.length > 0 ? parts.join(' · ') : 'nothing open',
      rule: 'No issue in this module waits on you, is stuck, or holds a live lease',
      ref: null,
      dueAt: null,
    },
  };
}

function attentionOf(byKind: Record<ModuleOpenKind, number>): ModuleAttentionGroup {
  if (byKind.needs_you > 0) return 'needs_you';
  if (byKind.stuck > 0) return 'stuck';
  if (byKind.moving > 0) return 'moving';
  return 'quiet';
}

export function countsOf(open: readonly OpenIssue[]): Record<ModuleOpenKind, number> {
  const out = Object.fromEntries(MODULE_OPEN_KINDS.map((k) => [k, 0])) as Record<
    ModuleOpenKind,
    number
  >;
  for (const issue of open) {
    const kind = issue.standing.attentionGroup;
    if (kind !== 'done') out[kind] += 1;
  }
  return out;
}

const criterionOrder = (a: string, b: string) =>
  Number(a.slice(3)) - Number(b.slice(3)) || a.localeCompare(b);

export function tracesOf(rows: readonly TraceRow[]): ModuleRequirementTrace[] {
  const byReq = new Map<number, { title: string; criteria: Set<string> }>();
  for (const r of rows) {
    const at = byReq.get(r.reqSeq) ?? { title: r.reqTitle, criteria: new Set<string>() };
    if (r.criterion) at.criteria.add(r.criterion);
    byReq.set(r.reqSeq, at);
  }
  return [...byReq]
    .sort(([a], [b]) => a - b)
    .map(([seq, v]) => ({
      key: `REQ-${seq}`,
      title: v.title,
      criteria: [...v.criteria].sort(criterionOrder),
    }));
}

export function landingsOf(
  rows: readonly LandingRow[],
  paths: ReadonlyMap<string, string>,
): ModuleLanding[] {
  return rows
    .map((r) => ({
      issueKey: r.issueKey,
      title: r.title,
      landedAt: r.landedAt,
      commitSha: r.commitSha,
      target: r.target,
      landing: r.landing,
      release: r.release,
      modulePath: paths.get(r.moduleId) ?? '',
    }))
    .sort((a, b) => b.landedAt.localeCompare(a.landedAt) || a.issueKey.localeCompare(b.issueKey));
}

export interface StandingInput {
  nodes: readonly ModuleNode[];
  openIssues: readonly OpenIssue[];
  latestLandings: readonly LandingRow[];
  traces: readonly TraceRow[];
}

export function deriveStandings(input: StandingInput): Map<string, ModuleStanding> {
  const { nodes, openIssues, latestLandings, traces } = input;
  const paths = modulePaths(nodes);
  const subtrees = subtreesOf(nodes);
  const childCount = new Map<string, number>();
  const known = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    if (n.parentId && known.has(n.parentId))
      childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1);
  }
  const out = new Map<string, ModuleStanding>();
  for (const node of nodes) {
    const within = new Set(subtrees.get(node.id) ?? [node.id]);
    const open = openIssues.filter(
      (i) => i.standing.module !== null && within.has(i.standing.module.id),
    );
    const byKind = countsOf(open);
    const landings = landingsOf(
      latestLandings.filter((l) => within.has(l.moduleId)),
      paths,
    );
    out.set(node.id, {
      attentionGroup: attentionOf(byKind),
      open: open.length,
      openByKind: byKind,
      running: byKind.moving,
      ...waitingOf(open, byKind),
      lastLanding: landings[0] ?? null,
      requirements: tracesOf(traces.filter((t) => within.has(t.moduleId))),
      childCount: childCount.get(node.id) ?? 0,
    });
  }
  return out;
}

const FENCE = /^\s*(```|~~~)/;
const SUMMARY_LIMIT = 420;

export function summaryOf(body: string): string {
  const lines = body.split('\n');
  const para: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      if (para.length > 0) break;
      continue;
    }
    if (fenced) continue;
    const text = line.trim();
    if (text === '' || /^#{1,6}\s/.test(text) || /^(?:---+|\*\*\*+|\|)/.test(text)) {
      if (para.length > 0) break;
      continue;
    }
    para.push(text);
  }
  const joined = para.join(' ');
  return joined.length > SUMMARY_LIMIT
    ? `${joined.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`
    : joined;
}

const SPAN = /`([^`\n]+)`/g;
const SYMBOL_SUFFIX = /:(?:\d+(?::\d+)?|[A-Za-z_$][\w$.]*)$/;
const EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

export function keyPathsOf(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(SPAN)) {
    const raw = (m[1] ?? '').trim();
    const path = raw.replace(SYMBOL_SUFFIX, '');
    if (!path.includes('/') || /\s|:\/\/|^https?:/.test(path)) continue;
    if (!(path.endsWith('/') || EXTENSION.test(path))) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length === MODULE_KEY_PATHS_SHOWN) break;
  }
  return out;
}

export function activityDays(
  rows: readonly { day: string; events: number }[],
  today: Date,
  days: number = MODULE_ACTIVITY_DAYS,
): ModuleActivityDay[] {
  const counts = new Map(rows.map((r) => [r.day, r.events]));
  const out: ModuleActivityDay[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const date = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back),
    )
      .toISOString()
      .slice(0, 10);
    out.push({ date, events: counts.get(date) ?? 0 });
  }
  return out;
}

interface ObservedCoupling {
  aId: string;
  bId: string;
  issueCount: number;
  recentIssueKeys: string[];
}

export function couplingsOf(
  id: string,
  refs: ReadonlyMap<string, ModuleRef>,
  observed: readonly ObservedCoupling[],
): ModuleCoupling[] {
  const byName = (a: ModuleCoupling, b: ModuleCoupling) =>
    a.module.path.localeCompare(b.module.path);
  const observedOut: ModuleCoupling[] = [];
  for (const e of observed) {
    if (e.aId !== id && e.bId !== id) continue;
    const other = refs.get(e.aId === id ? e.bId : e.aId);
    if (!other) continue;
    observedOut.push({
      module: other,
      issueCount: e.issueCount,
      recentIssueKeys: e.recentIssueKeys,
    });
  }
  return observedOut.sort((a, b) => b.issueCount - a.issueCount || byName(a, b));
}

const OPEN_RAIL_ORDER: readonly ModuleOpenKind[] = [
  'needs_you',
  'stuck',
  'moving',
  'queued',
  'paused',
];

export function railOrder(open: readonly OpenIssue[]): OpenIssue[] {
  const rank = (i: OpenIssue) => {
    const at = OPEN_RAIL_ORDER.indexOf(i.standing.attentionGroup as ModuleOpenKind);
    return at < 0 ? OPEN_RAIL_ORDER.length : at;
  };
  return [...open].sort((a, b) => rank(a) - rank(b) || newest(a, b));
}
