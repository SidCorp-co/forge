/**
 * REQ-6 BC-2, BC-4 — the build the web Judge defaults to (`GET /api/issues/:id/judged-build`), read
 * from the releases Forge verified rather than the issue's merge sha, which every forge-dev mark
 * left null (ISS-432 shipped in 0.4.0-dev.192 and the Judge named no commit at all). This project
 * declares no production probe, so the live build cannot be read and the default is the build that
 * shipped the issue, saying why. Which way the live build wins is `judged-build.test.ts`. Through
 * the app's own route, against real Postgres.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';

const SHIPPED = 'e523c4b0ff9038187ad0e7d81f69a3e087c8c252';

let projectId: string;
let ownerId: string;
let token: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
});

/** A release the batch cut and finished at `commit`, carrying `issueIds`. */
async function shipped(version: string, commit: string, issueIds: readonly string[]) {
  const at = new Date().toISOString();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
    VALUES (gen_random_uuid(), ${projectId}, 'system', 'completed', ${at}, ${at}, ${version}, ${at},
            ${JSON.stringify({ issueIds, source: 'release-batch', finish: { state: 'finished', commit } })}::jsonb)`);
}

const judgedBuild = (issueId: string) => api(token, 'GET', `/api/issues/${issueId}/judged-build`);

describe('the build a verdict defaults to, over the route', () => {
  it('is the commit the release that shipped the issue was verified at, where its merge names none', async () => {
    const { id } = await createTestIssue(projectId, ownerId, 432, {
      status: 'closed',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    await shipped('0.4.0-dev.192', SHIPPED, [id]);

    const r = await judgedBuild(id);

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ sha: SHIPPED, source: 'shipped', version: '0.4.0-dev.192' });
    expect(String(r.body.basis)).toContain('the live build could not be read');
  });

  it('names no build where no release carries the issue and its merge names no commit', async () => {
    const { id } = await createTestIssue(projectId, ownerId, 7, {
      status: 'closed',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    await shipped('0.4.0-dev.193', 'bc3764a270cd3bfc228c503f3b1ae2c4eed9411d', []);

    const r = await judgedBuild(id);

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ sha: null, source: null, version: null });
  });

  it('answers only a reader of the project', async () => {
    const { id } = await createTestIssue(projectId, ownerId, 8, {
      status: 'closed',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    const stranger = await userToken((await createTestUser({ verified: true })).id);

    const r = await api(stranger, 'GET', `/api/issues/${id}/judged-build`);

    expect([403, 404]).toContain(r.status);
  });
});
