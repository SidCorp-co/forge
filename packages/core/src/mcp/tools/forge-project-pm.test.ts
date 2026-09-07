/**
 * ISS-145 — Action-dispatcher tests for `forge_project_pm`.
 *
 * Covers per-action routing for the six consolidated actions
 * (snapshot/graph/runner_load/dispatch/set_dependency/write_decision),
 * the per-action required-field validation, the new `forge_pm.graph`
 * truncation contract (`truncated:true` + `remainingNodes:N`) and depth=5
 * boundary, and the cross-tenant PAT regression for at least one
 * project-scoped action.
 */

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
chain.where = () => chain;
chain.orderBy = () => chain;
chain.limit = () => chain;
chain.groupBy = () => chain;
chain.leftJoin = () => chain;
chain.innerJoin = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) => Promise.resolve(queue.shift()).then(resolve, reject);

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => chain) },
}));

const { forgeProjectPmTool } = await import('./forge-project-pm.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const ROOT_ID = '66666666-6666-4666-8666-666666666666';

const fakePrincipal = makeFakePrincipal(DEVICE_ID, OWNER_ID);

function makeAdminCtx() {
  return {
    principal: fakePrincipal,
    projectSlug: null,
  };
}

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
});

describe('forge_project_pm (action=snapshot)', () => {
  it('routes to the pmSnapshot handler when the caller is a project member', async () => {
    const tool = forgeProjectPmTool(makeAdminCtx());
    const memberCheck = [{ orgId: 'org-1', memberRole: 'member', orgRole: null }];
    const counts: unknown[] = [];
    const activeJobs: unknown[] = [];
    const stalled: unknown[] = [];
    const queuedCount = [{ n: 0 }];
    const recentFailures: unknown[] = [];
    const runners: unknown[] = [];
    // cm:guard the queue is POSITIONAL — each entry answers the next query `readPmSnapshot` runs, in its order. Reorder these bindings without reordering the service and every assertion still runs, against the wrong rows.
    queue.push(memberCheck, counts, activeJobs, stalled, queuedCount, recentFailures, runners);

    const result = (await tool.handler({ action: 'snapshot', projectId: PROJECT_ID })) as {
      queuedCount: number;
    };
    expect(result.queuedCount).toBe(0);
  });

  it('re-applies project-member auth — a non-member is rejected as not-found', async () => {
    const tool = forgeProjectPmTool(makeAdminCtx());
    queue.push([{ orgId: 'org-1', memberRole: null, orgRole: null }]);
    await expect(tool.handler({ action: 'snapshot', projectId: PROJECT_ID })).rejects.toThrow(
      /NOT_FOUND/,
    );
  });
});

describe('forge_project_pm (action=graph)', () => {
  // cm:guard `truncated` and `remainingNodes` are a CONTRACT, not a hint: the project-wide branch caps at 200 nodes, and a caller that reads a capped graph as complete draws a dependency conclusion from a subset it cannot tell is a subset (ISS-145)
  it('returns truncated:true + remainingNodes when count exceeds the cap', async () => {
    const tool = forgeProjectPmTool(makeAdminCtx());
    const stubNodes = Array.from({ length: 200 }, (_, i) => ({
      id: `${i}`.padStart(8, '0'),
      status: 'open',
      priority: 'medium',
      assigneeId: null,
      parentIssueId: null,
    }));
    const memberCheck = [{ orgId: 'org-1', memberRole: 'member', orgRole: null }];
    const totalFiftyOverTheCap = [{ total: 250 }];
    const noDepEdges: unknown[] = [];
    queue.push(memberCheck, totalFiftyOverTheCap, stubNodes, noDepEdges);
    const result = (await tool.handler({ action: 'graph', projectId: PROJECT_ID })) as {
      truncated: boolean;
      remainingNodes: number;
      nodes: unknown[];
    };
    expect(result.truncated).toBe(true);
    expect(result.remainingNodes).toBe(50);
    expect(result.nodes).toHaveLength(200);
  });

  // cm:guard depth=5 must PARSE — the cap was raised from 4 in ISS-145, and a schema that still rejects 5 fails as a validation error the caller reads as their own mistake
  it('accepts depth=5 at the input boundary', async () => {
    const tool = forgeProjectPmTool(makeAdminCtx());
    queue.push(
      [{ orgId: 'org-1', memberRole: 'member', orgRole: null }],
      // cm:guard five BFS iterations ask FOUR queries each — deps forward, deps reverse, children, parents — so the twenty empty entries below are one per query, not padding. Change the walk's query count without changing this many and the final nodeRows entry is read as an edge list.
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
      action: 'graph',
      projectId: PROJECT_ID,
      rootIssueId: ROOT_ID,
      depth: 5,
    })) as { depth: number };
    expect(result.depth).toBe(5);
  });

  it('rejects depth=6 at the input boundary', async () => {
    const tool = forgeProjectPmTool(makeAdminCtx());
    await expect(
      tool.handler({
        action: 'graph',
        projectId: PROJECT_ID,
        rootIssueId: ROOT_ID,
        depth: 6,
      }),
    ).rejects.toThrow();
  });
});

