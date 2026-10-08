/**
 * The refusals `forge_release_batch` gives a release run, unit level (ISS-1211).
 *
 * The integration suite drives the tool over `/mcp` on a real workspace credential; this one
 * plants the service errors that suite cannot reach cheaply and reads what the run is told.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const acceptFinish = vi.fn();
const lookAtBatch = vi.fn();
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
vi.mock('../../release-batch/finish-job.js', () => ({
  acceptReleaseBatchFinish: (...a: unknown[]) => acceptFinish(...a),
}));
vi.mock('../../release-batch/look.js', () => ({
  lookAtBatch: (...a: unknown[]) => lookAtBatch(...a),
}));
vi.mock('../../release-batch/service.js', async () => {
  const errors = await import('../../release-batch/errors.js');
  return {
    ...errors,
    abortReleaseBatch: vi.fn(),
    findReleaseBatchRun: vi.fn(async () => ({ id: RUN_ID, projectId: 'p-1' })),
    loadReleaseBatchContext: vi.fn(),
  };
});

const RUN_ID = '44444444-4444-4444-8444-444444444444';

const { forgeReleaseBatchTool } = await import('./forge-release-batch.js');
const { makeFakePrincipal } = await import('../fake-principal.fixture.js');
const {
  ReleaseBatchAbortedError,
  ReleaseFinishedForOtherCommitError,
  ReleaseFinishInFlightError,
  ReleaseNothingToReadError,
  ReleaseNotVerifiedError,
  ReleaseProbesUnreadableError,
  ReleaseRunClosedError,
  ReleaseVersionMissingError,
} = await import('../../release-batch/errors.js');

function tool(scopes: string[] = ['read', 'write']) {
  return forgeReleaseBatchTool({
    principal: makeFakePrincipal('t-1', 'u-1', { scopes }),
    projectSlug: null,
  });
}

beforeEach(() => vi.clearAllMocks());

describe('forge_release_batch refusals', () => {
  it('says an aborted batch has nothing left to finish, in the account the REST door gives', async () => {
    acceptFinish.mockRejectedValue(new ReleaseBatchAbortedError('released', 'p-1'));

    await expect(tool().handler({ action: 'finish', runId: RUN_ID })).rejects.toThrow(
      /^RELEASE_BATCH_ABORTED: This batch was aborted.*its claims were released/,
    );
  });

  it('says a promoted roster the abort held stays at releasing, claimed', async () => {
    acceptFinish.mockRejectedValue(new ReleaseBatchAbortedError('held', 'p-1'));

    const refused = tool().handler({ action: 'finish', runId: RUN_ID });

    await expect(refused).rejects.toThrow(/the abort kept its claims.*stay at `releasing`/);
    await expect(refused).rejects.not.toThrow(/claims were released/);
  });

  it('names the issues a finish closed before the abort, in the sentence and the details', async () => {
    acceptFinish.mockRejectedValue(
      new ReleaseBatchAbortedError('released', 'p-1', ['i-1'], new Map([['i-1', 'ISS-41']])),
    );

    const refused = tool().handler({ action: 'finish', runId: RUN_ID });

    await expect(refused).rejects.toThrow(/closed ISS-41 before the abort, and it stays closed/);
    await expect(refused).rejects.toThrow(/"closed":\["i-1"\]/);
  });

  it('carries a missing version under its own code', async () => {
    acceptFinish.mockRejectedValue(new ReleaseVersionMissingError(RUN_ID));

    const refused = tool().handler({ action: 'finish', runId: RUN_ID });
    await expect(refused).rejects.toThrow(/^RELEASE_VERSION_MISSING: Release run /);
    await expect(refused).rejects.not.toThrow(
      /RELEASE_VERSION_MISSING[\s\S]*RELEASE_VERSION_MISSING/,
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
      { action: 'look' },
      { action: 'finish' },
      { action: 'abort' },
    ]) {
      await expect(tool(['read']).handler({ ...args, runId: RUN_ID })).rejects.toThrow(
        /^RELEASE_CREDENTIAL_CANNOT_RECORD: /,
      );
    }
    expect(acceptFinish).not.toHaveBeenCalled();
    expect(lookAtBatch).not.toHaveBeenCalled();
    expect(announceMethod).not.toHaveBeenCalled();
  });

  it('refuses an argument the tool does not take, rather than ignoring it', async () => {
    await expect(tool().handler({ action: 'finish', runId: RUN_ID, force: true })).rejects.toThrow(
      /force/,
    );
    expect(acceptFinish).not.toHaveBeenCalled();
  });
});

describe('forge_release_batch finish answers the attempt, not the outcome (ISS-1190)', () => {
  it('returns the finish record the door took', async () => {
    const finish = { requestId: 'r-1', state: 'accepted', commit: null };
    acceptFinish.mockResolvedValue({ runId: RUN_ID, finish, started: true });

    await expect(tool().handler({ action: 'finish', runId: RUN_ID })).resolves.toEqual({
      runId: RUN_ID,
      finish,
    });
  });

  it('names the commit already in flight when another is claimed', async () => {
    const inFlight = 'a'.repeat(40);
    acceptFinish.mockRejectedValue(
      new ReleaseFinishInFlightError('r-1', inFlight, 'b'.repeat(40), {
        projectId: 'p-1',
        runId: RUN_ID,
      }),
    );

    const refused = tool().handler({ action: 'finish', runId: RUN_ID });

    await expect(refused).rejects.toThrow(
      new RegExp(`^RELEASE_FINISH_IN_FLIGHT: a finish for ${inFlight} is already running`),
    );
    await expect(refused).rejects.toThrow(
      new RegExp(`Read it with forge_release_batch action=state runId=${RUN_ID}:`),
    );
    await expect(refused).rejects.not.toThrow(/GET \/api|\{projectId\}/);
  });

  it('names the commit a finished batch verified when another is claimed', async () => {
    const finished = 'a'.repeat(40);
    acceptFinish.mockRejectedValue(
      new ReleaseFinishedForOtherCommitError('r-1', finished, 'b'.repeat(40), {
        projectId: 'p-1',
        runId: RUN_ID,
      }),
    );

    const refused = tool().handler({ action: 'finish', runId: RUN_ID, commit: 'b'.repeat(40) });

    await expect(refused).rejects.toThrow(
      new RegExp(`^RELEASE_FINISHED_FOR_OTHER_COMMIT: This batch already finished for ${finished}`),
    );
    await expect(refused).rejects.toThrow(
      new RegExp(`with forge_release_batch action=state runId=${RUN_ID}\\.`),
    );
    await expect(refused).rejects.not.toThrow(/GET \/api/);
  });
});

describe('forge_release_batch look is the agent’s act, and Forge takes the reading (ISS-1282)', () => {
  const NEW = 'b'.repeat(40);

  it('hands the run, the credential’s user and the commit to the one place a look is taken', async () => {
    const answer = {
      reading: { id: 'r-1' },
      judgement: { closable: false, reason: 'x', live: null },
    };
    lookAtBatch.mockResolvedValue(answer);

    await expect(tool().handler({ action: 'look', runId: RUN_ID, commit: NEW })).resolves.toBe(
      answer,
    );

    expect(lookAtBatch).toHaveBeenCalledWith({ runId: RUN_ID, takenBy: 'u-1', commit: NEW });
  });

  it('takes a look naming no commit', async () => {
    lookAtBatch.mockResolvedValue({});

    await tool().handler({ action: 'look', runId: RUN_ID });

    expect(lookAtBatch).toHaveBeenCalledWith({ runId: RUN_ID, takenBy: 'u-1', commit: undefined });
  });

  it('refuses a look where nothing declares a probe, saying finish records it unverified', async () => {
    lookAtBatch.mockRejectedValue(new ReleaseNothingToReadError());

    await expect(tool().handler({ action: 'look', runId: RUN_ID })).rejects.toThrow(
      /^RELEASE_NOTHING_TO_READ: No live deploy binding[\s\S]*unverified/,
    );
  });

  it('refuses a look on a batch whose run is over, under its own code', async () => {
    lookAtBatch.mockRejectedValue(new ReleaseRunClosedError('completed'));

    await expect(tool().handler({ action: 'look', runId: RUN_ID })).rejects.toThrow(
      /^RELEASE_RUN_CLOSED: This batch's run is completed/,
    );
  });

  it('refuses a look on an aborted batch in the account the finish gives', async () => {
    lookAtBatch.mockRejectedValue(new ReleaseBatchAbortedError('released', 'p-1'));

    await expect(tool().handler({ action: 'look', runId: RUN_ID })).rejects.toThrow(
      /^RELEASE_BATCH_ABORTED: /,
    );
  });

  it('names a probe declaration Forge cannot read under the code the finish gives it', async () => {
    lookAtBatch.mockRejectedValue(new ReleaseProbesUnreadableError([], ['coolify b-1']));

    await expect(tool().handler({ action: 'look', runId: RUN_ID })).rejects.toThrow(
      /^RELEASE_PROBES_UNREADABLE: [\s\S]*coolify b-1/,
    );
  });

  it('refuses a commit that is not a whole sha under RELEASE_NOT_VERIFIED', async () => {
    lookAtBatch.mockRejectedValue(new ReleaseNotVerifiedError('`abc` is not a whole commit', null));

    await expect(tool().handler({ action: 'look', runId: RUN_ID, commit: 'abc' })).rejects.toThrow(
      /^RELEASE_NOT_VERIFIED: `abc` is not a whole commit/,
    );
  });

  it('lets an error it does not know pass through unchanged rather than naming it a refusal', async () => {
    lookAtBatch.mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(tool().handler({ action: 'look', runId: RUN_ID })).rejects.toThrow(
      'connection terminated unexpectedly',
    );
  });
});

describe('the forge_release_batch description is what a release run reads first (ISS-1282)', () => {
  const description = tool().description;

  it('names look as the agent’s act and the recorded reading as what closes a probed roster', () => {
    expect(description).toMatch(/`look`/);
    expect(description).toMatch(/you decide when and how often/i);
    expect(description).toMatch(/closed only on recorded readings/i);
  });

  it('says what happens where no binding declares a probe, rather than leaving look to be tried', () => {
    expect(description).toMatch(
      /where no live binding declares a probe it closes the roster unverified/,
    );
  });

  it('describes no window, timer or second finish after a failed one', () => {
    expect(description).not.toMatch(/\bwindow\b|\btimer\b|five minutes|starts a new attempt/i);
  });
});
