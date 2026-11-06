/**
 * A release-batch cut wears the version its owner names (ISS-1034). Found on adminhub-fe 2026-11-06:
 * the owner asked for 1.15.0, stg served it, and production releases through release-batches, whose
 * cut took no version, so it could only wear highest + minor (0.58.0). Through the cut route, against
 * real Postgres: a given version is worn as `given`, refused by name where it is no release version,
 * another release wears it or it is not above the highest claimed, absent changes nothing, and a
 * re-cut of a given run keeps the reuse and bump rules.
 * @direct-test-of packages/core/src/release-batch/version-store.ts
 * @direct-test-of packages/core/src/release-batch/create.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { releaseEndedRunClaims } from '../../src/issues/index.js';
import { closeRunIfOneShot } from '../../src/pipeline/index.js';
import { stampReleaseShipped } from '../../src/pipeline/run-records.js';
import { api, userToken } from '../helpers/api.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
let token: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({ projectId, ownerId, bindingId, probes: 'none' });
});

const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

const send = (issueIds: string[], version?: string) =>
  call('POST', '/release-batches', version === undefined ? { issueIds } : { issueIds, version });

async function cut(issueIds: string[], version?: string) {
  const r = await send(issueIds, version);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { runId: String(r.body.runId), version: String(r.body.version) };
}

/** Shipped, and its claims let go as the pipeline sweep does (ISS-961, RELEASE_HELD_BY_ENDED_RUN). */
async function ship(runId: string): Promise<void> {
  await stampReleaseShipped(runId);
  await closeRunIfOneShot(runId, 'completed');
  await releaseEndedRunClaims();
}

