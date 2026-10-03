/**
 * ISS-1327 — a release batch's finish on a project whose work lands outside git, against real
 * Postgres. The finish closes through the kernel's transition writer, so what it may close is the
 * close gate's answer from `landing-evidence.ts`: a mark naming where the work landed closes, and a
 * bare timestamp is refused by name and left where it stood.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  seedProjectSource,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

describe('release batch finish on a website project', () => {
  let harness: TestDatabase;
  let projectId: string;
  let ownerId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    await registerIntegrationsForTest();
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
    await seedProjectSource(harness.db, projectId, owner.id, 'storefront');
  });

  const fx = releaseBatchFixture(
    () => harness,
    () => ({ projectId, ownerId }),
  );

  it('closes the issue whose mark names a landing and refuses the bare one by name', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    await fx.declareProduction();
    await fx.seedReleaseRunner();
    const landed = await fx.insertIssue();
    const bare = await fx.insertIssue();
    await harness.db.execute(sql`
      UPDATE issues SET merged_landing = 'https://mowmentbrand.com/products/tee' WHERE id = ${landed}
    `);
    const { runId } = await fx.claim([landed, bare]);

    const result = await finishReleaseBatch(runId, {
      type: 'user',
      id: ownerId,
      agency: 'human' as const,
    });

    expect(result.closed).toEqual([landed]);
    expect(result.failed.map((f) => f.id)).toEqual([bare]);
    expect(result.failed[0]?.reason).toContain('CLOSE_REQUIRES_SHIPPED');
    expect(result.failed[0]?.reason).toContain('`data.landing`');
    expect((await fx.stored(landed)).status).toBe('closed');
    expect((await fx.stored(bare)).status).not.toBe('closed');
  });
});
