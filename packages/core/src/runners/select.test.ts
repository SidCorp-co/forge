import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const limit = vi.fn();
const where = vi.fn(() => ({ limit }));
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));

vi.mock('../db/client.js', () => ({
  db: { execute, select },
}));

vi.mock('../lib/dispatch-liveness.js', () => ({
  dispatchLivenessMs: () => 120_000,
}));

const { getTrippedDeviceIds, onlineCapableDeviceIds } = await import('./select.js');

beforeEach(() => {
  execute.mockReset();
  limit.mockReset();
  // Default: no defaultDeviceId set on project.
  limit.mockResolvedValue([{ defaultDeviceId: null }]);
});

describe('getTrippedDeviceIds (device circuit breaker)', () => {
  const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('returns the device ids the breaker query yields', async () => {
    execute.mockResolvedValueOnce([{ device_id: 'dev-bad' }, { device_id: 'dev-bad2' }]);
    const tripped = await getTrippedDeviceIds(PROJECT_A);
    expect(tripped).toEqual(['dev-bad', 'dev-bad2']);
  });

  it('returns [] when no device is tripped', async () => {
    execute.mockResolvedValueOnce([]);
    expect(await getTrippedDeviceIds(PROJECT_A)).toEqual([]);
  });

  it('drops null device ids defensively', async () => {
    execute.mockResolvedValueOnce([{ device_id: 'dev-bad' }, { device_id: null }]);
    expect(await getTrippedDeviceIds(PROJECT_A)).toEqual(['dev-bad']);
  });

  it('builds a streak query: consecutive failed terminal jobs within a window', async () => {
    execute.mockResolvedValueOnce([]);
    await getTrippedDeviceIds(PROJECT_A);
    const q = JSON.stringify(execute.mock.calls.at(-1)?.[0]);
    expect(q).toContain('row_number'); // most-recent-N per device
    expect(q).toContain('bool_and'); // all of the last N are failed
    expect(q).toMatch(/'failed'/); // counts failed/done terminal outcomes only
    expect(q).toContain('finished_at'); // recency window
  });
});

describe('onlineCapableDeviceIds (retry round-robin candidate set)', () => {
  const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  // cm:why ISS-825 — without the health gate the retry rotation pins a quarantined device the claim then refuses (the ISS-823 wedge class), because the round-robin candidate set and the claim would disagree on who is eligible
  it('health-gated (default) query excludes quarantined runners', async () => {
    execute.mockResolvedValueOnce([]);
    await onlineCapableDeviceIds(PROJECT_A);
    const q = JSON.stringify(execute.mock.calls.at(-1)?.[0]);
    expect(q).toContain('quarantined_until');
  });

  it('includeLimited:true returns the unfiltered set (no quarantine gate)', async () => {
    execute.mockResolvedValueOnce([]);
    await onlineCapableDeviceIds(PROJECT_A, undefined, { includeLimited: true });
    const q = JSON.stringify(execute.mock.calls.at(-1)?.[0]);
    expect(q).not.toContain('quarantined_until');
  });

  it('omits a quarantined runner device from the health-gated candidate set', async () => {
    // The real WHERE clause filters the quarantined row out at the DB layer;
    // simulate that by having the query return only the healthy device.
    execute.mockResolvedValueOnce([{ device_id: 'dev-healthy' }]);
    const ids = await onlineCapableDeviceIds(PROJECT_A);
    expect(ids).toEqual(['dev-healthy']);
    expect(ids).not.toContain('dev-quarantined');
  });

  it('scopes the candidate set to the stage runner pool when one is given', async () => {
    execute.mockResolvedValueOnce([]);
    await onlineCapableDeviceIds(PROJECT_A, undefined, { allowDeviceIds: ['dev-pool'] });
    const q = new PgDialect().sqlToQuery(execute.mock.calls.at(-1)?.[0] as SQL);
    expect(q.sql).toContain('device_id IN (');
    // cm:guard the pool must render as placeholders, never as a `::uuid[]` cast over an interpolated array — drizzle expands that as a ROW CONSTRUCTOR and Postgres refuses it, which dead-lettered every dispatch on forge-dev for 11 days
    expect(q.sql).not.toContain('::uuid[]');
    expect(q.params).toContain('dev-pool');
  });
});
