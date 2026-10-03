/**
 * ISS-1346, ISS-12 — on an automatic-release project, what production runs is its environment
 * state: the latest deployment Coolify records for production's application, beside any runtime
 * probe the project document declares. A verdict is weighed against it; where nothing can report a
 * commit, the project is told once. Real Postgres, and a Coolify that answers its deployment list
 * over HTTP, because what is asserted is what a sweep tick leaves on the rows.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeCoolify, type CoolifyTarget as Target } from '../helpers/coolify-deployments.js';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  seedProductionDeployTrigger,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { seedProduction } from '../helpers/production.js';
import {
  AT_RELEASE,
  RELEASE_LABEL,
  releaseBatchFixture,
} from '../helpers/release-batch-fixture.js';

const SERVED = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const OLDER = '0d98a6be6d9680b967d3f16542eadd25d02602cb';

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

beforeEach(async () => {
  await truncateAll(harness.db);
  coolify.applications.clear();
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await seedProductionDeployTrigger(harness.db, projectId, owner.id);
  await fx.seedReleaseRunner();
});

const APP: Target = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };

/** Production deploying on land through a Coolify binding, declaring no probe or one. */
async function bindCoolify(probes: 'none' | 'source' = 'none'): Promise<void> {
  await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] }, probes);
  await seedProductionDeployTrigger(harness.db, projectId, ownerId, 'on-land');
}

const deployed = (uuid: string, commit: string, at: string, status?: string) =>
  coolify.deployed(APP.resourceUuid, uuid, commit, at, status);

const record = (uuid: string, at: string) =>
  `coolify deployment ${uuid} of environment \`live\` (succeeded, ${at})`;

const { judgedRow: waitingRow, holdOf, holdComments } = fx;

async function sweep() {
  const { sweepAutomaticReleases } = await import('../../src/pipeline/release-sweep.js');
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
  return sweepAutomaticReleases();
}

async function servingNow() {
  const { readServingNow } = await import('../../src/release-batch/serving-reading.js');
  return readServingNow(projectId);
}

async function commitsServed() {
  const { servedCommits } = await import('../../src/release-batch/serving-reading.js');
  const reading = await servingNow();
  return reading.kind === 'serving' ? servedCommits(reading) : reading;
}

describe("what production's deployment record says is the reading where no probe is declared", () => {
  it('names the commit of the latest finished deployment of the application, not an older one', async () => {
    await bindCoolify();
    deployed('dep-old', OLDER, '2026-09-29T10:00:00Z');
    deployed('dep-new', SERVED, '2026-09-29T11:00:00Z');

    const reading = await servingNow();

    expect(reading.kind).toBe('serving');
    if (reading.kind !== 'serving') return;
    expect(reading.served).toEqual([
      { commit: SERVED, where: record('dep-new', '2026-09-29T11:00:00.000Z') },
    ]);
  });

  it('counts a rollback, which Coolify records as the latest deployment, as what it now runs', async () => {
    await bindCoolify();
    deployed('dep-deploy', SERVED, '2026-09-29T10:00:00Z');
    deployed('dep-rollback', OLDER, '2026-09-29T11:00:00Z');

    expect(await commitsServed()).toEqual([OLDER]);
  });

  it('names nothing served while the latest deployment is still running', async () => {
    await bindCoolify();
    deployed('dep-done', OLDER, '2026-09-29T10:00:00Z');
    deployed('dep-running', SERVED, '2026-09-29T11:00:00Z', 'in_progress');

    const reading = await servingNow();

    expect(reading.kind).toBe('unreadable');
    if (reading.kind !== 'unreadable') return;
    expect(reading.why).toContain('dep-running');
    expect(reading.why).toContain('is not a finished deployment');
  });

  it('says unreadable, naming why, where Coolify fails to list the deployments', async () => {
    await bindCoolify();
    coolify.applications.set(APP.resourceUuid, 503);

    expect((await servingNow()).kind).toBe('unreadable');
  });

  it('says unreadable, naming the binding, where the route exists and nothing is on record yet', async () => {
    await bindCoolify();
    const reading = await servingNow();
    expect(reading.kind).toBe('unreadable');
    if (reading.kind !== 'unreadable') return;
    expect(reading.why).toContain('reports no deployment');
  });
});

