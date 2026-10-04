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
  OverviewNeed,
  OverviewNeeds,
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

export interface ContractWaitFact {
  issueKey: string;
  contract: string;
  minVersion: string;
  current: string | null;
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

const contractNode = (w: ContractWaitFact): OverviewChainNode => ({
  kind: 'contract',
  key: w.contract,
  title: `Needs ${w.minVersion}; the provider has published ${w.current ?? 'no version'}`,
  status: null,
  step: null,
  tone: null,
  waitingOn: null,
  held: false,
});

// cm:why held means held back by something that is neither a person nor a run: the Stuck attention group, or a queued issue an unsettled contract wait keeps out of dispatch (`ecosystem/waits/rules.ts:holdsDispatch`), which the standing read model does not yet read
export function stuckOf(
  rows: readonly IssueStandingRow[],
  waits: readonly ContractWaitFact[],
): OverviewStuck {
  const open = rows.filter(isOpen);
  const byKey = new Map(open.map((r) => [r.key, r]));
  const waitsOf = new Map<string, ContractWaitFact[]>();
  for (const w of waits) waitsOf.set(w.issueKey, [...(waitsOf.get(w.issueKey) ?? []), w]);

  const held = new Set(
    open
      .filter(
        (r) =>
          r.standing.attentionGroup === 'stuck' ||
          (r.standing.attentionGroup === 'queued' && waitsOf.has(r.key)),
      )
      .map((r) => r.key),
  );
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
  const waitId = (w: ContractWaitFact) => `contract:${w.contract}@${w.minVersion}`;
  const waitsByRoot = new Map<string, ContractWaitFact>();

  const rootsOf = (key: string, seen = new Set<string>()): string[] => {
    if (seen.has(key)) return [];
    seen.add(key);
    const r = byKey.get(key);
    const up = r ? r.standing.blockedBy.map((b) => b.key) : [];
    const contracts = (waitsOf.get(key) ?? []).map((w) => {
      waitsByRoot.set(waitId(w), w);
      return waitId(w);
    });
    const above = [...up.flatMap((k) => rootsOf(k, seen)), ...contracts];
    return above.length > 0 ? above : [key];
  };

  const rootIds = [...new Set([...held].flatMap((k) => rootsOf(k)))];
  const chains = rootIds.map((id): OverviewChain => {
    const contract = waitsByRoot.get(id);
    const rootNode = contract ? contractNode(contract) : nodeOf(id);
    const first = contract
      ? waits.filter((w) => waitId(w) === id).map((w) => w.issueKey)
      : (dependents.get(id) ?? []);
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

export interface UnassignedFact {
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

export interface ReleaseAskFact {
  runId: string;
  version: string | null;
  requestedAt: string;
  requestedBy: string;
  environment: string;
  decidable: boolean;
}

export interface ProposedVersionFact {
  contract: string;
  version: string;
  classification: string;
  recordedAt: string;
  decidable: boolean;
}

export interface ContractChangeFact {
  feedback: string;
  contract: string;
  version: string;
  title: string;
  dueAt: string;
  status: string;
  actable: boolean;
}

export const OPEN_CONTRACT_CHANGE: readonly string[] = ['new', 'triaged', 'reopened'];

const youOwe = (act: string, rule: string): OverviewNeed['waitingOn'] => ({
  kind: 'you',
  who: 'You',
  act,
  rule,
  ref: null,
  dueAt: null,
});

export function needsOf(
  rows: readonly IssueStandingRow[],
  releases: readonly ReleaseAskFact[],
  proposed: readonly ProposedVersionFact[],
  changes: readonly ContractChangeFact[],
): OverviewNeeds {
  const issues = rows
    .filter((r) => r.standing.attentionGroup === 'needs_you' && r.standing.waitingOn.kind === 'you')
    .map((r): OverviewNeed => {
      const s = r.standing;
      return {
        kind: 'issue',
        key: r.key,
        ref: r.key,
        title: r.title,
        facts: [
          ...(s.module ? [s.module.path] : []),
          ...(s.requirement
            ? [
                `${s.requirement.key}${s.requirement.criteria.length ? ` ${s.requirement.criteria.join(', ')}` : ''}`,
              ]
            : []),
        ],
        state: { family: 'issue', value: r.status, step: s.step, tone: s.tone },
        waitingOn: s.waitingOn,
        owner: s.owner ? { name: s.owner.name, kind: s.owner.kind } : null,
        touchedAt: s.touchedAt,
      };
    });
  const asks = releases
    .filter((a) => a.decidable)
    .map(
      (a): OverviewNeed => ({
        kind: 'release',
        key: a.version ?? `Batch ${a.runId.slice(0, 8)}`,
        ref: a.runId,
        title: a.version ? `Release ${a.version}` : 'Release batch',
        facts: [`Evidence from ${a.environment}`, `Asked by ${a.requestedBy}`],
        state: { family: 'release', value: 'pending' },
        waitingOn: youOwe(
          'approve the release',
          'a person other than the one who asked approves a release before production',
        ),
        owner: null,
        touchedAt: a.requestedAt,
      }),
    );
  const versions = proposed
    .filter((v) => v.decidable)
    .map(
      (v): OverviewNeed => ({
        kind: 'contract',
        key: `${v.contract} ${v.version}`,
        ref: `${v.contract}@${v.version}`,
        title: `${v.contract} ${v.version} is proposed`,
        facts: [`Measured ${v.classification}`],
        state: { family: 'classification', value: v.classification },
        waitingOn: youOwe(
          `approve ${v.version}`,
          'a proposed contract version is current only once a person with admin approves it',
        ),
        owner: null,
        touchedAt: v.recordedAt,
      }),
    );
  const due = changes
    .filter((c) => c.actable && OPEN_CONTRACT_CHANGE.includes(c.status))
    .map(
      (c): OverviewNeed => ({
        kind: 'contract',
        key: `${c.contract} ${c.version}`,
        ref: `${c.contract}@${c.version}`,
        title: c.title,
        facts: [c.feedback, `Adapt by ${c.dueAt.slice(0, 10)}`],
        state: { family: 'classification', value: 'breaking' },
        waitingOn: youOwe(
          `adapt by ${c.dueAt.slice(0, 10)}`,
          "an approved breaking version filed this item; the provider's commitment window ends on its due date",
        ),
        owner: null,
        touchedAt: null,
      }),
    );
  const out = [...issues, ...asks, ...versions, ...due];
  return { count: out.length, rows: out };
}
