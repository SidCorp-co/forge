/** ISS-1273 — the axis declaration and the line that says it. The counts themselves are in
 *  `tests/integration/loop-monitor-axis-e2e.test.ts`, against real Postgres. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerInfo = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { info: (...a: unknown[]) => loggerInfo(...a), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../db/client.js', () => ({ db: { execute: vi.fn(async () => []) } }));

const { loopMonitorCoverage, reportLoopMonitorCoverage } = await import('./loop-monitor-axis.js');

beforeEach(() => loggerInfo.mockReset());

describe('loop monitor coverage', () => {
  it('names the job axis and where the rows it misses are swept instead', () => {
    expect(loopMonitorCoverage(3)).toEqual({
      axis: 'job',
      claimHeldIssues: 3,
      sweptBy: 'pipeline/idle-issues.ts',
    });
  });

  // Read by nothing outside tests before this, so a judge could neither pass nor fail it.
  it('says it out loud, so the declaration has a reader at a running deployment', () => {
    reportLoopMonitorCoverage(4);
    expect(loggerInfo).toHaveBeenCalledWith(
      { axis: 'job', claimHeldIssues: 4, sweptBy: 'pipeline/idle-issues.ts' },
      expect.stringContaining('swept the job axis'),
    );
  });

  // Silence above zero only would mean "none held" and "nobody counted" alike.
  it('says it at zero too rather than falling silent', () => {
    expect(reportLoopMonitorCoverage(0).claimHeldIssues).toBe(0);
    expect(loggerInfo).toHaveBeenCalledTimes(1);
  });
});
