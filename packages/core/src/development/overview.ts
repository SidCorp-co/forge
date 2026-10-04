import type {
  OverviewAttentionPart,
  OverviewChain,
  OverviewChainNode,
  OverviewFlow,
  OverviewLane,
  OverviewLaneSegment,
  OverviewModuleRow,
  OverviewModules,
  OverviewMoving,
  OverviewStuck,
} from '@forge/contracts/development-overview';
import {
  OVERVIEW_FLOW_STAGE_OF,
  OVERVIEW_FLOW_STAGES,
  OVERVIEW_WINDOW_DAYS,
} from '@forge/contracts/development-overview';
import type {
  IssueAttentionGroup,
  IssueEdgeRef,
  IssueStandingRow,
} from '@forge/contracts/issue-standing';
import { ISSUE_ATTENTION_GROUPS } from '@forge/contracts/issue-standing';
import type { WorkStep } from '@forge/contracts/issue-vocabulary';

const DAY_MS = 86_400_000;
const QUARTER_MS = 900_000;
const LANE_SPAN_MS = DAY_MS;

const isOpen = (r: IssueStandingRow) => r.standing.attentionGroup !== 'done';

function partsOf(groups: readonly IssueAttentionGroup[]): OverviewAttentionPart[] {
  const tally = new Map<IssueAttentionGroup, number>();
  for (const g of groups) tally.set(g, (tally.get(g) ?? 0) + 1);
  return ISSUE_ATTENTION_GROUPS.flatMap((group) => {
    const count = tally.get(group) ?? 0;
    return count > 0 ? [{ group, count }] : [];
  });
}

// cm:why an issue belongs to the last 14 days when anything wrote to it inside them (its row, its work state or its activity); the stage is its status, and each stage splits by whose turn it is
export function flowOf(rows: readonly IssueStandingRow[], now: Date): OverviewFlow {
  const since = now.getTime() - OVERVIEW_WINDOW_DAYS * DAY_MS;
  const inWindow = rows.filter((r) => new Date(r.standing.touchedAt).getTime() >= since);
  return {
    windowDays: OVERVIEW_WINDOW_DAYS,
    total: inWindow.length,
    stages: OVERVIEW_FLOW_STAGES.map((id) => {
      const here = inWindow.filter((r) => OVERVIEW_FLOW_STAGE_OF[r.status] === id);
      return { id, count: here.length, parts: partsOf(here.map((r) => r.standing.attentionGroup)) };
    }),
  };
}

export interface LaneFacts {
  steps: readonly { step: WorkStep; startedAt: string; endedAt: string | null }[];
  box: string | null;
  acquiredAt: string | null;
}

const floorQuarter = (ms: number) => Math.floor(ms / QUARTER_MS) * QUARTER_MS;
const ceilQuarter = (ms: number) => Math.ceil(ms / QUARTER_MS) * QUARTER_MS;

export function movingOf(
  rows: readonly IssueStandingRow[],
  facts: ReadonlyMap<string, LaneFacts>,
  now: Date,
): OverviewMoving {
  const lanes = rows
    .filter((r) => r.standing.attentionGroup === 'moving')
    .map((r): OverviewLane => {
      const s = r.standing;
      const f = facts.get(r.key);
      const segments: OverviewLaneSegment[] = (f?.steps ?? []).map((e) => ({ ...e }));
      return {
        key: r.key,
        title: r.title,
        status: r.status,
        step: s.step,
        holder: s.lease?.holder ?? null,
        box: f?.box ?? null,
        branch: s.branch,
        segments,
        heldSince: segments[0]?.startedAt ?? f?.acquiredAt ?? null,
        lease: s.lease ? { verdict: s.lease.verdict, expiresAt: s.lease.expiresAt } : null,
        waitingOn: s.waitingOn,
      };
    })
    .sort(
      (a, b) => (a.heldSince ?? '').localeCompare(b.heldSince ?? '') || a.key.localeCompare(b.key),
    );
  if (lanes.length === 0) return { count: 0, window: null, lanes };

  const nowMs = now.getTime();
  const starts = lanes.flatMap((l) => (l.heldSince ? [new Date(l.heldSince).getTime()] : []));
  const ends = lanes.flatMap((l) =>
    l.lease?.expiresAt ? [new Date(l.lease.expiresAt).getTime()] : [],
  );
  const from = floorQuarter(Math.max(Math.min(nowMs, ...starts), nowMs - LANE_SPAN_MS));
  const to = ceilQuarter(Math.min(Math.max(nowMs + QUARTER_MS, ...ends), nowMs + LANE_SPAN_MS));
  return {
    count: lanes.length,
    window: {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      now: now.toISOString(),
    },
    lanes,
  };
}

