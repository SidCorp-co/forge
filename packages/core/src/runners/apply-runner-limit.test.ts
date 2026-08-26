import { beforeEach, describe, expect, it, vi } from 'vitest';

const returning = vi.fn();
const updateWhere = vi.fn(() => ({ returning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const update = vi.fn(() => ({ set: updateSet }));
vi.mock('../db/client.js', () => ({ db: { update } }));

const publish = vi.fn();
vi.mock('../ws/server.js', () => ({ roomManager: { publish } }));

const emitPipelineWedge = vi.fn();
const resolvePipelineWedge = vi.fn();
vi.mock('../pipeline/wedge.js', () => ({ emitPipelineWedge, resolvePipelineWedge }));

const { stampRunnerLimit, clearRunnerLimit } = await import('./apply-runner-limit.js');

const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUNNER_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
  returning.mockReset();
  returning.mockResolvedValue([]);
  updateWhere.mockClear();
  updateSet.mockClear();
  update.mockClear();
  publish.mockClear();
  emitPipelineWedge.mockClear();
  resolvePipelineWedge.mockClear();
});

describe('stampRunnerLimit', () => {
  // cm:why the measured gap: device dev1-ai013 sat auth-dead for 5.5h across 421 jobs, excluded from dispatch by name, with nothing anywhere telling its owner
  it('alarms on an auth limit, which nothing else can clear', async () => {
    await stampRunnerLimit(RUNNER_A, PROJECT_A, {
      reason: 'auth',
      until: null,
      detail: 'OAuth token has expired',
    });
    expect(emitPipelineWedge).toHaveBeenCalledTimes(1);
    expect(emitPipelineWedge).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_A,
        entity: 'runner',
        entityId: RUNNER_A,
        reason: 'auth_dead:OAuth token has expired',
      }),
    );
  });

  it.each([
    ['rate_limit', new Date('2026-08-26T10:00:00.000Z')],
    ['usage_limit', new Date('2026-08-26T12:00:00.000Z')],
  ] as const)('does not alarm on %s, which lifts itself', async (reason, until) => {
    await stampRunnerLimit(RUNNER_A, PROJECT_A, { reason, until, detail: 'resets later' });
    expect(emitPipelineWedge).not.toHaveBeenCalled();
  });

  it('still stamps the row when the alarm is not raised', async () => {
    await stampRunnerLimit(RUNNER_A, PROJECT_A, {
      reason: 'rate_limit',
      until: new Date('2026-08-26T10:00:00.000Z'),
      detail: 'slow down',
    });
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ limitReason: 'rate_limit' }));
  });

  it('writes and alarms nothing when the job carries no runner', async () => {
    await stampRunnerLimit(null, PROJECT_A, { reason: 'auth', until: null, detail: 'x' });
    expect(update).not.toHaveBeenCalled();
    expect(emitPipelineWedge).not.toHaveBeenCalled();
  });

  it('never throws when the DB update fails (best-effort contract)', async () => {
    updateWhere.mockRejectedValueOnce(new Error('db down'));
    await expect(
      stampRunnerLimit(RUNNER_A, PROJECT_A, { reason: 'auth', until: null, detail: 'x' }),
    ).resolves.toBeUndefined();
  });
});

describe('clearRunnerLimit', () => {
  // cm:why a job succeeding is the only proof the box is well again, and it is also the only thing that can clear an auth stamp
  it('resolves the runner alarm when a row was actually cleared', async () => {
    returning.mockResolvedValueOnce([{ id: RUNNER_A }]);
    await clearRunnerLimit(RUNNER_A, PROJECT_A);
    expect(resolvePipelineWedge).toHaveBeenCalledWith(RUNNER_A);
  });

  it('leaves the alarm alone when nothing was set', async () => {
    returning.mockResolvedValueOnce([]);
    await clearRunnerLimit(RUNNER_A, PROJECT_A);
    expect(resolvePipelineWedge).not.toHaveBeenCalled();
  });

  it('never throws when the DB update fails (best-effort contract)', async () => {
    returning.mockRejectedValueOnce(new Error('db down'));
    await expect(clearRunnerLimit(RUNNER_A, PROJECT_A)).resolves.toBeUndefined();
  });
});
