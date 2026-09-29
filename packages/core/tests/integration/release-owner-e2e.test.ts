/**
 * ISS-1281 — a release is owned by the run session a project's master opens over exactly its
 * roster, and by nothing else.
 *
 * Integration, because every proposition here is about rows under real locks: which of two
 * masters' opens finds the release row still waiting under `FOR UPDATE`, and whether a refused
 * take leaves any session, run or lease standing. What happens once the owner is gone is
 * `release-owner-loss-e2e`.
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
import { RELEASE_LABEL, releaseBatchFixture } from '../helpers/release-batch-fixture.js';
import { DRAINING, refusalOf, releaseOwnerProbes } from '../helpers/release-owner-probes.js';

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
  await fx.declareProduction();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);
const { insertIssue, stored, claim, take, runStatus, seedReleaseRunner } = fx;

const { ownerOf, counts, endSession } = releaseOwnerProbes(() => harness);

describe('the door refuses a release no box could own, naming every box once', () => {
  it('names each box by the one thing stopping it, and claims nothing', async () => {
    await seedReleaseRunner({ name: 'offline-box', runnerStatus: 'offline' });
    await seedReleaseRunner({ name: 'masterless-box', master: false });
    await seedReleaseRunner({ name: 'old-box', capabilities: { releaseRole: false } });
    await seedReleaseRunner({ name: 'unreported-box', capabilities: null });
    await seedReleaseRunner({ name: 'draining-box', capabilities: DRAINING });
    const a = await insertIssue();

    const err = await refusalOf(claim([a]));

    expect(err.code).toBe('RELEASE_NO_OWNER');
    const reasons = Object.fromEntries(
      (err.boxes as Array<{ deviceName: string; reason: string }>).map((b) => [
        b.deviceName,
        b.reason,
      ]),
    );
    expect(reasons).toEqual({
      'offline-box': 'runner-held',
      'masterless-box': 'no-master',
      'old-box': 'no-release-role',
      'unreported-box': 'no-release-role',
      'draining-box': 'draining',
    });
    for (const name of Object.keys(reasons)) {
      expect(err.message.split(`\`${name}\``).length - 1, `${name} is named once`).toBe(1);
    }
    expect(err.message).toMatch(/admits no run until \d{4}-\d\d-\d\dT/);
    expect(await stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
    expect(await counts()).toMatchObject({ releases: 0, jobs: 0 });
  });

  it('refuses a roster larger than one run session carries, before anything is written', async () => {
    await seedReleaseRunner();
    const ids: string[] = [];
    for (let i = 0; i < 17; i += 1) ids.push(await insertIssue());

    const err = await refusalOf(claim(ids));

    expect(err.code).toBe('RELEASE_ROSTER_OVER_RUN');
    expect(err.message).toContain('this release names 17');
    expect(await counts()).toMatchObject({ releases: 0 });
    expect((await stored(ids[0] as string)).claim).toBeNull();
  });

  it('cuts sixteen, the most a run session carries', async () => {
    await seedReleaseRunner();
    const ids: string[] = [];
    for (let i = 0; i < 16; i += 1) ids.push(await insertIssue());

    const { runId } = await claim(ids);

    expect(await runStatus(runId)).toBe('running');
  });
});

describe('a release cut and waiting for a master', () => {
  it('writes an awaiting owner, the brief, and no job', async () => {
    const box = await seedReleaseRunner();
    const a = await insertIssue();

    const cut = await claim([a]);

    const owner = await ownerOf(cut.runId);
    expect(owner).toMatchObject({ state: 'awaiting', sessionId: null, refusals: [] });
    expect(owner.deadlineAt).toBe(cut.ownerDeadlineAt);
    expect(await counts()).toMatchObject({ releases: 1, jobs: 0 });

    const { pendingReleases } = await import('../../src/release-batch/owner-take.js');
    const [pending, ...rest] = await pendingReleases(projectId);
    expect(rest).toEqual([]);
    expect(pending?.runId).toBe(cut.runId);
    expect(pending?.issueKeys).toHaveLength(1);
    expect(pending?.mayTake).toEqual([{ deviceId: box.deviceId, deviceName: box.deviceName }]);
    expect(pending?.brief).toContain(`runId: ${cut.runId}`);
    expect(pending?.brief).toContain('### Who owns this release');
    expect(pending?.brief).toContain('### Ordering contract');
  });

  it('puts the roster on the admissible list of the box that may take it, and no other', async () => {
    const able = await seedReleaseRunner();
    const draining = await seedReleaseRunner({ capabilities: DRAINING });
    const a = await insertIssue();
    await claim([a]);

    const { readAdmissibleIssues } = await import('../../src/devices/admissible.js');
    const listed = async (deviceId: string) =>
      (await readAdmissibleIssues({ deviceId })).map((i) => i.issueId);

    expect(await listed(able.deviceId)).toContain(a);
    expect(await listed(draining.deviceId)).not.toContain(a);
  });

  it('reads on the run screen what stops each box', async () => {
    await seedReleaseRunner({ name: 'able-box' });
    await seedReleaseRunner({ name: 'masterless-box', master: false });
    const a = await insertIssue();
    const { runId } = await claim([a]);

    const { readReleaseRunState } = await import('../../src/release-batch/state.js');
    const owner = (await readReleaseRunState(runId))?.owner;

    expect(owner?.state).toBe('awaiting');
    expect(owner?.boxes.map((b) => [b.deviceName, b.able])).toEqual([
      ['able-box', true],
      ['masterless-box', false],
    ]);
  });

  it('is left alone by the orphaned one-shot reaper, which cannot see who owns it', async () => {
    await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET started_at = now() - interval '6 hours' WHERE id = ${runId}
    `);

    const { reapOrphanedOneShotRuns } = await import('../../src/pipeline/sweeper.js');
    await reapOrphanedOneShotRuns(new Date());

    expect(await runStatus(runId)).toBe('running');
  });

  it('is counted by A6 once it has waited past the grace', async () => {
    await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);
    const { alertReleaseUnowned } = await import('../../src/admin/alert-release-owner.js');

    expect((await alertReleaseUnowned(600)).count).toBe(0);
    await harness.db.execute(sql`
      UPDATE pipeline_runs
         SET metadata = jsonb_set(metadata, '{owner,since}', to_jsonb((now() - interval '20 minutes')::text))
       WHERE id = ${runId}
    `);
    const alert = await alertReleaseUnowned(600);
    expect(alert).toMatchObject({ id: 'A6', status: 'warn', count: 1 });
    expect(alert.entities[0]?.ref).toBe(projectId);
  });
});

describe('a master taking the release', () => {
  it('owns it through the run session declared over exactly its roster', async () => {
    const box = await seedReleaseRunner();
    const a = await insertIssue();
    const b = await insertIssue();
    const { runId } = await claim([a, b]);

    const opened = await take(runId, box.deviceId);

    expect(await ownerOf(runId)).toMatchObject({
      state: 'owned',
      sessionId: opened.sessionId,
      deviceId: box.deviceId,
    });
    const rows = (await harness.db.execute(sql`
      SELECT metadata ->> 'releaseRunId' AS release FROM pipeline_runs WHERE id = ${opened.runId}
    `)) as unknown as Array<{ release: string }>;
    expect(rows[0]?.release).toBe(runId);
    const { pendingReleases } = await import('../../src/release-batch/owner-take.js');
    expect(await pendingReleases(projectId)).toEqual([]);
  });

  it('refuses a declaration over part of the roster, opening nothing and saying so on the batch', async () => {
    const box = await seedReleaseRunner();
    const a = await insertIssue();
    const b = await insertIssue();
    const { runId } = await claim([a, b]);
    const before = await counts();

    const err = await refusalOf(take(runId, box.deviceId, [a]));

    expect(err.message).toMatch(
      /^RELEASE_OWNERSHIP_REFUSED: .*declare all of ISS-\d+, ISS-\d+ and nothing else/,
    );
    expect(await counts()).toEqual(before);
    const owner = await ownerOf(runId);
    expect(owner.state).toBe('awaiting');
    expect(owner.refusals.map((r) => r.deviceId)).toEqual([box.deviceId]);
  });

  it('refuses a box that is draining', async () => {
    const box = await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await harness.db.execute(sql`
      UPDATE devices SET capabilities = ${JSON.stringify(DRAINING)}::jsonb WHERE id = ${box.deviceId}
    `);

    const err = await refusalOf(take(runId, box.deviceId));

    expect(err.message).toMatch(/cannot own the release now — .*draining for update/);
    expect((await ownerOf(runId)).state).toBe('awaiting');
  });

  it('refuses the unlabelled box while a labelled one may take it, naming that one', async () => {
    const labelled = await seedReleaseRunner({ name: 'prod-box' });
    const plain = await seedReleaseRunner({ name: 'spare-box', labels: [] });
    const a = await insertIssue();
    const { runId } = await claim([a]);

    const err = await refusalOf(take(runId, plain.deviceId));

    expect(err.message).toContain(`prefers a box labelled \`${RELEASE_LABEL}\``);
    expect(err.message).toContain('`prod-box`');
    await take(runId, labelled.deviceId);
    expect((await ownerOf(runId)).deviceId).toBe(labelled.deviceId);
  });

  it('lets exactly one of two masters racing for it win, and leaves the loser with nothing', async () => {
    const first = await seedReleaseRunner();
    const second = await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);

    const outcomes = await Promise.allSettled([
      take(runId, first.deviceId),
      take(runId, second.deviceId),
    ]);

    const won = outcomes.filter((o) => o.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const winner = (won[0] as PromiseFulfilledResult<{ sessionId: string }>).value;
    expect((await ownerOf(runId)).sessionId).toBe(winner.sessionId);
    expect((await counts()).runSessions).toBe(1);
  });

  it('refuses a second take once it is owned, naming the owner', async () => {
    const box = await seedReleaseRunner();
    const other = await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);
    const opened = await take(runId, box.deviceId);
    await endSession(opened.sessionId);
    await harness.db.execute(sql`DELETE FROM issue_leases`);

    const err = await refusalOf(take(runId, other.deviceId));

    expect(err.message).toContain(`already owned by run session ${opened.sessionId}`);
  });
});