describe('a row held before the route existed is carried by the next sweep', () => {
  it('claims a row whose commit: verdicts name what production runs, over the hold it already carried', async () => {
    await bindCoolify();
    const id = await waitingRow(SERVED, '2026-09-29T09:00:00Z');
    const oldHold = {
      at: '2026-09-28T10:00:00.000Z',
      status: 'awaiting_release',
      code: 'RELEASE_CRITERIA_UNEARNED',
      reason: 'judged against source … but no runtime witnessed it',
      owes: 'human',
      waitingFor: 'a verdict on each criterion named at the running deployment',
    };
    await harness.db.execute(sql`
      UPDATE issues SET session_context = jsonb_build_object('releaseHold', ${JSON.stringify(oldHold)}::jsonb)
       WHERE id = ${id}
    `);
    deployed('dep-1', SERVED, '2026-09-29T11:00:00Z');

    const result = await sweep();

    expect(result.issuesCut).toBe(1);
    expect(await fx.stored(id)).toMatchObject(AT_RELEASE);
    expect(await holdOf(id)).toBeNull();
  }, 30_000);

  it('holds a row judged at a commit production no longer runs, naming the deployment it read', async () => {
    await bindCoolify();
    const id = await waitingRow(OLDER, '2026-09-29T09:00:00Z');
    deployed('dep-2', SERVED, '2026-09-29T11:00:00Z');

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    const hold = await holdOf(id);
    expect(hold?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(String(hold?.reason)).toContain(
      `\`${SERVED}\` at ${record('dep-2', '2026-09-29T11:00:00.000Z')}`,
    );
  }, 30_000);

  // Judge finding 2: a probe and a record on two commits is a project between deploys.
  it('pairs each served commit with what answered it, and calls two commits no fault', async () => {
    await bindCoolify('source');
    const id = await waitingRow(OLDER, '2026-09-29T09:00:00Z');
    const other = '9f3b2c1d0e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c';
    fx.serve(other);
    deployed('dep-app', SERVED, '2026-09-29T11:00:00Z');

    await sweep();

    const reason = String((await holdOf(id))?.reason);
    expect(reason).toContain(`\`${SERVED}\` at ${record('dep-app', '2026-09-29T11:00:00.000Z')}`);
    expect(reason).toContain(`\`${other}\` at https://`);
    expect(reason).not.toContain('more than one commit is running');
  }, 30_000);
});

describe('a project nothing can read is told once', () => {
  /** Production deploying through a provider whose adapter reads no deployment history. */
  async function bindUnreporting(): Promise<void> {
    await seedProduction(harness.db, {
      projectId,
      ownerId,
      provider: 'epodsystem',
      config: { releaseRunnerLabel: RELEASE_LABEL },
      probes: 'none',
      trigger: 'on-land',
      deploysFrom: 'production',
    });
  }

  it('holds every owing row with the unrouted hold, commenting the oldest alone', async () => {
    await bindUnreporting();
    const oldest = await waitingRow(SERVED, '2026-09-27T09:00:00Z');
    const middle = await waitingRow(SERVED, '2026-09-28T09:00:00Z');
    const newest = await waitingRow(OLDER, '2026-09-29T09:00:00Z');

    await sweep();

    for (const id of [oldest, middle, newest]) {
      const hold = await holdOf(id);
      expect(hold?.code).toBe('RELEASE_RUNTIME_UNROUTED');
      expect(String(hold?.reason)).toContain('epodsystem');
    }
    expect(await holdComments(oldest)).toBe(1);
    expect(await holdComments(middle)).toBe(0);
    expect(await holdComments(newest)).toBe(0);

    await sweep();
    expect(await holdComments(oldest)).toBe(1);
  }, 30_000);

  it('moves the one comment to the next oldest once the oldest leaves the gate', async () => {
    await bindUnreporting();
    const oldest = await waitingRow(SERVED, '2026-09-27T09:00:00Z');
    const next = await waitingRow(SERVED, '2026-09-28T09:00:00Z');
    const last = await waitingRow(SERVED, '2026-09-29T09:00:00Z');
    await sweep();
    await harness.db.execute(sql`UPDATE issues SET status = 'reopen' WHERE id = ${oldest}`);

    await sweep();
    await sweep();

    expect(await holdComments(next)).toBe(1);
    expect(await holdComments(last)).toBe(0);
  }, 30_000);

  it('answers one project-level blocker naming what is missing, in place of the per-row one', async () => {
    await bindUnreporting();
    const later = await waitingRow(SERVED, '2026-09-28T09:00:00Z');
    const earlier = await waitingRow(SERVED, '2026-09-27T09:00:00Z');
    const { loadReleaseReadiness } = await import('../../src/release-batch/readiness.js');

    const readiness = await loadReleaseReadiness(projectId);

    const codes = readiness?.blockers.map((b) => b.code) ?? [];
    expect(codes.filter((c) => c === 'RELEASE_RUNTIME_UNROUTED')).toHaveLength(1);
    expect(codes).not.toContain('RELEASE_CRITERIA_UNEARNED');
    const unrouted = readiness?.blockers.find((b) => b.code === 'RELEASE_RUNTIME_UNROUTED');
    expect(unrouted?.message).toContain('epodsystem');
    expect(unrouted?.message).not.toContain('Held: 2 issue(s)');
    expect(unrouted?.message.match(/`ISS-\d+` owes criterion 1, 2/g)).toHaveLength(2);
    // Judge r2 finding 5: held rows are listed oldest merge first, not in the order Postgres returns.
    const [first, second] = await fx.displayIds([earlier, later]);
    expect(unrouted?.message).toContain(`\`${first}\` owes criterion 1, 2; \`${second}\``);
  }, 30_000);

  // Judge r2 finding 1: beside rows owing nothing, the card sent a person to a judging run.
  it('names the route, not a judging run, where only some waiting rows owe a criterion', async () => {
    await bindUnreporting();
    const owing = await waitingRow(SERVED, '2026-09-27T09:00:00Z');
    const free = await waitingRow(SERVED, '2026-09-28T09:00:00Z');
    await harness.db.execute(sql`UPDATE issues SET acceptance_criteria = NULL WHERE id = ${free}`);
    const { loadReleaseReadiness } = await import('../../src/release-batch/readiness.js');

    const readiness = await loadReleaseReadiness(projectId);

    const said = readiness?.warnings.find((w) => w.code === 'RELEASE_CRITERIA_HELD_BACK')?.message;
    expect(said).toContain(`\`${(await fx.displayIds([owing]))[0]}\` owes criterion 1, 2`);
    expect(said).toContain('What is missing: DEPLOY_HISTORY_UNSUPPORTED');
    expect(said).toContain('goes through epodsystem');
    expect(said).toContain('The way to give it one: declare a runtime probe on the production');
    expect(said).toContain('no judging run can earn one until the project can be read');
    expect(said).not.toContain('still owes a judging run');
  }, 30_000);

  // Judge finding 4: an epodsystem project cannot deploy through Coolify, so it is not told to.
  it('offers a project bound through a provider that reports nothing only a route it can take', async () => {
    await bindUnreporting();
    const id = await waitingRow(SERVED, '2026-09-27T09:00:00Z');
    const { loadReleaseReadiness } = await import('../../src/release-batch/readiness.js');

    await sweep();
    const readiness = await loadReleaseReadiness(projectId);

    const hold = String((await holdOf(id))?.reason);
    const card = readiness?.blockers.find((b) => b.code === 'RELEASE_RUNTIME_UNROUTED')?.message;
    for (const said of [hold, String(card)]) {
      expect(said).toContain('declare a runtime probe on the production environment');
      expect(said).not.toMatch(/Coolify/);
    }
  }, 30_000);
});

describe('a reason every waiting row shares is said once (judge finding 1)', () => {
  // Review 32467c F1: with nowhere to land a release the gate refuses first.
  it('holds every row RELEASE_TARGET_UNDECLARED where production deploys through a binding the project does not hold, commenting the oldest alone', async () => {
    const newest = await waitingRow(SERVED, '2026-09-29T09:00:00Z');
    const oldest = await waitingRow(SERVED, '2026-09-27T09:00:00Z');
    const middle = await waitingRow(SERVED, '2026-09-28T09:00:00Z');
    const { loadReleaseReadiness } = await import('../../src/release-batch/readiness.js');

    await sweep();
    await sweep();
    const codes = (await loadReleaseReadiness(projectId))?.blockers.map((b) => b.code) ?? [];

    for (const id of [oldest, middle, newest]) {
      const hold = await holdOf(id);
      expect(hold?.code).toBe('RELEASE_TARGET_UNDECLARED');
      expect(String(hold?.reason)).toContain('which is not an active binding');
    }
    expect(await holdComments(oldest)).toBe(1);
    expect(await holdComments(middle)).toBe(0);
    expect(await holdComments(newest)).toBe(0);
    expect(codes.filter((c) => c === 'RELEASE_TARGET_UNDECLARED')).toHaveLength(1);
    expect(codes).not.toContain('RELEASE_RUNTIME_UNROUTED');
  }, 30_000);

  // Review 834824 F1: a row commented before this change already carries the per-row wording.
  it('posts no second comment on an oldest row that carries the per-row wording of the same hold', async () => {
    const oldest = await waitingRow(SERVED, '2026-09-27T09:00:00Z');
    await waitingRow(SERVED, '2026-09-28T09:00:00Z');
    await sweep();
    const { readReleaseHold, releaseHoldComment } = await import(
      '../../src/pipeline/release-hold.js'
    );
    const hold = readReleaseHold(await holdOf(oldest));
    if (!hold) throw new Error('the first sweep wrote no hold');
    await harness.db.execute(sql`
      UPDATE comments SET body = ${releaseHoldComment(hold)}
       WHERE issue_id = ${oldest} AND body LIKE '%release-hold: %'
    `);

    await sweep();

    expect(await holdComments(oldest)).toBe(1);
  }, 30_000);

  /** Every runner of the project rate limited until `until`, as a heartbeat reports it. */
  async function rateLimited(until: string): Promise<void> {
    await harness.db.execute(sql`
      UPDATE runners SET limit_reason = 'rate_limit', rate_limited_until = ${until}::timestamptz
       WHERE project_id = ${projectId}
    `);
  }

  it('comments a refused cut on the oldest row it refused, once, while the reset drifts by milliseconds', async () => {
    await bindCoolify();
    deployed('dep-1', SERVED, '2026-09-29T11:00:00Z');
    const later = await waitingRow(SERVED, '2026-09-29T09:00:00Z');
    const oldest = await waitingRow(SERVED, '2026-09-28T09:00:00Z');
    const reset = new Date(Date.now() + 3_600_000);
    reset.setUTCSeconds(9, 790);
    await rateLimited(reset.toISOString());

    await sweep();
    expect((await holdOf(oldest))?.code).toBe('NO_RUNNER_ONLINE');
    expect(String((await holdOf(oldest))?.reason)).toContain(
      `rate limited until ${reset.toISOString()}`,
    );
    reset.setUTCMilliseconds(375);
    await rateLimited(reset.toISOString());
    await sweep();

    expect((await holdOf(later))?.code).toBe('NO_RUNNER_ONLINE');
    expect(await holdComments(oldest)).toBe(1);
    expect(await holdComments(later)).toBe(0);
  }, 30_000);
});
