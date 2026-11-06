/**
 * ISS-1051 (b): the workspace's Activity release column shows a release run that was cut and is still
 * in flight, as cut, then deploying, then shipped, until its run ends. The held forecast reads only
 * the next release (the soonest requirement still landing, or the draft), so a cut run that was
 * deploying read null there, as adminhub-api 0.14.0 and adminhub-fe 1.16.0 did at 16:05Z.
 *
 * @direct-test-of packages/core/src/activity/lane-releases.ts
 * @direct-test-of packages/core/src/activity/read.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, seedOrg } from '../helpers/factories.js';

let ownerId = '';
let orgId = '';
const projects: Record<'cut' | 'deploying' | 'shipped' | 'ended' | 'none', string> = {
  cut: '',
  deploying: '',
  shipped: '',
  ended: '',
  none: '',
};

/** A release run of `projectId` at `version`, as the release batch starts it. */
async function releaseRun(
  projectId: string,
  version: string,
  over: { status?: string; released?: boolean; startedAgo?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, created_at, started_at, finished_at,
                               release_version, release_released_at, metadata)
    VALUES (${id}, ${projectId}, 'system', ${over.status ?? 'running'},
            now() - ${over.startedAgo ?? '10 minutes'}::interval,
            now() - ${over.startedAgo ?? '10 minutes'}::interval,
            ${over.status === 'completed' ? sql`now()` : sql`NULL`},
            ${version}, ${over.released ? sql`now() - interval '1 minute'` : sql`NULL`},
            ${JSON.stringify({ source: 'release-batch', issueIds: [] })}::jsonb)`);
  return id;
}

async function deployAttempt(runId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO release_attempts (run_id, stage, idempotency_key)
    VALUES (${runId}, 'deploy', ${`deploy:${runId}`})`);
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  orgId = await seedOrg(ownerId);
  for (const k of Object.keys(projects) as (keyof typeof projects)[]) {
    projects[k] = (await createTestProject(ownerId, { orgId })).id;
  }
  await releaseRun(projects.cut, '0.14.0');
  // an older run of the same project that ended stands behind the one in flight
  await releaseRun(projects.deploying, '1.15.0', { status: 'completed', startedAgo: '2 days' });
  await deployAttempt(await releaseRun(projects.deploying, '1.16.0'));
  await deployAttempt(await releaseRun(projects.shipped, '2.0.0', { released: true }));
  await releaseRun(projects.ended, '3.1.0', { status: 'completed', released: true });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('ISS-1051 (b) a release run in flight shows in the release column', () => {
  it('shows each cut run by its version and how far it got, and none where no run is in flight', async () => {
    const { readOrgActivity } = await import('../../src/activity/read.js');
    const read = await readOrgActivity(orgId, { userId: ownerId, agency: 'human' }, new Date(), {
      waitMs: 60_000,
    });
    const row = (k: keyof typeof projects) =>
      read.projects.find((p) => p.projectId === projects[k]);
    expect(row('deploying')?.releasing, 'a cut run that is deploying shows nothing').toMatchObject({
      version: '1.16.0',
      stage: 'deploying',
    });
    expect(row('cut')?.releasing).toMatchObject({ version: '0.14.0', stage: 'cut' });
    expect(row('shipped')?.releasing).toMatchObject({ version: '2.0.0', stage: 'shipped' });
    expect(row('ended')?.releasing).toBeNull();
    expect(row('none')?.releasing).toBeNull();
    // the held forecast still reads only what is coming next: nothing on these projects
    expect(row('deploying')?.release).toBeNull();
  });
});
