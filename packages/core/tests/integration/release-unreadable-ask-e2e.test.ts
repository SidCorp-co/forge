/**
 * ISS-1421 r6, criterion 94 — anhome's question b210f881 said only that the box could not read what
 * the release agent asked, so nobody could answer it and the release waited on it. A release's
 * unreadable ask is refused by name, RELEASE_ASK_UNREADABLE: no question is written, the release is
 * stopped and each issue it carried is told why and what to do next. Same world as
 * `release-blocked-decision-e2e.test.ts`, against real Postgres and the real job routes.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { pairDevice } from '../helpers/pair-device.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let deviceId: string;
let deviceToken: string;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

const DIALOG = {
  kind: 'dialog',
  questions: [
    {
      question: 'Staging is ahead of the roster.\nHow should the release go on?',
      header: 'Fork',
      multiSelect: false,
      options: [
        { label: 'Push + finish unverified', description: 'ship what is here (Recommended)' },
        { label: 'Also ship bb4fb368' },
        { label: 'Abort to gate' },
      ],
    },
  ],
} as const;

const BLOCKED_REASON =
  "the job's pane `forge-job-0af4b864` has been stopped on a question only a human can answer for 15m — nothing on this box answers a job pane's question, so that wait had no end of its own and the slot was holding it";

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  const [lifecycle, batch, err, hooksMod, subscriber] = await Promise.all([
    import('../../src/jobs/lifecycle-routes.js'),
    import('../../src/release-batch/routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/pipeline/hooks.js'),
    import('../../src/release-batch/decision-subscriber.js'),
  ]);
  subscriber.registerReleaseDecisionSubscriber(hooksMod.hooks);
  app = new Hono();
  app.route('/api/jobs', lifecycle.jobLifecycleDeviceRoutes);
  app.route('/api/jobs', lifecycle.jobLifecycleUserRoutes);
  app.route('/api/projects', batch.releaseBatchRoutes);
  app.onError(err.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${ownerId}`);
  projectId = (await createTestProject(harness.db, ownerId)).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  await fx.declareProduction();
  await fx.seedReleaseRunner();
  const issued = await pairDevice({ ownerId, name: 'box', platform: 'linux' });
  deviceId = issued.device.id;
  deviceToken = issued.plaintext;
});

/** Three issues at the gate, one release claimed over them, and its job out with the box. */
async function runningRelease() {
  const ids = [await fx.insertIssue(), await fx.insertIssue(), await fx.insertIssue()];
  const released = await fx.claim(ids);
  await harness.db.execute(sql`
    UPDATE jobs SET status = 'running', device_id = ${deviceId}, dispatched_at = now(), acked_at = now()
     WHERE id = ${released.jobId}
  `);
  return { ids, ...released };
}

function post(path: string, token: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const blocked = (jobId: string, asked: unknown = DIALOG) =>
  post(`/api/jobs/${jobId}/blocked`, deviceToken, { error: BLOCKED_REASON, asked });

async function jobsOf(runId: string): Promise<Array<{ id: string; status: string }>> {
  const rows = await harness.db.execute(sql`
    SELECT id, status FROM jobs WHERE pipeline_run_id = ${runId} ORDER BY created_at
  `);
  return rows as unknown as Array<{ id: string; status: string }>;
}

async function questionsOn(issueId: string | null) {
  const rows = await harness.db.execute(sql`
    SELECT id, status, blocker_kind, steps FROM agent_questions
     WHERE project_id = ${projectId}
       AND ${issueId === null ? sql`issue_id IS NULL` : sql`issue_id = ${issueId}`}
     ORDER BY id
  `);
  return rows as unknown as Array<{
    id: string;
    status: string;
    blocker_kind: string;
    steps: Array<Record<string, unknown>>;
  }>;
}

describe('a release agent whose ask Forge could not read', () => {
  it.each([
    ['a plain failure from an older runner', null],
    [
      'the blocked door, naming why it could not read',
      { kind: 'unread', why: 'the transcript was cut' },
    ],
  ])(
    'refuses the unreadable ask by name through %s: no question, each issue told why',
    async (_door, asked) => {
      const release = await runningRelease();
      const res = asked
        ? await blocked(release.jobId, asked)
        : await post(`/api/jobs/${release.jobId}/fail`, deviceToken, { error: BLOCKED_REASON });
      expect(res.status).toBe(200);
      expect((await res.json()).heldJobId).toBeNull();
      expect(await questionsOn(null)).toEqual([]);
      expect((await jobsOf(release.runId)).map((j) => j.status)).toEqual(['failed']);
      const rows = await harness.db.execute(
        sql`SELECT error FROM jobs WHERE id = ${release.jobId}`,
      );
      expect(String(rows[0]?.error)).toMatch(
        /^RELEASE_ASK_UNREADABLE: The release agent stopped on/,
      );
      expect(await fx.runStatus(release.runId)).not.toBe('running');
      for (const id of release.ids) {
        expect(await questionsOn(id)).toEqual([]);
        expect(await fx.stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
        const said = await harness.db.execute(
          sql`SELECT body FROM comments WHERE issue_id = ${id}`,
        );
        const text = said.map((r) => String(r.body)).join('\n');
        expect(text).toContain('No question was written, since nobody could answer it');
        expect(text).toContain('Start the next release from Awaiting release.');
      }
    },
  );
});
