/**
 * ISS-1346 criteria 17 and 19 — which times in a hold's words make it a new reason, proved by the
 * sweep over real rows: each time is moved in the database with nothing else in the sentence
 * moving, and the `release_holds` records the sweep leaves are read.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { clearReleaseHolds } from '../../src/release-batch/hold.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import {
  fakeCoolify,
  releaseWorld,
  seedProductionDeployTrigger,
} from '../helpers/release-world.js';

const SERVED = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const OLDER = '0d98a6be6d9680b967d3f16542eadd25d02602cb';
const MERGED = '2026-09-29T09:00:00Z';
const APP = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };

let projectId: string;
let ownerId: string;
const coolify = fakeCoolify();
const fx = releaseWorld(() => ({ projectId, ownerId }));
const { holdOf, holdHistory } = fx;
const sweep = () => sweepAutomaticReleases();

beforeEach(async () => {
  await truncateAll();
  coolify.applications.clear();
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
  await seedProductionDeployTrigger(projectId, ownerId);
  await fx.seedReleaseRunner();
});

describe('a runner reset drifting inside its minute is one reason (criterion 17)', () => {
  const FIRST = '2099-01-01T12:34:10.790Z';
  const SAME_MINUTE = '2099-01-01T12:34:50.375Z';
  const NEXT_MINUTE = '2099-01-01T12:35:10.000Z';

  it.each([
    ['rate_limited_until', 'is rate limited until'],
    ['quarantined_until', 'is quarantined until'],
  ] as const)(
    'writes once while %s moves inside the minute, and again once it leaves it',
    async (column, says) => {
      await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] });
      await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
      coolify.deployed(APP.resourceUuid, 'dep-1', SERVED, '2026-09-29T11:00:00Z');
      fx.serve(SERVED);
      const id = await fx.judgedRow(SERVED, MERGED);
      const resetTo = async (at: string) => {
        const reset = await rows<{ reset: string | Date }>(sql`
        UPDATE runners SET ${sql.raw(column)} = ${at}::timestamptz WHERE project_id = ${projectId}
        RETURNING ${sql.raw(column)} AS reset
      `);
        expect(reset.map((r) => new Date(r.reset).toISOString())).toEqual([at]);
      };

      await resetTo(FIRST);
      await sweep();
      const held = await holdOf(id);
      expect(held?.code).toBe('NO_RUNNER_ONLINE');
      expect(held?.reason).toContain(`${says} ${FIRST}`);
      expect(await holdHistory(id)).toHaveLength(1);

      await resetTo(SAME_MINUTE);
      await sweep();
      expect(await holdHistory(id)).toHaveLength(1);

      await resetTo(NEXT_MINUTE);
      await sweep();
      expect((await holdOf(id))?.reason).toContain(`${says} ${NEXT_MINUTE}`);
      expect(await holdHistory(id)).toHaveLength(2);
    },
  );
});

describe('any other time moving in a hold is a new reason (criterion 19)', () => {
  const FINISHED = '2026-09-29T11:00:00.000Z';
  const REFINISHED = '2026-09-29T11:05:00.000Z';
  const recorded = (at: string) =>
    `coolify deployment dep-1 of environment \`live\` (succeeded, ${at})`;

  /** Moves only the time Coolify records: same deployment, same commit. */
  function finishAt(at: string) {
    coolify.applications.set(APP.resourceUuid, []);
    coolify.deployed(APP.resourceUuid, 'dep-1', SERVED, at);
  }

  it('records a moved deployment time as a new reason, and a hold written afresh after a clear', async () => {
    await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] }, 'none');
    await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
    finishAt(FINISHED);
    const id = await fx.judgedRow(OLDER, MERGED);
    const reason = async () => String((await holdOf(id))?.reason);

    await sweep();
    expect((await holdOf(id))?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(await reason()).toContain(recorded(FINISHED));
    expect(await holdHistory(id)).toHaveLength(1);

    await sweep();
    expect(await holdHistory(id)).toHaveLength(1);

    finishAt(REFINISHED);
    await sweep();
    expect(await reason()).toContain(recorded(REFINISHED));
    expect(await reason()).not.toContain(FINISHED);
    expect(await holdHistory(id)).toHaveLength(2);

    await clearReleaseHolds([id]);
    await sweep();
    expect(await holdHistory(id)).toHaveLength(3);
    expect(await reason()).toContain(recorded(REFINISHED));
  });

  it('keeps one record while only the moment the probe was read moves', async () => {
    await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] });
    await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
    finishAt(FINISHED);
    fx.serve(SERVED);
    const id = await fx.judgedRow(OLDER, MERGED);

    await sweep();
    const first = String((await holdOf(id))?.reason);
    expect(first).toMatch(/read at \d{4}-\d\d-\d\dT/);
    await new Promise((r) => setTimeout(r, 20));
    await sweep();

    expect(await holdHistory(id)).toHaveLength(1);
    expect((await holdOf(id))?.reason).toBe(first);
  });
});

describe('the sweep acts on what the database holds, not a cached read', () => {
  it('reads the runner afresh each tick: a reset cleared lets the next tick cut', async () => {
    await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] });
    await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
    coolify.deployed(APP.resourceUuid, 'dep-1', SERVED, '2026-09-29T11:00:00Z');
    fx.serve(SERVED);
    const id = await fx.judgedRow(SERVED, MERGED);
    await db.execute(
      sql`UPDATE runners SET rate_limited_until = '2099-01-01T00:00:00Z' WHERE project_id = ${projectId}`,
    );
    await sweep();
    expect((await holdOf(id))?.code).toBe('NO_RUNNER_ONLINE');

    await db.execute(
      sql`UPDATE runners SET rate_limited_until = NULL WHERE project_id = ${projectId}`,
    );
    const result = await sweep();

    expect(result.issuesCut).toBe(1);
    expect(await holdOf(id)).toBeNull();
  });
});
