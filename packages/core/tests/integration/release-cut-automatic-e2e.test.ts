/**
 * ISS-1153: a release the sweep cuts reads as cut automatically, never as a person's Cut. On
 * sid-desk 0.20.0 the sweep cut after a landing and the release read `owner: orchestrator,
 * ownerAct: "Cut"`, naming a person who made no cut (VISION: state-never-lies): the sweep enqueues
 * its job as the project's owner, and the read took `jobs.created_by` for the cutter.
 *
 * Against real Postgres, production deploying `on-land`: the sweep cuts one release, a person cuts
 * the next through `POST /api/projects/:id/release-batches`, and the release read names the person
 * on theirs alone.
 *
 * @direct-test-of packages/core/src/release-batch/release-facts.ts
 * @direct-test-of packages/core/src/release-batch/release-cuts.ts
 * @direct-test-of packages/core/src/release-batch/release-read-views.ts
 * @direct-test-of packages/core/src/schedules/release-batch-run.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { releaseEndedRunClaims } from '../../src/issues/index.js';
import { closeRunIfOneShot } from '../../src/pipeline/index.js';
import { stampReleaseShipped } from '../../src/pipeline/run-records.js';
import { readRelease } from '../../src/release-batch/release-read.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { declareCutoff } from '../helpers/release-cutoff-world.js';
import { declareProductionDocument, fakeCoolify, releaseWorld } from '../helpers/release-world.js';

const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const APP = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };
const MINUTE = 60_000;

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
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const bindingId = await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] });
  await declareProductionDocument({ projectId, ownerId, bindingId, trigger: 'on-land' });
  coolify.applications.clear();
  coolify.deployed(APP.resourceUuid, 'dep-1', SERVING, '2026-11-07T11:00:00Z');
  fx.serve(SERVING);
  await fx.seedReleaseRunner();
  await declareCutoff(projectId, null);
});

/** A recording: an issue landed and moved to `awaiting_release`. */
async function recorded(): Promise<string> {
  const id = await fx.insertIssue('awaiting_release');
  await db.execute(
    sql`UPDATE issues SET merged_commit_sha = ${'ab12'.repeat(10)} WHERE id = ${id}`,
  );
  return id;
}

async function versionOf(runId: string): Promise<string> {
  const [row] = await rows<{ v: string }>(
    sql`SELECT release_version AS v FROM pipeline_runs WHERE id = ${runId}`,
  );
  if (!row) throw new Error(`no run ${runId}`);
  return row.v;
}

/** Shipped, and its claims let go as the pipeline sweep does. */
async function ship(runId: string): Promise<void> {
  await stampReleaseShipped(runId);
  await closeRunIfOneShot(runId, 'completed');
  await releaseEndedRunClaims();
}

describe('who cut a release (ISS-1153)', () => {
  it('reads the sweep cut as automatic and a person cut as theirs', async () => {
    const swept = await recorded();
    const cut = await sweepAutomaticReleases(new Date(Date.now() + 11 * MINUTE));
    expect(cut).toMatchObject({ projectsCut: 1, issuesCut: 1 });
    const sweptRun = (await fx.stored(swept)).claim;
    if (!sweptRun) throw new Error('the sweep cut no run');

    const auto = await readRelease(projectId, await versionOf(sweptRun), null);
    expect({ owner: auto.owner, ownerAct: auto.ownerAct }).toEqual({
      owner: null,
      ownerAct: 'Cut automatically',
    });
    expect(auto.cuts.map((c) => ({ cutBy: c.cutBy, cutAs: c.cutAs }))).toEqual([
      { cutBy: null, cutAs: 'automatic' },
    ]);

    await ship(sweptRun);
    const byHand = await recorded();
    const token = await userToken(ownerId);
    const r = await api(token, 'POST', `/api/projects/${projectId}/release-batches`, {
      issueIds: [byHand],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const person = await readRelease(projectId, String(r.body.version), null);
    expect(person.owner?.id).toBe(ownerId);
    expect(person.ownerAct).toBe('Cut');
    expect(person.cuts.map((c) => ({ by: c.cutBy?.id ?? null, cutAs: c.cutAs }))).toEqual([
      { by: ownerId, cutAs: 'person' },
    ]);
  });
});
