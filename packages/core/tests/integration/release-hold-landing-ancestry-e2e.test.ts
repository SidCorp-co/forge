/**
 * ISS-997 (agenfold, FB-506, 2026-11-05): ISS-171 landed at 7e24f05 and waited in draft 0.140.0. Its
 * hold said it was weighed at what production serves, "a commit no release shipped", and asked for
 * verdicts at 87a8c61, which is the commit v0.139.0 shipped and does not hold 7e24f05: no verdict there
 * could be about ISS-171, so the hold could never be earned.
 *
 * Planted as agenfold stood: production deploys `on-land`, a Coolify deployment names the commit it
 * serves, that commit is the one release 0.139.0 shipped, and ISS-171 landed before 0.139.0 was
 * stamped shipped (so production's reading keeps the served basis) without being in it. What the
 * served commit holds of the landing is the project's ancestry source's answer, planted per case.
 * Against real Postgres; production's deployment is planted.
 *
 * @direct-test-of packages/core/src/release-batch/criteria-hold-words.ts
 * @direct-test-of packages/core/src/release-batch/runtime-weighing.ts
 * @direct-test-of packages/core/src/release-batch/criteria-basis.ts
 * @direct-test-of packages/core/src/release-batch/release-sweep.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import type { AncestrySource } from '../../src/release-batch/ancestry-source.js';
import { criteriaBasisOf } from '../../src/release-batch/criteria-basis.js';
import { draftedVersion } from '../../src/release-batch/draft-version.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/factories.js';
import { declareControls } from '../helpers/project-controls.js';
import { declareProductionDocument, fakeCoolify, releaseWorld } from '../helpers/release-world.js';

/** 87a8c61, the commit release 0.139.0 shipped and production serves. */
const SERVED = '87a8c6100000000000000000000000000000c610';
/** 7e24f05, where ISS-171 landed. */
const LANDED = '7e24f05000000000000000000000000000000f05';
const APP = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };

/** What the project's ancestry source answers about the landing under what production serves. */
let ancestry: 'holds' | 'lacks' | 'none' = 'lacks';
const NO_HOST =
  "the project's repository binding cannot serve: its GitHub App installation was removed";

vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
  ancestrySourceFor: async (): Promise<AncestrySource> => {
    if (ancestry === 'none') return { kind: 'none', why: NO_HOST };
    return {
      kind: 'box',
      why: 'the planted box',
      reader: {
        async ask(pairs) {
          return new Map(
            pairs.map((p) => [
              `${p.commit}@${p.release}`,
              p.commit === LANDED && p.release === SERVED
                ? ancestry === 'holds'
                : { unread: 'no history' },
            ]),
          );
        },
        witness: () => ({ via: 'source-host' }),
      },
    };
  },
}));

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
  ancestry = 'lacks';
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
  await declareControls(projectId, ownerId, { delivery: { verdictsRequired: true } });
  const bindingId = await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] });
  await declareProductionDocument({ projectId, ownerId, bindingId, trigger: 'on-land' });
  coolify.applications.clear();
  coolify.deployed(APP.resourceUuid, 'jskc4skwgk88c0kg4cko44c8', SERVED, '2026-11-05T04:40:00Z');
  fx.serve(SERVED);
  await fx.seedReleaseRunner();
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** Release `version`, cut at `commit` and stamped shipped `shippedAgo` minutes ago. */
async function shipped(version: string, commit: string, shippedAgo: number): Promise<void> {
  const at = minutesAgo(shippedAgo);
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, created_at, release_version,
                               release_released_at, metadata)
    VALUES (${randomUUID()}, ${projectId}, 'system', 'completed', ${minutesAgo(shippedAgo + 60)}::timestamptz,
            ${minutesAgo(shippedAgo + 60)}::timestamptz, ${version}, ${at}::timestamptz,
            ${JSON.stringify({ source: 'release-batch', finish: { requestId: randomUUID(), state: 'finished', commit, version: 1 } })}::jsonb)
  `);
}

/** ISS-171: landed at LANDED 45 minutes ago, before 0.139.0 was stamped shipped, no verdict yet. */
async function landedBeforeTheStamp(): Promise<string> {
  const id = await fx.insertIssue('awaiting_release', undefined, true, ['works', 'still works']);
  await db.execute(sql`
    UPDATE issues SET merged_commit_sha = ${LANDED}, merged_at = ${minutesAgo(45)}::timestamptz
     WHERE id = ${id}
  `);
  return id;
}

describe('a release hold asks for verdicts only at a commit holding the landing (ISS-997)', () => {
  it('names no commit where production serves a shipped release that does not hold the landing', async () => {
    await shipped('0.139.0', SERVED, 30);
    const id = await landedBeforeTheStamp();
    // the served basis stands, as it did for agenfold's 0.140.0
    expect(await criteriaBasisOf(projectId)).toMatchObject({ kind: 'serving' });
    const draft = await draftedVersion(projectId);

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 0, issuesExcluded: 1 });
    const hold = await fx.holdOf(id);
    expect(hold?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    const reason = String(hold?.reason);
    expect(reason).not.toContain(SERVED.slice(0, 7));
    expect(reason).not.toContain(LANDED.slice(0, 7));
    expect(reason).toContain(
      "production serves no commit that holds this issue's landing yet (read from the box holding this project's checkout)",
    );
    expect(reason).toContain(
      `its criteria are owed after the release that carries it, release ${draft}, drafted from what waits at the gate`,
    );
    expect(reason).toContain('`POST /api/projects/:id/release-batches` with `issueIds`');
    // what the served commit is, from the records: never "a commit no release shipped"
    expect(reason).toContain('production serves (the commit release 0.139.0 shipped)');
    expect(reason).not.toContain('a commit no release shipped');
    expect(hold?.waitingFor).toBe(
      'the release that carries it to ship, then a verdict on each criterion named',
    );
  });

  it('asks for verdicts at what production serves where it holds the landing', async () => {
    ancestry = 'holds';
    await shipped('0.139.0', SERVED, 30);
    const id = await landedBeforeTheStamp();

    await sweepAutomaticReleases();

    const reason = String((await fx.holdOf(id))?.reason);
    expect(reason).toContain(`judged at a commit this project is serving — \`${SERVED}\``);
    expect(reason).toContain('production serves (the commit release 0.139.0 shipped)');
    expect(reason).not.toContain('owed after the release');
  });

  it('says by name why it cannot tell where no ancestry can be read, and asks at no commit', async () => {
    ancestry = 'none';
    await shipped('0.139.0', SERVED, 30);
    const id = await landedBeforeTheStamp();

    await sweepAutomaticReleases();

    const hold = await fx.holdOf(id);
    const reason = String(hold?.reason);
    expect(reason).toContain(
      `whether what production serves holds this issue's landing could not be read: ${NO_HOST}, so no commit is named here to judge at`,
    );
    expect(reason).toContain(`\`git merge-base --is-ancestor ${LANDED} ${SERVED}\``);
    expect(reason).not.toContain('judged at a commit this project is serving');
    expect(hold?.waitingFor).toBe(
      'a verdict on each criterion named at a served commit shown to hold its landing, or the release that carries it',
    );
  });

  it('says a served commit no release names is one, never that it is a release', async () => {
    ancestry = 'holds';
    // production serves a commit no release shipped: the release Forge recorded is elsewhere
    await shipped('0.139.0', 'b'.repeat(40), 30);
    const id = await landedBeforeTheStamp();

    await sweepAutomaticReleases();

    const reason = String((await fx.holdOf(id))?.reason);
    expect(reason).toContain('production serves (a commit no release names)');
    expect(reason).not.toContain('0.139.0 shipped');
  });
});
