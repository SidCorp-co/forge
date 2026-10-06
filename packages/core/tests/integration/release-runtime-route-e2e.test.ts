/**
 * ISS-1346, ISS-12 — on an automatic-release project, what production runs is its environment
 * state: the latest deployment Coolify records for production's application, beside any runtime
 * probe the project document declares. A verdict is weighed against it; where nothing can report a
 * commit, the project is told once. Real Postgres, and a Coolify that answers its deployment list
 * over HTTP, because what is asserted is what a sweep tick leaves on the rows.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { loadReleaseReadiness } from '../../src/release-batch/readiness.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { readServingNow, servedCommits } from '../../src/release-batch/serving-reading.js';
import {
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import {
  AT_RELEASE,
  fakeCoolify,
  RELEASE_LABEL,
  releaseWorld,
  seedProduction,
  seedProductionDeployTrigger,
} from '../helpers/release-world.js';

const SERVED = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const OLDER = '0d98a6be6d9680b967d3f16542eadd25d02602cb';

let projectId: string;
let ownerId: string;
const coolify = fakeCoolify();
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeEach(async () => {
  await truncateAll();
  coolify.applications.clear();
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
  await seedProductionDeployTrigger(projectId, ownerId);
  await fx.seedReleaseRunner();
});

const APP = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };

/** Production deploying on land through a Coolify binding, declaring no probe or one. */
async function bindCoolify(probes: 'none' | 'source' = 'none'): Promise<void> {
  await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] }, probes);
  await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
}

const deployed = (uuid: string, commit: string, at: string, status?: string) =>
  coolify.deployed(APP.resourceUuid, uuid, commit, at, status);

const record = (uuid: string, at: string) =>
  `coolify deployment ${uuid} of environment \`live\` (succeeded, ${at})`;

const { judgedRow: waitingRow, holdOf, holdHistory } = fx;
const sweep = () => sweepAutomaticReleases();
const servingNow = () => readServingNow(projectId);

async function commitsServed() {
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
    await db.execute(sql`
      INSERT INTO release_holds (project_id, issue_id, code, reason, owes, waiting_for, held_at)
      VALUES (${projectId}, ${id}, 'RELEASE_CRITERIA_UNEARNED',
              'judged against source … but no runtime witnessed it', 'human',
              'a verdict on each criterion named at the running deployment', '2026-09-28T10:00:00Z')
    `);
    deployed('dep-1', SERVED, '2026-09-29T11:00:00Z');

    const result = await sweep();

    expect(result.issuesCut).toBe(1);
    expect(await fx.stored(id)).toMatchObject(AT_RELEASE);
    expect(await holdOf(id)).toBeNull();
  });

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
  });

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
  });
});

