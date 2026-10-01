/**
 * ISS-1346 criteria 17 and 19 — which times in a hold's words make it a new reason, proved by the
 * sweep over real rows. The judge could reach neither live: no scratch runner reports a reset, and
 * no deployment's recorded time moves without a new deployment. Here each time is moved in the
 * database with nothing else in the sentence moving, and what the sweep leaves on the row is read.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CoolifyTarget, fakeCoolify } from '../helpers/coolify-deployments.js';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  seedProductionDeployTrigger,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const SERVED = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const OLDER = '0d98a6be6d9680b967d3f16542eadd25d02602cb';
const MERGED = '2026-09-29T09:00:00Z';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
const coolify = fakeCoolify();

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

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);
const { holdOf, holdComments } = fx;

beforeEach(async () => {
  await truncateAll(harness.db);
  coolify.applications.clear();
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await seedProductionDeployTrigger(harness.db, projectId, owner.id);
  await fx.seedReleaseRunner();
});

async function sweep() {
  const { sweepAutomaticReleases } = await import('../../src/pipeline/release-sweep.js');
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
  return sweepAutomaticReleases();
}

describe('a runner reset drifting inside its minute is one reason (criterion 17)', () => {
  // Fixed UTC instants in the future, either side of a minute boundary: no wall clock decides which
  // minute a reset falls in (consult 5d63c5 F1).
  const FIRST = '2099-01-01T12:34:10.790Z';
  const SAME_MINUTE = '2099-01-01T12:34:50.375Z';
  const NEXT_MINUTE = '2099-01-01T12:35:10.000Z';

  it.each([
    ['rate_limited_until', 'is rate limited until'],
    ['quarantined_until', 'is quarantined until'],
  ] as const)(
    'comments once while %s moves inside the minute, and again once it leaves it',
    async (column, says) => {
      const app = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };
      await fx.declareProduction({ baseUrl: coolify.url(), targets: [app] });
      await seedProductionDeployTrigger(harness.db, projectId, ownerId, 'on-land');
      coolify.deployed(app.resourceUuid, 'dep-1', SERVED, '2026-09-29T11:00:00Z');
      fx.serve(SERVED);
      const id = await fx.judgedRow(SERVED, MERGED);
      const resetTo = async (at: string) => {
        const rows = (await harness.db.execute(sql`
        UPDATE runners SET ${sql.raw(column)} = ${at}::timestamptz WHERE project_id = ${projectId}
        RETURNING ${sql.raw(column)} AS reset
      `)) as unknown as Array<{ reset: string | Date }>;
        expect(rows.map((r) => new Date(r.reset).toISOString())).toEqual([at]);
      };

      await resetTo(FIRST);
      await sweep();
      const held = await holdOf(id);
      expect(held?.code).toBe('NO_RUNNER_ONLINE');
      expect(String(held?.reason)).toContain(`${says} ${FIRST}`);
      expect(await holdComments(id)).toBe(1);

      await resetTo(SAME_MINUTE);
      await sweep();
      expect(await holdComments(id)).toBe(1);

      await resetTo(NEXT_MINUTE);
      await sweep();
      expect(String((await holdOf(id))?.reason)).toContain(`${says} ${NEXT_MINUTE}`);
      expect(await holdComments(id)).toBe(2);
    },
    30_000,
  );
});

describe('any other time moving in a hold is a new reason, said once per hold (criterion 19)', () => {
  const APP: CoolifyTarget = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };
  const FINISHED = '2026-09-29T11:00:00.000Z';
  const REFINISHED = '2026-09-29T11:05:00.000Z';
  const recorded = (at: string) =>
    `coolify deployment dep-1 of environment \`live\` (succeeded, ${at})`;

  /** Moves only the time Coolify records: same deployment, same commit. */
  function finishAt(at: string) {
    coolify.applications.set(APP.resourceUuid, []);
    coolify.deployed(APP.resourceUuid, 'dep-1', SERVED, at);
  }

  it('rewrites and comments a moved deployment time, and returning to it posts nothing new', async () => {
    await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] }, 'none');
    await seedProductionDeployTrigger(harness.db, projectId, ownerId, 'on-land');
    finishAt(FINISHED);
    const id = await fx.judgedRow(OLDER, MERGED);
    const reason = async () => String((await holdOf(id))?.reason);

    await sweep();
    expect((await holdOf(id))?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(await reason()).toContain(recorded(FINISHED));
    expect(await holdComments(id)).toBe(1);

    // The first arm: only the recorded time moved, and it is written and said as a new reason.
    finishAt(REFINISHED);
    await sweep();
    expect(await reason()).toContain(recorded(REFINISHED));
    expect(await reason()).not.toContain(FINISHED);
    expect(await holdComments(id)).toBe(2);

    // The unless arm: back to words already commented while the row stayed held.
    finishAt(FINISHED);
    await sweep();
    expect(await reason()).toContain(recorded(FINISHED));
    expect(await holdComments(id)).toBe(2);

    // Held afresh, the same words are said again.
    const { clearReleaseHolds } = await import('../../src/pipeline/release-hold.js');
    await clearReleaseHolds([id]);
    await sweep();
    expect(await holdComments(id)).toBe(3);
  }, 30_000);
});
