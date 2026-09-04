import { randomUUID } from 'node:crypto';
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

// cm:guard both picks are hand-written `db.execute(sql)` strings, so the columns they name are invisible to tsc and to `src/lib/device-pool.test.ts`, which mocks `db.execute` and cannot represent a schema mismatch at all — that is how `AND r.host = 'device'` outlived migration 0200 dropping the column and 500'd `POST /api/agent-sessions/send` on forge-beta (2026-09-04). A dropped or renamed runners/devices column must fail HERE; do not move these assertions onto a mocked db.
describe('device-pool picks run against the migrated schema', () => {
  let harness: TestDatabase;
  let findAvailableDeviceForProject: typeof import('../../src/lib/device-pool.js').findAvailableDeviceForProject;
  let findChatCapableDeviceForProject: typeof import('../../src/lib/device-pool.js').findChatCapableDeviceForProject;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';

    ({ findAvailableDeviceForProject, findChatCapableDeviceForProject } = await import(
      '../../src/lib/device-pool.js'
    ));
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedOnlineRunner(opts: { lastSeenAt?: string } = {}) {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const device = await createTestDevice(harness.db, user.id);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at)
      VALUES (
        ${randomUUID()}, ${project.id}, 'claude-code', ${device.id}, 'pool-runner', 'online',
        ${opts.lastSeenAt ?? new Date().toISOString()}
      )
    `);
    return { project, device };
  }

  it('findAvailableDeviceForProject returns the online runner device', async () => {
    const { project, device } = await seedOnlineRunner();
    await expect(findAvailableDeviceForProject(project.id)).resolves.toBe(device.id);
  });

  it('findAvailableDeviceForProject honours excludeDeviceIds', async () => {
    const { project, device } = await seedOnlineRunner();
    await expect(
      findAvailableDeviceForProject(project.id, { excludeDeviceIds: [device.id] }),
    ).resolves.toBeNull();
  });

  it('findAvailableDeviceForProject skips a runner outside the liveness window', async () => {
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    const { project } = await seedOnlineRunner({ lastSeenAt: stale });
    await expect(findAvailableDeviceForProject(project.id)).resolves.toBeNull();
  });

  it('findChatCapableDeviceForProject validates an explicit pick, and rejects a foreign device', async () => {
    const { project, device } = await seedOnlineRunner();
    await expect(findChatCapableDeviceForProject(project.id, device.id)).resolves.toBe(device.id);
    await expect(findChatCapableDeviceForProject(project.id, randomUUID())).resolves.toBeNull();
  });

  it('findChatCapableDeviceForProject gates on health, and allowLimited skips that gate', async () => {
    const { project, device } = await seedOnlineRunner();
    await harness.db.execute(sql`
      UPDATE runners SET limit_reason = 'auth' WHERE device_id = ${device.id}
    `);
    await expect(findChatCapableDeviceForProject(project.id, device.id)).resolves.toBeNull();
    await expect(
      findChatCapableDeviceForProject(project.id, device.id, { allowLimited: true }),
    ).resolves.toBe(device.id);
  });
});
