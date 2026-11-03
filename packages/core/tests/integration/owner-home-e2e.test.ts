/**
 * ISS-919 (FB-483, owner 2026-11-03: every status check is a question in chat). A person's home reads,
 * across every project they read and none they do not: the feedback they gave and the issues they own
 * that are not live, each at its stage; each project's latest release with how many of their items it
 * carried; and a search that says where any item stands, live since a version or still moving.
 * Against real Postgres.
 *
 * @direct-test-of packages/core/src/product-progress/home-routes.ts
 * @direct-test-of packages/core/src/product-progress/home-moving.ts
 * @direct-test-of packages/core/src/product-progress/home-live.ts
 * @direct-test-of packages/core/src/product-progress/home-find.ts
 * @direct-test-of packages/core/src/product-progress/home-stage.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeWorld, type Doc, ok, requester, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

let say: ReturnType<typeof requester>;
let owner = '';
let outsider = '';
let projectId = '';
let slug = '';
let hiddenId = '';
const T = (day: number) => new Date(Date.UTC(2026, 9, day));

/** A release batch that shipped `issueIds` as `version` at `at`, as the release list reads one. */
async function shippedRelease(project: string, version: string, issueIds: string[], at: Date) {
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
    VALUES (${randomUUID()}, ${project}, 'system', 'completed', ${at.toISOString()}, ${at.toISOString()},
            ${version}, ${at.toISOString()}, ${JSON.stringify({ source: 'release-batch', issueIds })}::jsonb)
  `);
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  owner = (await createTestUser({ verified: true })).id;
  outsider = (await createTestUser({ verified: true })).id;
  say = requester(app, {
    owner: await signUserToken(owner),
    outsider: await signUserToken(outsider),
  });
  ({ id: projectId, slug } = await createTestProject(owner));
  // a project the owner cannot read: its items and releases never reach the owner's home
  hiddenId = (await createTestProject(outsider)).id;

  const shipped = await createTestIssue(projectId, owner, 1, {
    status: 'closed',
    createdAt: T(1),
    mergedAt: T(2),
  });
  await createTestIssue(projectId, owner, 2, { status: 'in_progress', createdAt: T(3) });
  await createTestIssue(projectId, owner, 3, {
    status: 'awaiting_release',
    createdAt: T(3),
    mergedAt: T(4),
  });
  await createTestIssue(projectId, owner, 4, { status: 'open', createdAt: T(3) });
  await createTestIssue(projectId, owner, 5, { status: 'dropped', createdAt: T(3) });
  await shippedRelease(projectId, '1.2.0', [shipped.id], T(5));
  await createTestFeedback(projectId, owner, 1);
  const hiddenIssue = await createTestIssue(hiddenId, outsider, 1, {
    status: 'closed',
    createdAt: T(1),
    mergedAt: T(2),
  });
  await shippedRelease(hiddenId, '9.9.9', [hiddenIssue.id], T(6));
  await createTestIssue(hiddenId, outsider, 2, { status: 'open', createdAt: T(3) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("a person's home", () => {
  it('lists what the person gave and owns that is not live, each at its stage, and no date it does not hold', async () => {
    const home = ok(await say('owner', 'GET', '/api/me/home'));
    const moving = home.moving as Doc[];
    const stageOf = (key: string) => moving.find((m) => m.key === key)?.stage ?? null;
    expect(stageOf('ISS-2')).toBe('building');
    expect(stageOf('ISS-3')).toBe('landed');
    expect(stageOf('ISS-4')).toBe('planned');
    expect(stageOf('FB-1')).toBe('new');
    // closed and dropped are over: not moving
    expect(stageOf('ISS-1')).toBeNull();
    expect(stageOf('ISS-5')).toBeNull();
    // nothing of the project the owner cannot read
    expect(new Set(moving.map((m) => m.projectSlug))).toEqual(new Set([slug]));
    expect(moving.filter((m) => m.kind === 'issue')).toHaveLength(3);
    // a row with no forecast holds no date: null, never a guess
    for (const m of moving)
      expect(m.likelyBy === null || typeof m.likelyBy === 'string').toBe(true);
    expect(moving.find((m) => m.key === 'FB-1')?.likelyBy).toBeNull();
  });

  it("names each readable project's latest release and how many of the person's items it carried", async () => {
    const home = ok(await say('owner', 'GET', '/api/me/home'));
    const live = home.live as Doc[];
    expect(live.map((l) => l.version)).toEqual(['1.2.0']);
    expect(live[0]).toMatchObject({ environment: 'production', mine: 1 });
  });

  it('finds a live item as live since its version, a moving one at its stage, and nothing the person cannot read', async () => {
    const find = async (q: string) =>
      ok(await say('owner', 'GET', `/api/me/home/find?q=${encodeURIComponent(q)}`)).items as Doc[];
    const [liveOne] = await find('ISS-1');
    expect(liveOne).toMatchObject({
      key: 'ISS-1',
      standing: { kind: 'live', environment: 'production', version: '1.2.0' },
    });
    expect(liveOne?.standing.since).toBe(T(5).toISOString());
    const [moving] = await find('ISS-3');
    expect(moving).toMatchObject({ key: 'ISS-3', standing: { kind: 'moving', stage: 'landed' } });
    const [dropped] = await find('ISS-5');
    expect(dropped).toMatchObject({ standing: { kind: 'ended', how: 'dropped' } });
    // a title word, across the readable project only: the hidden project's `issue 1` is not found
    const byWord = await find('issue');
    expect(byWord.length).toBeGreaterThan(0);
    expect(new Set(byWord.map((f) => f.projectSlug))).toEqual(new Set([slug]));
  });

  it('refuses a query too short to search, by name', async () => {
    const res = await say('owner', 'GET', '/api/me/home/find?q=a');
    expect(res.status).toBe(400);
  });

  it("gives the outsider their own project's release, never the owner's", async () => {
    const home = ok(await say('outsider', 'GET', '/api/me/home'));
    expect((home.live as Doc[]).map((l) => l.version)).toEqual(['9.9.9']);
    expect((home.moving as Doc[]).map((m) => m.key)).toEqual(['ISS-2']);
  });
});