const issueNode = (r: IssueStandingRow, held: boolean): OverviewChainNode => ({
  kind: 'issue',
  key: r.key,
  title: r.title,
  status: r.status,
  step: r.standing.step,
  tone: r.standing.tone,
  waitingOn: r.standing.waitingOn,
  held,
});

const edgeNode = (e: IssueEdgeRef): OverviewChainNode => ({
  kind: 'issue',
  key: e.key,
  title: e.title,
  status: e.status,
  step: null,
  tone: null,
  waitingOn: null,
  held: false,
});

// cm:why held means held back by something that is neither a person nor a run: the Stuck attention group
export function stuckOf(rows: readonly IssueStandingRow[]): OverviewStuck {
  const open = rows.filter(isOpen);
  const byKey = new Map(open.map((r) => [r.key, r]));
  const held = new Set(open.filter((r) => r.standing.attentionGroup === 'stuck').map((r) => r.key));
  if (held.size === 0) return { count: 0, chains: [] };

  const dependents = new Map<string, string[]>();
  const refs = new Map<string, IssueEdgeRef>();
  for (const r of open) {
    for (const b of r.standing.blockedBy) {
      dependents.set(b.key, [...(dependents.get(b.key) ?? []), r.key]);
      refs.set(b.key, b);
    }
  }
  const nodeOf = (key: string): OverviewChainNode => {
    const r = byKey.get(key);
    if (r) return issueNode(r, held.has(key));
    return edgeNode(refs.get(key) as IssueEdgeRef);
  };

  const rootsOf = (key: string, seen = new Set<string>()): string[] => {
    if (seen.has(key)) return [];
    seen.add(key);
    const r = byKey.get(key);
    const up = r ? r.standing.blockedBy.map((b) => b.key) : [];
    const above = up.flatMap((k) => rootsOf(k, seen));
    return above.length > 0 ? above : [key];
  };

  const rootIds = [...new Set([...held].flatMap((k) => rootsOf(k)))];
  const chains = rootIds.map((id): OverviewChain => {
    const rootNode = nodeOf(id);
    const first = dependents.get(id) ?? [];
    const seen = new Set<string>([id]);
    const levels: OverviewChainNode[][] = [[rootNode]];
    let frontier = first;
    while (frontier.length > 0) {
      const level = [...new Set(frontier)].filter((k) => !seen.has(k) && byKey.has(k));
      if (level.length === 0) break;
      for (const k of level) seen.add(k);
      levels.push(level.map(nodeOf));
      frontier = level.flatMap((k) => dependents.get(k) ?? []);
    }
    return { id, levels, held: levels.flat().filter((n) => n.held).length };
  });
  chains.sort((a, b) => b.held - a.held || a.id.localeCompare(b.id));
  return { count: held.size, chains: chains.filter((c) => c.held > 0) };
}

export interface ModuleFact {
  id: string;
  path: string;
  name: string;
  shipped: number;
  lastLandingAt: string | null;
}

interface UnassignedFact {
  shipped: number;
  lastLandingAt: string | null;
}

const moduleRow = (
  base: Pick<OverviewModuleRow, 'id' | 'path' | 'name'>,
  open: readonly IssueStandingRow[],
  shipped: number,
  lastLandingAt: string | null,
): OverviewModuleRow => ({
  ...base,
  open: open.length,
  parts: partsOf(open.map((r) => r.standing.attentionGroup)),
  shipped,
  lastLandingAt,
});

export function modulesOf(
  rows: readonly IssueStandingRow[],
  modules: readonly ModuleFact[],
  unassigned: UnassignedFact,
): OverviewModules {
  const open = rows.filter(isOpen);
  const built = modules
    .map((m) =>
      moduleRow(
        { id: m.id, path: m.path, name: m.name },
        open.filter((r) => r.standing.module?.id === m.id),
        m.shipped,
        m.lastLandingAt,
      ),
    )
    .sort((a, b) => b.open - a.open || a.path.localeCompare(b.path));
  const loose = moduleRow(
    { id: null, path: '', name: 'No module' },
    open.filter((r) => r.standing.module === null),
    unassigned.shipped,
    unassigned.lastLandingAt,
  );
  return {
    rows: built,
    max: Math.max(0, loose.open, ...built.map((m) => m.open)),
    unassigned: loose,
  };
}

export interface ProposedVersionFact {
  contract: string;
  version: string;
  classification: string;
  recordedAt: string;
}

export interface ContractChangeFact {
  feedback: string;
  contract: string;
  version: string;
  title: string;
  dueAt: string;
  status: string;
}

export const OPEN_CONTRACT_CHANGE: readonly string[] = ['new', 'triaged', 'reopened'];
