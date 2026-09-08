/**
 * ISS-934 — what core does with a box's `runner:sessions` frame.
 *
 * A mirror of another process's state fails in two directions: it accepts a
 * frame from something that is not that process, or it half-understands one
 * from a version it does not know. Both are silent, so both are asserted here.
 */

import { describe, expect, it, vi } from 'vitest';

const applyMock = vi.fn(async (_args: unknown) => {});
vi.mock('./run-ledger.js', () => ({
  applyRunLedgerSnapshot: (args: unknown) => applyMock(args),
}));
vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const { handleRunnerSessions } = await import('./run-ledger-ws.js');

const PROJECT = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';

function run(over: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    projectId: PROJECT,
    sessionId: SESSION,
    masterSessionId: null,
    pid: 4242,
    worktreePath: '/repo/.worktrees/grp-1',
    bootId: 'boot-a',
    incarnation: 'live',
    work: 'runnable',
    blockerKind: null,
    waitingOn: null,
    issues: [{ issueKey: 'ISS-934', leaseReturned: false }],
    ...over,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: the handler takes a `ws` socket; a principal is all it reads
const socket = (principal: unknown) => ({ principal }) as any;

describe('runner:sessions', () => {
  it('stores what a device reported', async () => {
    applyMock.mockClear();
    await handleRunnerSessions(socket({ type: 'device', deviceId: 'dev-1' }), {
      type: 'runner:sessions',
      data: { bootId: 'boot-a', runs: [run()] },
    });
    expect(applyMock).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      entries: [
        {
          runId: 'run-1',
          projectId: PROJECT,
          sessionId: SESSION,
          masterSessionId: null,
          pid: 4242,
          worktreePath: '/repo/.worktrees/grp-1',
          bootId: 'boot-a',
          incarnation: 'live',
          work: 'runnable',
          blockerKind: null,
          waitingOn: null,
          issues: [{ issueKey: 'ISS-934', leaseReturned: false }],
        },
      ],
    });
  });

  it('never stores a snapshot that arrived on a user principal', async () => {
    applyMock.mockClear();
    await handleRunnerSessions(socket({ type: 'user', userId: 'u-1' }), {
      type: 'runner:sessions',
      data: { bootId: 'boot-a', runs: [run()] },
    });
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('refuses the whole snapshot when a run carries a field this version does not know', async () => {
    applyMock.mockClear();
    await handleRunnerSessions(socket({ type: 'device', deviceId: 'dev-1' }), {
      type: 'runner:sessions',
      data: { bootId: 'boot-a', runs: [run({ cursor: 42 })] },
    });
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('refuses a work state outside the three the ledger can hold', async () => {
    applyMock.mockClear();
    await handleRunnerSessions(socket({ type: 'device', deviceId: 'dev-1' }), {
      type: 'runner:sessions',
      data: { bootId: 'boot-a', runs: [run({ work: 'paused' })] },
    });
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('accepts an empty snapshot, which is how a box says it is holding nothing', async () => {
    applyMock.mockClear();
    await handleRunnerSessions(socket({ type: 'device', deviceId: 'dev-1' }), {
      type: 'runner:sessions',
      data: { bootId: 'boot-a', runs: [] },
    });
    expect(applyMock).toHaveBeenCalledWith({ deviceId: 'dev-1', entries: [] });
  });
});
