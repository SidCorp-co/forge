/**
 * ISS-1421 r37 — the release gate calls an issue ready only where Release now over it is not refused.
 *
 * judge-151 at c2f5249 (criteria 366 and 367): a project whose only waiting issue had no release note
 * read "1 ready" and offered Release now, which the create door refused 409 RELEASE_RECORD_MISSING in
 * the caller's words, naming the stored key and a JSON shape. The gate counted only what the finish's
 * close refuses. Real Postgres and the real route mount: the roster reads the door's own enumerator,
 * and the refusal carries the sentence a person reads beside the caller's.
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
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let token: string;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  const [batch, err] = await Promise.all([
    import('../../src/release-batch/routes.js'),
    import('../../src/middleware/error.js'),
  ]);
  app = new Hono();
  app.route('/api/projects', batch.releaseBatchRoutes);
  app.onError(err.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${ownerId}`);
  projectId = (await createTestProject(harness.db, ownerId)).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  await fx.declareProduction();
  const { signUserToken } = await import('../../src/auth/jwt.js');
  token = await signUserToken(ownerId);
});

interface GateRow {
  id: string;
  releaseRefusals: Array<{ code: string; said: string; saidHere: string }>;
}
interface Gate {
  issues: GateRow[];
  blockingAll: Array<{ code: string; said: string; runId: string | null }>;
}

async function gate(): Promise<Gate> {
  const res = await app.request(`/api/projects/${projectId}/release-batches/roster`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Gate;
}

function press(issueIds: string[]) {
  return app.request(`/api/projects/${projectId}/release-batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ issueIds }),
  });
}

describe('the release gate counts ready only what Release now would not refuse', () => {
  it('marks the lone issue with no release note not ready, saying what makes it ready', async () => {
    await fx.seedReleaseRunner();
    const unnoted = await fx.insertIssue('awaiting_release', null);

    const read = await gate();

    expect(read.blockingAll).toEqual([]);
    const row = read.issues.find((i) => i.id === unnoted);
    expect(row?.releaseRefusals.map((r) => r.code)).toEqual(['RELEASE_RECORD_MISSING']);
    for (const said of [row?.releaseRefusals[0]?.said, row?.releaseRefusals[0]?.saidHere]) {
      expect(said).toMatch(/has no release note/);
      expect(said).toMatch(
        /A member of the project writes one under Release note on (this|the issue's) page/,
      );
      expect(said).not.toMatch(/releaseNotes|userFacing|[{}`]/);
    }
  });

  it('leaves a row with its note unrefused beside one without', async () => {
    await fx.seedReleaseRunner();
    const noted = await fx.insertIssue();
    const unnoted = await fx.insertIssue('awaiting_release', null);

    const read = await gate();

    expect(read.issues.find((i) => i.id === noted)?.releaseRefusals).toEqual([]);
    expect(read.issues.find((i) => i.id === unnoted)?.releaseRefusals).toHaveLength(1);
  });

  it('says once what refuses every pick where no box could take the release', async () => {
    await fx.insertIssue();

    const read = await gate();

    expect(read.blockingAll.map((b) => b.code)).toEqual(['RELEASE_POOL_EMPTY']);
    expect(read.blockingAll[0]?.said).toMatch(/no runner registered/);
  });

  it('refuses the press over a note-less issue in words a person reads beside the caller sentence', async () => {
    await fx.seedReleaseRunner();
    const unnoted = await fx.insertIssue('awaiting_release', null);

    const res = await press([unnoted]);
    const body = (await res.json()) as {
      code: string;
      message?: string;
      error?: string;
      details?: { reader?: string };
    };

    expect(res.status).toBe(409);
    expect(body.code).toBe('RELEASE_RECORD_MISSING');
    expect(body.details?.reader).toMatch(/has no release note/);
    expect(body.details?.reader).not.toMatch(/releaseNotes|userFacing|[{}]/);
  });

  // ISS-1421 r38, judge-155 at c0f8105: the gate said a second release "would claim the same
  // issues. Let it finish, or abort it" of a release carrying one issue, and linked to no run.
  it('names what the running release carries, what the rest do, and the run to open', async () => {
    await fx.seedReleaseRunner();
    const shipping = await fx.insertIssue();
    const created = await press([shipping]);
    expect(created.status).toBe(201);
    const { runId } = (await created.json()) as { runId: string };
    const waiting = await fx.insertIssue();
    const [carried, rest] = await fx.displayIds([shipping, waiting]);

    const read = await gate();

    expect(read.blockingAll).toEqual([
      {
        code: 'BATCH_IN_FLIGHT',
        runId,
        said: `A release is already running for this project, carrying ${carried}. A project runs one release at a time, so ${rest} is on no release and waits until it finishes.`,
      },
    ]);
  });

  it('answers a press naming no issue in words a person reads, naming no route', async () => {
    await fx.seedReleaseRunner();
    await fx.insertIssue();

    const res = await press([]);
    const body = (await res.json()) as { code: string; details?: { reader?: string } };

    expect(body.code).toBe('RELEASE_ISSUES_UNNAMED');
    expect(body.details?.reader).toBe(
      'No issue was picked, so nothing was released. Pick the issues to release from those the release gate lists as ready.',
    );
  });
});
