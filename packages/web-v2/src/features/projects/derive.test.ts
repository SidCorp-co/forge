import { describe, expect, it } from 'vitest';
import {
  deriveHealth,
  filterProjects,
  formatCycleTime,
  formatRelativeTime,
  formatSpend,
  isAttention,
  mergeProjects,
  sortProjects,
  workspaceTotals,
} from './derive';
import type { ProjectConsoleItem, ProjectHealthRow, ProjectListItem } from './types';

function listItem(over: Partial<ProjectListItem> & { id: string }): ProjectListItem {
  return {
    id: over.id,
    slug: over.slug ?? over.id,
    name: over.name ?? over.id,
    orgId: over.orgId ?? 'org-1',
    orgName: over.orgName ?? 'Org One',
    orgIsPersonal: over.orgIsPersonal ?? true,
    createdBy: over.createdBy ?? 'user-1',
    role: over.role ?? 'admin',
    orgRole: over.orgRole ?? 'owner',
    apiKey: over.apiKey ?? 'k',
    createdAt: over.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

function healthRow(over: Partial<ProjectHealthRow> & { id: string }): ProjectHealthRow {
  return {
    id: over.id,
    projectName: over.projectName ?? over.id,
    projectSlug: over.projectSlug ?? over.id,
    projectMeta: {},
    description: over.description ?? null,
    repoPath: over.repoPath ?? null,
    throughput: 0,
    totalActive: over.totalActive ?? 0,
    statusDistribution: {},
    blockers: over.blockers ?? [],
    pendingEscalations: over.pendingEscalations ?? 0,
    avgCycleTimeDays: 0,
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

describe('deriveHealth', () => {
  it('blocked / escalated → attention', () => {
    expect(
      deriveHealth({ blockers: [{ issueId: 'i', documentId: 'd', status: 'on_hold' }], pendingEscalations: 0, runnerCount: 2, totalActive: 3, liveRuns: 0 }),
    ).toBe('attention');
    expect(deriveHealth({ blockers: [], pendingEscalations: 1, runnerCount: 2, totalActive: 3, liveRuns: 0 })).toBe('attention');
  });

  it('work present but no online runner → attention', () => {
    expect(deriveHealth({ blockers: [], pendingEscalations: 0, runnerCount: 0, totalActive: 4, liveRuns: 0 })).toBe('attention');
    expect(deriveHealth({ blockers: [], pendingEscalations: 0, runnerCount: 0, totalActive: 0, liveRuns: 1 })).toBe('attention');
  });

  it('nothing active → idle', () => {
    expect(deriveHealth({ blockers: [], pendingEscalations: 0, runnerCount: 0, totalActive: 0, liveRuns: 0 })).toBe('idle');
  });

  it('active work with online runners → healthy', () => {
    expect(deriveHealth({ blockers: [], pendingEscalations: 0, runnerCount: 2, totalActive: 5, liveRuns: 1 })).toBe('healthy');
  });
});

describe('mergeProjects', () => {
  it('joins list to health by id and applies pins', () => {
    const list = [listItem({ id: 'a', name: 'Alpha' }), listItem({ id: 'b', name: 'Beta' })];
    const health = [healthRow({ id: 'a', totalActive: 3, runnerCount: 1, liveRuns: 2, repoPath: 'org/a', members: ['AD'], memberCount: 4 })];
    const merged = mergeProjects(list, health, new Set(['b']));

    const a = merged.find((p) => p.id === 'a');
    const b = merged.find((p) => p.id === 'b');
    expect(a?.health).toBe('healthy');
    expect(a?.liveRuns).toBe(2);
    expect(a?.repoPath).toBe('org/a');
    expect(a?.memberCount).toBe(4);
    expect(a?.pinned).toBe(false);
    // No health row → safe idle defaults, still rendered.
    expect(b?.health).toBe('idle');
    expect(b?.openIssues).toBe(0);
    expect(b?.pinned).toBe(true);
  });
});

describe('workspaceTotals', () => {
  it('sums metrics across items', () => {
    const items = [
      consoleItem({ id: 'a', liveRuns: 2, openIssues: 3, runnerCount: 1, spend24hUsd: 1.5 }),
      consoleItem({ id: 'b', liveRuns: 1, openIssues: 4, runnerCount: 2, spend24hUsd: 2.25 }),
    ];
    expect(workspaceTotals(items)).toEqual({ projects: 2, liveRuns: 3, openIssues: 7, runners: 3, spend24hUsd: 3.75 });
  });
});

describe('sortProjects', () => {
  const items = [
    consoleItem({ id: 'a', name: 'Charlie', health: 'healthy', lastActivityAt: '2026-05-01T00:00:00.000Z' }),
    consoleItem({ id: 'b', name: 'Alpha', health: 'attention', lastActivityAt: '2026-05-10T00:00:00.000Z' }),
    consoleItem({ id: 'c', name: 'Bravo', health: 'idle', lastActivityAt: null }),
  ];

  it('name → alphabetical', () => {
    expect(sortProjects(items, 'name').map((p) => p.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('recent → newest activity first, nulls last', () => {
    expect(sortProjects(items, 'recent').map((p) => p.id)).toEqual(['b', 'a', 'c']);
  });

  it('health → worst first', () => {
    expect(sortProjects(items, 'health').map((p) => p.health)).toEqual(['attention', 'healthy', 'idle']);
  });

  it('does not mutate the input array', () => {
    const copy = [...items];
    sortProjects(items, 'name');
    expect(items).toEqual(copy);
  });
});

describe('filterProjects', () => {
  const items = [
    consoleItem({ id: 'a', name: 'Forge Web', repoPath: 'sid/web', description: 'cloud UI', health: 'healthy' }),
    consoleItem({ id: 'b', name: 'Forge Core', repoPath: 'sid/core', description: 'backend', health: 'attention' }),
  ];

  it('matches name, repo, or description', () => {
    expect(filterProjects(items, 'web', false).map((p) => p.id)).toEqual(['a']);
    expect(filterProjects(items, 'sid/core', false).map((p) => p.id)).toEqual(['b']);
    expect(filterProjects(items, 'backend', false).map((p) => p.id)).toEqual(['b']);
    expect(filterProjects(items, 'forge', false)).toHaveLength(2);
  });

  it('attentionOnly keeps only attention/down', () => {
    expect(filterProjects(items, '', true).map((p) => p.id)).toEqual(['b']);
  });
});

describe('isAttention', () => {
  it('flags attention and down only', () => {
    expect(isAttention({ health: 'attention' })).toBe(true);
    expect(isAttention({ health: 'down' })).toBe(true);
    expect(isAttention({ health: 'healthy' })).toBe(false);
    expect(isAttention({ health: 'idle' })).toBe(false);
  });
});

describe('formatSpend / formatRelativeTime', () => {
  it('formatSpend → 2dp dollars', () => {
    expect(formatSpend(13.384)).toBe('$13.38');
    expect(formatSpend(0)).toBe('$0.00');
  });

  it('formatRelativeTime buckets', () => {
    const now = Date.parse('2026-05-31T12:00:00.000Z');
    expect(formatRelativeTime(null, now)).toBe('—');
    expect(formatRelativeTime('2026-05-31T11:59:30.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-05-31T11:30:00.000Z', now)).toBe('30m');
    expect(formatRelativeTime('2026-05-31T09:00:00.000Z', now)).toBe('3h');
    expect(formatRelativeTime('2026-05-29T12:00:00.000Z', now)).toBe('2d');
    expect(formatRelativeTime('2026-05-10T12:00:00.000Z', now)).toBe('3w');
  });
});

describe('formatCycleTime', () => {
  it('shows — for zero / missing / invalid (no misleading "0d")', () => {
    expect(formatCycleTime(0)).toBe('—');
    expect(formatCycleTime(null)).toBe('—');
    expect(formatCycleTime(undefined)).toBe('—');
    expect(formatCycleTime(Number.NaN)).toBe('—');
    expect(formatCycleTime(-3)).toBe('—');
  });
  it('renders sub-day values as hours', () => {
    expect(formatCycleTime(0.5)).toBe('12h');
    expect(formatCycleTime(0.01)).toBe('1h'); // floored at 1h
  });
  it('renders day values with sensible precision', () => {
    expect(formatCycleTime(2.4)).toBe('2.4d');
    expect(formatCycleTime(14.2)).toBe('14d');
  });
});
