import { beforeEach, describe, expect, it, vi } from 'vitest';

const sweep = vi.hoisted(() => vi.fn(async () => ({ raised: 0 })));

vi.mock('./requirements/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./requirements/index.js')>()),
  sweepDeliveredRequirements: sweep,
}));

const { coreTimers } = await import('./timer-registry.js');

beforeEach(() => sweep.mockClear());

// ISS-489 r5: a delivery a linked issue's close could not read is raised only by this timer, so
// dropping it from the list left every other test green.
describe('the requirement delivery sweep', () => {
  it('is a cluster timer that runs the delivery sweep every 5 minutes', async () => {
    const timer = coreTimers().find((t) => t.name === 'requirement-delivery-sweep');

    expect(timer).toMatchObject({ kind: 'cluster', cron: '*/5 * * * *' });
    await timer?.run();
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
