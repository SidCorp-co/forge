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
chain.innerJoin = () => chain;
chain.values = () => chain;
chain.returning = () => chain;
chain.onConflictDoNothing = () => chain;
chain.set = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) => Promise.resolve(queue.shift()).then(resolve, reject);

const insertSpy = vi.fn(() => chain);

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => chain),
    insert: insertSpy,
  },
}));

const enqueueJobSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../jobs/enqueue.js', () => ({
  enqueueJob: enqueueJobSpy,
}));

// ISS-101 — pipeline_run lookups are stubbed so the chainable db mock above
// doesn't need to know about the SELECT/INSERT pair on `pipeline_runs`.
vi.mock('../../pipeline/runs.js', () => ({
  openIssueRun: vi.fn().mockResolvedValue({ id: 'run-1', startedAt: new Date() }),
  openOneShotRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
  closeRun: vi.fn().mockResolvedValue(undefined),
  closeRunIfOneShot: vi.fn().mockResolvedValue(undefined),
  closeOpenRunForIssue: vi.fn().mockResolvedValue(undefined),
  setCurrentStep: vi.fn().mockResolvedValue(undefined),
  setCurrentStepForOpenIssueRun: vi.fn().mockResolvedValue(undefined),
}));

const { forgePmDispatchTool } = await import('./forge-pm-dispatch.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '99999999-9999-4999-8999-999999999999';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
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

function pushPmActorOk() {
  queue.push([{ ownerId: OWNER_ID }]); // assertDeviceOwnerIsMember: project (owner)
  queue.push([{ capabilities: { pm: true } }]); // runner row
}

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
  enqueueJobSpy.mockResolvedValue(undefined);
});

describe('forge_pm.dispatch', () => {
  it('rejects when device has no claude-code runner', async () => {
    const tool = forgePmDispatchTool(ctx);
    queue.push([{ ownerId: OWNER_ID }]); // assertMember
    queue.push([]); // no runner
    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        jobType: 'code',
        reason: 'go',
      }),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it('rejects when capabilities.pm is not true', async () => {
    const tool = forgePmDispatchTool(ctx);
    queue.push([{ ownerId: OWNER_ID }]);
    queue.push([{ capabilities: { pm: false } }]);
    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        jobType: 'code',
        reason: 'go',
      }),
    ).rejects.toThrow(/capabilities\.pm/);
  });

  it('rejects unknown jobType (pm)', async () => {
    const tool = forgePmDispatchTool(ctx);
    pushPmActorOk();
    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        jobType: 'pm',
        reason: 'go',
      }),
    ).rejects.toThrow(/not dispatchable/);
  });

  it('rejects cross-project issue', async () => {
    const tool = forgePmDispatchTool(ctx);
    pushPmActorOk();
    queue.push([{ projectId: OTHER_PROJECT_ID }]); // issue
    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        jobType: 'code',
        reason: 'go',
      }),
    ).rejects.toThrow(/different project/);
  });

  it('happy path inserts a job + enqueues', async () => {
    const tool = forgePmDispatchTool(ctx);
    pushPmActorOk();
    queue.push([{ projectId: PROJECT_ID }]); // issue
    queue.push([{ agentConfig: { pipelineConfig: { states: {} } } }]); // states lookup
    queue.push([{ stage: 'approved', name: 'forge-code' }]); // skill resolver rows
    queue.push([{ id: JOB_ID }]); // jobs insert returning
    queue.push([{ id: 'run-1', status: 'running' }]); // ISS-102 pipeline_run lookup

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      jobType: 'code',
      reason: 'rerun after fix',
    })) as {
      ok: boolean;
      jobId: string;
      jobType: string;
      pipelineRun: { id: string; status: string } | null;
    };

    expect(result.ok).toBe(true);
    expect(result.jobId).toBe(JOB_ID);
    expect(result.jobType).toBe('code');
    expect(enqueueJobSpy).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_ID }));
    expect(result.pipelineRun).toEqual({ id: 'run-1', status: 'running' });
  });

  it('rejects when the stage is configured as manual-only (ISS-108)', async () => {
    const tool = forgePmDispatchTool(ctx);
    pushPmActorOk();
    queue.push([{ projectId: PROJECT_ID }]); // issue
    queue.push([
      {
        agentConfig: {
          pipelineConfig: { states: { clarified: { enabled: true, mode: 'manual' } } },
        },
      },
    ]);

    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        jobType: 'plan',
        reason: 'go',
      }),
    ).rejects.toThrow(/FORBIDDEN.*STAGE_MANUAL_ONLY/);
  });

  it('rejects when no skill_registration exists for the project (ISS-108)', async () => {
    const tool = forgePmDispatchTool(ctx);
    pushPmActorOk();
    queue.push([{ projectId: PROJECT_ID }]); // issue
    queue.push([{ agentConfig: { pipelineConfig: { states: {} } } }]);
    queue.push([]); // no registrations

    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        jobType: 'code',
        reason: 'go',
      }),
    ).rejects.toThrow(/NOT_FOUND.*skill_registration/);
  });

  it('returns pipelineRun=null when the parent run vanished after dispatch', async () => {
    const tool = forgePmDispatchTool(ctx);
    pushPmActorOk();
    queue.push([{ projectId: PROJECT_ID }]);
    queue.push([{ agentConfig: { pipelineConfig: { states: {} } } }]);
    queue.push([{ stage: 'approved', name: 'forge-code' }]);
    queue.push([{ id: JOB_ID }]);
    queue.push([]); // pipeline_runs lookup returns nothing — defensive path

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      jobType: 'code',
      reason: 'go',
    })) as { ok: boolean; pipelineRun: unknown };

    expect(result.ok).toBe(true);
    expect(result.pipelineRun).toBeNull();
  });

  it('returns already_active on unique-violation', async () => {
    const tool = forgePmDispatchTool(ctx);
    pushPmActorOk();
    queue.push([{ projectId: PROJECT_ID }]); // issue
    queue.push([{ agentConfig: { pipelineConfig: { states: {} } } }]);
    queue.push([{ stage: 'approved', name: 'forge-code' }]);
    // jobs insert throws 23505
    insertSpy.mockReturnValueOnce({
      values: () => ({
        returning: () => Promise.reject(Object.assign(new Error('dup'), { code: '23505' })),
      }),
      // biome-ignore lint/suspicious/noExplicitAny: partial chain
    } as any);
    queue.push([{ id: JOB_ID }]); // existing-job lookup

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      jobType: 'code',
      reason: 'go',
    })) as { ok: boolean; reason: string; jobId: string | null };

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('already_active');
    expect(result.jobId).toBe(JOB_ID);
    expect(enqueueJobSpy).not.toHaveBeenCalled();
  });
});
