import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const queue: unknown[] = [];

// biome-ignore lint/suspicious/noExplicitAny: chainable mock proxy
const chain: any = {};
chain.from = () => chain;
chain.where = () => chain;
chain.orderBy = () => chain;
chain.limit = () => chain;
chain.values = () => chain;
chain.returning = () => chain;
chain.onConflictDoNothing = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) =>
  Promise.resolve(queue.shift()).then(resolve, reject);

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
  },
}));

const { forgePmSetDependencyTool } = await import('./forge-pm-set-dependency.js');
const { hooks } = await import('../../pipeline/hooks.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const FROM_ID = '22222222-2222-4222-8222-222222222222';
const TO_ID = '33333333-3333-4333-8333-333333333333';
const EDGE_ID = '66666666-6666-4666-8666-666666666666';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

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

function pushPmActorOk() {
  queue.push([{ ownerId: OWNER_ID }]);
  queue.push([{ capabilities: { pm: true } }]);
}

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
});

describe('forge_pm.set_dependency', () => {
  it('rejects self-edge', async () => {
    const tool = forgePmSetDependencyTool(fakeDevice);
    pushPmActorOk();
    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        fromIssueId: FROM_ID,
        toIssueId: FROM_ID,
        kind: 'blocks',
      }),
    ).rejects.toThrow(/self-edge/);
  });

  it('rejects when an issue is in another project', async () => {
    const tool = forgePmSetDependencyTool(fakeDevice);
    pushPmActorOk();
    queue.push([
      { id: FROM_ID, projectId: PROJECT_ID },
      { id: TO_ID, projectId: 'other-project' },
    ]);
    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        fromIssueId: FROM_ID,
        toIssueId: TO_ID,
        kind: 'blocks',
      }),
    ).rejects.toThrow(/projectId/);
  });

  it('inserts a new edge → created:true and emits dependencyChanged', async () => {
    const tool = forgePmSetDependencyTool(fakeDevice);
    pushPmActorOk();
    queue.push([
      { id: FROM_ID, projectId: PROJECT_ID },
      { id: TO_ID, projectId: PROJECT_ID },
    ]);
    queue.push([{ id: EDGE_ID }]); // insert returning

    hooks.reset();
    const depSpy = vi.fn();
    hooks.on('dependencyChanged', (p) => depSpy(p));

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'blocks',
    })) as { id: string; created: boolean };

    expect(result.created).toBe(true);
    expect(result.id).toBe(EDGE_ID);
    expect(depSpy).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      edgeId: EDGE_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'blocks',
    });
  });

  it('returns existing edge → created:false on conflict, no hook emit', async () => {
    const tool = forgePmSetDependencyTool(fakeDevice);
    pushPmActorOk();
    queue.push([
      { id: FROM_ID, projectId: PROJECT_ID },
      { id: TO_ID, projectId: PROJECT_ID },
    ]);
    queue.push([]); // insert returns no row (conflict)
    queue.push([{ id: EDGE_ID }]); // existing row lookup

    hooks.reset();
    const depSpy = vi.fn();
    hooks.on('dependencyChanged', (p) => depSpy(p));

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'blocks',
    })) as { id: string; created: boolean };

    expect(result.created).toBe(false);
    expect(result.id).toBe(EDGE_ID);
    expect(depSpy).not.toHaveBeenCalled();
  });
});
