/**
 * The releasing sweep runs on a schedule of its own: registered once at boot, every minute, and its
 * worker is the pass. The pass itself is proved on real Postgres in
 * `tests/integration/releasing-settle-e2e.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const boss = vi.hoisted(() => ({
  createQueue: vi.fn(async () => undefined),
  work: vi.fn(async () => undefined),
  schedule: vi.fn(async () => undefined),
}));
vi.mock('../queue/boss.js', () => ({ boss }));
const execute = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../db/client.js', () => ({ db: { execute } }));

const { registerReleasingSettle, resetReleasingSettleForTest } = await import(
  './releasing-settle.js'
);

describe('registerReleasingSettle (ISS-1421)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReleasingSettleForTest();
  });

  it('creates its queue, works it, and schedules it every minute', async () => {
    await registerReleasingSettle();

    expect(boss.createQueue).toHaveBeenCalledWith('release-batch-releasing-settle');
    expect(boss.work).toHaveBeenCalledWith('release-batch-releasing-settle', expect.any(Function));
    expect(boss.schedule).toHaveBeenCalledWith('release-batch-releasing-settle', '* * * * *');
  });

  it('registers once however often it is called', async () => {
    await registerReleasingSettle();
    await registerReleasingSettle();

    expect(boss.schedule).toHaveBeenCalledTimes(1);
  });

  it('works the queue with the pass, which reads the rows at Releasing', async () => {
    await registerReleasingSettle();
    const worker = (boss.work.mock.calls[0] as unknown as [string, () => Promise<void>])[1];
    execute.mockClear();

    await worker();

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
