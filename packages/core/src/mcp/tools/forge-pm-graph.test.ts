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
chain.leftJoin = () => chain;
chain.where = () => chain;
chain.orderBy = () => chain;
chain.limit = () => chain;
chain.groupBy = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) => Promise.resolve(queue.shift()).then(resolve, reject);

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => chain) },
}));

const { pmGraphHandler, pmGraphInputSchema } = await import('./forge-pm-graph.js');

// cm:why these cases used to run through the deprecated `forge_pm.<action>` shim factory, which was deleted once nothing named it; the handler and its schema are what `forge_project_pm` actually dispatches into, so the coverage moves down one layer instead of leaving with the shim — for runner_load, dispatch and write_decision this file is still the only place that behaviour is tested
const forgePmGraphTool = (c: typeof ctx) => ({
  handler: async (args: unknown) => pmGraphHandler(c.device, pmGraphInputSchema.parse(args)),
});

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
  machineId: null,
  gitCredentialRef: null,
  maxConcurrent: 1,
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

describe('forge_pm.graph', () => {
  it('rejects non-member', async () => {
    const tool = forgePmGraphTool(ctx);
    queue.push([{ orgId: 'org-1', memberRole: null, orgRole: null }]);
    await expect(tool.handler({ projectId: PROJECT_ID })).rejects.toThrow(/FORBIDDEN/);
  });

  it('returns whole-project graph when rootIssueId omitted', async () => {
    const tool = forgePmGraphTool(ctx);
    queue.push(
      [{ orgId: 'org-1', memberRole: 'member', orgRole: null }],
      [{ total: 2 }],
      [
        { id: ROOT_ID, status: 'open', priority: 'medium', assigneeId: null },
        { id: CHILD_ID, status: 'open', priority: 'low', assigneeId: null },
      ],
      [{ from: ROOT_ID, to: CHILD_ID, kind: 'blocks' }],
    );

    const result = (await tool.handler({ projectId: PROJECT_ID })) as {
      nodes: unknown[];
      edges: Array<{ kind: string }>;
      truncated: boolean;
      remainingNodes: number;
      rootIssueId: string | null;
    };
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.rootIssueId).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.remainingNodes).toBe(0);
  });

  // cm:guard `truncated` and `remainingNodes` are a CONTRACT, not a hint: the project-wide branch caps at 200 nodes, and a caller that reads a capped graph as complete draws a dependency conclusion from a subset it cannot tell is a subset (ISS-145)
  it('returns truncated:true + remainingNodes when project exceeds the 200-node cap', async () => {
    const tool = forgePmGraphTool(ctx);
    const stubNodes = Array.from({ length: 200 }, (_, i) => ({
      id: `${i}`.padStart(8, '0'),
      status: 'open',
      priority: 'medium',
      assigneeId: null,
      parentIssueId: null,
    }));
    const memberCheck = [{ orgId: 'org-1', memberRole: 'member', orgRole: null }];
    const totalFifteenOverTheCap = [{ total: 215 }];
    const noEdges: unknown[] = [];
    queue.push(memberCheck, totalFifteenOverTheCap, stubNodes, noEdges);
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
    const memberCheck = [{ orgId: 'org-1', memberRole: 'member', orgRole: null }];
    const depth1Forward = [{ from: ROOT_ID, to: CHILD_ID, kind: 'blocks' }];
    const depth1ReverseCycle = [{ from: CHILD_ID, to: ROOT_ID, kind: 'blocks' }];
    const depth2ForwardAlreadySeen = [{ from: ROOT_ID, to: CHILD_ID, kind: 'blocks' }];
    const depth2Reverse: unknown[] = [];
    // cm:guard the BFS asks forward-then-reverse at EACH depth, and this queue answers in that order — the cycle case only proves dedupe because `depth2ForwardAlreadySeen` repeats an edge the walk has already taken; reorder these and the test still passes while testing nothing
    queue.push(
      memberCheck,
      depth1Forward,
      depth1ReverseCycle,
      depth2ForwardAlreadySeen,
      depth2Reverse,
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

    expect(result.edges).toHaveLength(2);
    expect(result.rootIssueId).toBe(ROOT_ID);
  });

  it('rejects depth > 5', async () => {
    const tool = forgePmGraphTool(ctx);
    await expect(
      tool.handler({ projectId: PROJECT_ID, rootIssueId: ROOT_ID, depth: 6 }),
    ).rejects.toThrow();
  });

  // cm:guard depth=5 must PARSE — the cap was raised from 4 in ISS-145, and a schema that still rejects 5 fails as a validation error the caller reads as their own mistake
  it('accepts depth=5 at the input boundary', async () => {
    const tool = forgePmGraphTool(ctx);
    queue.push(
      [{ orgId: 'org-1', memberRole: 'member', orgRole: null }],
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
      [],
    );
    const result = (await tool.handler({
      projectId: PROJECT_ID,
      rootIssueId: ROOT_ID,
      depth: 5,
    })) as { depth: number };
    expect(result.depth).toBe(5);
  });
});
