import { describe, expect, it } from 'vitest';
import {
  aggregateStatusDistribution,
  groupWorkBuckets,
  perProjectWorkload,
  workspaceKpis,
} from './derive';
import { workspaceTotals } from '@/features/projects/derive';
import type { ProjectConsoleItem, ProjectHealthRow } from '@/features/projects/types';

function healthRow(over: Partial<ProjectHealthRow> & { id: string }): ProjectHealthRow {
  return {
    id: over.id,
    projectName: over.projectName ?? over.id,
    projectSlug: over.projectSlug ?? over.id,
    projectMeta: {},
    description: over.description ?? null,
    repoPath: over.repoPath ?? null,
    throughput: over.throughput ?? 0,
    totalActive: over.totalActive ?? 0,
    statusDistribution: over.statusDistribution ?? {},
    blockers: over.blockers ?? [],
    pendingEscalations: over.pendingEscalations ?? 0,
    avgCycleTimeDays: over.avgCycleTimeDays ?? 0,
    liveRuns: over.liveRuns ?? 0,
    runnerCount: over.runnerCount ?? 0,
    spend24hUsd: over.spend24hUsd ?? 0,
    memberCount: over.memberCount ?? 0,
    members: over.members ?? [],
    lastActivityAt: over.lastActivityAt ?? null,
  };
}

function consoleItem(over: Partial<ProjectConsoleItem> & { id: string }): ProjectConsoleItem {
  return {
    id: over.id,
    slug: over.slug ?? over.id,
    name: over.name ?? over.id,
    orgId: over.orgId ?? 'org-1',
    orgName: over.orgName ?? 'Org One',
    orgIsPersonal: over.orgIsPersonal ?? true,
    role: over.role ?? 'admin',
    createdAt: over.createdAt ?? '2026-01-01T00:00:00.000Z',
    description: over.description ?? null,
    repoPath: over.repoPath ?? null,
    health: over.health ?? 'idle',
    liveRuns: over.liveRuns ?? 0,
    openIssues: over.openIssues ?? 0,
    runnerCount: over.runnerCount ?? 0,
    spend24hUsd: over.spend24hUsd ?? 0,
    memberCount: over.memberCount ?? 0,
    members: over.members ?? [],
    lastActivityAt: over.lastActivityAt ?? null,
    pinned: over.pinned ?? false,
  };
}

describe('aggregateStatusDistribution', () => {
  it('sums status counts across projects', () => {
    const rows = [
      healthRow({ id: 'a', statusDistribution: { open: 2, in_progress: 1 } }),
      healthRow({ id: 'b', statusDistribution: { open: 3, closed: 5 } }),
    ];
    expect(aggregateStatusDistribution(rows)).toEqual({ open: 5, in_progress: 1, closed: 5 });
  });

  it('handles undefined / empty input', () => {
    expect(aggregateStatusDistribution(undefined)).toEqual({});
    expect(aggregateStatusDistribution([])).toEqual({});
  });
});

describe('groupWorkBuckets', () => {
  it('folds statuses into semantic-tone buckets and excludes closed/draft', () => {
    const { buckets, total } = groupWorkBuckets({
      open: 2,
      confirmed: 1,
      approved: 3,
      in_progress: 4,
      testing: 2,
      needs_info: 1,
      released: 1,
      on_hold: 1,
      closed: 50, // excluded from the in-flight view
      draft: 9, // excluded
    });
    const by = Object.fromEntries(buckets.map((b) => [b.key, b.count]));
    expect(by.queued).toBe(6); // open + confirmed + approved (neutral)
    expect(by.progress).toBe(6); // in_progress + testing (active)
    expect(by.attention).toBe(1); // needs_info (a human must act)
    expect(by.ready).toBe(1); // released (success)
    expect(by.blocked).toBe(1); // on_hold (calm ink, NOT red)
    // total counts only the bucketed (in-flight) statuses — not closed/draft.
    expect(total).toBe(15);
  });

  it('always returns all five tone buckets in pipeline order', () => {
    const { buckets } = groupWorkBuckets({});
    expect(buckets.map((b) => b.key)).toEqual([
      'queued',
      'progress',
      'attention',
      'ready',
      'blocked',
    ]);
    expect(buckets.every((b) => b.count === 0)).toBe(true);
  });

  it('never colors a benign bucket with the failure(red) tone', () => {
    const { buckets } = groupWorkBuckets({});
    // failure-red token is var(--red-500); no work-distribution bucket uses it.
    expect(buckets.every((b) => !b.color.includes('red'))).toBe(true);
  });
});

