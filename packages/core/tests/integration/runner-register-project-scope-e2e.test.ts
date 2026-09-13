/**
 * The socket register handler's upsert key (ISS-990, an extra fix on the same
 * registration-collision axis).
 *
 * `runners_project_device_type_uq` says a device may serve several projects,
 * and the daemon sends one `runner:register` per bound project. Keyed on device
 * and type alone, the handler's UPDATE re-pointed an existing row's project_id,
 * so the second register moved the first project's runner instead of creating
 * its own — and the 23505 branch beside it re-selected the same way. Dormant
 * today (`register_enabled` defaults false) and wrong on either path.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('registering one device for two projects over the socket', () => {
  let harness: TestDatabase;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  let handleRunnerRegister: typeof import('../../src/runners/heartbeat-ws.js').handleRunnerRegister;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    handleRunnerRegister = (await import('../../src/runners/heartbeat-ws.js')).handleRunnerRegister;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed() {
    const owner = await createTestUser(harness.db);
    const first = await createTestProject(harness.db, owner.id);
    const second = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id);
    const socket = {
      principal: { type: 'device' as const, deviceId: device.id, ownerId: owner.id },
      send: () => undefined,
    };
    const register = (projectId: string) =>
      handleRunnerRegister(socket as never, {
        data: { type: 'claude-code', name: 'forge-vm', projectId },
      });
    return { owner, first, second, device, register };
  }

  const rowsFor = async (deviceId: string) =>
    (await harness.db.execute(sql`
      SELECT project_id, status FROM runners WHERE device_id = ${deviceId}
    `)) as unknown as Array<{ project_id: string; status: string }>;

  it('gives each project its own runner row rather than moving the first one', async () => {
    const s = await seed();

    await s.register(s.first.id);
    await s.register(s.second.id);

    const projects = (await rowsFor(s.device.id)).map((r) => r.project_id).sort();
    expect(projects).toEqual([s.first.id, s.second.id].sort());
  });

  it('leaves the first project still holding a runner after the second registers', async () => {
    const s = await seed();

    await s.register(s.first.id);
    await s.register(s.second.id);

    const first = (await rowsFor(s.device.id)).filter((r) => r.project_id === s.first.id);
    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe('online');
  });

  it('still re-registers the same project onto its own row, not a second one', async () => {
    const s = await seed();

    await s.register(s.first.id);
    await s.register(s.first.id);

    expect(await rowsFor(s.device.id)).toHaveLength(1);
  });
});
