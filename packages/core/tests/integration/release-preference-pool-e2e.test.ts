/**
 * ISS-1128 — `releaseRunnerLabel` recommends a box; it does not remove the rest
 * of the fleet from the pool.
 *
 * Measured on forge-dev on 2026-09-20: both runners carried `labels: []`, both
 * were online and healthy, and declaring `releaseRunnerLabel` turned a project
 * that could deploy on either box into one that could deploy on neither —
 * `503 RELEASE_POOL_EMPTY`, with nothing about the fleet changed.
 *
 * Integration and not unit, because what is under test is which boxes the
 * preflight counts. The label is read out of `integration_bindings` overlaid on
 * `integration_connections`, and eligibility out of `runners` joined to
 * `devices`; a mock of either cannot disagree with the release path, which is
 * the only disagreement that matters.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { RELEASE_LABEL, releaseBatchFixture } from '../helpers/release-batch-fixture.js';

describe('a release runner label ranks the pool it does not filter', () => {
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
  const { declareProduction, insertIssue, stored, claim } = fx;

  /**
   * One box on the project. Every case below moves exactly one of `labels`,
   * `status` and `agentVersion`, which are the three ways a box stops being
   * eligible to take the release.
   */
  async function seedBox(opts: {
    labels: string[];
    status?: 'online' | 'offline';
    agentVersion?: string;
  }): Promise<string> {
    const device = await createTestDevice(harness.db, ownerId, {
      status: 'online',
      ...(opts.agentVersion === undefined ? {} : { agentVersion: opts.agentVersion }),
    });
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (
        ${randomUUID()}, ${projectId}, 'claude-code', ${device.id},
        ${`box-${device.id.slice(0, 8)}`}, ${opts.status ?? 'online'}, now(),
        ${JSON.stringify(opts.labels)}::jsonb
      )
    `);
    return device.id;
  }

  /** Take the declared label off the binding, leaving every other key on it. */
  async function withdrawLabel(): Promise<void> {
    await harness.db.execute(sql`
      UPDATE integration_bindings SET config = config - 'releaseRunnerLabel'
      WHERE project_id = ${projectId} AND provider = 'coolify' AND 'live' = ANY(stages)
    `);
  }

  async function releaseRunnerOf(runId: string): Promise<Record<string, unknown> | null> {
    const rows = await harness.db.execute(sql`
      SELECT metadata -> 'releaseRunner' AS release_runner
      FROM pipeline_runs WHERE id = ${runId}
    `);
    return (rows[0]?.release_runner as Record<string, unknown> | null) ?? null;
  }

  it('opens a batch on a fleet where no eligible box carries the declared label', async () => {
    await declareProduction();
    await seedBox({ labels: [] });
    const a = await insertIssue();

    const { runId } = await claim([a]);

    expect(runId).toBeTruthy();
    expect((await stored(a)).status).toBe('releasing');
  });

  it('records the declared label and the unmet preference on the run', async () => {
    await declareProduction();
    await seedBox({ labels: [] });
    const a = await insertIssue();

    const { runId } = await claim([a]);

    expect(await releaseRunnerOf(runId)).toEqual({
      label: RELEASE_LABEL,
      preferenceMet: false,
    });
  });

  it('records the preference as met where an eligible box carries the label', async () => {
    await declareProduction();
    await seedBox({ labels: [RELEASE_LABEL] });
    await seedBox({ labels: [] });
    const a = await insertIssue();

    const { runId } = await claim([a]);

    expect(await releaseRunnerOf(runId)).toEqual({
      label: RELEASE_LABEL,
      preferenceMet: true,
    });
  });

  it('releases on the online box where the only labelled box is offline', async () => {
    await declareProduction();
    await seedBox({ labels: [RELEASE_LABEL], status: 'offline' });
    await seedBox({ labels: [] });
    const a = await insertIssue();

    const { runId } = await claim([a]);

    expect((await stored(a)).status).toBe('releasing');
    expect(await releaseRunnerOf(runId)).toMatchObject({ preferenceMet: false });
  });

  it('releases on the eligible box where the only labelled box is below the claim floor', async () => {
    await declareProduction();
    await seedBox({ labels: [RELEASE_LABEL], agentVersion: '0.10.0' });
    await seedBox({ labels: [] });
    const a = await insertIssue();

    const { runId } = await claim([a]);

    expect((await stored(a)).status).toBe('releasing');
    expect(await releaseRunnerOf(runId)).toMatchObject({ preferenceMet: false });
  });

  it('refuses RELEASE_POOL_EMPTY where the project has no runner at all', async () => {
    await declareProduction();
    const a = await insertIssue();

    await expect(claim([a])).rejects.toThrow('RELEASE_POOL_EMPTY');

    expect(await stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
  });

  it('refuses NO_RUNNER_ONLINE where every registered box is ineligible', async () => {
    await declareProduction();
    await seedBox({ labels: [RELEASE_LABEL], status: 'offline' });
    await seedBox({ labels: [], status: 'offline' });
    const a = await insertIssue();

    await expect(claim([a])).rejects.toThrow('NO_RUNNER_ONLINE');

    expect(await stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
  });

  // ISS-1275 — anhome held 30 issues at the gate for seven hours for want of a
  // string whose own refusal said any value would do. Nothing declared is the
  // ordinary state of a project that has expressed no preference, so it admits
  // the pool the way every other job type already reaches it.
  it('opens a batch where no binding names a label at all', async () => {
    await declareProduction();
    await withdrawLabel();
    await seedBox({ labels: [] });
    const a = await insertIssue();

    const { runId } = await claim([a]);

    expect(runId).toBeTruthy();
    expect((await stored(a)).status).toBe('releasing');
  });

  // Nothing was preferred, so nothing went unhonoured: `preferenceMet` reads
  // true beside a null label rather than reporting a preference nobody made.
  it('records no label and a preference nothing broke where none was declared', async () => {
    await declareProduction();
    await withdrawLabel();
    await seedBox({ labels: [] });
    const a = await insertIssue();

    const { runId } = await claim([a]);

    expect(await releaseRunnerOf(runId)).toEqual({ label: null, preferenceMet: true });
  });

  it('tells the release agent the label, whether it was met, and the box that took the job', async () => {
    await declareProduction();
    await seedBox({ labels: [] });
    const a = await insertIssue();
    const { runId, jobId } = await claim([a]);
    const took = await seedBox({ labels: [] });
    await harness.db.execute(sql`
      UPDATE jobs SET device_id = ${took} WHERE id = ${jobId}
    `);

    const { loadReleaseBatchContext } = await import('../../src/release-batch/queries.js');

    expect((await loadReleaseBatchContext(runId))?.releaseRunner).toEqual({
      label: RELEASE_LABEL,
      preferenceMet: false,
      claimedByDeviceId: took,
    });
  });
});