describe('a project nothing can read is told once', () => {
  /** Production deploying through a provider whose adapter reads no deployment history. */
  async function bindUnreporting(): Promise<void> {
    await seedProduction({
      projectId,
      ownerId,
      provider: 'epodsystem',
      config: { releaseRunnerLabel: RELEASE_LABEL },
      probes: 'none',
      trigger: 'on-land',
      deploysFrom: 'production',
    });
  }

  it('holds every owing row with the one unrouted reason, and a second sweep writes nothing', async () => {
    await bindUnreporting();
    const oldest = await waitingRow(SERVED, '2026-09-27T09:00:00Z');
    const middle = await waitingRow(SERVED, '2026-09-28T09:00:00Z');
    const newest = await waitingRow(OLDER, '2026-09-29T09:00:00Z');

    const first = await sweep();

    const reasons = new Set<string>();
    for (const id of [oldest, middle, newest]) {
      const hold = await holdOf(id);
      expect(hold?.code).toBe('RELEASE_RUNTIME_UNROUTED');
      expect(hold?.reason).toContain('epodsystem');
      reasons.add(String(hold?.reason));
    }
    expect(reasons.size).toBe(1);
    expect(first.holdsWritten).toBe(3);
    expect((await sweep()).holdsWritten).toBe(0);
    expect(await holdHistory(oldest)).toHaveLength(1);
  });

  it('clears the hold of a row that left the gate, and keeps its neighbours held', async () => {
    await bindUnreporting();
    const oldest = await waitingRow(SERVED, '2026-09-27T09:00:00Z');
    const next = await waitingRow(SERVED, '2026-09-28T09:00:00Z');
    await sweep();
    await seedIssueStatus(oldest, 'reopen');

    await sweep();

    expect(await holdOf(oldest)).toBeNull();
    expect((await holdOf(next))?.code).toBe('RELEASE_RUNTIME_UNROUTED');
    expect(await holdHistory(next)).toHaveLength(1);
  });

  it('answers one project-level blocker naming what is missing, in place of the per-row one', async () => {
    await bindUnreporting();
    const later = await waitingRow(SERVED, '2026-09-28T09:00:00Z');
    const earlier = await waitingRow(SERVED, '2026-09-27T09:00:00Z');

    const readiness = await loadReleaseReadiness(projectId);

    const codes = readiness?.blockers.map((b) => b.code) ?? [];
    expect(codes.filter((c) => c === 'RELEASE_RUNTIME_UNROUTED')).toHaveLength(1);
    expect(codes).not.toContain('RELEASE_CRITERIA_UNEARNED');
    const unrouted = readiness?.blockers.find((b) => b.code === 'RELEASE_RUNTIME_UNROUTED');
    expect(unrouted?.message).toContain('epodsystem');
    expect(unrouted?.message).not.toContain('Held: 2 issue(s)');
    expect(unrouted?.message.match(/`ISS-\d+` owes criteria 1, 2/g)).toHaveLength(2);
    const [first, second] = await fx.displayIds([earlier, later]);
    expect(unrouted?.message).toContain(`\`${first}\` owes criteria 1, 2; \`${second}\``);
  });

  it('names the route, not a judging run, where only some waiting rows owe a criterion', async () => {
    await bindUnreporting();
    const owing = await waitingRow(SERVED, '2026-09-27T09:00:00Z');
    await fx.insertIssue();

    const readiness = await loadReleaseReadiness(projectId);

    const said = readiness?.warnings.find((w) => w.code === 'RELEASE_CRITERIA_HELD_BACK')?.message;
    expect(said).toContain(`\`${(await fx.displayIds([owing]))[0]}\` owes criteria 1, 2`);
    expect(said).toContain('What is missing: DEPLOY_HISTORY_UNSUPPORTED');
    expect(said).toContain('goes through epodsystem');
    expect(said).toContain('The way to give it one: declare a runtime probe on the production');
    expect(said).toContain('no judging run can earn one until the project can be read');
    expect(said).not.toContain('still owes a judging run');
  });

  it('offers a project bound through a provider that reports nothing only a route it can take', async () => {
    await bindUnreporting();
    const id = await waitingRow(SERVED, '2026-09-27T09:00:00Z');

    await sweep();
    const readiness = await loadReleaseReadiness(projectId);

    const hold = String((await holdOf(id))?.reason);
    const card = readiness?.blockers.find((b) => b.code === 'RELEASE_RUNTIME_UNROUTED')?.message;
    for (const said of [hold, String(card)]) {
      expect(said).toContain('declare a runtime probe on the production environment');
      expect(said).not.toMatch(/Coolify/);
    }
  });
});

describe('a reason every waiting row shares is one blocker on the card (judge finding 1)', () => {
  it('holds every row RELEASE_TARGET_UNDECLARED where production deploys through a binding the project does not hold', async () => {
    const newest = await waitingRow(SERVED, '2026-09-29T09:00:00Z');
    const oldest = await waitingRow(SERVED, '2026-09-27T09:00:00Z');
    const middle = await waitingRow(SERVED, '2026-09-28T09:00:00Z');

    await sweep();
    await sweep();
    const codes = (await loadReleaseReadiness(projectId))?.blockers.map((b) => b.code) ?? [];

    for (const id of [oldest, middle, newest]) {
      const hold = await holdOf(id);
      expect(hold?.code).toBe('RELEASE_TARGET_UNDECLARED');
      expect(hold?.reason).toContain('which is not an active binding');
      expect(await holdHistory(id)).toHaveLength(1);
    }
    expect(codes.filter((c) => c === 'RELEASE_TARGET_UNDECLARED')).toHaveLength(1);
    expect(codes).not.toContain('RELEASE_RUNTIME_UNROUTED');
  });

  /** Every runner of the project rate limited until `until`, as a heartbeat reports it. */
  async function rateLimited(until: string): Promise<void> {
    await db.execute(sql`
      UPDATE runners SET limit_reason = 'rate_limit', rate_limited_until = ${until}::timestamptz
       WHERE project_id = ${projectId}
    `);
  }

  it('holds a refused cut on every row it refused, once, while the reset drifts by milliseconds', async () => {
    await bindCoolify();
    deployed('dep-1', SERVED, '2026-09-29T11:00:00Z');
    const later = await waitingRow(SERVED, '2026-09-29T09:00:00Z');
    const oldest = await waitingRow(SERVED, '2026-09-28T09:00:00Z');
    const reset = new Date(Date.now() + 3_600_000);
    reset.setUTCSeconds(9, 790);
    await rateLimited(reset.toISOString());

    await sweep();
    expect((await holdOf(oldest))?.code).toBe('NO_RUNNER_ONLINE');
    expect((await holdOf(oldest))?.reason).toContain(`rate limited until ${reset.toISOString()}`);
    reset.setUTCMilliseconds(375);
    await rateLimited(reset.toISOString());
    await sweep();

    expect((await holdOf(later))?.code).toBe('NO_RUNNER_ONLINE');
    expect(await holdHistory(oldest)).toHaveLength(1);
    expect(await holdHistory(later)).toHaveLength(1);
  });
});
