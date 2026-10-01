/**
 * ISS-1346 — on an automatic-release project with no `verify.probes`, what Forge itself deployed
 * through the project's Coolify binding is what a verdict is weighed against; where nothing can
 * report a commit, the project is told once. Real Postgres, and a Coolify that answers deployment
 * records over HTTP, because what is asserted is what a sweep tick leaves on the rows.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeCoolify,
  recordForgeDeployment,
  type CoolifyTarget as Target,
} from '../helpers/coolify-deployments.js';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  seedProductionDeployTrigger,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { RELEASE_LABEL, releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const SERVED = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const OLDER = '0d98a6be6d9680b967d3f16542eadd25d02602cb';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
const coolify = fakeCoolify();
const deployments = coolify.deployments;

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
  deployments.clear();
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await seedProductionDeployTrigger(harness.db, projectId, owner.id);
  await fx.seedReleaseRunner();
});

const APP: Target = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };
const API: Target = { id: 't-api', label: 'Api', resourceUuid: 'api-uuid' };
const WEB: Target = { id: 't-web', label: 'Web', resourceUuid: 'web-uuid' };

/** A live Coolify binding declaring no probe, as anhome's and portal-lighthuman's are. */
async function bindCoolify(targets: Target[] = [APP]): Promise<string> {
  await fx.declareProduction({ baseUrl: coolify.url(), targets }, 'none');
  const rows = (await harness.db.execute(sql`
    SELECT id FROM integration_bindings WHERE project_id = ${projectId}
  `)) as unknown as Array<{ id: string }>;
  return String(rows[0]?.id);
}

function deployed(bindingId: string, target: Target, uuid: string, at: string, sent?: string) {
  return recordForgeDeployment(harness, bindingId, target, uuid, at, sent);
}

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

describe('what Forge deployed is the reading where no probe is declared', () => {
  it('names the commit of the latest finished Forge deployment of the target, not an older one', async () => {
    const binding = await bindCoolify();
    deployments.set('dep-old', OLDER);
    deployments.set('dep-new', SERVED);
    await deployed(binding, APP, 'dep-old', '2026-09-29T10:00:00Z');
    await deployed(binding, APP, 'dep-new', '2026-09-29T11:00:00Z');

    const reading = await servingNow();

    expect(reading.kind).toBe('serving');
    if (reading.kind !== 'serving') return;
    expect(reading.served.map((s) => s.commit)).toEqual([SERVED]);
    const where = reading.served[0]?.where ?? '';
    expect(where).toContain("Coolify target `App` (live), Forge's deployment dep-new finished");
    expect(where).not.toContain('dep-old');
  });

  it('names a target with no Forge deployment, and one whose record fails, while the answering one decides', async () => {
    const binding = await bindCoolify([APP, API, WEB]);
    deployments.set('dep-app', SERVED);
    deployments.set('dep-api', 503);
    await deployed(binding, APP, 'dep-app', '2026-09-29T11:00:00Z');
    await deployed(binding, API, 'dep-api', '2026-09-29T11:00:00Z');

    const reading = await servingNow();

    expect(reading.kind).toBe('serving');
    if (reading.kind !== 'serving') return;
    expect(reading.served.map((s) => s.commit)).toEqual([SERVED]);
    const unread = reading.unread.join('\n');
    expect(unread).toContain('`Web` (live) has no deployment Forge made and saw finish on record');
    expect(unread).toMatch(/dep-api to Coolify target `Api` \(live\).*could not be read/);
  });

  it('counts a rollback Forge made to the target as what it now runs', async () => {
    const binding = await bindCoolify();
    deployments.set('dep-deploy', SERVED);
    deployments.set('dep-rollback', OLDER);
    await deployed(binding, APP, 'dep-deploy', '2026-09-29T10:00:00Z');
    await deployed(
      binding,
      APP,
      'dep-rollback',
      '2026-09-29T11:00:00Z',
      'deploy.rollback.requested',
    );

    expect(await commitsServed()).toEqual([OLDER]);
  });

  // Review 1881fe F2: the label is a name; the target is its id and the resource it points at.
  it('does not carry a deployment of the old resource onto a target repointed under the same label', async () => {
    const binding = await bindCoolify([{ ...APP, resourceUuid: 'new-app-uuid' }]);
    deployments.set('dep-old-resource', SERVED);
    await deployed(binding, APP, 'dep-old-resource', '2026-09-29T11:00:00Z');

    const reading = await servingNow();

    expect(reading.kind).toBe('unreadable');
  });

  it("keeps a target's deployment when only its label changed", async () => {
    const binding = await bindCoolify([{ ...APP, label: 'Frontend' }]);
    deployments.set('dep-renamed', SERVED);
    await deployed(binding, APP, 'dep-renamed', '2026-09-29T11:00:00Z');

    expect(await commitsServed()).toEqual([SERVED]);
  });

  it('says unreadable, naming the target, where the route exists and nothing is on record yet', async () => {
    await bindCoolify();
    const reading = await servingNow();
    expect(reading.kind).toBe('unreadable');
    if (reading.kind !== 'unreadable') return;
    expect(reading.why).toContain('`App` (live) has no deployment Forge made and saw finish');
  });
});

