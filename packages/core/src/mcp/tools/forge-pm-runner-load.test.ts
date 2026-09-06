import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakePrincipal } from '../fake-principal.fixture.js';

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
chain.innerJoin = () => chain;
chain.where = () => chain;
chain.orderBy = () => chain;
chain.limit = () => chain;
chain.groupBy = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) => Promise.resolve(queue.shift()).then(resolve, reject);

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => chain), execute: () => Promise.resolve(queue.shift()) },
}));

const { pmRunnerLoadHandler, pmRunnerLoadInputSchema } = await import('./forge-pm-runner-load.js');

// cm:why these cases used to run through the deprecated `forge_pm.<action>` shim factory, which was deleted once nothing named it; the handler and its schema are what `forge_project_pm` actually dispatches into, so the coverage moves down one layer instead of leaving with the shim — for runner_load, dispatch and write_decision this file is still the only place that behaviour is tested
const forgePmRunnerLoadTool = (c: typeof ctx) => ({
  handler: async (args: unknown) =>
    pmRunnerLoadHandler(c.principal, pmRunnerLoadInputSchema.parse(args)),
});

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

const fakePrincipal = makeFakePrincipal(DEVICE_ID, OWNER_ID);

const ctx = {
  principal: fakePrincipal,
  projectSlug: null,
};

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
});

describe('forge_pm.runner_load', () => {
  it('rejects a non-member as not-found (existence-hiding)', async () => {
    const tool = forgePmRunnerLoadTool(ctx);
    queue.push([{ orgId: 'org-1', memberRole: null, orgRole: null }]);
    await expect(tool.handler({ projectId: PROJECT_ID })).rejects.toThrow(/NOT_FOUND/);
  });

  // cm:guard the payload carries the raw `inFlight` count and NO capacity field. Core enforces no ceiling since the master began claiming from the pool, so any headroom reported here would be a limit nothing applies — the operator reads the count and concludes, this tool does not conclude for them.
  it('returns runner list with inFlight and no capacity field', async () => {
    const tool = forgePmRunnerLoadTool(ctx);
    const memberCheck = [{ orgId: 'org-1', memberRole: 'member', orgRole: null }];
    queue.push(
      memberCheck,
      [
        {
          id: 'r1',
          type: 'claude-code',
          status: 'online',
          lastSeenAt: new Date('2026-05-01T00:00:00Z'),
        },
        {
          id: 'r2',
          type: 'claude-code',
          status: 'offline',
          lastSeenAt: null,
        },
      ],
      [{ runner_id: 'r1', n: 1 }],
    );

    const result = (await tool.handler({ projectId: PROJECT_ID })) as {
      runners: Array<{ id: string; inFlight: number }>;
    };
    expect(result.runners).toHaveLength(2);
    expect(result.runners[0]?.inFlight).toBe(1);
    expect(result.runners[1]?.inFlight).toBe(0);
    for (const r of result.runners) expect(r).not.toHaveProperty('capacity');
  });
});
