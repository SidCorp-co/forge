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

// ISS-40 PR-E added a cycle pre-check on `kind='blocks'` inserts that walks
// the dependency graph via its own `db.select` chain. The queue-mock above
// is shaped for the tool's own calls, not the cycle walk; stub the helper
// to return `null` (no cycle) so this test stays focused on the tool's own
// branches. Cycle detection itself is covered by `dependency-routes.test.ts`.
vi.mock('../../issues/dependency-routes.js', () => ({
  detectCycle: vi.fn(async () => null),
}));

// ISS-138 (PR-D) — the tool now calls `decomposeParent` after a successful
// `decomposes` edge insert. The helper has its own DB shape so we mock it
// at the module boundary; the helper's own tests cover its internals.
const decomposeSpy = vi.fn(async () => ({
  parentId: 'parent',
  childIds: ['child'],
  integrationBranch: 'iss-1-foo',
  createdEdges: 0,
}));
vi.mock('../../issues/decompose.js', () => ({
  decomposeParent: decomposeSpy,
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

const ctx = {
  principal: { kind: 'device' as const, device: fakeDevice },
  device: fakeDevice,
  projectSlug: null,
};

// ISS-131 — gate relaxed from `assertPmActor` to `assertDeviceOwnerIsMember`.
// The member-only check does ONE select on `projects.ownerId`; when the device
// owns the project that short-circuits as both member + admin without a
// `projectMembers` lookup.
function pushMemberOk() {
  queue.push([{ ownerId: OWNER_ID }]);
}

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
  decomposeSpy.mockClear();
});

describe('forge_pm.set_dependency', () => {
  it('rejects self-edge', async () => {
    const tool = forgePmSetDependencyTool(ctx);
    pushMemberOk();
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
    const tool = forgePmSetDependencyTool(ctx);
    pushMemberOk();
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
    const tool = forgePmSetDependencyTool(ctx);
    pushMemberOk();
    queue.push([
      { id: FROM_ID, projectId: PROJECT_ID },
      { id: TO_ID, projectId: PROJECT_ID },
    ]);
    // detectCycle is module-mocked to return null — does NOT consume the
    // queue, so we go straight to insert.
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
    const tool = forgePmSetDependencyTool(ctx);
    pushMemberOk();
    queue.push([
      { id: FROM_ID, projectId: PROJECT_ID },
      { id: TO_ID, projectId: PROJECT_ID },
    ]);
    // detectCycle is module-mocked to return null — does NOT consume the queue.
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

  // ISS-131 — explicit guardrail. Before the gate relaxation the tool also
  // required `runners.capabilities.pm=true` which a plan-pipeline agent
  // (claude-code runner without the PM flag) never has. Now the tool runs
  // for any device whose owner is a member of the project: the projects
  // lookup hits the device's `ownerId` and short-circuits as member+admin
  // without ever inspecting the `runners` table.
  it('admits a non-PM device that owns the project (ISS-131 gate relaxation)', async () => {
    const tool = forgePmSetDependencyTool(ctx);
    // Queue ONLY the project-owner lookup — no runner-capabilities row, which
    // would have been needed under the old `assertPmActor` path.
    pushMemberOk();
    queue.push([
      { id: FROM_ID, projectId: PROJECT_ID },
      { id: TO_ID, projectId: PROJECT_ID },
    ]);
    queue.push([{ id: EDGE_ID }]);

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'blocks',
    })) as { id: string; created: boolean };

    expect(result.created).toBe(true);
    expect(result.id).toBe(EDGE_ID);
  });

  // ISS-138 (PR-D) — decomposes-edge inserts trigger the integration-branch
  // helper. Blocks edges and opt-out callers must not.
  it('calls decomposeParent after a fresh decomposes edge insert', async () => {
    const tool = forgePmSetDependencyTool(ctx);
    pushMemberOk();
    queue.push([
      { id: FROM_ID, projectId: PROJECT_ID },
      { id: TO_ID, projectId: PROJECT_ID },
    ]);
    queue.push([{ id: EDGE_ID }]);

    await tool.handler({
      projectId: PROJECT_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'decomposes',
    });

    expect(decomposeSpy).toHaveBeenCalledTimes(1);
    expect(decomposeSpy).toHaveBeenCalledWith(
      FROM_ID,
      [{ existingIssueId: TO_ID }],
      { userId: OWNER_ID },
      { useIntegrationBranch: undefined },
    );
  });

  it('skips decomposeParent when decomposeOpts.useIntegrationBranch is false', async () => {
    const tool = forgePmSetDependencyTool(ctx);
    pushMemberOk();
    queue.push([
      { id: FROM_ID, projectId: PROJECT_ID },
      { id: TO_ID, projectId: PROJECT_ID },
    ]);
    queue.push([{ id: EDGE_ID }]);

    await tool.handler({
      projectId: PROJECT_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'decomposes',
      decomposeOpts: { useIntegrationBranch: false },
    });

    expect(decomposeSpy).not.toHaveBeenCalled();
  });

  it('does not call decomposeParent for non-decomposes edges', async () => {
    const tool = forgePmSetDependencyTool(ctx);
    pushMemberOk();
    queue.push([
      { id: FROM_ID, projectId: PROJECT_ID },
      { id: TO_ID, projectId: PROJECT_ID },
    ]);
    queue.push([{ id: EDGE_ID }]);

    await tool.handler({
      projectId: PROJECT_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'blocks',
    });

    expect(decomposeSpy).not.toHaveBeenCalled();
  });

  // Sanity check: a device whose owner is neither the project owner nor a
  // member row must still be rejected. This is the FORBIDDEN branch in
  // `loadDeviceProjectRole` → `assertDeviceOwnerIsMember`.
  it('rejects a device whose owner is not a project member', async () => {
    const tool = forgePmSetDependencyTool(ctx);
    // Project exists but is owned by a stranger; no projectMembers row.
    queue.push([{ ownerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }]);
    queue.push([]); // projectMembers lookup returns nothing

    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        fromIssueId: FROM_ID,
        toIssueId: TO_ID,
        kind: 'blocks',
      }),
    ).rejects.toThrow(/FORBIDDEN/);
  });
});
