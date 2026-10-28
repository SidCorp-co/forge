/**
 * ISS-1117 — the ISS-1139/ISS-1114 reproduction, against real Postgres: an issue at
 * `awaiting_release` with a criterion whose latest verdict is `skipped` is left exactly where it is
 * by `sweepAutomaticReleases`, on a project that has otherwise opted all the way into "nobody
 * presses release", while its earned neighbour is cut.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { collectReleaseBlockers } from '../../src/release-batch/blockers.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { readServingNow } from '../../src/release-batch/serving-reading.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/factories.js';
import {
  AT_RELEASE,
  declareProductionDocument,
  fakeCoolify,
  PRODUCTION_PROBE,
  releaseWorld,
  seedProductionDeployTrigger,
  seedProjectDocument,
  verdictComment,
} from '../helpers/release-world.js';

// `dev` as sidcorp-mail's ISS-5 saw it: its landing, a later dev head holding it (3c9aa69, after the
// fix e52423c landed under ISS-6), and a commit on no line that holds it
const H = vi.hoisted(() => {
  const landed = 'dce6f354c0b7a1e2d3f4a5b6c7d8e9f0a1b2c3d4';
  const later = '3c9aa6900000000000000000000000000000e523';
  const aside = 'a51de00000000000000000000000000000000b2c';
  const holds: Record<string, readonly string[]> = { [later]: [later, landed], [aside]: [aside] };
  return { landed, later, aside, holds };
});

vi.mock('../../src/release-batch/shipped-earlier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/shipped-earlier.js')>()),
  ancestrySourceFor: async () => ({
    kind: 'box',
    why: 'the planted box',
    reader: {
      async ask(pairs: readonly { commit: string; release: string }[]) {
        const out = new Map<string, boolean | { unread: string }>();
        for (const p of pairs) {
          const held = H.holds[p.release];
          out.set(
            `${p.commit}@${p.release}`,
            held ? held.includes(p.commit) : { unread: 'no history' },
          );
        }
        return out;
      },
      witness: () => ({ via: 'source-host' }),
    },
  }),
}));

const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';
/** A runtime that is not that one: the head a repair replaced, as ISS-1185 carried it. */
const REPLACED = '34450f4420ae4a3b6de40b6d3cfb2b0e66aa2f51';
/** The landing commit: a source, which no deployment answers. */
const LANDED = H.landed;
const APP = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };

function verdictBlock(criterion: number, verdict: string, at = `runtime: ${SERVING}`): string {
  return [
    `criterion: ${criterion}`,
    `verdict: ${verdict}`,
    at,
    'evidence: judge-evidence.txt',
    'why: exercised directly',
    'judge: judge-1',
    'judge-from: inherited',
  ].join('\n');
}

let projectId: string;
let ownerId: string;
let bindingId: string;
const coolify = fakeCoolify();
const fx = releaseWorld(() => ({ projectId, ownerId }));
const { stored, holdOf } = fx;

/** A waiting row with `n` criteria, landed at `LANDED`, carrying `blocks` as its verdicts. */
async function waitingRow(n: number, blocks: string[]): Promise<string> {
  const id = await fx.insertIssue(
    'awaiting_release',
    undefined,
    true,
    Array.from({ length: n }, (_, i) => `criterion ${i + 1}`),
  );
  const landing = JSON.stringify({ landing: { head: LANDED, deployment: SERVING } });
  await db.execute(sql`UPDATE issues SET session_context = ${landing}::jsonb WHERE id = ${id}`);
  await fx.postVerdict(id, verdictComment(blocks));
  return id;
}

// a commit verdict emits `verdict.recorded`, whose delivery job needs the queue the server boots
beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
  bindingId = await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] });
  // work lands on the branch production deploys from, so landing IS deploying production and a
  // criterion is earned at what production serves (the sidcorp-mail shape below crosses a promotion)
  await declareProductionDocument({ projectId, ownerId, bindingId, trigger: 'on-land' });
  coolify.applications.clear();
  coolify.deployed(APP.resourceUuid, 'dep-1', SERVING, '2026-09-29T11:00:00Z');
  fx.serve(SERVING);
  await fx.seedReleaseRunner();
});