async function abort(runId: string, body: Record<string, unknown>) {
  await db.execute(sql`UPDATE jobs SET dispatched_at = now() WHERE pipeline_run_id = ${runId}`);
  const r = await call('POST', `/release-batches/${runId}/abort`, { reason: 'refused', ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function cutRecord(runId: string) {
  const [row] = await rows<{ cut: Record<string, unknown> }>(
    sql`SELECT metadata -> 'versionCut' AS cut FROM pipeline_runs WHERE id = ${runId}`,
  );
  return row?.cut;
}

const runCount = async () =>
  Number(
    (await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM pipeline_runs`))[0]?.n ?? -1,
  );

/** adminhub-fe's world: one release shipped and worn as 0.57.0, the highest the project claimed. */
async function shippedAt057(): Promise<void> {
  const first = await cut([await fx.insertIssue()]);
  await ship(first.runId);
  await db.execute(
    sql`UPDATE pipeline_runs SET release_version = '0.57.0' WHERE id = ${first.runId}`,
  );
}

function refusal(r: { status: number; body: unknown }) {
  const body = r.body as { error?: { code?: string; details?: unknown } };
  return { status: r.status, text: JSON.stringify(body) };
}

describe('a cut that names its version', () => {
  it('wears 1.15.0 on a project whose highest is 0.57.0, decided `given`', async () => {
    await shippedAt057();
    const named = await cut([await fx.insertIssue()], '1.15.0');
    expect(named.version).toBe('1.15.0');
    expect(await cutRecord(named.runId)).toMatchObject({
      decided: 'given',
      recutOf: null,
      from: null,
      attempt: 1,
    });

    const page = await call('GET', '/releases/1.15.0');
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.release.cuts[0].rule.decided).toBe('given');
  });

  it('takes `v1.15.0` the same way', async () => {
    await shippedAt057();
    const named = await cut([await fx.insertIssue()], 'v1.15.0');
    expect(named.version).toBe('1.15.0');
    expect((await cutRecord(named.runId))?.decided).toBe('given');
  });

  it('refuses a version another release wears, by name, and cuts nothing', async () => {
    await shippedAt057();
    const named = await cut([await fx.insertIssue()], '1.15.0');
    await ship(named.runId);
    const before = await runCount();

    const again = refusal(await send([await fx.insertIssue()], '1.15.0'));
    expect(again.status).toBe(422);
    expect(again.text).toContain('RELEASE_CUT_VERSION_TAKEN');
    expect(again.text).toContain(`release 1.15.0 is already worn by another release`);
    expect(again.text).toContain(named.runId);
    expect(again.text).toContain('/version');
    expect(await runCount()).toBe(before);
  });

  it('refuses a version at or below the highest claimed, by name, naming the highest', async () => {
    await shippedAt057();
    const below = refusal(await send([await fx.insertIssue()], '0.9.0'));
    expect(below.status).toBe(422);
    expect(below.text).toContain('RELEASE_CUT_VERSION_BEHIND');
    expect(below.text).toContain('0.9.0 is not above 0.57.0');

    // at: an attempt ended unshipped still claimed 1.15.0, and no release wears it any more
    const ended = await cut([await fx.insertIssue()], '1.15.0');
    await abort(ended.runId, { pushed: false });
    const before = await runCount();
    const at = refusal(await send([await fx.insertIssue()], '1.15.0'));
    expect(at.status).toBe(422);
    expect(at.text).toContain('RELEASE_CUT_VERSION_BEHIND');
    expect(at.text).toContain('1.15.0 is not above 1.15.0');
    expect(await runCount()).toBe(before);
  });

  it('refuses what is no release version, by name, with the shape that is valid', async () => {
    await shippedAt057();
    const roster = [await fx.insertIssue()];
    const before = await runCount();
    for (const bad of ['latest', '1.15', 'v1.15.0.1', '', '1.15.0-rc']) {
      const r = refusal(await send(roster, bad));
      expect(r.status, bad).toBe(422);
      expect(r.text, bad).toContain('RELEASE_VERSION_SHAPE');
      expect(r.text, bad).toContain('MAJOR.MINOR.PATCH');
    }
    expect(await runCount()).toBe(before);
    expect((await cut(roster, '1.15.0')).version).toBe('1.15.0');
  });

  it('absent, takes the version it took before: highest + minor, decided `first`', async () => {
    await shippedAt057();
    const plain = await cut([await fx.insertIssue()]);
    expect(plain.version).toBe('0.58.0');
    expect((await cutRecord(plain.runId))?.decided).toBe('first');
  });
});

describe('a re-cut of a run first cut with a given version', () => {
  it('reuses the given version where nothing outside Forge carries it', async () => {
    await shippedAt057();
    const roster = [await fx.insertIssue()];
    const first = await cut(roster, '1.15.0');
    await abort(first.runId, { pushed: false });

    const again = await cut(roster);
    expect(again.version).toBe('1.15.0');
    expect(await cutRecord(again.runId)).toMatchObject({
      decided: 'reused',
      recutOf: first.runId,
      from: '1.15.0',
      attempt: 2,
    });
  });

  it('bumps past it where a tag carries it', async () => {
    await shippedAt057();
    const roster = [await fx.insertIssue()];
    const first = await cut(roster, '1.15.0');
    await abort(first.runId, { carried: [{ kind: 'tag', name: 'v1.15.0' }] });

    const again = await cut(roster);
    expect(again.version).toBe('1.16.0');
    expect(await cutRecord(again.runId)).toMatchObject({
      decided: 'bumped',
      recutOf: first.runId,
      from: '1.15.0',
      attempt: 2,
      carriers: [{ kind: 'tag', name: 'v1.15.0' }],
    });
  });

  it('naming the version the rule reuses records the reuse, and naming a higher one records it given', async () => {
    await shippedAt057();
    const roster = [await fx.insertIssue()];
    const first = await cut(roster, '1.15.0');
    await abort(first.runId, { pushed: false });

    const same = await cut(roster, 'v1.15.0');
    expect(same.version).toBe('1.15.0');
    expect(await cutRecord(same.runId)).toMatchObject({ decided: 'reused', attempt: 2 });
    await abort(same.runId, { pushed: false });

    const higher = await cut(roster, '1.20.0');
    expect(higher.version).toBe('1.20.0');
    expect(await cutRecord(higher.runId)).toMatchObject({
      decided: 'given',
      recutOf: same.runId,
      from: '1.15.0',
      attempt: 3,
    });
  });
});
