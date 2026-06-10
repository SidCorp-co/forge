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
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) =>
  Promise.resolve(queue.shift()).then(resolve, reject);

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => chain) },
}));

const { forgeProjectPmTool } = await import('./forge-project-pm.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const ROOT_ID = '66666666-6666-4666-8666-666666666666';

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
  status: 'online' as const,
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  createdAt: new Date(),
};

function makeDeviceCtx() {
  return {
    principal: { kind: 'device' as const, device: fakeDevice },
    device: fakeDevice,
    projectSlug: null,
  };
}

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
});

describe('forge_project_pm (action=snapshot)', () => {
  it('routes to the pmSnapshot handler when device owner is project member', async () => {
    const tool = forgeProjectPmTool(makeDeviceCtx());
    queue.push(
      [{ orgId: 'org-1', memberRole: 'member', orgRole: null }], // assertDeviceOwnerIsMember
      [], // counts
      [], // activeJobs
      [], // stalled
      [{ n: 0 }], // queuedCount
      [], // recentFailures
      [], // runners
    );

    const result = (await tool.handler({ action: 'snapshot', projectId: PROJECT_ID })) as {
      queuedCount: number;
    };
    expect(result.queuedCount).toBe(0);
  });

  it('re-applies project-member auth — non-member is rejected with FORBIDDEN', async () => {
    const tool = forgeProjectPmTool(makeDeviceCtx());
    queue.push([{ orgId: 'org-1', memberRole: null, orgRole: null }]); // project lookup + no member row
    await expect(
      tool.handler({ action: 'snapshot', projectId: PROJECT_ID }),
    ).rejects.toThrow(/FORBIDDEN/);
  });
});

describe('forge_project_pm (action=graph)', () => {
  // ISS-145 — project-wide branch returns truncated:true + remainingNodes>0
  // when the project exceeds the 200-node cap.
  it('returns truncated:true + remainingNodes when count exceeds the cap', async () => {
    const tool = forgeProjectPmTool(makeDeviceCtx());
    const stubNodes = Array.from({ length: 200 }, (_, i) => ({
      id: `${i}`.padStart(8, '0'),
      status: 'open',
      priority: 'medium',
      assigneeId: null,
      parentIssueId: null,
    }));
    queue.push(
      [{ orgId: 'org-1', memberRole: 'member', orgRole: null }], // assert
      [{ total: 250 }], // count() → 50 over cap
      stubNodes,
      [], // dep edges
    );
    const result = (await tool.handler({ action: 'graph', projectId: PROJECT_ID })) as {
      truncated: boolean;
      remainingNodes: number;
      nodes: unknown[];
    };
    expect(result.truncated).toBe(true);
    expect(result.remainingNodes).toBe(50);
    expect(result.nodes).toHaveLength(200);
  });

  // ISS-145 — depth=5 must validate at the input boundary (previous cap 4).
  it('accepts depth=5 at the input boundary', async () => {
    const tool = forgeProjectPmTool(makeDeviceCtx());
    queue.push(
      [{ orgId: 'org-1', memberRole: 'member', orgRole: null }], // assert
      // 5 BFS iterations × 4 queries (deps fwd/rev + children/parents)
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
      action: 'graph',
      projectId: PROJECT_ID,
      rootIssueId: ROOT_ID,
      depth: 5,
    })) as { depth: number };
    expect(result.depth).toBe(5);
  });

  it('rejects depth=6 at the input boundary', async () => {
    const tool = forgeProjectPmTool(makeDeviceCtx());
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
    const tool = forgeProjectPmTool(makeDeviceCtx());
    await expect(
      tool.handler({ action: 'dispatch', projectId: PROJECT_ID, jobType: 'code', reason: 'r' }),
    ).rejects.toThrow(/BAD_REQUEST: issueId is required for dispatch/);
  });

  it('set_dependency without fromIssueId throws BAD_REQUEST', async () => {
    const tool = forgeProjectPmTool(makeDeviceCtx());
    await expect(
      tool.handler({
        action: 'set_dependency',
        projectId: PROJECT_ID,
        toIssueId: '22222222-2222-4222-8222-222222222222',
        kind: 'blocks',
      }),
    ).rejects.toThrow(/BAD_REQUEST: fromIssueId is required for set_dependency/);
  });

  it('write_decision without summary throws BAD_REQUEST', async () => {
    const tool = forgeProjectPmTool(makeDeviceCtx());
    await expect(
      tool.handler({
        action: 'write_decision',
        projectId: PROJECT_ID,
        cause: 'job-failed',
      }),
    ).rejects.toThrow(/BAD_REQUEST: summary is required for write_decision/);
  });
});

// Acceptance criterion 8 — PAT for project A cannot run a pm action against
// project B. Two layers of defence:
//   (1) `server.ts` gates the consolidated dispatcher (per-action via
//       DEVICE_REQUIRED) AND a PAT allowlist check.
//   (2) Bypassing the server (calling the factory directly with a PAT
//       principal) still fails because the dispatcher uses the stub
//       device's `ownerId` — set to the PAT user — and the project
//       membership check resolves on that user. We assert the FORBIDDEN
//       surface here so a future regression that removes the action-level
//       auth is caught even if the server gate is intact.
describe('forge_project_pm — action-level auth (cross-tenant)', () => {
  it('snapshot re-applies project-member auth so cross-tenant PAT is rejected', async () => {
    // PAT principals reach the dispatcher with a stub device whose ownerId
    // is the PAT user. If the PAT user is NOT a member of the project,
    // assertDeviceOwnerIsMember throws FORBIDDEN — exactly the surface a
    // real cross-tenant call would hit when the server-level allowlist
    // gate is somehow bypassed (defence in depth).
    const tool = forgeProjectPmTool({
      principal: {
        kind: 'pat' as const,
        userId: OWNER_ID,
        tokenId: '77777777-7777-4777-8777-777777777777',
        scopes: ['read', 'write'],
        projectIds: ['99999999-9999-4999-8999-999999999999'],
      },
      device: fakeDevice,
      projectSlug: null,
    });
    queue.push([{ ownerId: 'other-owner' }], []); // project + no member row
    await expect(
      tool.handler({ action: 'snapshot', projectId: PROJECT_ID }),
    ).rejects.toThrow(/FORBIDDEN/);
  });
});
