import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectDistinctImpl = vi.fn();
const executeImpl = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    selectDistinct: (...a: unknown[]) => selectDistinctImpl(...a),
    execute: (...a: unknown[]) => executeImpl(...a),
  },
}));

const { forgeMetricsStepDurationsTool } = await import('./forge-metrics.js');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

const fakeDevice = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  name: 'fake',
  platform: 'linux' as const,
  agentVersion: null,
  tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
  tokenPrefix: 'fake0001',
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

function mockVisible(ids: string[]) {
  selectDistinctImpl.mockImplementationOnce(() => ({
    from: () => ({
      leftJoin: () => ({
        where: () => Promise.resolve(ids.map((id) => ({ id }))),
      }),
    }),
  }));
}

// Flatten a drizzle `sql` template into its literal text chunks.
function collectSqlFragments(sqlArg: unknown): string {
  const fragments: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      fragments.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node && typeof node === 'object') {
      const value = (node as { value?: unknown }).value;
      if (typeof value === 'string') fragments.push(value);
      else if (Array.isArray(value)) visit(value);
      const chunks = (node as { queryChunks?: unknown }).queryChunks;
      if (chunks) visit(chunks);
    }
  };
  visit(sqlArg);
  return fragments.join(' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  selectDistinctImpl.mockReset();
  executeImpl.mockReset();
});

describe('forge_metrics.step_durations', () => {
  it('returns empty without querying when caller has no visible projects', async () => {
    mockVisible([]);
    const tool = forgeMetricsStepDurationsTool(buildCtx());
    const res = (await tool.handler({ days: 30 })) as { rows: unknown[]; windowDays: number };
    expect(res.rows).toEqual([]);
    expect(res.windowDays).toBe(30);
    expect(executeImpl).not.toHaveBeenCalled();
  });

  it('scopes to visible projects with IN (...) — not ANY(::uuid[]) (array-binding regression)', async () => {
    mockVisible([PROJECT_ID]);
    executeImpl.mockResolvedValueOnce([]);
    const tool = forgeMetricsStepDurationsTool(buildCtx());
    await tool.handler({ days: 30 });

    expect(executeImpl).toHaveBeenCalledTimes(1);
    const sqlText = collectSqlFragments(executeImpl.mock.calls[0][0]);
    expect(sqlText).toContain('IN (');
    expect(sqlText).not.toContain('ANY(');
    expect(sqlText).not.toContain('::uuid[]');
  });
});
