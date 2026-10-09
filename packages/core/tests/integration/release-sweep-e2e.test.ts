/**
 * ISS-1117 — the ISS-1139/ISS-1114 reproduction, against real Postgres: an issue at
 * `awaiting_release` with a criterion whose latest verdict is `skipped` is left exactly where it is
 * by `sweepAutomaticReleases`, on a project that has otherwise opted all the way into "nobody
 * presses release", while its earned neighbour is cut.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/factories.js';
import {
  AT_RELEASE,
  declareProductionDocument,
  fakeCoolify,
  releaseWorld,
  seedProductionDeployTrigger,
  verdictComment,
} from '../helpers/release-world.js';

const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';
/** A runtime that is not that one: the head a repair replaced, as ISS-1185 carried it. */
const REPLACED = '34450f4420ae4a3b6de40b6d3cfb2b0e66aa2f51';
/** The landing commit: a source, which no deployment answers. */
const LANDED = 'dce6f354c0b7a1e2d3f4a5b6c7d8e9f0a1b2c3d4';
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
  await seedProductionDeployTrigger(projectId, ownerId);
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
      deploysFrom: 'production',
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