describe('a row held before the route existed is carried by the next sweep', () => {
  it('claims a row whose commit: verdicts name what Forge deployed, over the hold it already carried', async () => {
    const binding = await bindCoolify();
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
    deployments.set('dep-1', SERVED);
    await deployed(binding, APP, 'dep-1', '2026-09-29T11:00:00Z');

    const result = await sweep();

    expect(result.issuesCut).toBe(1);
    expect((await fx.stored(id)).status).toBe('releasing');
    expect(await holdOf(id)).toBeNull();
  }, 30_000);

  it('holds a row judged at a commit Forge is no longer serving, naming the deployment it read', async () => {
    const binding = await bindCoolify();
    const id = await waitingRow(OLDER, '2026-09-29T09:00:00Z');
    deployments.set('dep-2', SERVED);
    await deployed(binding, APP, 'dep-2', '2026-09-29T11:00:00Z');

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    const hold = await holdOf(id);
    expect(hold?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(String(hold?.reason)).toContain(
      `\`${SERVED}\` at Coolify target \`App\` (live), Forge's deployment dep-2 finished`,
    );
    expect(String(hold?.reason)).not.toContain('commitUrl');
  }, 30_000);

  // Judge finding 2: staging and production on two commits is a project between releases.
  it('pairs each served commit with the target running it, and calls two commits no fault', async () => {
    const binding = await bindCoolify([APP, WEB]);
    const id = await waitingRow(OLDER, '2026-09-29T09:00:00Z');
    const other = '9f3b2c1d0e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c';
    deployments.set('dep-app', SERVED);
    deployments.set('dep-web', other);
    await deployed(binding, APP, 'dep-app', '2026-09-29T11:00:00Z');
    await deployed(binding, WEB, 'dep-web', '2026-09-29T10:00:00Z');

    await sweep();

    const reason = String((await holdOf(id))?.reason);
    expect(reason).toContain(
      `\`${SERVED}\` at Coolify target \`App\` (live), Forge's deployment dep-app`,
    );
    expect(reason).toContain(
      `\`${other}\` at Coolify target \`Web\` (live), Forge's deployment dep-web`,
    );
    expect(reason).not.toContain('more than one commit is running');
  }, 30_000);
});

describe('a project nothing can read is told once', () => {
  /** A live binding through a provider whose deployments name no commit. */
  async function bindUnreporting(): Promise<void> {
    const connectionId = randomUUID();
    await harness.db.execute(sql`
      UPDATE projects SET base_branch = 'main',
             release_chain = '[{"branch": "main"}, {"branch": "production", "from": "merge-branch"}]'::jsonb
       WHERE id = ${projectId}
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connectionId}, 'user', ${ownerId}, 'epodsystem', true)
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
      VALUES (${connectionId}, ${projectId}, 'epodsystem', 'deploy', ARRAY['live']::text[], true,
              ${JSON.stringify({ releaseRunnerLabel: RELEASE_LABEL })}::jsonb)
    `);
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
    await harness.db.execute(sql`UPDATE issues SET status = 'developed' WHERE id = ${oldest}`);

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
    expect(said).toContain('What is missing: its deploy bindings go through epodsystem');
    expect(said).toContain('The way to give it one: declare `verify.probes`');
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
      expect(said).toContain('declare `verify.probes` on the live deploy binding');
      expect(said).not.toMatch(/Coolify/);
    }
  }, 30_000);
});

describe('a reason every waiting row shares is said once (judge finding 1)', () => {
  /** A preview-only binding through a provider that reports no commit: still no live target. */
  async function bindPreviewOnly(): Promise<void> {
    const connectionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connectionId}, 'user', ${ownerId}, 'epodsystem', true)
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
      VALUES (${connectionId}, ${projectId}, 'epodsystem', 'deploy', ARRAY['preview']::text[], true, '{}'::jsonb)
    `);
  }

  // Review 32467c F1: with no live target the gate refuses first, whatever preview bindings exist.
  it.each([
    ['no binding at all', false],
    ['only a preview binding that reports no commit', true],
  ])(
    'holds every row RELEASE_TARGET_UNDECLARED with %s, commenting the oldest alone',
    async (_, preview) => {
      await harness.db.execute(sql`
      UPDATE projects SET base_branch = 'main', release_chain = '[{"branch": "main"}]'::jsonb
       WHERE id = ${projectId}
    `);
      if (preview) await bindPreviewOnly();
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
        expect(String(hold?.reason)).toContain(
          'no active deploy binding carrying the `live` stage',
        );
      }
      expect(await holdComments(oldest)).toBe(1);
      expect(await holdComments(middle)).toBe(0);
      expect(await holdComments(newest)).toBe(0);
      expect(codes.filter((c) => c === 'RELEASE_TARGET_UNDECLARED')).toHaveLength(1);
      expect(codes).not.toContain('RELEASE_RUNTIME_UNROUTED');
    },
    30_000,
  );

  // Review 834824 F1: a row commented before this change already carries the per-row wording.
  it('posts no second comment on an oldest row that carries the per-row wording of the same hold', async () => {
    await harness.db.execute(sql`
      UPDATE projects SET base_branch = 'main', release_chain = '[{"branch": "main"}]'::jsonb
       WHERE id = ${projectId}
    `);
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
    const binding = await bindCoolify();
    deployments.set('dep-1', SERVED);
    await deployed(binding, APP, 'dep-1', '2026-09-29T11:00:00Z');
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