describe('forge_project_pm — required-field validation', () => {
  it('dispatch without issueId throws BAD_REQUEST', async () => {
    const tool = forgeProjectPmTool(makeAdminCtx());
    await expect(
      tool.handler({ action: 'dispatch', projectId: PROJECT_ID, jobType: 'code', reason: 'r' }),
    ).rejects.toThrow(/BAD_REQUEST: issueId is required for dispatch/);
  });

  it('set_dependency without fromIssueId throws BAD_REQUEST', async () => {
    const tool = forgeProjectPmTool(makeAdminCtx());
    await expect(
      tool.handler({
        action: 'set_dependency',
        projectId: PROJECT_ID,
        toIssueId: '22222222-2222-4222-8222-222222222222',
        kind: 'blocks',
      }),
    ).rejects.toThrow(/BAD_REQUEST: fromIssueId is required for set_dependency/);
  });

  // cm:guard `write_decision` is refused on the CREDENTIAL before any field is checked, so there is deliberately no required-field case for it. A refusal naming `summary` to a caller who cannot use the action with every field supplied is the wrong condition (ISS-787/ISS-868).
  it('write_decision refuses on the credential before it asks for summary', async () => {
    const tool = forgeProjectPmTool(makeAdminCtx());
    await expect(
      tool.handler({
        action: 'write_decision',
        projectId: PROJECT_ID,
        cause: 'job-failed',
      }),
    ).rejects.toThrow(/PM_REQUIRES_DEVICE/);
  });
});

// cm:guard these cases deliberately BYPASS the server-level gate by calling the factory directly, because the dispatcher must refuse a cross-project PAT on its own. The two gates are defence in depth, and a suite that only ever goes through the outer one cannot tell you the inner one still exists.
describe('forge_project_pm — action-level auth (cross-tenant)', () => {
  it('snapshot re-applies project-member auth so cross-tenant PAT is rejected', async () => {
    // cm:why a PAT reaches the dispatcher carrying a stub device whose ownerId IS the PAT user, so the ordinary membership check resolves on that user and FORBIDDEN is the surface a real cross-tenant call would hit
    const tool = forgeProjectPmTool({
      principal: {
        kind: 'pat' as const,
        agency: 'human' as const,
        userId: OWNER_ID,
        tokenId: '77777777-7777-4777-8777-777777777777',
        scopes: ['read', 'write'],
        projectIds: ['99999999-9999-4999-8999-999999999999'],
        boundProjectId: null,
        deviceId: null,
        machine: null,
      },
      projectSlug: null,
    });
    queue.push([{ ownerId: 'other-owner' }], []);
    await expect(tool.handler({ action: 'snapshot', projectId: PROJECT_ID })).rejects.toThrow(
      /NOT_FOUND/,
    );
  });
});
