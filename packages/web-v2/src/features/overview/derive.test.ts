import { describe, expect, it } from 'vitest';
import {
  aggregateStatusDistribution,
  groupWorkBuckets,
  pickSpotlightProjects,
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
  it('folds statuses into pipeline buckets and excludes closed/draft', () => {
    const { buckets, total } = groupWorkBuckets({
      open: 2,
      confirmed: 1,
      approved: 3,
      in_progress: 4,
      testing: 2,
      released: 1,
      on_hold: 1,
      closed: 50, // excluded from the in-flight view
      draft: 9, // excluded
    });
    const by = Object.fromEntries(buckets.map((b) => [b.key, b.count]));
    expect(by.backlog).toBe(3); // open + confirmed
    expect(by.planning).toBe(3); // approved (+ waiting:0)
    expect(by.progress).toBe(4); // in_progress
    expect(by.review).toBe(2); // testing
    expect(by.ready).toBe(1); // released
    expect(by.blocked).toBe(1); // on_hold
    // total counts only the bucketed (in-flight) statuses — not closed/draft.
    expect(total).toBe(14);
  });

  it('always returns all six buckets in pipeline order', () => {
    const { buckets } = groupWorkBuckets({});
    expect(buckets.map((b) => b.key)).toEqual([
      'backlog',
      'planning',
      'progress',
      'review',
      'ready',
      'blocked',
    ]);
    expect(buckets.every((b) => b.count === 0)).toBe(true);
  });
});

describe('pickSpotlightProjects', () => {
  const items = [
    consoleItem({ id: 'a', health: 'healthy', lastActivityAt: '2026-05-01T00:00:00.000Z' }),
    consoleItem({ id: 'b', health: 'attention', lastActivityAt: '2026-04-01T00:00:00.000Z' }),
    consoleItem({ id: 'c', health: 'idle', lastActivityAt: '2026-05-10T00:00:00.000Z' }),
    consoleItem({ id: 'd', health: 'down', lastActivityAt: null }),
  ];

  it('puts attention/down projects first, then recency', () => {
    // b (attention) + d (down) lead; among them recency desc puts b before d
    // (d has null activity). Then healthy/idle by recency: c before a.
    expect(pickSpotlightProjects(items, 4).map((p) => p.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('caps at the limit and does not mutate input', () => {
    const copy = [...items];
    expect(pickSpotlightProjects(items, 2)).toHaveLength(2);
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
