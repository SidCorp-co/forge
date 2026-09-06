import { describe, expect, it, vi } from 'vitest';

// cm:why alert-queries.ts imports db/client.js at module scope, which validates env at import time; stub it so this pure-function suite doesn't need real env/Postgres (integration coverage: tests/integration/admin-alerts-e2e.test.ts)
vi.mock('../db/client.js', () => ({ db: {} }));

const {
  classifyDeliveryFailRate,
  classifyScheduleStreak,
  classifySpend,
  classifySpendCeiling,
  classifyStuck,
  opsAlertResolutionKey,
  worstStatus,
} = await import('./alert-queries.js');

describe('worstStatus', () => {
  it('picks crit over warn and warn over ok', () => {
    expect(worstStatus('ok', 'warn')).toBe('warn');
    expect(worstStatus('warn', 'crit')).toBe('crit');
    expect(worstStatus('crit', 'ok')).toBe('crit');
    expect(worstStatus('ok', 'ok')).toBe('ok');
  });
});

describe('opsAlertResolutionKey', () => {
  it('namespaces by alert id', () => {
    expect(opsAlertResolutionKey('A1')).toBe('ops-alert:A1');
    expect(opsAlertResolutionKey('A5')).toBe('ops-alert:A5');
  });
});

describe('classifyStuck (A2)', () => {
  it('is ok with no stuck jobs', () => {
    expect(classifyStuck(0, 0, 600)).toBe('ok');
  });

  it('is warn below the crit count and age ceiling', () => {
    expect(classifyStuck(1, 700, 600)).toBe('warn');
    expect(classifyStuck(2, 700, 600)).toBe('warn');
  });

  it('is crit at the crit count threshold', () => {
    expect(classifyStuck(3, 700, 600)).toBe('crit');
  });

  it('is crit when the oldest offender exceeds 4x staleSeconds, even with count=1', () => {
    expect(classifyStuck(1, 600 * 4 + 1, 600)).toBe('crit');
  });

  it('stays warn exactly at the 4x boundary', () => {
    expect(classifyStuck(1, 600 * 4, 600)).toBe('warn');
  });

  it('is crit a fraction of a second past the 4x boundary — the age must not arrive truncated', () => {
    expect(classifyStuck(1, 600 * 4 + 0.25, 600)).toBe('crit');
  });
});

// cm:guard every threshold below is a LITERAL, never read back from the module that classifies against it — an assertion against the implementation's own constant agrees with whatever the implementation does and cannot go red on a wrong derivation (ISS-654)
describe('classifySpend (A4)', () => {
  // cm:why $0.5 is a 50x ratio over a $0.01 baseline, but never clears the $5 floor
  it('stays ok below the absolute floor regardless of ratio', () => {
    expect(classifySpend(0.5, 0.01, 2)).toBe('ok');
  });

  it('is warn when the baseline is 0 but the current window clears the floor', () => {
    expect(classifySpend(10, 0, 2)).toBe('warn');
  });

  it('stays ok when the baseline is 0 and current does not clear the floor', () => {
    expect(classifySpend(1, 0, 2)).toBe('ok');
  });

  it('is ok below the configured warn ratio', () => {
    expect(classifySpend(10, 8, 2)).toBe('ok');
  });

  it('is warn at the configured warn ratio', () => {
    expect(classifySpend(20, 10, 2)).toBe('warn');
  });

  it('is crit at twice the configured warn ratio', () => {
    expect(classifySpend(40, 10, 2)).toBe('crit');
  });

  it('follows the configured multiple rather than a constant', () => {
    expect(classifySpend(30, 10, 2)).toBe('warn');
    expect(classifySpend(30, 10, 5)).toBe('ok');
    expect(classifySpend(30, 10, 1.5)).toBe('crit');
  });
});

describe('classifySpendCeiling (A4)', () => {
  it('is ok when no ceiling is set, however large the spend', () => {
    expect(classifySpendCeiling(10_000, null)).toBe('ok');
  });

  it('is ok below 80% of the ceiling', () => {
    expect(classifySpendCeiling(79, 100)).toBe('ok');
  });

  it('is warn at 80% of the ceiling', () => {
    expect(classifySpendCeiling(80, 100)).toBe('warn');
  });

  it('is crit at the ceiling', () => {
    expect(classifySpendCeiling(100, 100)).toBe('crit');
  });

  it('is crit past the ceiling', () => {
    expect(classifySpendCeiling(250, 100)).toBe('crit');
  });
});

describe('classifyScheduleStreak (A5)', () => {
  it('is ok below the configured warn streak', () => {
    expect(classifyScheduleStreak(2, 3)).toBe('ok');
  });

  it('is warn at the configured warn streak', () => {
    expect(classifyScheduleStreak(3, 3)).toBe('warn');
  });

  it('is crit two past the configured warn streak', () => {
    expect(classifyScheduleStreak(5, 3)).toBe('crit');
  });

  it('follows the configured streak rather than a constant', () => {
    expect(classifyScheduleStreak(2, 2)).toBe('warn');
    expect(classifyScheduleStreak(4, 2)).toBe('crit');
  });
});

describe('classifyDeliveryFailRate (A5)', () => {
  it('is ok below the minimum sample size regardless of fail rate', () => {
    expect(classifyDeliveryFailRate(4, 4, 50)).toBe('ok');
  });

  it('is warn at the configured warn fail-rate over the minimum sample', () => {
    expect(classifyDeliveryFailRate(3, 6, 50)).toBe('warn');
  });

  it('is crit at 1.6x the configured warn fail-rate', () => {
    expect(classifyDeliveryFailRate(8, 10, 50)).toBe('crit');
  });

  it('is ok below the configured warn fail-rate', () => {
    expect(classifyDeliveryFailRate(1, 6, 50)).toBe('ok');
  });

  it('follows the configured rate rather than a constant', () => {
    expect(classifyDeliveryFailRate(2, 10, 50)).toBe('ok');
    expect(classifyDeliveryFailRate(2, 10, 20)).toBe('warn');
    expect(classifyDeliveryFailRate(4, 10, 20)).toBe('crit');
  });
});