describe('release sweep (ISS-1117)', () => {
  it('cuts the earned issue and leaves the ISS-1139-shaped skipped one untouched, held', async () => {
    const earnedId = await waitingRow(2, [verdictBlock(1, 'pass'), verdictBlock(2, 'pass')]);
    const unearnedId = await waitingRow(2, [verdictBlock(1, 'pass'), verdictBlock(2, 'skipped')]);
    const before = await stored(unearnedId);

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 1, issuesExcluded: 1, projectsCut: 1 });
    const earned = await stored(earnedId);
    expect(earned).toMatchObject(AT_RELEASE);
    expect(earned.claim).not.toBeNull();
    expect(await stored(unearnedId)).toEqual(before);
    expect((await holdOf(unearnedId))?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect((await holdOf(unearnedId))?.reason).toContain('criterion 2');
    expect(await holdOf(earnedId)).toBeNull();
  });

  it('cuts a release for a project that declares no probe, writing no hold (ISS-1321)', async () => {
    await declareProductionDocument({
      projectId,
      ownerId,
      bindingId,
      probes: 'none',
      trigger: 'on-land',
    });
    const id = await waitingRow(1, [verdictBlock(1, 'pass')]);

    const result = await sweepAutomaticReleases();

    expect(result.issuesCut).toBe(1);
    expect(await stored(id)).toMatchObject(AT_RELEASE);
    expect(await holdOf(id)).toBeNull();
  });

  it('touches nothing when every waiting issue is unearned', async () => {
    const id = await waitingRow(1, [verdictBlock(1, 'skipped')]);
    const before = await stored(id);

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 0, issuesExcluded: 1, projectsCut: 0 });
    expect(await stored(id)).toEqual(before);
  });

  it('leaves an issue whose every criterion passed at a runtime a repair replaced', async () => {
    const id = await waitingRow(2, [
      verdictBlock(1, 'pass', `runtime: ${REPLACED}`),
      verdictBlock(2, 'pass', `runtime: ${REPLACED}`),
    ]);
    const before = await stored(id);

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 0, issuesExcluded: 1 });
    expect(await stored(id)).toEqual(before);
    expect((await holdOf(id))?.reason).toContain(REPLACED);
  });

  it('holds an issue whose pass names only a source no deployment answers, naming what is served once', async () => {
    const id = await waitingRow(1, [verdictBlock(1, 'pass', `commit: ${LANDED}`)]);
    const before = await stored(id);

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 0, issuesExcluded: 1 });
    expect(await stored(id)).toEqual(before);
    const reason = String((await holdOf(id))?.reason);
    expect((await holdOf(id))?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(reason).toContain(`criterion 1: judged at ${LANDED}`);
    expect(reason).toContain('which is not a commit this project is serving');
    expect(reason.split(SERVING)).toHaveLength(2);
    expect(reason).toContain(`judged at a commit this project is serving — \`${SERVING}\``);
  });

  it('does nothing for a project whose production deploys on request', async () => {
    await seedProductionDeployTrigger(projectId, ownerId, 'on-request');
    const id = await waitingRow(1, [verdictBlock(1, 'pass')]);

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 0, issuesExcluded: 0, holdsWritten: 0 });
    const after = await stored(id);
    expect(after.status).toBe('awaiting_release');
    expect(after.claim).toBeNull();
  });

  it('skips a row an aborted release left for a person, and weighs its neighbour', async () => {
    const blocked = await waitingRow(1, [verdictBlock(1, 'pass')]);
    const neighbour = await waitingRow(1, [verdictBlock(1, 'skipped')]);
    const { abortBlockedHold, writeReleaseHolds } = await import('../../src/release-batch/hold.js');
    await writeReleaseHolds({
      projectId,
      issueIds: [blocked],
      holdFor: () =>
        abortBlockedHold({
          projectId,
          version: '1.2.3',
          reason: 'the production database needs a person.',
          waitingFor: 'a person to migrate the database',
        }),
      now: new Date(),
    });

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 0, issuesExcluded: 1 });
    expect((await holdOf(blocked))?.code).toBe('RELEASE_ABORT_BLOCKED');
    expect((await stored(blocked)).claim).toBeNull();
    expect((await holdOf(neighbour))?.code).toBe('RELEASE_CRITERIA_UNEARNED');
  });
});

