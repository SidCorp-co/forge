import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const queue: unknown[] = [];

// biome-ignore lint/suspicious/noExplicitAny: chainable mock proxy for drizzle
const chain: any = {};
chain.from = () => chain;
chain.where = () => chain;
chain.orderBy = () => chain;
chain.limit = () => chain;
chain.groupBy = () => chain;
chain.leftJoin = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge for await
chain.then = (resolve: any, reject: any) => Promise.resolve(queue.shift()).then(resolve, reject);

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => chain),
    execute: () => Promise.resolve(queue.shift()),
  },
}));

const { pmSnapshotHandler, pmSnapshotInputSchema } = await import('./forge-pm-snapshot.js');

// cm:why these cases used to run through the deprecated `forge_pm.<action>` shim factory, which was deleted once nothing named it; the handler and its schema are what `forge_project_pm` actually dispatches into, so the coverage moves down one layer instead of leaving with the shim — for runner_load, dispatch and write_decision this file is still the only place that behaviour is tested
const forgePmSnapshotTool = (c: typeof ctx) => ({
  handler: async (args: unknown) => pmSnapshotHandler(c.device, pmSnapshotInputSchema.parse(args)),
});

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

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

const ctx = {
  principal: { kind: 'device' as const, device: fakeDevice },
  device: fakeDevice,
  projectSlug: null,
};

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
});

describe('forge_pm.snapshot', () => {
  it('rejects non-member with FORBIDDEN', async () => {
    const tool = forgePmSnapshotTool(ctx);
    const projectLookup = [{ orgId: 'org-1', memberRole: null, orgRole: null }];
    const noMemberRow: unknown[] = [];
    queue.push(projectLookup, noMemberRow);
    await expect(tool.handler({ projectId: PROJECT_ID })).rejects.toThrow(/FORBIDDEN/);
  });

  it('rejects invalid input', async () => {
    const tool = forgePmSnapshotTool(ctx);
    await expect(tool.handler({ projectId: 'not-a-uuid' })).rejects.toThrow();
  });

  it('returns digest with expected shape under 2KB', async () => {
    const tool = forgePmSnapshotTool(ctx);
    const memberCheck = [{ orgId: 'org-1', memberRole: 'member', orgRole: null }];
    const countsByStatus = [
      { status: 'open', n: 3 },
      { status: 'in_progress', n: 1 },
    ];
    const activeJobs = [
      {
        id: 'j1',
        type: 'code',
        status: 'running',
        issueId: 'i1',
        queuedAt: new Date('2026-05-01T00:00:00Z'),
      },
    ];
    const stalledIssues = [
      {
        id: 'i9',
        issueId: 9,
        status: 'in_progress',
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      },
    ];
    const queuedCount = [{ n: 4 }];
    const recentFailures = [
      {
        id: 'j2',
        type: 'review',
        failureKind: 'transient',
        failureReason: 'x'.repeat(500),
        finishedAt: new Date('2026-05-01T00:00:00Z'),
      },
    ];
    // cm:guard the queue is POSITIONAL — each entry answers the next query `readPmSnapshot` runs, in its order. Reorder these bindings without reordering the service and every assertion still runs, against the wrong rows.
    queue.push(
      memberCheck,
      countsByStatus,
      activeJobs,
      stalledIssues,
      queuedCount,
      recentFailures,
      [
        {
          id: 'r1',
          type: 'claude-code',
          status: 'online',
          lastSeenAt: new Date('2026-05-01T00:00:00Z'),
        },
      ],
      [{ runner_id: 'r1', n: 2 }],
    );

    const result = (await tool.handler({ projectId: PROJECT_ID })) as {
      countsByStatus: Record<string, number>;
      activeJobs: unknown[];
      stalledIssues: Array<{ issueId: string }>;
      queuedCount: number;
      recentFailures: Array<{ failureReason: string }>;
      runnerHealth: Array<{ inFlight: number }>;
    };

    expect(result.countsByStatus.open).toBe(3);
    expect(result.activeJobs).toHaveLength(1);
    expect(result.stalledIssues[0]?.issueId).toBe('ISS-9');
    expect(result.queuedCount).toBe(4);
    expect(result.recentFailures[0]?.failureReason?.length).toBeLessThanOrEqual(201);
    expect(result.runnerHealth[0]?.inFlight).toBe(2);

    expect(JSON.stringify(result).length).toBeLessThan(2048);
  });
});
