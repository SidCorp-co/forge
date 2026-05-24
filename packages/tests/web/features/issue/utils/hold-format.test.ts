import { describe, expect, it } from 'vitest';
import { formatHoldCountdown } from '@/features/issue/utils/hold-format';

const NOW = new Date('2026-05-23T12:00:00Z');

describe('formatHoldCountdown', () => {
  it('returns kind=none when manualHold is false/undefined', () => {
    expect(formatHoldCountdown(false, null, NOW).kind).toBe('none');
    expect(formatHoldCountdown(undefined, undefined, NOW).kind).toBe('none');
  });

  it('returns manual-only when held with no expiry', () => {
    const r = formatHoldCountdown(true, null, NOW);
    expect(r.kind).toBe('manual-only');
    expect(r.kind === 'manual-only' && r.label).toBe('Hold (manual resume only)');
  });

  it('returns auto-resume countdown when expiry is in the future', () => {
    const target = new Date(NOW.getTime() + 27 * 60_000).toISOString();
    const r = formatHoldCountdown(true, target, NOW);
    expect(r.kind).toBe('auto-resume');
    expect(r.kind === 'auto-resume' && r.minutesLeft).toBe(27);
    expect(r.kind === 'auto-resume' && r.label).toBe('Auto-resume in 27m');
  });

  it('falls back to manual-only when expiry has already passed', () => {
    const past = new Date(NOW.getTime() - 60_000).toISOString();
    expect(formatHoldCountdown(true, past, NOW).kind).toBe('manual-only');
  });

  it('rounds up so sub-minute windows still display "Auto-resume in 1m"', () => {
    const target = new Date(NOW.getTime() + 20_000).toISOString();
    const r = formatHoldCountdown(true, target, NOW);
    expect(r.kind === 'auto-resume' && r.minutesLeft).toBe(1);
  });
});
