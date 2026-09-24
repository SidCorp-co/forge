/**
 * The refusals `forge_release_batch` gives a release run, unit level (ISS-1211).
 *
 * The integration suite drives the tool over `/mcp` on a real workspace credential; this one
 * plants the service errors that suite cannot reach cheaply and reads what the run is told.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const finishReleaseBatch = vi.fn();
const announceMethod = vi.fn(async (a: unknown) => a);

vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('./lib.js', async (importActual) => ({
  ...(await importActual<typeof import('./lib.js')>()),
  assertPrincipalIsWriter: vi.fn(async () => undefined),
  resolveEffectiveProjectId: vi.fn(async (_c: unknown, id: string | null) => id ?? 'p-1'),
}));
vi.mock('../../release-batch/state.js', () => ({ readReleaseRunState: vi.fn() }));
vi.mock('../../release-batch/method.js', async (importActual) => ({
  ...(await importActual<typeof import('../../release-batch/method.js')>()),
  announceMethod: (a: unknown) => announceMethod(a),
}));
vi.mock('../../release-batch/service.js', async () => {
  const errors = await import('../../release-batch/errors.js');
  return {
    ...errors,
    abortReleaseBatch: vi.fn(),
    findReleaseBatchRun: vi.fn(async () => ({ id: RUN_ID, projectId: 'p-1' })),
    finishReleaseBatch: (...a: unknown[]) => finishReleaseBatch(...a),
    loadReleaseBatchContext: vi.fn(),
  };
});

const RUN_ID = '44444444-4444-4444-8444-444444444444';

const { forgeReleaseBatchTool } = await import('./forge-release-batch.js');
const { makeFakePrincipal } = await import('../fake-principal.fixture.js');
const { MethodMismatchError } = await import('../../release-batch/method.js');
const { ReleaseBatchAbortedError, ReleaseVersionMissingError } = await import(
  '../../release-batch/errors.js'
);

function tool(scopes: string[] = ['read', 'write']) {
  return forgeReleaseBatchTool({
    principal: makeFakePrincipal('t-1', 'u-1', { scopes }),
    projectSlug: null,
  });
}

beforeEach(() => vi.clearAllMocks());

describe('forge_release_batch refusals', () => {
  it('names the method the job expects when the run announced another', async () => {
    finishReleaseBatch.mockRejectedValue(new MethodMismatchError('improvised', 'release-flow'));

    await expect(tool().handler({ action: 'finish', runId: RUN_ID })).rejects.toThrow(
      /^RELEASE_METHOD_MISMATCH: .*`improvised`.*Announce `release-flow` with action=method/,
    );
  });

  it('says an aborted batch has nothing left to finish', async () => {
    finishReleaseBatch.mockRejectedValue(new ReleaseBatchAbortedError());

    await expect(tool().handler({ action: 'finish', runId: RUN_ID })).rejects.toThrow(
      /^RELEASE_BATCH_ABORTED: this batch was aborted/,
    );
  });

  it('carries a missing version under its own code', async () => {
    finishReleaseBatch.mockRejectedValue(new ReleaseVersionMissingError(RUN_ID));

    await expect(tool().handler({ action: 'finish', runId: RUN_ID })).rejects.toThrow(
      /^RELEASE_VERSION_MISSING: /,
    );
  });

  it('refuses a method announcement that does not say whether the skill loaded', async () => {
    await expect(
      tool().handler({ action: 'method', runId: RUN_ID, skill: 'release-flow' }),
    ).rejects.toThrow(/^BAD_REQUEST: method needs `loaded`/);
    expect(announceMethod).not.toHaveBeenCalled();
  });

  it('refuses a read-only token on every action before the service is reached', async () => {
    for (const args of [
      { action: 'get' },
      { action: 'state' },
      { action: 'method', skill: 'release-flow', loaded: true },
      { action: 'finish' },
      { action: 'abort' },
    ]) {
      await expect(tool(['read']).handler({ ...args, runId: RUN_ID })).rejects.toThrow(
        /^RELEASE_CREDENTIAL_CANNOT_RECORD: /,
      );
    }
    expect(finishReleaseBatch).not.toHaveBeenCalled();
    expect(announceMethod).not.toHaveBeenCalled();
  });

  it('refuses an argument the tool does not take, rather than ignoring it', async () => {
    await expect(tool().handler({ action: 'finish', runId: RUN_ID, force: true })).rejects.toThrow(
      /force/,
    );
    expect(finishReleaseBatch).not.toHaveBeenCalled();
  });
});
