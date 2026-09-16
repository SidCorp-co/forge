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
chain.where = () => chain;
chain.orderBy = () => chain;
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
  },
}));

vi.mock('../../issues/cycle-detect.js', () => ({
  detectCycle: vi.fn(async () => null),
}));

const publishHealthSpy = vi.fn(async (_projectId: string, _ids: string[]) => undefined);
vi.mock('../../issues/pipeline-health.js', () => ({
  publishPipelineHealthChanged: (projectId: string, ids: string[]) =>
    publishHealthSpy(projectId, ids),
}));

const { detectCycle } = await import('../../issues/cycle-detect.js');
const { forgePmSetDependencyTool, pmSetDependencyHandler } = await import(
  './forge-pm-set-dependency.js'
);
const { hooks } = await import('../../pipeline/hooks.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const FROM_ID = '22222222-2222-4222-8222-222222222222';
const TO_ID = '33333333-3333-4333-8333-333333333333';
const EDGE_ID = '66666666-6666-4666-8666-666666666666';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

const fakePrincipal = makeFakePrincipal(DEVICE_ID, OWNER_ID);

const ctx = {
  principal: fakePrincipal,
  projectSlug: null,
};

function pushMemberOk() {
  queue.push([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
}

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
  publishHealthSpy.mockClear();
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
    queue.push([{ id: EDGE_ID }]);

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
    queue.push([]);
    queue.push([{ id: EDGE_ID }]);

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

  it('a decomposes edge reports the work-evidence waiver it just applied', async () => {
    const tool = forgePmSetDependencyTool(ctx);
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
      kind: 'decomposes',
    })) as {
      created: boolean;
      effects: { gatesDispatch: boolean; waivesWorkEvidence: boolean; note: string };
    };

    expect(result.created).toBe(true);
    expect(result.effects.waivesWorkEvidence).toBe(true);
    expect(result.effects.gatesDispatch).toBe(false);
    expect(result.effects.note).toContain('work-evidence gate');
  });

  it('a blocks edge reports dispatch gating and no waiver', async () => {
    const tool = forgePmSetDependencyTool(ctx);
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
    })) as { effects: { gatesDispatch: boolean; waivesWorkEvidence: boolean } };

    expect(result.effects.gatesDispatch).toBe(true);
    expect(result.effects.waivesWorkEvidence).toBe(false);
  });

  it('admits a project owner with no PM capability (ISS-131 gate relaxation)', async () => {
    const tool = forgePmSetDependencyTool(ctx);
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

  it('rejects a caller who is not a project member', async () => {
    const tool = forgePmSetDependencyTool(ctx);
    queue.push([{ ownerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }]);
    queue.push([]);

    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        fromIssueId: FROM_ID,
        toIssueId: TO_ID,
        kind: 'blocks',
      }),
    ).rejects.toThrow(/NOT_FOUND/);
  });
});

describe('forge_pm.set_dependency — retracting an existing edge', () => {
  it('applies validUntil on conflict and emits dependencyChanged so the gated side can dispatch', async () => {
    const tool = forgePmSetDependencyTool(ctx);
    pushMemberOk();
    queue.push([
      { id: FROM_ID, projectId: PROJECT_ID },
      { id: TO_ID, projectId: PROJECT_ID },
    ]);
    queue.push([]);
    queue.push([{ id: EDGE_ID }]);
    queue.push([]);

    hooks.reset();
    const depSpy = vi.fn();
    hooks.on('dependencyChanged', (p) => depSpy(p));

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'blocks',
      validUntil: '2020-01-01T00:00:00Z',
    })) as { id: string; created: boolean; updated: boolean };

    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);
    expect(depSpy).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      edgeId: EDGE_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'blocks',
    });
  });

  it('does not run the cycle walk for a retraction, so a loop that exists can be undone', async () => {
    const tool = forgePmSetDependencyTool(ctx);
    const cycleWalk = vi.mocked(detectCycle);
    cycleWalk.mockResolvedValue('cycle');
    pushMemberOk();
    queue.push([
      { id: FROM_ID, projectId: PROJECT_ID },
      { id: TO_ID, projectId: PROJECT_ID },
    ]);
    queue.push([]);
    queue.push([{ id: EDGE_ID }]);
    queue.push([]);

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      fromIssueId: FROM_ID,
      toIssueId: TO_ID,
      kind: 'blocks',
      validUntil: '2020-01-01T00:00:00Z',
    })) as { id: string; updated: boolean };

    expect(result.updated).toBe(true);
    expect(cycleWalk).not.toHaveBeenCalled();
    cycleWalk.mockResolvedValue(null);
  });

  it('still refuses a live edge that closes a loop, expiry in the FUTURE included', async () => {
    const tool = forgePmSetDependencyTool(ctx);
    vi.mocked(detectCycle).mockResolvedValue('cycle');
    pushMemberOk();
    queue.push([
      { id: FROM_ID, projectId: PROJECT_ID },
      { id: TO_ID, projectId: PROJECT_ID },
    ]);

    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        fromIssueId: FROM_ID,
        toIssueId: TO_ID,
        kind: 'blocks',
        validUntil: '2099-01-01T00:00:00Z',
      }),
    ).rejects.toThrow(/CYCLE_DETECTED/);
    vi.mocked(detectCycle).mockResolvedValue(null);
  });
});

describe('forge_pm.set_dependency — deferHealthPublish', () => {
  function queueFreshBlocksInsert() {
    pushMemberOk();
    queue.push([
      { id: FROM_ID, projectId: PROJECT_ID },
      { id: TO_ID, projectId: PROJECT_ID },
    ]);
    queue.push([{ id: EDGE_ID }]);
  }

  const input = {
    projectId: PROJECT_ID,
    fromIssueId: FROM_ID,
    toIssueId: TO_ID,
    kind: 'blocks' as const,
  };

  it('publishes the health refresh when the caller does not defer', async () => {
    queueFreshBlocksInsert();
    const result = await pmSetDependencyHandler(fakePrincipal, input);
    expect(result.created).toBe(true);
    expect(publishHealthSpy).toHaveBeenCalledWith(PROJECT_ID, [TO_ID]);
  });

  it('writes the edge and emits dependencyChanged but skips the publish when deferred', async () => {
    queueFreshBlocksInsert();
    hooks.reset();
    const depSpy = vi.fn();
    hooks.on('dependencyChanged', (p) => depSpy(p));

    const result = await pmSetDependencyHandler(fakePrincipal, input, {
      deferHealthPublish: true,
    });

    expect(result.created).toBe(true);
    expect(depSpy).toHaveBeenCalledTimes(1);
    expect(publishHealthSpy).not.toHaveBeenCalled();
  });
});
