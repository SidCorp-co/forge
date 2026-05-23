import { describe, expect, it } from 'vitest';
import { computeHoldUntil } from './hold-policy.js';

const NOW = new Date('2026-05-23T00:00:00Z');

describe('computeHoldUntil', () => {
  it('returns NULL for permanent classifications', () => {
    expect(
      computeHoldUntil(
        {
          classificationKind: 'permanent_invalid',
          trigger: 'job_failed',
          recoveryStats: { transientFailures: 10, permissionFailures: 1 },
        },
        NOW,
      ),
    ).toBeNull();
  });

  it('holds for 30 minutes when transient repeats >= 3', () => {
    const result = computeHoldUntil(
      {
        classificationKind: 'transient_network',
        trigger: 'job_failed',
        recoveryStats: { transientFailures: 3, permissionFailures: 0 },
      },
      NOW,
    );
    expect(result).not.toBeNull();
    expect(result?.getTime()).toBe(NOW.getTime() + 30 * 60_000);
  });

  it('returns NULL for transient < 3', () => {
    expect(
      computeHoldUntil(
        {
          classificationKind: 'transient_network',
          trigger: 'job_failed',
          recoveryStats: { transientFailures: 2, permissionFailures: 0 },
        },
        NOW,
      ),
    ).toBeNull();
  });

  it('holds 5 minutes for session_lost regardless of classification', () => {
    const result = computeHoldUntil(
      {
        classificationKind: 'unknown',
        trigger: 'session_lost',
      },
      NOW,
    );
    expect(result?.getTime()).toBe(NOW.getTime() + 5 * 60_000);
  });

  it('returns NULL for unknown classification with no special trigger', () => {
    expect(
      computeHoldUntil(
        {
          classificationKind: 'unknown',
          trigger: 'adapter_error',
        },
        NOW,
      ),
    ).toBeNull();
  });

  it('handles missing recoveryStats as zero counts', () => {
    expect(
      computeHoldUntil(
        {
          classificationKind: 'transient_network',
          trigger: 'job_failed',
        },
        NOW,
      ),
    ).toBeNull();
  });
});
