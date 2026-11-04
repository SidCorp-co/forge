/**
 * ISS-964 (agenfold, 2026-11-04): its production names the commit it serves since 0.123.0, so the
 * release fell back to weighing at what production serves. But agenfold's production moves only by its
 * releases: draft 0.125.0 asked for verdicts at a939c3f, the 0.123.0 build, which holds none of its
 * changes, and refused a pass at each landing as "not a commit this project is serving" — held for ever.
 *
 * Planted as agenfold stands: production deploys `on-land` with a source probe naming its commit, the
 * commit it serves is the one its last release shipped, no `delivery.judgedOn`, and an issue landed
 * after that release with a pass at its landing. The automatic release carries it. And the negative: a
 * production serving a commit no release shipped, which a landing reached, keeps weighing at what is
 * served, and the hold says so. Against real Postgres; production's probe and deployments are planted.
 *
 * @direct-test-of packages/core/src/release-batch/criteria-basis.ts
 * @direct-test-of packages/core/src/release-batch/criteria-hold.ts
 * @direct-test-of packages/core/src/release-batch/hold.ts
 * @direct-test-of packages/core/src/release-batch/release-sweep.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { coverageLandingHolds, criteriaBasisOf } from '../../src/release-batch/criteria-basis.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/factories.js';
import { declareControls } from '../helpers/project-controls.js';
import {
  AT_RELEASE,
  declareProductionDocument,
  fakeCoolify,
  releaseWorld,
} from '../helpers/release-world.js';

// nothing here asks a repository: an ancestry question answers unread
vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
  ancestrySourceFor: async () => ({
    kind: 'box',
    why: 'the planted box',
    reader: {
      async ask(pairs: readonly { commit: string; release: string }[]) {
        return new Map(pairs.map((p) => [`${p.commit}@${p.release}`, { unread: 'no history' }]));
      },
      witness: () => ({ via: 'source-host' }),
    },
  }),
}));

/** a939c3f, the 0.123.0 build production serves. */
const SERVED = 'a939c3f00000000000000000000000000000c3f0';
/** Where ISS-146 landed after it, as 240ea9204d63 did. */
const LANDED = '240ea9204d6300000000000000000000000000ab';
const APP = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };

let projectId: string;
let ownerId: string;
const coolify = fakeCoolify();
const fx = releaseWorld(() => ({ projectId, ownerId }));

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
  await declareControls(projectId, ownerId, { delivery: { verdictsRequired: true } });
  const bindingId = await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] });
  // production on `main`, deployed on land by the automatic release, its probe naming its commit
  await declareProductionDocument({ projectId, ownerId, bindingId, trigger: 'on-land' });
  coolify.applications.clear();
  coolify.deployed(APP.resourceUuid, 'dep-123', SERVED, '2026-11-04T13:03:00Z');
  fx.serve(SERVED);
  await fx.seedReleaseRunner();
});

/** A release that shipped `commit` an hour ago, as a finished release batch records it. */
async function shipped(version: string, commit: string): Promise<void> {
  const at = new Date(Date.now() - 60 * 60_000).toISOString();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, created_at, release_version,
                               release_released_at, metadata)
    VALUES (${randomUUID()}, ${projectId}, 'system', 'completed', ${at}::timestamptz,
            ${at}::timestamptz, ${version}, ${at}::timestamptz,
            ${JSON.stringify({ source: 'release-batch', finish: { requestId: randomUUID(), state: 'finished', commit, version: 1 } })}::jsonb)
  `);
}

/** ISS-146: landed at LANDED just now, both criteria passed at that landing commit. */
const landedAfter = () => fx.judgedRow(LANDED, new Date().toISOString());

describe('a production that moves only by its releases weighs a waiting issue at its landing', () => {
  it('carries an issue landed after the served release on a pass at its landing commit', async () => {
    await shipped('0.123.0', SERVED);
    const id = await landedAfter();

    const basis = await criteriaBasisOf(projectId);
    expect(basis).toMatchObject({ kind: 'landing', why: 'release-only', deployment: 'on-land' });
    const result = await sweepAutomaticReleases();

    expect(result, JSON.stringify(await fx.holdOf(id))).toMatchObject({ issuesCut: 1 });
    expect(await fx.stored(id)).toMatchObject(AT_RELEASE);
    expect(await fx.holdOf(id)).toBeNull();
    // a requirement's coverage reads the same basis
    expect(await coverageLandingHolds(projectId, [id])).not.toBeNull();
  });

  it('holds one with no pass naming its landing commit and the true reason, never the served build', async () => {
    await shipped('0.123.0', SERVED);
    const id = await fx.insertIssue('awaiting_release', undefined, true, ['works', 'still works']);
    await db.execute(sql`UPDATE issues SET merged_commit_sha = ${LANDED} WHERE id = ${id}`);

    await sweepAutomaticReleases();

    const hold = await fx.holdOf(id);
    expect(hold?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(hold?.reason).toContain(`judged at its landing commit \`${LANDED.slice(0, 12)}\``);
    expect(hold?.reason).toContain('production is deployed only by a release');
    expect(hold?.reason).toContain('every commit it serves is one a release shipped');
    expect(hold?.reason).not.toContain(SERVED);
  });
});

describe('a production a landing reached keeps weighing at what it serves', () => {
  it('holds a pass at the landing alone, naming the served basis and why', async () => {
    // production serves a commit no release shipped: something deployed it on land
    await shipped('0.123.0', 'b'.repeat(40));
    const id = await landedAfter();

    expect(await criteriaBasisOf(projectId)).toEqual({
      kind: 'serving',
      why: 'on-land',
      judgedOn: null,
    });
    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 0, issuesExcluded: 1 });
    const hold = await fx.holdOf(id);
    expect(hold?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(hold?.reason).toContain(
      "It is weighed at what this project's production serves, which deploys on land",
    );
    expect(hold?.reason).toContain(SERVED);
    expect(await coverageLandingHolds(projectId, [id])).toBeNull();
  });
});
