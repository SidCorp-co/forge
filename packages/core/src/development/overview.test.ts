import type {
  IssueAttentionGroup,
  IssueEdgeRef,
  IssueStandingRow,
} from '@forge/contracts/issue-standing';
import type { KernelIssueStatus } from '@forge/contracts/issue-vocabulary';
import { describe, expect, it } from 'vitest';
import {
  flowOf,
  type LaneFacts,
  modulesOf,
  movingOf,
  needsOf,
  releaseDecidableBy,
  stuckOf,
} from './overview.js';

const NOW = new Date('2026-10-04T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

interface Over {
  status?: KernelIssueStatus;
  group?: IssueAttentionGroup;
  blockedBy?: string[];
  touched?: string;
  module?: { id: string; path: string; name: string } | null;
  waiting?: 'you' | 'run' | 'issue' | 'none';
  lease?: { holder: string; expiresAt: string } | null;
  step?: 'build' | null;
}

const ref = (key: string, status: KernelIssueStatus = 'open'): IssueEdgeRef => ({
  key,
  title: `title ${key}`,
  status,
  group: null,
  landed: false,
});

const row = (key: string, o: Over = {}): IssueStandingRow => {
  const status = o.status ?? 'open';
  const group = o.group ?? 'queued';
  return {
    id: `id-${key}`,
    key,
    title: `title ${key}`,
    status,
    priority: 'medium',
    category: null,
    complexity: null,
    assigneeId: null,
    createdById: null,
    createdAt: daysAgo(30),
    updatedAt: o.touched ?? hoursAgo(1),
    standing: {
      state: status,
      step: o.step ?? null,
      stepStartedAt: null,
      tone: 'neutral',
      attentionGroup: group,
      waitingOn: {
        kind: o.waiting ?? 'none',
        who: 'Who',
        act: 'act',
        rule: 'rule',
        ref: null,
      },
      criteria: { total: 0, passing: 0, failing: 0, skipped: 0 },
      requirement: null,
      module: o.module ?? null,
      feedback: [],
      blockedBy: (o.blockedBy ?? []).map((b) => ref(b)),
      blocks: [],
      lease: o.lease
        ? { holder: o.lease.holder, verdict: 'live', expiresAt: o.lease.expiresAt }
        : null,
      inFlight: false,
      branch: null,
      headSha: null,
      owner: null,
      wave: null,
      touchedAt: o.touched ?? hoursAgo(1),
    },
  };
};

describe('the issue flow', () => {
  it('counts an issue when anything wrote to it inside 14 days, and splits each stage by whose turn it is', () => {
    const f = flowOf(
      [
        row('ISS-1', { status: 'draft', group: 'needs_you' }),
        row('ISS-2', { status: 'in_progress', group: 'moving' }),
        row('ISS-3', { status: 'in_progress', group: 'stuck' }),
        row('ISS-4', { status: 'closed', group: 'done', touched: daysAgo(3) }),
        row('ISS-5', { status: 'dropped', group: 'done', touched: daysAgo(3) }),
      ],
      NOW,
    );
    expect(f.total).toBe(5);
    const stage = (id: string) => f.stages.find((s) => s.id === id);
    expect(stage('draft')?.count).toBe(1);
    expect(stage('in_progress')?.parts).toEqual([
      { group: 'moving', count: 1 },
      { group: 'stuck', count: 1 },
    ]);
    expect(stage('closed')?.count).toBe(2);
  });

  it('leaves out an issue untouched for longer than the window, at the window edge', () => {
    const f = flowOf(
      [
        row('ISS-1', { touched: daysAgo(14) }),
        row('ISS-2', { touched: new Date(NOW.getTime() - 14 * 86_400_000 - 1).toISOString() }),
      ],
      NOW,
    );
    expect(f.total).toBe(1);
  });

  it('is empty, not an error, when nothing was touched', () => {
    const f = flowOf([], NOW);
    expect(f.total).toBe(0);
    expect(f.stages.map((s) => s.count)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('the runs holding a lease', () => {
  const facts = new Map<string, LaneFacts>([
    [
      'ISS-1',
      {
        steps: [
          { step: 'plan', startedAt: hoursAgo(3), endedAt: hoursAgo(2) },
          { step: 'build', startedAt: hoursAgo(2), endedAt: null },
        ],
        box: 'forge-box-1',
        acquiredAt: hoursAgo(3),
      },
    ],
  ]);

  it('draws one lane per moving issue with its step segments and the box that holds it', () => {
    const m = movingOf(
      [
        row('ISS-1', {
          status: 'in_progress',
          group: 'moving',
          step: 'build',
          lease: {
            holder: 'claude:x',
            expiresAt: new Date(NOW.getTime() + 1_800_000).toISOString(),
          },
        }),
        row('ISS-2', { status: 'open', group: 'queued' }),
      ],
      facts,
      NOW,
    );
    expect(m.count).toBe(1);
    expect(m.lanes[0]).toMatchObject({ key: 'ISS-1', box: 'forge-box-1', holder: 'claude:x' });
    expect(m.lanes[0]?.segments).toHaveLength(2);
    expect(m.lanes[0]?.heldSince).toBe(hoursAgo(3));
  });

  it('spans the axis from the first start to the last lease expiry, in quarter hours', () => {
    const m = movingOf(
      [
        row('ISS-1', {
          group: 'moving',
          lease: { holder: 'h', expiresAt: new Date(NOW.getTime() + 2_000_000).toISOString() },
        }),
      ],
      facts,
      NOW,
    );
    const w = m.window as NonNullable<typeof m.window>;
    expect(new Date(w.from).getTime() % 900_000).toBe(0);
    expect(new Date(w.to).getTime() % 900_000).toBe(0);
    expect(new Date(w.from).getTime()).toBeLessThanOrEqual(new Date(hoursAgo(3)).getTime());
    expect(new Date(w.to).getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 2_000_000);
  });

  it('never stretches the axis past a day back, so a stale step cannot flatten the rest', () => {
    const old = new Map<string, LaneFacts>([
      ['ISS-1', { steps: [], box: null, acquiredAt: daysAgo(5) }],
    ]);
    const m = movingOf([row('ISS-1', { group: 'moving' })], old, NOW);
    const w = m.window as NonNullable<typeof m.window>;
    expect(NOW.getTime() - new Date(w.from).getTime()).toBeLessThanOrEqual(86_400_000);
  });

  it('has no lanes and no axis when nothing is moving', () => {
    expect(movingOf([row('ISS-1')], new Map(), NOW)).toEqual({ count: 0, window: null, lanes: [] });
  });
});

describe('stuck chains read from the root', () => {
  it('roots a chain at the issue nothing holds back and lists what it frees by level', () => {
    const s = stuckOf(
      [
        row('ISS-1', { status: 'in_progress', group: 'moving' }),
        row('ISS-2', { group: 'stuck', blockedBy: ['ISS-1'], waiting: 'issue' }),
        row('ISS-3', { group: 'stuck', blockedBy: ['ISS-2'], waiting: 'issue' }),
      ],
      [],
    );
    expect(s.count).toBe(2);
    expect(s.chains).toHaveLength(1);
    expect(s.chains[0]?.levels.map((l) => l.map((n) => n.key))).toEqual([
      ['ISS-1'],
      ['ISS-2'],
      ['ISS-3'],
    ]);
    expect(s.chains[0]?.held).toBe(2);
  });

  it('shows a stuck issue that nothing blocks as a chain of its own', () => {
    const s = stuckOf([row('ISS-7', { status: 'in_progress', group: 'stuck' })], []);
    expect(s.count).toBe(1);
    expect(s.chains[0]?.levels).toHaveLength(1);
    expect(s.chains[0]?.levels[0]?.[0]).toMatchObject({ key: 'ISS-7', held: true });
  });

  it('roots a chain at a contract version when an unsettled wait holds a queued issue', () => {
    const s = stuckOf(
      [row('ISS-4', { group: 'queued' }), row('ISS-5', { group: 'queued' })],
      [{ issueKey: 'ISS-4', contract: 'autoflow/api', minVersion: '2.0.0', current: '1.4.0' }],
    );
    expect(s.count).toBe(1);
    const root = s.chains[0]?.levels[0]?.[0];
    expect(root).toMatchObject({ kind: 'contract', key: 'autoflow/api', status: null });
    expect(root?.title).toContain('2.0.0');
    expect(root?.title).toContain('1.4.0');
    expect(s.chains[0]?.levels[1]?.[0]?.key).toBe('ISS-4');
  });

  it('does not count an issue a person or a run holds, though it has an open blocker', () => {
    const s = stuckOf(
      [
        row('ISS-1', { status: 'in_progress', group: 'moving' }),
        row('ISS-2', { status: 'draft', group: 'needs_you', blockedBy: ['ISS-1'], waiting: 'you' }),
        row('ISS-3', { status: 'in_progress', group: 'moving', blockedBy: ['ISS-1'] }),
      ],
      [],
    );
    expect(s).toEqual({ count: 0, chains: [] });
  });

  it('survives a cycle of blocks edges without looping', () => {
    const s = stuckOf(
      [
        row('ISS-1', { group: 'stuck', blockedBy: ['ISS-2'] }),
        row('ISS-2', { group: 'stuck', blockedBy: ['ISS-1'] }),
      ],
      [],
    );
    expect(s.count).toBe(2);
    expect(s.chains.length).toBeGreaterThan(0);
  });

  it('names a blocker the read did not reach by its edge, never drops the chain', () => {
    const s = stuckOf([row('ISS-2', { group: 'stuck', blockedBy: ['ISS-900'] })], []);
    expect(s.chains[0]?.levels[0]?.[0]).toMatchObject({ key: 'ISS-900', held: false, tone: null });
    expect(s.chains[0]?.levels[1]?.[0]?.key).toBe('ISS-2');
  });

  it('puts the chain that frees the most first', () => {
    const s = stuckOf(
      [
        row('ISS-1', { status: 'in_progress', group: 'moving' }),
        row('ISS-2', { group: 'stuck', blockedBy: ['ISS-1'] }),
        row('ISS-8', { status: 'in_progress', group: 'moving' }),
        row('ISS-9', { group: 'stuck', blockedBy: ['ISS-8'] }),
        row('ISS-10', { group: 'stuck', blockedBy: ['ISS-8'] }),
      ],
      [],
    );
    expect(s.chains.map((c) => c.id)).toEqual(['ISS-8', 'ISS-1']);
  });
});

describe('modules by state', () => {
  const mod = { id: 'm1', path: 'storefront/autoflow', name: 'Autoflow' };

  it('counts open issues by primary module on one scale, and leaves the module-less apart', () => {
    const m = modulesOf(
      [
        row('ISS-1', { group: 'moving', module: mod }),
        row('ISS-2', { group: 'stuck', module: mod }),
        row('ISS-3', { group: 'queued' }),
        row('ISS-4', { status: 'closed', group: 'done', module: mod }),
      ],
      [
        { id: 'm1', path: mod.path, name: mod.name, shipped: 4, lastLandingAt: hoursAgo(5) },
        { id: 'm2', path: 'quiet', name: 'Quiet', shipped: 0, lastLandingAt: null },
      ],
      { shipped: 2, lastLandingAt: null },
    );
    expect(m.rows[0]).toMatchObject({ id: 'm1', open: 2, shipped: 4 });
    expect(m.rows[0]?.parts).toEqual([
      { group: 'moving', count: 1 },
      { group: 'stuck', count: 1 },
    ]);
    expect(m.rows[1]).toMatchObject({ id: 'm2', open: 0 });
    expect(m.unassigned).toMatchObject({ id: null, open: 1, shipped: 2 });
    expect(m.max).toBe(2);
  });

  it('has a zero scale and no rows for a project with no modules and no open issues', () => {
    const m = modulesOf([], [], { shipped: 0, lastLandingAt: null });
    expect(m.rows).toEqual([]);
    expect(m.max).toBe(0);
  });
});

describe('what waits on the viewer', () => {
  const issues = [
    row('ISS-1', { status: 'draft', group: 'needs_you', waiting: 'you' }),
    row('ISS-2', { status: 'draft', group: 'needs_you', waiting: 'none' }),
    row('ISS-3', { status: 'in_progress', group: 'moving', waiting: 'run' }),
    row('ISS-4', { status: 'on_hold', group: 'paused', waiting: 'you' }),
  ];
  const ask = (decidable: boolean) => ({
    runId: 'run-1',
    version: '1.2.0',
    requestedAt: hoursAgo(2),
    requestedBy: 'Minh',
    environment: 'staging',
    decidable,
  });

  it('lists only what waits on the viewer, as the Issues page counts it (Needs you, not Paused): their issues, the releases and versions they may decide', () => {
    const n = needsOf(
      issues,
      [ask(true), { ...ask(false), runId: 'run-2' }],
      [
        {
          contract: 'hop/api',
          version: '2.0.0',
          classification: 'breaking',
          recordedAt: hoursAgo(1),
          decidable: true,
        },
        {
          contract: 'hop/api',
          version: '2.1.0',
          classification: 'breaking',
          recordedAt: hoursAgo(1),
          decidable: false,
        },
      ],
      [],
    );
    expect(n.rows.map((r) => `${r.kind}:${r.ref}`)).toEqual([
      'issue:ISS-1',
      'release:run-1',
      'contract:hop/api@2.0.0',
    ]);
    expect(n.count).toBe(3);
  });

  it('lists an open breaking-change item with its deadline and drops a closed one', () => {
    const change = (status: string) => ({
      feedback: 'FB-4',
      contract: 'autoflow/api',
      version: '2.0.0',
      title: 'autoflow/api 2.0.0 is breaking',
      dueAt: '2026-11-03T00:00:00.000Z',
      status,
      actable: true,
    });
    expect(needsOf([], [], [], [change('triaged')]).rows[0]?.waitingOn.act).toBe(
      'adapt by 2026-11-03',
    );
    expect(needsOf([], [], [], [change('verified')]).count).toBe(0);
    expect(needsOf([], [], [], [change('declined')]).count).toBe(0);
  });

  it('is empty for a reader nothing waits on', () => {
    expect(needsOf([row('ISS-3', { group: 'moving', waiting: 'run' })], [], [], [])).toEqual({
      count: 0,
      rows: [],
    });
  });

  it('lets only a person with admin, other than the asker, decide a release', () => {
    const v = { userId: 'u1', isPerson: true, isAdmin: true };
    expect(releaseDecidableBy(v, 'u2')).toBe(true);
    expect(releaseDecidableBy(v, 'u1')).toBe(false);
    expect(releaseDecidableBy({ ...v, isAdmin: false }, 'u2')).toBe(false);
    expect(releaseDecidableBy({ ...v, isPerson: false }, 'u2')).toBe(false);
  });
});
