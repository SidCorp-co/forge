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
  isIssueAtReleaseStage: vi.fn(),
  resolveLatestIssueRunId: vi.fn(),
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
