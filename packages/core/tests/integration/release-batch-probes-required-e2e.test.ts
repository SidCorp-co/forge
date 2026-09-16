/**
 * ISS-1042 criteria 1 and 2 — a project with no probes may not run a release.
 *
 * `finishReleaseBatch` wrapped its whole verification in `if (channel.verify)`,
 * so a project that declared a release gate and no probes fell straight through
 * to the closes: every claimed issue reached `closed` on the sentence an agent
 * wrote about its own work, and `finish` is the only thing in Forge that writes
 * `closed` past the gate. The refusal now stands at BOTH doors — creation, so
 * the operator is told before anything moves, and finish, because a run created
 * before this rule existed reaches the close with no probes.
 *
 * Integration rather than unit: what is under test is `resolveReleaseChannel`
 * reading a real binding row, and a mocked channel would assert the predicate
 * this change writes rather than the hole it closes. The fixture declares
 * probes by default now, so `{ verify: null }` is the shape of a project that
 * declares none.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
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

  // cm:guard the refusal must land BEFORE the claim, and the assertion on the issue's status is
  // what says so. A refusal thrown after the CAS update would leave the roster at `releasing`
  // under a run nobody will ever finish, which is worse than the hole it replaces.
  it('refuses to create a batch, naming RELEASE_PROBES_UNDECLARED, and claims nothing', async () => {
    await declareProduction({ verify: null });
    await seedReleaseRunner();
    const a = await insertIssue();

    await expect(claim([a])).rejects.toThrow('RELEASE_PROBES_UNDECLARED');

    expect(await stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
  });

  // cm:guard a run created BEFORE this rule existed is the case this exists for, and it is why the
  // refusal cannot live at creation alone. Seeded by claiming with probes and then taking them
  // away, which is the same world that run wakes up in.
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

  // cm:guard the counterexample: the SAME path with probes declared closes the roster. Without it
  // the two refusals above are satisfied by a `finish` that refuses everything.
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
