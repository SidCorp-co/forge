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
chain.groupBy = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) =>
  Promise.resolve(queue.shift()).then(resolve, reject);

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => chain) },
}));

const { forgePmGraphTool } = await import('./forge-pm-graph.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ROOT_ID = '22222222-2222-4222-8222-222222222222';
const CHILD_ID = '33333333-3333-4333-8333-333333333333';
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

const ctx = {
  principal: { kind: 'device' as const, device: fakeDevice },
  device: fakeDevice,
  projectSlug: null,
};

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
});

describe('forge_pm.graph', () => {
  it('rejects non-member', async () => {
    const tool = forgePmGraphTool(ctx);
    queue.push([{ ownerId: 'other' }], []); // assertDeviceOwnerIsMember
    await expect(tool.handler({ projectId: PROJECT_ID })).rejects.toThrow(/FORBIDDEN/);
  });

  it('returns whole-project graph when rootIssueId omitted', async () => {
    const tool = forgePmGraphTool(ctx);
    queue.push(
      [{ ownerId: OWNER_ID }], // assert
      [{ total: 2 }], // count() for totalNodes
      [
        { id: ROOT_ID, status: 'open', priority: 'medium', assigneeId: null, parentIssueId: null },
        {
          id: CHILD_ID,
          status: 'open',
          priority: 'low',
          assigneeId: null,
          parentIssueId: ROOT_ID,
        },
      ],
      [{ from: ROOT_ID, to: CHILD_ID, kind: 'blocks' }], // dep edges
    );

    const result = (await tool.handler({ projectId: PROJECT_ID })) as {
      nodes: unknown[];
      edges: Array<{ kind: string }>;
      truncated: boolean;
      remainingNodes: number;
      rootIssueId: string | null;
    };
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(2); // 1 dep + 1 parent
    expect(result.rootIssueId).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.remainingNodes).toBe(0);
  });

  // ISS-145 — explicit truncation contract for the project-wide branch.
  it('returns truncated:true + remainingNodes when project exceeds the 200-node cap', async () => {
    const tool = forgePmGraphTool(ctx);
    const stubNodes = Array.from({ length: 200 }, (_, i) => ({
      id: `${i}`.padStart(8, '0'),
      status: 'open',
      priority: 'medium',
      assigneeId: null,
      parentIssueId: null,
    }));
    queue.push(
      [{ ownerId: OWNER_ID }], // assert
      [{ total: 215 }], // count() — 15 more than the cap
      stubNodes, // capped nodes
      [], // no edges
    );
    const result = (await tool.handler({ projectId: PROJECT_ID })) as {
      truncated: boolean;
      remainingNodes: number;
      nodes: unknown[];
    };
    expect(result.truncated).toBe(true);
    expect(result.remainingNodes).toBe(15);
    expect(result.nodes).toHaveLength(200);
  });

  it('BFS expands to depth and dedupes edges with cycle', async () => {
    const tool = forgePmGraphTool(ctx);
    queue.push(
      [{ ownerId: OWNER_ID }], // assert
      // depth 1: forward deps from ROOT
      [{ from: ROOT_ID, to: CHILD_ID, kind: 'blocks' }],
      // depth 1: reverse deps to ROOT (cycle: CHILD also blocks ROOT)
      [{ from: CHILD_ID, to: ROOT_ID, kind: 'blocks' }],
      // depth 1: child rows where ROOT is the issue
      [],
      // depth 1: child rows where ROOT is the parent
      [],
      // depth 2: forward deps from CHILD
      [{ from: ROOT_ID, to: CHILD_ID, kind: 'blocks' }], // already seen
      // depth 2: reverse deps to CHILD
      [],
      [],
      [],
      // final: nodeRows for visited set
      [
        { id: ROOT_ID, status: 'open', priority: 'medium', assigneeId: null },
        { id: CHILD_ID, status: 'open', priority: 'low', assigneeId: null },
      ],
    );

    const result = (await tool.handler({ projectId: PROJECT_ID, rootIssueId: ROOT_ID })) as {
      nodes: unknown[];
      edges: Array<{ from: string; to: string; kind: string }>;
      rootIssueId: string;
    };
    expect(result.nodes).toHaveLength(2);
    // 2 distinct edges (cycle: ROOT→CHILD and CHILD→ROOT both blocks)
    expect(result.edges).toHaveLength(2);
    expect(result.rootIssueId).toBe(ROOT_ID);
  });

  it('rejects depth > 5', async () => {
    const tool = forgePmGraphTool(ctx);
    await expect(
      tool.handler({ projectId: PROJECT_ID, rootIssueId: ROOT_ID, depth: 6 }),
    ).rejects.toThrow();
  });

  // ISS-145 — input parse must accept depth=5 (raised from previous cap of 4).
  it('accepts depth=5 at the input boundary', async () => {
    const tool = forgePmGraphTool(ctx);
    queue.push(
      [{ ownerId: OWNER_ID }], // assert
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [], // final nodeRows
    );
    const result = (await tool.handler({
      projectId: PROJECT_ID,
      rootIssueId: ROOT_ID,
      depth: 5,
    })) as { depth: number };
    expect(result.depth).toBe(5);
  });
});