// sidcorp-mail (project a417a126), 2026-10-27: work lands on `dev`, production deploys `master` on
// land, and the promotion dev → master IS the release. The hold demanded ISS-1's criteria be earned
// at what production served (225fb35), which can never hold the change before the release that
// promotes it: every waiting issue was held for ever, RELEASE_CRITERIA_UNEARNED. Approval required.
describe('a promotion stands between where work lands and what production deploys', () => {
  async function sidcorpMailShape(judgedOn?: string): Promise<void> {
    await seedProjectDocument(projectId, ownerId, {
      defaultBranch: 'dev',
      promotions: [{ from: 'dev', to: 'master', via: 'merge' }],
      environments: {
        dev: { tier: 'dev', deploysFrom: 'dev', deployment: { mode: 'external' } },
        live: {
          tier: 'production',
          deploysFrom: 'master',
          deployment: { binding: bindingId, trigger: 'on-land' },
          verification: {
            runtime: [
              { type: 'http', url: PRODUCTION_PROBE, path: 'commit', identifies: 'source' },
            ],
          },
        },
      } as never,
      extra: {
        release: { approval: { required: true }, changeRequests: false },
        ...(judgedOn ? { delivery: { judgedOn } } : {}),
      } as never,
    });
  }

  /** A waiting row merged on `dev` as `LANDED`, carrying `blocks` as its verdicts. */
  async function landedRow(blocks: string[]): Promise<string> {
    const id = await waitingRow(blocks.length, blocks);
    await db.execute(sql`UPDATE issues SET merged_commit_sha = ${LANDED} WHERE id = ${id}`);
    return id;
  }

  it('cuts an issue whose criteria passed at its landing commit, where today it is held', async () => {
    await sidcorpMailShape();
    const id = await landedRow([
      verdictBlock(1, 'pass', `commit: ${LANDED}`),
      verdictBlock(2, 'pass', `commit: ${LANDED}`),
    ]);

    const serving = await readServingNow(projectId);
    const report = await collectReleaseBlockers(projectId, { door: 'batch', serving });
    expect(report.blockers.map((b) => b.code)).not.toContain('RELEASE_CRITERIA_UNEARNED');
    expect(report.warnings.map((w) => w.code)).not.toContain('RELEASE_CRITERIA_HELD_BACK');

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 1, issuesExcluded: 0 });
    expect(await stored(id)).toMatchObject(AT_RELEASE);
    expect(await holdOf(id)).toBeNull();
  });

  it('counts a runtime verdict at the landing commit on the environment `delivery.judgedOn` names', async () => {
    await sidcorpMailShape('dev');
    const id = await landedRow([verdictBlock(1, 'pass', `runtime: ${LANDED}`)]);

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 1, issuesExcluded: 0 });
    expect(await holdOf(id)).toBeNull();
  });

  it('still holds an issue judged at what production serves, naming its landing commit', async () => {
    await sidcorpMailShape();
    const id = await landedRow([verdictBlock(1, 'pass', `runtime: ${SERVING}`)]);
    const before = await stored(id);

    const serving = await readServingNow(projectId);
    const report = await collectReleaseBlockers(projectId, { door: 'batch', serving });
    const held = report.blockers.find((b) => b.code === 'RELEASE_CRITERIA_UNEARNED');
    expect(held?.message).toContain('owes criterion 1');
    expect(held?.message).not.toContain('without a person acting');

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 0, issuesExcluded: 1 });
    expect(await stored(id)).toEqual(before);
    const hold = await holdOf(id);
    expect(hold?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(hold?.reason).toContain(`landing commit \`${LANDED.slice(0, 12)}\``);
    expect(hold?.reason).toContain('`dev`');
    expect(hold?.reason).not.toContain('serving');
  });

  // sidcorp-mail ISS-5, 2026-10-28: held RELEASE_CRITERIA_UNEARNED on C6, which passes at dev
  // 3c9aa69, a later dev head holding its landing 58ecb43; requirement coverage already counted it
  it('cuts an issue whose criterion passed at a later commit that holds its landing', async () => {
    await sidcorpMailShape();
    const id = await landedRow([
      verdictBlock(1, 'pass', `commit: ${LANDED}`),
      verdictBlock(2, 'pass', `commit: ${H.later}`),
    ]);

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 1, issuesExcluded: 0 });
    expect(await holdOf(id)).toBeNull();
  });

  it('counts a runtime pass on `delivery.judgedOn` at a later commit that holds the landing', async () => {
    await sidcorpMailShape('dev');
    const id = await landedRow([verdictBlock(1, 'pass', `runtime: ${H.later}`)]);

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 1, issuesExcluded: 0 });
    expect(await holdOf(id)).toBeNull();
  });

  it('still holds a pass at a commit that does not hold the landing, naming both', async () => {
    await sidcorpMailShape();
    const id = await landedRow([verdictBlock(1, 'pass', `commit: ${H.aside}`)]);

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 0, issuesExcluded: 1 });
    const hold = await holdOf(id);
    expect(hold?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(hold?.reason).toContain(`\`${H.aside.slice(0, 12)}\`, which does not hold`);
  });
});
