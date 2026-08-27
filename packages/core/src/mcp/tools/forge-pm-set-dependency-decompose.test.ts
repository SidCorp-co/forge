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
chain.select = () => chain;
chain.insert = () => chain;
chain.update = () => chain;
chain.execute = async () => undefined;
chain.from = () => chain;
chain.leftJoin = () => chain;
chain.where = () => chain;
chain.limit = () => chain;
chain.values = () => chain;
chain.returning = () => chain;
chain.onConflictDoNothing = () => chain;
chain.set = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) => Promise.resolve(queue.shift()).then(resolve, reject);

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    transaction: (callback: (tx: typeof chain) => Promise<unknown>) => callback(chain),
  },
}));

vi.mock('../../issues/dependency-routes.js', () => ({
  detectCycle: vi.fn(async () => null),
}));

const prepareSpy = vi.fn(async () => ({
  result: {
    parentId: 'parent',
    childIds: ['child'],
    integrationBranch: 'iss-1-foo',
    createdEdges: 0,
    parentAlreadyDecomposed: false,
    parentStatus: 'confirmed',
    projectId: PROJECT_ID,
    hasActiveDecomposition: true,
    reviewGate: null,
  },
  actor: { type: 'user' as const, id: OWNER_ID },
  children: [],
  edges: [],
}));
const finalizeSpy = vi.fn(async () => ({
  parentId: 'parent',
  childIds: ['child'],
  integrationBranch: 'iss-1-foo',
  createdEdges: 0,
}));
vi.mock('../../issues/decompose.js', () => ({
  prepareDecomposition: prepareSpy,
  finalizeDecomposition: finalizeSpy,
}));

vi.mock('../../issues/pipeline-health.js', () => ({
  publishPipelineHealthChanged: vi.fn(async () => undefined),
}));

const { forgePmSetDependencyTool } = await import('./forge-pm-set-dependency.js');
const { publishPipelineHealthChanged } = await import('../../issues/pipeline-health.js');
const { hooks } = await import('../../pipeline/hooks.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const FROM_ID = '22222222-2222-4222-8222-222222222222';
const TO_ID = '33333333-3333-4333-8333-333333333333';
const EDGE_ID = '66666666-6666-4666-8666-666666666666';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';

const fakeDevice = {
  id: '55555555-5555-4555-8555-555555555555',
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

const context = {
  principal: { kind: 'device' as const, device: fakeDevice },
  device: fakeDevice,
  projectSlug: null,
};

function pushMemberOk() {
  queue.push([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
}

function pushSides() {
  queue.push([
    { id: FROM_ID, projectId: PROJECT_ID },
    { id: TO_ID, projectId: PROJECT_ID },
  ]);
}

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
  prepareSpy.mockClear();
  finalizeSpy.mockClear();
});

describe('forge_pm.set_dependency decomposition creation', () => {
  it('creates integration branch state before publishing dependency change', async () => {
    const order: string[] = [];
    hooks.reset();
    hooks.on('dependencyChanged', () => {
      order.push('dependencyChanged');
    });
    prepareSpy.mockImplementationOnce(async () => {
      order.push('decompose');
      return {
        result: {
          parentId: 'parent',
          childIds: ['child'],
          integrationBranch: 'iss-1-foo',
          createdEdges: 0,
          parentAlreadyDecomposed: false,
          parentStatus: 'confirmed',
          projectId: PROJECT_ID,
          hasActiveDecomposition: true,
          reviewGate: null,
        },
        actor: { type: 'user' as const, id: OWNER_ID },
        children: [],
        edges: [],
      };
    });
    const tool = forgePmSetDependencyTool(context);
    pushMemberOk();
    pushSides();
    queue.push([]);
    queue.push([{ id: EDGE_ID }]);

    await tool.handler({
      projectId: PROJECT_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'decomposes',
    });

    expect(prepareSpy).toHaveBeenCalledWith(
      expect.anything(),
      FROM_ID,
      [{ existingIssueId: TO_ID }],
      { userId: OWNER_ID },
      { useIntegrationBranch: undefined },
    );
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['decompose', 'dependencyChanged']);
    expect(publishPipelineHealthChanged).toHaveBeenCalledWith(PROJECT_ID, [FROM_ID]);
  });

  it('keeps the review gate while opting out of an integration branch', async () => {
    const tool = forgePmSetDependencyTool(context);
    pushMemberOk();
    pushSides();
    queue.push([]);
    queue.push([{ id: EDGE_ID }]);

    await tool.handler({
      projectId: PROJECT_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'decomposes',
      decomposeOpts: { useIntegrationBranch: false },
    });

    expect(prepareSpy).toHaveBeenCalledWith(
      expect.anything(),
      FROM_ID,
      [{ existingIssueId: TO_ID }],
      { userId: OWNER_ID },
      { useIntegrationBranch: false },
    );
  });
});

describe('forge_pm.set_dependency decomposition recovery', () => {
  it('retries an existing active decomposition edge', async () => {
    const tool = forgePmSetDependencyTool(context);
    pushMemberOk();
    pushSides();
    queue.push([{ id: EDGE_ID, validUntil: null }]);

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'decomposes',
    })) as { created: boolean; updated: boolean };

    expect(result).toMatchObject({ created: false, updated: false });
    expect(prepareSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry an expired decomposition edge', async () => {
    const tool = forgePmSetDependencyTool(context);
    pushMemberOk();
    pushSides();
    queue.push([{ id: EDGE_ID, validUntil: null }]);
    queue.push([]);

    await tool.handler({
      projectId: PROJECT_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'decomposes',
      validUntil: '2020-01-01T00:00:00Z',
    });

    expect(prepareSpy).not.toHaveBeenCalled();
    expect(publishPipelineHealthChanged).toHaveBeenCalledWith(PROJECT_ID, [FROM_ID]);
  });

  it('does not set up a newly expired decomposition edge', async () => {
    const tool = forgePmSetDependencyTool(context);
    pushMemberOk();
    pushSides();
    queue.push([]);
    queue.push([{ id: EDGE_ID }]);

    await tool.handler({
      projectId: PROJECT_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'decomposes',
      validUntil: '2020-01-01T00:00:00Z',
    });

    expect(prepareSpy).not.toHaveBeenCalled();
  });
});
