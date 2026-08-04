import { beforeEach, describe, expect, it, vi } from 'vitest';

// ISS-780 — health-gate coverage for the chat/agent-turn device pick.
// `db.execute` is mocked (no real Postgres), so ORDER BY ranking itself is
// trusted to the database; these tests assert (a) the health-preference
// clause is actually sent, and (b) the function's own logic — pass-through
// of whatever the DB ranked first, last-resort fallback when only a limited
// runner exists, and the WHERE-level gate toggle on `findChatCapableDeviceForProject`.

const execute = vi.fn();
const limit = vi.fn();
const where = vi.fn(() => ({ limit }));
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));

vi.mock('../db/client.js', () => ({
  db: { execute, select },
}));

vi.mock('./dispatch-liveness.js', () => ({
  dispatchLivenessMs: () => 120_000,
}));

const { findAvailableDeviceForProject, findChatCapableDeviceForProject } = await import(
  './device-pool.js'
);

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_HEALTHY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_LIMITED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

beforeEach(() => {
  execute.mockReset();
  limit.mockReset();
  limit.mockResolvedValue([{ defaultDeviceId: null }]);
});

describe('findAvailableDeviceForProject', () => {
  it('sends a health-preference ORDER BY (rate_limited_until, limit_reason auth)', async () => {
    execute.mockResolvedValueOnce([{ device_id: DEVICE_HEALTHY }]);
    await findAvailableDeviceForProject(PROJECT);
    const q = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(q).toContain('rate_limited_until');
    expect(q).toContain('limit_reason');
    expect(q).toContain('auth');
  });

  it('returns the healthy runner when the DB ranks it ahead of a rate-limited/auth runner', async () => {
    // The DB is the one that ranks healthy-first; this asserts the function
    // passes that ranking straight through (rows[0]).
    execute.mockResolvedValueOnce([{ device_id: DEVICE_HEALTHY }]);
    await expect(findAvailableDeviceForProject(PROJECT)).resolves.toBe(DEVICE_HEALTHY);
  });

  it('returns the limited runner when it is the only online option (no wedge)', async () => {
    execute.mockResolvedValueOnce([{ device_id: DEVICE_LIMITED }]);
    await expect(findAvailableDeviceForProject(PROJECT)).resolves.toBe(DEVICE_LIMITED);
  });

  it('falls back to the project defaultDeviceId when no runner row matches', async () => {
    execute.mockResolvedValueOnce([]);
    limit.mockResolvedValueOnce([{ defaultDeviceId: DEVICE_HEALTHY }]);
    limit.mockResolvedValueOnce([{ id: DEVICE_HEALTHY }]);
    await expect(findAvailableDeviceForProject(PROJECT)).resolves.toBe(DEVICE_HEALTHY);
  });

  it('excludes already-tried devices via excludeDeviceIds', async () => {
    execute.mockResolvedValueOnce([]);
    await findAvailableDeviceForProject(PROJECT, { excludeDeviceIds: [DEVICE_HEALTHY] });
    const q = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(q).toContain(DEVICE_HEALTHY);
    expect(q).toContain('NOT IN');
  });
});

describe('findChatCapableDeviceForProject', () => {
  // Simulates a Postgres WHERE clause: the device only "matches" when the
  // health-gate fragment is ABSENT from the query (i.e. allowLimited:true
  // dropped it) — modelling a device that is online but currently limited.
  function mockLimitedDevice(deviceId: string) {
    execute.mockImplementation(async (q: unknown) => {
      const str = JSON.stringify(q);
      const healthGated = str.includes('rate_limited_until') && str.includes('limit_reason');
      return healthGated ? [] : [{ device_id: deviceId }];
    });
  }

  it('gates out a rate-limited/auth-flagged device by default', async () => {
    mockLimitedDevice(DEVICE_LIMITED);
    await expect(findChatCapableDeviceForProject(PROJECT, DEVICE_LIMITED)).resolves.toBeNull();
  });

  it('honours an explicit pick via allowLimited:true', async () => {
    mockLimitedDevice(DEVICE_LIMITED);
    await expect(
      findChatCapableDeviceForProject(PROJECT, DEVICE_LIMITED, { allowLimited: true }),
    ).resolves.toBe(DEVICE_LIMITED);
  });

  it('still returns a healthy device by default (no regression)', async () => {
    execute.mockResolvedValueOnce([{ device_id: DEVICE_HEALTHY }]);
    await expect(findChatCapableDeviceForProject(PROJECT, DEVICE_HEALTHY)).resolves.toBe(
      DEVICE_HEALTHY,
    );
  });
});
