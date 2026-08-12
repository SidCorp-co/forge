import { describe, expect, it, vi } from 'vitest';

// cm:why alert-queries.ts imports db/client.js at module scope, which validates env at import time; stub it so this pure-function suite doesn't need real env/Postgres (integration coverage: tests/integration/admin-alerts-e2e.test.ts)
vi.mock('../db/client.js', () => ({ db: {} }));

const {
  classifyDeliveryFailRate,
  classifyScheduleStreak,
  classifySpend,
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
});

describe('classifySpend (A4)', () => {
  // cm:why $0.5 is a 50x ratio over a $0.01 baseline, but never clears the $5 floor
  it('stays ok below the absolute floor regardless of ratio', () => {
    expect(classifySpend(0.5, 0.01)).toBe('ok');
  });

  it('is warn when the baseline is 0 but the current window clears the floor', () => {
    expect(classifySpend(10, 0)).toBe('warn');
  });

  it('stays ok when the baseline is 0 and current does not clear the floor', () => {
    expect(classifySpend(1, 0)).toBe('ok');
  });

  it('is ok below the warn ratio', () => {
    expect(classifySpend(10, 8)).toBe('ok');
  });

  it('is warn at the warn ratio', () => {
    expect(classifySpend(20, 10)).toBe('warn');
  });

  it('is crit at the crit ratio', () => {
    expect(classifySpend(40, 10)).toBe('crit');
  });
});

describe('classifyScheduleStreak (A5)', () => {
  it('is ok below the warn streak', () => {
    expect(classifyScheduleStreak(2)).toBe('ok');
  });

  it('is warn at the warn streak', () => {
    expect(classifyScheduleStreak(3)).toBe('warn');
  });

  it('is crit at the crit streak', () => {
    expect(classifyScheduleStreak(5)).toBe('crit');
  });
});

describe('classifyDeliveryFailRate (A5)', () => {
  it('is ok below the minimum sample size regardless of fail rate', () => {
    expect(classifyDeliveryFailRate(4, 4)).toBe('ok');
  });

  it('is warn at the warn fail-rate over the minimum sample', () => {
    expect(classifyDeliveryFailRate(3, 6)).toBe('warn');
  });

  it('is crit at the crit fail-rate', () => {
    expect(classifyDeliveryFailRate(8, 10)).toBe('crit');
  });

  it('is ok below the warn fail-rate', () => {
    expect(classifyDeliveryFailRate(1, 6)).toBe('ok');
  });
});
