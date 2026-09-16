import { beforeEach, describe, expect, it, vi } from 'vitest';

const select = vi.fn();
let lookupWhere: unknown;
const applyKernelTransition = vi.fn();
const closeRunIfOneShot = vi.fn();
const returnIssuesForRun = vi.fn();

vi.mock('../db/client.js', () => ({ db: { select: (...a: unknown[]) => select(...a) } }));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../lifecycle/transition.js', () => ({
  applyKernelTransition: (...a: unknown[]) => applyKernelTransition(...a),
}));
vi.mock('../pipeline/runs.js', () => ({
  closeRunIfOneShot: (...a: unknown[]) => closeRunIfOneShot(...a),
  openOneShotRun: vi.fn(),
}));
vi.mock('./run-issue-return.js', () => ({
  returnIssuesForRun: (...a: unknown[]) => returnIssuesForRun(...a),
}));

import { closeRunSession } from './run-session.js';

const ARGS = { deviceId: 'dev-1', sessionId: 'sess-1' };

function sessionRow(row: { status: string; runId: string | null } | null) {
  select.mockReturnValue({
    from: () => ({
      where: async (w: unknown) => {
        lookupWhere = w;
        return row ? [{ status: row.status, runId: row.runId }] : [];
      },
    }),
  });
}

/** Every bound value in the lookup's WHERE, however drizzle nested it. */
function boundValues(node: unknown, out: unknown[] = []): unknown[] {
  if (node === null || typeof node !== 'object') return out;
  const q = node as { queryChunks?: unknown[]; value?: unknown };
  if ('value' in q && !Array.isArray(q.value)) out.push(q.value);
  for (const chunk of q.queryChunks ?? []) boundValues(chunk, out);
  return out;
}

/** The `set` payload the close wrote, as the chokepoint received it. */
function writtenSet() {
  return applyKernelTransition.mock.calls[0]?.[1] as { to: string; set: Record<string, unknown> };
}

beforeEach(() => {
  lookupWhere = undefined;
  select.mockReset();
  applyKernelTransition.mockReset();
  closeRunIfOneShot.mockReset();
  returnIssuesForRun.mockReset();
  applyKernelTransition.mockResolvedValue([{ id: ARGS.sessionId }]);
  returnIssuesForRun.mockResolvedValue([{ issueKey: 'ISS-1', from: 'in_progress', to: 'open' }]);
  closeRunIfOneShot.mockResolvedValue(undefined);
});

describe('closeRunSession', () => {
  it('records a deliberate idle reap as a completion, not a failure', async () => {
    sessionRow({ status: 'running', runId: 'run-1' });

    const closed = await closeRunSession({ ...ARGS, outcome: 'killed_idle' });

    expect(writtenSet().to).toBe('completed');
    expect(writtenSet().set.failureReason).toBeNull();
    expect(closeRunIfOneShot).toHaveBeenCalledWith('run-1', 'completed');
    expect(closed).toEqual({ alreadyTerminal: false, returned: [] });
  });

  it('leaves the issues of a session that ended on its own where the agent put them', async () => {
    sessionRow({ status: 'running', runId: 'run-1' });

    const closed = await closeRunSession({ ...ARGS, outcome: 'ended' });

    expect(returnIssuesForRun).not.toHaveBeenCalled();
    expect(closed?.returned).toEqual([]);
  });

  it('leaves the issues of an idle reap alone too', async () => {
    sessionRow({ status: 'running', runId: 'run-1' });
    await closeRunSession({ ...ARGS, outcome: 'killed_idle' });
    expect(returnIssuesForRun).not.toHaveBeenCalled();
  });

  it('fails a death mid-turn, blames the agent, and gives the issues back', async () => {
    sessionRow({ status: 'running', runId: 'run-1' });

    const closed = await closeRunSession({ ...ARGS, outcome: 'died', detail: 'pane vanished' });

    expect(writtenSet().to).toBe('failed');
    expect(writtenSet().set.failureReason).toBe('agent_exited_without_result');
    expect(writtenSet().set.failureDetail).toBe('pane vanished');
    expect(returnIssuesForRun).toHaveBeenCalledWith('run-1', { reason: 'pane vanished' });
    expect(closeRunIfOneShot).toHaveBeenCalledWith('run-1', 'failed');
    expect(closed?.returned).toEqual(['ISS-1']);
  });

  it('never blames the transport for a death the box itself reported', async () => {
    sessionRow({ status: 'running', runId: 'run-1' });
    await closeRunSession({ ...ARGS, outcome: 'died' });
    expect(writtenSet().set.failureReason).not.toBe('runner_unreachable');
  });

  it('refuses a session it could not find for this device', async () => {
    sessionRow(null);

    expect(await closeRunSession({ ...ARGS, outcome: 'died' })).toBeNull();
    expect(applyKernelTransition).not.toHaveBeenCalled();
  });

  it('narrows the lookup by device id, not by session id alone', async () => {
    sessionRow({ status: 'running', runId: 'run-1' });

    await closeRunSession({ ...ARGS, outcome: 'died' });

    expect(boundValues(lookupWhere)).toContain('dev-1');
  });

  it('flips nothing when the session is already terminal', async () => {
    sessionRow({ status: 'failed', runId: 'run-1' });

    expect((await closeRunSession({ ...ARGS, outcome: 'died' }))?.alreadyTerminal).toBe(true);
    expect(applyKernelTransition).not.toHaveBeenCalled();
  });

  it('finishes a close that stopped between the flip and the issue return', async () => {
    sessionRow({ status: 'failed', runId: 'run-1' });

    const closed = await closeRunSession({ ...ARGS, outcome: 'died', detail: 'pane vanished' });

    expect(returnIssuesForRun).toHaveBeenCalledWith('run-1', { reason: 'pane vanished' });
    expect(closeRunIfOneShot).toHaveBeenCalledWith('run-1', 'failed');
    expect(closed).toEqual({ alreadyTerminal: true, returned: ['ISS-1'] });
  });

  it('returns nothing on the terminal path when the run did not fail', async () => {
    sessionRow({ status: 'completed', runId: 'run-1' });

    expect(await closeRunSession({ ...ARGS, outcome: 'ended' })).toEqual({
      alreadyTerminal: true,
      returned: [],
    });
    expect(returnIssuesForRun).not.toHaveBeenCalled();
  });

  it('reports what was actually left to return when the reaper won the flip', async () => {
    sessionRow({ status: 'running', runId: 'run-1' });
    applyKernelTransition.mockResolvedValue([]);
    returnIssuesForRun.mockResolvedValue([]);

    expect(await closeRunSession({ ...ARGS, outcome: 'died' })).toEqual({
      alreadyTerminal: true,
      returned: [],
    });
    expect(returnIssuesForRun).toHaveBeenCalledWith('run-1', { reason: 'run died' });
  });
});
