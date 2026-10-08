import { afterEach, describe, expect, it } from 'vitest';
import { isInFlight, provisionStalledSeconds, provisionStallMs } from './provision-stall.js';

const NOW = new Date('2026-10-09T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

afterEach(() => {
  delete process.env.PROVISION_STALL_MS;
});

describe('provisionStallMs', () => {
  it('is thirty minutes unless the environment says otherwise', () => {
    expect(provisionStallMs()).toBe(30 * 60_000);
    process.env.PROVISION_STALL_MS = '120000';
    expect(provisionStallMs()).toBe(120_000);
  });

  it.each(['', 'soon', '0', '-5'])('refuses %j rather than reading a window of nothing', (raw) => {
    process.env.PROVISION_STALL_MS = raw;
    expect(provisionStallMs()).toBe(30 * 60_000);
  });
});

describe('isInFlight', () => {
  it.each(['queued', 'cloning', 'syncing_skills', 'writing_mcp'])('%s is in flight', (s) => {
    expect(isInFlight(s)).toBe(true);
  });

  it.each([null, 'ready', 'failed', 'needs_manual_setup'])('%s is not', (s) => {
    expect(isInFlight(s)).toBe(false);
  });
});

describe('provisionStalledSeconds', () => {
  it('names how long an in-flight provision has stood once the window is reached', () => {
    expect(provisionStalledSeconds('cloning', ago(3_000_000), NOW, 1_800_000)).toBe(3000);
  });

  it('is null one millisecond inside the window and a number at it', () => {
    expect(provisionStalledSeconds('cloning', ago(1_799_999), NOW, 1_800_000)).toBeNull();
    expect(provisionStalledSeconds('cloning', ago(1_800_000), NOW, 1_800_000)).toBe(1800);
  });

  it('is null for a settled row however old', () => {
    expect(provisionStalledSeconds('ready', ago(1e12), NOW, 1_800_000)).toBeNull();
    expect(provisionStalledSeconds('failed', ago(1e12), NOW, 1_800_000)).toBeNull();
    expect(provisionStalledSeconds(null, ago(1e12), NOW, 1_800_000)).toBeNull();
  });
});
