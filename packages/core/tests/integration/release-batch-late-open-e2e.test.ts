/**
 * A release batch opened AFTER the release it records had already shipped.
 *
 * `createReleaseBatch` keeps what is live when the batch row is written as
 * `commitBefore`. Where the promote landed first, that snapshot IS the released
 * commit, and the close gate asked the deployment to move away from the commit
 * it was asking it to arrive at: five `finish` attempts on `sidpeak`, five 300s
 * windows, one refusal no future state of the world could clear (ISS-1199).
 *
 * Integration because the failure is the create door and the close door
 * disagreeing about one value in the run's metadata, and a mocked twin of
 * either proves only itself.
 */

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

describe('a release batch opened after its own release', () => {
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
    await declareProduction();
    await seedReleaseRunner();
  });

  const fx = releaseBatchFixture(
    () => harness,
    () => ({ projectId, ownerId }),
  );
  const { declareProduction, seedReleaseRunner, insertIssue, stored } = fx;
  const { runStatus, claim, serve } = fx;

  const actor = () => ({ type: 'user', id: ownerId }) as const;

  /** The commit this was found on: cut, deployed, and only then batched. */
  const RELEASED = '30bc56b16af665118ddcbd2e32bbc8b2bc0e5c0c';

  it('finishes a batch opened after its own release had already shipped', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    serve(RELEASED);
    const a = await insertIssue();
    const { runId } = await claim([a], { deploy: false });

    const result = await finishReleaseBatch(runId, actor(), { commit: RELEASED });

    expect(result.closed).toEqual([a]);
    expect(result.failed).toEqual([]);
    expect((await stored(a)).status).toBe('closed');
    expect(await runStatus(runId)).toBe('completed');
  });

  it('still refuses a batch whose deployment is serving some other commit', async () => {
    const { ReleaseNotVerifiedError, finishReleaseBatch } = await import(
      '../../src/release-batch/service.js'
    );
    serve(RELEASED);
    const a = await insertIssue();
    const { runId } = await claim([a], { deploy: false });

    const err = await finishReleaseBatch(runId, actor(), {
      commit: 'c0ffee1234567890abcdef1234567890abcdef12',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReleaseNotVerifiedError);
    expect((await stored(a)).status).toBe('releasing');
  });

  it('says at the door when what is already serving carries a roster merge', async () => {
    serve(RELEASED);
    const a = await insertIssue();
    await harness.db.execute(
      sql`UPDATE issues SET merged_commit_sha = ${RELEASED} WHERE id = ${a}`,
    );

    const created = await claim([a], { deploy: false });

    expect(created.openedAfterRelease).toBe(true);
    const rows = await harness.db.execute(
      sql`SELECT metadata FROM pipeline_runs WHERE id = ${created.runId}`,
    );
    const meta = rows[0]?.metadata as { openedAfterRelease?: boolean };
    expect(meta.openedAfterRelease).toBe(true);
  });

  it('says nothing of the kind where what is serving carries no roster merge', async () => {
    serve(RELEASED);
    const a = await insertIssue();

    const created = await claim([a], { deploy: false });

    expect(created.openedAfterRelease).toBe(false);
  });
});
