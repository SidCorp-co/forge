import { beforeEach, describe, expect, it, vi } from 'vitest';

const returning = vi.fn();
const updateWhere = vi.fn(() => ({ returning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const update = vi.fn(() => ({ set: updateSet }));
vi.mock('../db/client.js', () => ({ db: { update } }));

const broadcastRunnerChanged = vi.fn();
vi.mock('./apply-runner-limit.js', () => ({ broadcastRunnerChanged }));

const resolvePipelineWedge = vi.fn();
vi.mock('../pipeline/wedge.js', () => ({ resolvePipelineWedge }));

const { clearRunnerFaultFlags } = await import('./clear-fault-flags.js');

const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUNNER_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
  returning.mockReset();
  returning.mockResolvedValue([]);
  updateSet.mockClear();
  update.mockClear();
  broadcastRunnerChanged.mockClear();
  resolvePipelineWedge.mockClear();
});

describe('clearRunnerFaultFlags', () => {
  it('forgets every fault column the reset owns', async () => {
    returning.mockResolvedValueOnce([{ id: RUNNER_A }]);
    expect(await clearRunnerFaultFlags(RUNNER_A, PROJECT_A)).toBe(true);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        lastError: null,
        limitReason: null,
        rateLimitedUntil: null,
        limitDetail: null,
        quarantinedUntil: null,
        quarantineReason: null,
      }),
    );
    expect(broadcastRunnerChanged).toHaveBeenCalledWith(PROJECT_A, RUNNER_A);
  });

  // cm:why an operator who repairs the box by hand must not be left holding the alarm it raised — the wedge re-notifies at most daily, so a stale one also hides the next real trip
  it('clears the alarm the quarantine raised', async () => {
    returning.mockResolvedValueOnce([{ id: RUNNER_A }]);
    await clearRunnerFaultFlags(RUNNER_A, PROJECT_A);
    expect(resolvePipelineWedge).toHaveBeenCalledWith(RUNNER_A);
  });

  it('reports nothing done, and touches nothing, when no flag was set', async () => {
    returning.mockResolvedValueOnce([]);
    expect(await clearRunnerFaultFlags(RUNNER_A, PROJECT_A)).toBe(false);
    expect(broadcastRunnerChanged).not.toHaveBeenCalled();
    expect(resolvePipelineWedge).not.toHaveBeenCalled();
  });
});
