import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

// Shared drizzle query-builder chain mock (mirrors forge-issues.test.ts /
// forge-schedules.test.ts). `effectiveProjectRole` (authz membership check)
// chains select().from().leftJoin().leftJoin().where().limit(1); this tool's
// own issues query chains select().from().where().orderBy().limit(N) — both
// terminate at the shared `selectLimit` mock, resolved in call order.
const selectLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));
const selectSpy = vi.fn(() => ({ from: selectFrom }));

vi.mock('../../db/client.js', () => ({
  db: { select: (...a: unknown[]) => selectSpy(...a) },
}));

const getKnowledgeEntryMock = vi.fn();
vi.mock('../../knowledge/service.js', () => ({
  getKnowledgeEntry: (...a: unknown[]) => getKnowledgeEntryMock(...a),
}));

const { forgeProjectStatusSummaryTool, bucketOf, assignFeature, parseFeatureMapBody } =
  await import('./forge-project-status-summary.js');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

const fakeDevice = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  name: 'fake',
  platform: 'linux' as const,
  agentVersion: null,
  machineId: null,
  gitCredentialRef: null,
  tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
  tokenPrefix: 'fake0001',
  disabledAt: null,
  status: 'online' as const,
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  createdAt: new Date(),
};

function buildCtx() {
  return {
    principal: { kind: 'device' as const, device: fakeDevice },
    device: fakeDevice,
    projectSlug: null,
  };
}

function mockMemberRole(role: 'viewer' | 'member' | 'admin' | null = 'member') {
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: role, orgRole: null }]);
}

function mockIssueRows(rows: unknown[]) {
  selectLimit.mockResolvedValueOnce(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  getKnowledgeEntryMock.mockReset();
  getKnowledgeEntryMock.mockResolvedValue(null);
});

describe('bucketOf', () => {
  it('closed is always done, merged or not', () => {
    expect(bucketOf('closed', null)).toBe('done');
    expect(bucketOf('closed', new Date())).toBe('done');
  });

  it('remaining statuses without mergedAt stay remaining', () => {
    expect(bucketOf('draft', null)).toBe('remaining');
    expect(bucketOf('waiting', null)).toBe('remaining');
    expect(bucketOf('needs_info', null)).toBe('remaining');
    expect(bucketOf('on_hold', null)).toBe('remaining');
  });

  it('on_hold with a stale mergedAt stays remaining, not done', () => {
    expect(bucketOf('on_hold', new Date())).toBe('remaining');
  });

  it('reopen with a stale mergedAt is in_flight, never done', () => {
    expect(bucketOf('reopen', new Date())).toBe('in_flight');
    expect(bucketOf('reopen', null)).toBe('in_flight');
  });

  it('released counts done only once merged, otherwise in_flight', () => {
    expect(bucketOf('released', new Date())).toBe('done');
    expect(bucketOf('released', null)).toBe('in_flight');
  });

  it('draft with a stale mergedAt stays remaining (excluded from the merged-done branch)', () => {
    expect(bucketOf('draft', new Date())).toBe('remaining');
  });

  it('needs_info with a stale mergedAt stays remaining', () => {
    expect(bucketOf('needs_info', new Date())).toBe('remaining');
  });

  it('every in-flight status without mergedAt is in_flight', () => {
    for (const status of [
      'open',
      'confirmed',
      'clarified',
      'approved',
      'in_progress',
      'developed',
      'testing',
      'tested',
    ] as const) {
      expect(bucketOf(status, null)).toBe('in_flight');
    }
  });

  it('an in-flight status that picks up a mergedAt counts as done', () => {
    expect(bucketOf('in_progress', new Date())).toBe('done');
    expect(bucketOf('testing', new Date())).toBe('done');
  });

  it('covers all 15 issueStatuses with a defined bucket', () => {
    const statuses = [
      'open',
      'confirmed',
      'clarified',
      'waiting',
      'approved',
      'in_progress',
      'developed',
      'testing',
      'tested',
      'released',
      'closed',
      'reopen',
      'on_hold',
      'needs_info',
      'draft',
    ] as const;
    for (const status of statuses) {
      expect(['done', 'in_flight', 'remaining']).toContain(bucketOf(status, null));
      expect(['done', 'in_flight', 'remaining']).toContain(bucketOf(status, new Date()));
    }
  });
});

describe('parseFeatureMapBody', () => {
  it('parses a valid { featureName: [pattern...] } map', () => {
    expect(parseFeatureMapBody('{"Chat":["[Chat]","Chat:"]}')).toEqual({
      Chat: ['[Chat]', 'Chat:'],
    });
  });

  it('rejects invalid JSON', () => {
    expect(parseFeatureMapBody('not json')).toBeNull();
  });

  it('rejects a non-object shape', () => {
    expect(parseFeatureMapBody('[1,2,3]')).toBeNull();
    expect(parseFeatureMapBody('"just a string"')).toBeNull();
  });

  it('rejects a map whose values are not string arrays', () => {
    expect(parseFeatureMapBody('{"Chat":"not-an-array"}')).toBeNull();
    expect(parseFeatureMapBody('{"Chat":[1,2]}')).toBeNull();
  });
});

