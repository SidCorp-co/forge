/**
 * FB-102: an issue and a requirement never named the release that shipped them — dev's REQ-16
 * delivered and named none, and ISS-294's shipping release (dev.72) was only in comment prose. The
 * issue's detail and each issue on its requirement now carry `shippedIn`, and the requirement its
 * `releases`: read off the shipped release runs, the roster each was cut with and the rows it closed
 * afterwards (`metadata.rosterClosed`).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeWorld, type Doc, ok, requester, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestIssue,
  createTestProject,
  createTestRelease,
  createTestRequirement,
  createTestUser,
} from '../helpers/factories.js';

let say: ReturnType<typeof requester>;
let projectId = '';
let owner = '';
const T = (day: number) => new Date(Date.UTC(2026, 9, day));

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  owner = (await createTestUser({ verified: true })).id;
  say = requester(app, { owner: await signUserToken(owner) });
  projectId = (await createTestProject(owner)).id;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('the release that shipped an issue', () => {
  it('names it on the issue and on its requirement, and none while nothing shipped it', async () => {
    const req = await createTestRequirement(projectId, 16, 'Delivered requirement');
    const onRoster = await createTestIssue(projectId, owner, 1, {
      status: 'closed',
      createdAt: T(1),
      mergedAt: T(2),
      requirementId: req.id,
    });
    const closedAfter = await createTestIssue(projectId, owner, 2, {
      status: 'closed',
      createdAt: T(1),
      mergedAt: T(2),
      requirementId: req.id,
    });
    const waiting = await createTestIssue(projectId, owner, 3, {
      status: 'awaiting_release',
      createdAt: T(1),
      mergedAt: T(3),
      requirementId: req.id,
    });
    await createTestRelease(projectId, '0.1.0', [onRoster.id], T(4));
    // an earlier release's commit carried it, and the later release closed it against that ship
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
      VALUES (${randomUUID()}, ${projectId}, 'system', 'completed', ${T(5).toISOString()}, ${T(5).toISOString()},
              '0.1.1', ${T(5).toISOString()}, ${JSON.stringify({ issueIds: [], rosterClosed: [closedAfter.id] })}::jsonb)
    `);

    const issue = async (id: string): Promise<Doc> =>
      ok(await say('owner', 'GET', `/api/issues/${id}?projectId=${projectId}`));
    expect((await issue(onRoster.id)).shippedIn).toMatchObject({ version: '0.1.0' });
    expect((await issue(closedAfter.id)).shippedIn).toMatchObject({ version: '0.1.1' });
    expect((await issue(waiting.id)).shippedIn).toBeNull();

    const detail = ok(
      await say('owner', 'GET', `/api/projects/${projectId}/requirements/${req.key}`),
    );
    expect(
      (detail.issues as Doc[]).map((i) => [
        i.displayId.replace(/^.*-/, ''),
        i.shippedIn?.version ?? null,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['1', '0.1.0'],
        ['2', '0.1.1'],
        ['3', null],
      ]),
    );
    expect((detail.releases as Doc[]).map((r) => r.version)).toEqual(['0.1.0', '0.1.1']);
  });
});
