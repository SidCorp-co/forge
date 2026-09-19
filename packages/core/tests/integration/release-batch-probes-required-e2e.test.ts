import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

describe('a release refuses a project that declares no probes', () => {
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
  });

  const fx = releaseBatchFixture(
    () => harness,
    () => ({ projectId, ownerId }),
  );
  const { declareProduction, seedReleaseRunner, insertIssue, stored, claim, runStatus } = fx;

  const actor = () => ({ type: 'user', id: ownerId }) as const;

  async function dropProbes(): Promise<void> {
    await harness.db.execute(sql`
      UPDATE integration_bindings SET config = config - 'verify'
      WHERE project_id = ${projectId} AND provider = 'coolify' AND 'live' = ANY(stages)
    `);
  }

  it('refuses to create a batch, naming RELEASE_PROBES_UNDECLARED, and claims nothing', async () => {
    await declareProduction({ verify: null });
    await seedReleaseRunner();
    const a = await insertIssue();

    await expect(claim([a])).rejects.toThrow('RELEASE_PROBES_UNDECLARED');

    expect(await stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
  });

  it('refuses to finish a run whose project declares no probes, and closes nothing', async () => {
    await declareProduction();
    await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await dropProbes();

    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    await expect(finishReleaseBatch(runId, actor())).rejects.toThrow('RELEASE_PROBES_UNDECLARED');

    expect(await stored(a)).toMatchObject({ status: 'releasing' });
    expect(await runStatus(runId)).toBe('running');
  });

  it('closes the roster once the probes are declared and agree', async () => {
    await declareProduction();
    await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);

    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const result = await finishReleaseBatch(runId, actor());

    expect(result).toEqual({ closed: [a], failed: [] });
    expect((await stored(a)).status).toBe('closed');
  });
});