describe('perProjectWorkload', () => {
  const items = [
    consoleItem({ id: 'a', health: 'healthy' }),
    consoleItem({ id: 'b', health: 'attention' }),
    consoleItem({ id: 'c', health: 'idle' }),
    consoleItem({ id: 'd', health: 'down' }),
  ];
  const rows = [
    healthRow({ id: 'a', statusDistribution: { in_progress: 1 } }), // 1 in flight
    healthRow({ id: 'b', statusDistribution: { open: 2, waiting: 1 } }), // 3 in flight, attention
    healthRow({ id: 'c', statusDistribution: { open: 5 } }), // 5 in flight, not attention
    healthRow({ id: 'd', statusDistribution: {} }), // 0 in flight, attention (down)
  ];

  it('puts attention/down projects first, then most in-flight work', () => {
    // b + d (attention) lead; among them total desc puts b (3) before d (0).
    // Then healthy/idle by total desc: c (5) before a (1).
    expect(perProjectWorkload(items, rows, 4).map((w) => w.project.id)).toEqual([
      'b',
      'd',
      'c',
      'a',
    ]);
  });

  it('buckets each project from its OWN statusDistribution, not the workspace aggregate', () => {
    const workload = perProjectWorkload(items, rows, 4);
    const b = workload.find((w) => w.project.id === 'b');
    expect(b?.total).toBe(3);
    const byKey = Object.fromEntries(b?.buckets.map((bk) => [bk.key, bk.count]) ?? []);
    expect(byKey.queued).toBe(2);
    expect(byKey.attention).toBe(1);
  });

  it('falls back to empty distribution when a project has no health row yet', () => {
    const workload = perProjectWorkload(items, undefined, 4);
    expect(workload.every((w) => w.total === 0)).toBe(true);
  });

  it('caps at the limit and does not mutate input', () => {
    const copy = [...items];
    expect(perProjectWorkload(items, rows, 2)).toHaveLength(2);
    expect(items).toEqual(copy);
  });
});

describe('workspaceKpis', () => {
  it('widens totals with summed throughput + mean cycle time over rows with data', () => {
    const items = [
      consoleItem({ id: 'a', health: 'attention', liveRuns: 1, openIssues: 2, runnerCount: 1, spend24hUsd: 1 }),
      consoleItem({ id: 'b', health: 'idle', liveRuns: 0, openIssues: 0, runnerCount: 0, spend24hUsd: 0 }),
    ];
    const rows = [
      healthRow({ id: 'a', throughput: 4, avgCycleTimeDays: 2 }),
      healthRow({ id: 'b', throughput: 1, avgCycleTimeDays: 0 }), // no data → excluded from mean
    ];
    const kpis = workspaceKpis(workspaceTotals(items), items, rows);
    expect(kpis.projects).toBe(2);
    expect(kpis.throughput).toBe(5);
    expect(kpis.avgCycleTimeDays).toBe(2); // mean over the single row with data
    expect(kpis.attentionProjects).toBe(1);
  });

  it('null cycle time when no project has resolved anything', () => {
    const items = [consoleItem({ id: 'a' })];
    const rows = [healthRow({ id: 'a', avgCycleTimeDays: 0 })];
    expect(workspaceKpis(workspaceTotals(items), items, rows).avgCycleTimeDays).toBeNull();
  });

  it('tolerates undefined health rows', () => {
    const items = [consoleItem({ id: 'a' })];
    const kpis = workspaceKpis(workspaceTotals(items), items, undefined);
    expect(kpis.throughput).toBe(0);
    expect(kpis.avgCycleTimeDays).toBeNull();
  });
});
