import { describe, expect, it } from 'vitest';
import { AGENT_NAMING_MIN_RUNNER, atLeastVersion } from './device-cap.js';

// cm:guard every "not proven new enough" case below must stay FALSE. The claim refuses a below-floor box outright rather than degrading it, so relaxing one of these does not cost throughput — it hands the retry engine a candidate that can never claim, and the queue burns all 30 attempts without ever reaching `all_devices_exhausted`.
describe('atLeastVersion', () => {
  it('accepts a runner exactly at the floor', () => {
    expect(atLeastVersion(AGENT_NAMING_MIN_RUNNER, AGENT_NAMING_MIN_RUNNER)).toBe(true);
  });

  it('accepts one above the floor', () => {
    expect(atLeastVersion('0.11.1', AGENT_NAMING_MIN_RUNNER)).toBe(true);
  });

  it('refuses one below the floor', () => {
    expect(atLeastVersion('0.10.5', AGENT_NAMING_MIN_RUNNER)).toBe(false);
  });

  it('compares each part numerically, not as text', () => {
    expect(atLeastVersion('0.9.0', '0.11.0')).toBe(false);
    expect(atLeastVersion('0.11.0', '0.9.0')).toBe(true);
  });

  it.each([
    ['unknown', null],
    ['never reported', undefined],
    ['unparseable', 'nightly'],
    ['not three parts', '0.11'],
  ])('refuses a box whose version is %s', (_label, version) => {
    expect(atLeastVersion(version as string | null | undefined, AGENT_NAMING_MIN_RUNNER)).toBe(
      false,
    );
  });
});
