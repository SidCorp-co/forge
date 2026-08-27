import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const publishSpy = vi.fn(async (_projectId: string, _ids: string[]) => undefined);
vi.mock('../../issues/pipeline-health.js', () => ({
  publishPipelineHealthChanged: (projectId: string, ids: string[]) => publishSpy(projectId, ids),
}));

let inFlight = 0;
let sawOverlap = false;
const pmSpy = vi.fn(
  async (
    _device: unknown,
    input: { toIssueId: string },
    _actor?: unknown,
    opts?: { deferHealthPublish?: boolean },
  ) => {
    if (inFlight > 0) sawOverlap = true;
    inFlight++;
    // cm:guard the suspension here must be a REAL one (a timer, not `await Promise.resolve()`) — a microtask-only await resolves before any sibling iteration can start, so `sawOverlap` stays false even under `Promise.all` and the test green-lights the exact refactor the guard in issue-relations.ts forbids
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    void opts;
    return { id: `edge-${input.toIssueId}`, created: true, updated: false };
  },
);
vi.mock('./forge-pm-set-dependency.js', () => ({
  pmSetDependencyHandler: (
    device: unknown,
    input: { toIssueId: string },
    actor?: unknown,
    opts?: { deferHealthPublish?: boolean },
  ) => pmSpy(device, input, actor, opts),
}));

const { applyIssueRelations } = await import('./issue-relations.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const BLOCKER_A = '33333333-3333-4333-8333-333333333333';
const BLOCKER_B = '44444444-4444-4444-8444-444444444444';
const BLOCKED_C = '55555555-5555-4555-8555-555555555555';

const fakeDevice = {
  id: '66666666-6666-4666-8666-666666666666',
  ownerId: '77777777-7777-4777-8777-777777777777',
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
  publishSpy.mockClear();
  pmSpy.mockClear();
  inFlight = 0;
  sawOverlap = false;
});

describe('applyIssueRelations — health publish is batched, never per edge', () => {
  it('defers every per-edge publish and publishes ONCE for the whole array', async () => {
    const applied = await applyIssueRelations(ctx, PROJECT_ID, ISSUE_ID, [
      { kind: 'blocks', dependsOnId: BLOCKER_A },
      { kind: 'blocks', dependsOnId: BLOCKER_B },
      { kind: 'blocks', blocksId: BLOCKED_C },
    ]);

    expect(applied).toHaveLength(3);
    expect(pmSpy).toHaveBeenCalledTimes(3);
    for (const call of pmSpy.mock.calls) {
      expect(call[3]).toEqual({ deferHealthPublish: true });
    }
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [projectId, ids] = publishSpy.mock.calls[0] as unknown as [string, string[]];
    expect(projectId).toBe(PROJECT_ID);
    expect([...ids].sort()).toEqual([ISSUE_ID, ISSUE_ID, BLOCKED_C].sort());
  });

  it('runs the edges sequentially so detectCycle sees the previous insert', async () => {
    await applyIssueRelations(ctx, PROJECT_ID, ISSUE_ID, [
      { kind: 'blocks', dependsOnId: BLOCKER_A },
      { kind: 'blocks', dependsOnId: BLOCKER_B },
    ]);
    expect(sawOverlap).toBe(false);
  });

  it('publishes nothing when no blocks edge landed', async () => {
    await applyIssueRelations(ctx, PROJECT_ID, ISSUE_ID, [
      { kind: 'relates', dependsOnId: BLOCKER_A },
    ]);
    expect(pmSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('publishes nothing for an empty or absent relations array', async () => {
    expect(await applyIssueRelations(ctx, PROJECT_ID, ISSUE_ID, [])).toEqual([]);
    expect(await applyIssueRelations(ctx, PROJECT_ID, ISSUE_ID, undefined)).toEqual([]);
    expect(pmSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('rejects a relation naming both sides, before any edge is written', async () => {
    await expect(
      applyIssueRelations(ctx, PROJECT_ID, ISSUE_ID, [
        { kind: 'blocks', dependsOnId: BLOCKER_A, blocksId: BLOCKED_C },
      ]),
    ).rejects.toThrow(/exactly one of dependsOnId or blocksId/);
    expect(pmSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });
});
