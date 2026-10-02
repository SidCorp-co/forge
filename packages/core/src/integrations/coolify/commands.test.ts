// ISS-1211 — a release deploy Forge performs is refused for a run whose
// recording half has not been reached, before the dispatch rather than after.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const tryDispatchCoolifyRelease = vi.fn(async () => ({
  dispatched: true,
  pendingHumanConfirm: false,
  integrationIds: ['binding-1'],
}));
const isOpenReleaseBatchRun = vi.fn(async () => true);
const readRunMethod = vi.fn(async () => null as unknown);
const assertApprovalAllowsAttempt = vi.fn(async (_runId: string, _projectId: string) => {});
const approvalRequired = vi.fn(async (_projectId: string) => false);
const isIssueAtReleaseStage = vi.fn(async (_issueId: string) => false);
const resolveLatestIssueRunId = vi.fn(async (_issueId: string) => 'run-of-issue' as string | null);

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: TEST_SECRET,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/test',
    DEVICE_TOKEN_PEPPER: TEST_SECRET,
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../pipeline/release-coolify.js', () => ({
  tryDispatchCoolifyRelease: (...a: unknown[]) => tryDispatchCoolifyRelease(...(a as [])),
  dispatchCoolifyDeployDirect: vi.fn(),
  isIssueAtReleaseStage: (id: string) => isIssueAtReleaseStage(id),
  resolveLatestIssueRunId: (id: string) => resolveLatestIssueRunId(id),
}));
vi.mock('../../release-batch/approvals.js', () => ({
  assertApprovalAllowsAttempt: (r: string, p: string) => assertApprovalAllowsAttempt(r, p),
  approvalRequired: (p: string) => approvalRequired(p),
}));
vi.mock('../../release-batch/service.js', () => ({
  isOpenReleaseBatchRun: (...a: unknown[]) => isOpenReleaseBatchRun(...(a as [])),
}));
vi.mock('../../release-batch/method.js', () => ({
  readRunMethod: (...a: unknown[]) => readRunMethod(...(a as [])),
}));

const { runCoolifyDeploy, CoolifyCommandError } = await import('./commands.js');

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  isOpenReleaseBatchRun.mockResolvedValue(true);
  approvalRequired.mockResolvedValue(false);
  isIssueAtReleaseStage.mockResolvedValue(false);
});

describe('runCoolifyDeploy on a release run', () => {
  // ISS-1276 — what this refuses is a run that has recorded NOTHING, which is what it always
  // measured; only its name said otherwise. The skill gate it read as went with `assertMethodFor`.
  it('refuses a run that has recorded nothing, and dispatches nothing', async () => {
    readRunMethod.mockResolvedValue(null);

    const out = runCoolifyDeploy({ projectId: PROJECT_ID, pipelineRunId: RUN_ID });

    await expect(out).rejects.toBeInstanceOf(CoolifyCommandError);
    await expect(out).rejects.toThrow(
      /^RELEASE_NOTHING_RECORDED: .*forge_release_batch.*action=method/,
    );
    expect(readRunMethod).toHaveBeenCalledWith(RUN_ID);
    expect(tryDispatchCoolifyRelease).not.toHaveBeenCalled();
  });

  it('dispatches for a run whose announcement says its method would not load', async () => {
    readRunMethod.mockResolvedValue({
      skill: 'release-flow',
      loaded: false,
      detail: 'the plugin is not installed on this box',
      announcedAt: '2026-09-26T00:00:00.000Z',
    });

    await runCoolifyDeploy({ projectId: PROJECT_ID, pipelineRunId: RUN_ID });

    expect(tryDispatchCoolifyRelease).toHaveBeenCalled();
  });

  it('reaches the release dispatch for a run that announced its method', async () => {
    readRunMethod.mockResolvedValue({
      skill: 'release-flow',
      loaded: true,
      detail: null,
      announcedAt: '2026-09-24T00:00:00.000Z',
    });

    const out = await runCoolifyDeploy({ projectId: PROJECT_ID, pipelineRunId: RUN_ID });

    expect(out.dispatched).toBe(true);
    expect(tryDispatchCoolifyRelease).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, runId: RUN_ID, allowLive: true }),
    );
  });

  it('asks nothing about a method for a run that is not an open release batch', async () => {
    isOpenReleaseBatchRun.mockResolvedValue(false);

    await expect(
      runCoolifyDeploy({ projectId: PROJECT_ID, pipelineRunId: RUN_ID }),
    ).rejects.toThrow('pipelineRunId is not an open release-batch run for this project');
    expect(readRunMethod).not.toHaveBeenCalled();
  });
});

describe('runCoolifyDeploy on a project that requires release approval', () => {
  it('refuses a release run approval does not allow, by the code the approval check names', async () => {
    readRunMethod.mockResolvedValue({
      skill: 'release-flow',
      loaded: true,
      detail: null,
      announcedAt: 'x',
    });
    const { HTTPException } = await import('hono/http-exception');
    assertApprovalAllowsAttempt.mockRejectedValueOnce(
      new HTTPException(409, {
        message: 'no approval',
        cause: { code: 'RELEASE_APPROVAL_REQUIRED' },
      }),
    );
    await expect(
      runCoolifyDeploy({ projectId: PROJECT_ID, pipelineRunId: RUN_ID }),
    ).rejects.toThrow(/^RELEASE_APPROVAL_REQUIRED: no approval$/);
    expect(assertApprovalAllowsAttempt).toHaveBeenCalledWith(RUN_ID, PROJECT_ID);
    expect(tryDispatchCoolifyRelease).not.toHaveBeenCalled();
  });

  it('refuses an issue at its release stage, which would reach production outside a batch', async () => {
    approvalRequired.mockResolvedValue(true);
    isIssueAtReleaseStage.mockResolvedValue(true);
    await expect(runCoolifyDeploy({ projectId: PROJECT_ID, issueId: 'issue-1' })).rejects.toThrow(
      /^RELEASE_APPROVAL_REQUIRED: /,
    );
    expect(tryDispatchCoolifyRelease).not.toHaveBeenCalled();
  });

  it('still deploys an issue before its release stage, which reaches no live binding', async () => {
    approvalRequired.mockResolvedValue(true);
    await runCoolifyDeploy({ projectId: PROJECT_ID, issueId: 'issue-1' });
    expect(tryDispatchCoolifyRelease).toHaveBeenCalledWith(
      expect.objectContaining({ allowLive: false }),
    );
  });
});
