/**
 * The silent-batch sweep is on a schedule of its own: registered once at boot, every minute, and
 * its worker is the pass. The pass itself is proved on real Postgres in
 * `tests/integration/release-silent-recovery-e2e.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const boss = vi.hoisted(() => ({
  createQueue: vi.fn(async () => undefined),
  work: vi.fn(async () => undefined),
  schedule: vi.fn(async () => undefined),
}));
vi.mock('../queue/boss.js', () => ({ boss }));
vi.mock('../db/client.js', () => ({ db: { execute: vi.fn(async () => []) } }));
vi.mock('../pipeline/wedge.js', () => ({ emitPipelineWedge: vi.fn() }));

const { registerReleaseSilentRecovery, resetReleaseSilentRecoveryForTest } = await import(
  './silent-recovery.js'
);

describe('registerReleaseSilentRecovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReleaseSilentRecoveryForTest();
  });

  it('creates its queue, works it, and schedules it every minute', async () => {
    await registerReleaseSilentRecovery();

    expect(boss.createQueue).toHaveBeenCalledWith('release-batch-silent-recovery');
    expect(boss.work).toHaveBeenCalledWith('release-batch-silent-recovery', expect.any(Function));
    expect(boss.schedule).toHaveBeenCalledWith('release-batch-silent-recovery', '* * * * *');
  });

  it('registers once however often it is called', async () => {
    await registerReleaseSilentRecovery();
    await registerReleaseSilentRecovery();

    expect(boss.schedule).toHaveBeenCalledTimes(1);
  });

  it('works the queue with a pass that finds no batch to recover when none is taken', async () => {
    await registerReleaseSilentRecovery();
    const worker = (boss.work.mock.calls[0] as unknown as [string, () => Promise<void>])[1];

    await expect(worker()).resolves.toBeUndefined();
  });
});