describe('assignFeature', () => {
  it('matches a plain title-prefix pattern from the feature map', () => {
    expect(assignFeature('[Chat] fix streaming', { Chat: ['[Chat]'] })).toBe('Chat');
  });

  it('matches a regex-literal pattern from the feature map', () => {
    expect(assignFeature('Chat: fix streaming', { Chat: ['/^chat:/i'] })).toBe('Chat');
  });

  it('falls back to a bracketed title-prefix heuristic when no map matches', () => {
    expect(assignFeature('[Billing] invoice bug', null)).toBe('Billing');
  });

  it('falls back to a colon-tag title-prefix heuristic when no map matches', () => {
    expect(assignFeature('Billing: invoice bug', null)).toBe('Billing');
  });

  it('falls back to "Other" when nothing matches', () => {
    expect(assignFeature('a plain title with no prefix', null)).toBe('Other');
    expect(assignFeature('a plain title with no prefix', { Chat: ['[Chat]'] })).toBe('Other');
  });
});

describe('forge_project_status_summary', () => {
  it('returns an explicit empty fact for a project with zero issues', async () => {
    mockMemberRole('member');
    mockIssueRows([]);

    const tool = forgeProjectStatusSummaryTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID })) as {
      ok: boolean;
      empty: boolean;
      overall: { done: number; inFlight: number; remaining: number; total: number };
    };

    expect(res.ok).toBe(true);
    expect(res.empty).toBe(true);
    expect(res.overall).toEqual({ done: 0, inFlight: 0, remaining: 0, total: 0 });
  });

  it('returns an explicit unavailable fact when the DB read fails', async () => {
    mockMemberRole('member');
    selectLimit.mockRejectedValueOnce(new Error('connection reset'));

    const tool = forgeProjectStatusSummaryTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID })) as {
      ok: boolean;
      status: string;
    };

    expect(res.ok).toBe(false);
    expect(res.status).toBe('unavailable');
  });

  it('reconciles overall totals against the live GetContent-shaped mix (59 done, 5 draft)', async () => {
    mockMemberRole('member');
    const rows = [
      ...Array.from({ length: 59 }, (_, i) => ({
        id: `closed-${i}`,
        title: `[Alpha] closed issue ${i}`,
        status: 'closed' as const,
        mergedAt: new Date(),
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `draft-${i}`,
        title: `[Beta] draft issue ${i}`,
        status: 'draft' as const,
        mergedAt: null,
      })),
    ];
    mockIssueRows(rows);

    const tool = forgeProjectStatusSummaryTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID, groupByFeature: true })) as {
      overall: { done: number; inFlight: number; remaining: number; total: number };
      features: Array<{ name: string; total: number }>;
    };

    expect(res.overall).toEqual({ done: 59, inFlight: 0, remaining: 5, total: 64 });
    const featureTotal = res.features.reduce((sum, f) => sum + f.total, 0);
    expect(featureTotal).toBe(res.overall.total);
  });

  it('uses the feature-map knowledge entry when present and non-archived', async () => {
    mockMemberRole('member');
    getKnowledgeEntryMock.mockResolvedValueOnce({
      body: '{"Billing":["[Billing]"]}',
      archivedAt: null,
    });
    mockIssueRows([
      { id: '1', title: '[Billing] fix invoice', status: 'closed', mergedAt: new Date() },
      { id: '2', title: 'unrelated title', status: 'open', mergedAt: null },
    ]);

    const tool = forgeProjectStatusSummaryTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID })) as {
      features: Array<{ name: string; total: number }>;
    };

    const names = res.features.map((f) => f.name).sort();
    expect(names).toEqual(['Billing', 'Other']);
  });

  it('ignores an archived feature-map entry and falls back to the title-prefix heuristic', async () => {
    mockMemberRole('member');
    getKnowledgeEntryMock.mockResolvedValueOnce({
      body: '{"Billing":["[Billing]"]}',
      archivedAt: new Date(),
    });
    mockIssueRows([
      { id: '1', title: '[Growth] fix funnel', status: 'closed', mergedAt: new Date() },
    ]);

    const tool = forgeProjectStatusSummaryTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID })) as {
      features: Array<{ name: string; total: number }>;
    };

    expect(res.features).toEqual([
      { name: 'Growth', done: 1, inFlight: 0, remaining: 0, total: 1 },
    ]);
  });

  it('drops no issue into an unmatched group — everything lands in "Other"', async () => {
    mockMemberRole('member');
    getKnowledgeEntryMock.mockResolvedValueOnce(null);
    mockIssueRows([
      { id: '1', title: 'no prefix at all', status: 'open', mergedAt: null },
      { id: '2', title: 'also no prefix', status: 'in_progress', mergedAt: null },
    ]);

    const tool = forgeProjectStatusSummaryTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID })) as {
      overall: { total: number };
      features: Array<{ name: string; total: number }>;
    };

    expect(res.features).toEqual([{ name: 'Other', done: 0, inFlight: 2, remaining: 0, total: 2 }]);
    expect(res.features.reduce((sum, f) => sum + f.total, 0)).toBe(res.overall.total);
  });

  it('flags truncated when the row count hits the scan cap', async () => {
    mockMemberRole('member');
    const rows = Array.from({ length: 5001 }, (_, i) => ({
      id: `row-${i}`,
      title: `issue ${i}`,
      status: 'open' as const,
      mergedAt: null,
    }));
    mockIssueRows(rows);

    const tool = forgeProjectStatusSummaryTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID, groupByFeature: false })) as {
      truncated?: boolean;
      overall: { total: number };
    };

    expect(res.truncated).toBe(true);
    expect(res.overall.total).toBe(5000);
  });
});
