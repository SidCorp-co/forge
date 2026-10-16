/**
 * ISS-1228 round 9 — a comment says it records a release because core's release flow marked it as it
 * wrote it, never because of its words. Read through the comment thread the issue page reads, against
 * a live database: the two release writers mark their comment, a person's comment with the same words
 * stays unmarked, and no caller's door takes the mark.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const RELEASED = 'b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e';
const ACCOUNT = 'Promoted by hand; the provider console reports no commit Forge could read.';
const RUN = '33333333-3333-4333-8333-333333333333';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let ownerId: string;
let jwt: string;

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  jwt = await signUserToken(owner.id);
  await fx.seedReleaseRunner();
  await fx.declareProduction({ verify: null });
});

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${server.baseUrl}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

interface ThreadNode {
  body: string;
  announces: string | null;
  replies: ThreadNode[];
}

async function thread(issueId: string): Promise<ThreadNode[]> {
  const res = await call('GET', `/issues/${issueId}/comments`);
  expect(res.status).toBe(200);
  return res.body.items as ThreadNode[];
}

describe('a release is a mark core records, not a reading of the words (ISS-1228 round 9)', () => {
  it('marks the note a release recorded by hand writes on the issue it closes', async () => {
    const a = await fx.insertIssue();
    const res = await call('POST', `/projects/${projectId}/release-records`, {
      issueIds: [a],
      commit: RELEASED,
      account: ACCOUNT,
    });
    expect(res.status).toBe(201);

    const notes = (await thread(a)).filter((n) =>
      n.body.startsWith('Released outside a release batch'),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.announces).toBe('release');
  });

  it('marks the note an unverified release close writes, whatever its words', async () => {
    const a = await fx.insertIssue();
    const { noteUnverifiedCloses } = await import('../../src/release-batch/unverified-close.js');
    await noteUnverifiedCloses({
      runId: RUN,
      issueIds: [a],
      actor: { type: 'user', id: ownerId },
      commit: RELEASED,
    });

    const [note] = await thread(a);
    expect(note?.body).toContain('This issue is being closed by a release that was not verified.');
    expect(note?.announces).toBe('release');
  });

  it("leaves a person's comment unmarked, the release writer's very words included", async () => {
    const a = await fx.insertIssue();
    for (const body of [
      'Released outside a release batch, and recorded on the account of whoever released it.',
      'Released v1.2.0 to prod',
      'Released: nothing this week.',
    ]) {
      expect((await call('POST', `/issues/${a}/comments`, { body })).status).toBe(201);
    }

    const nodes = await thread(a);
    expect(nodes).toHaveLength(3);
    for (const n of nodes) expect(n.announces).toBeNull();
  });

  it("refuses a caller's comment that names the mark, and writes nothing", async () => {
    const a = await fx.insertIssue();
    const res = await call('POST', `/issues/${a}/comments`, {
      body: 'Released v1.2.0 to prod',
      announces: 'release',
    });
    expect(res.status).toBe(400);
    expect(await thread(a)).toEqual([]);
  });

  it('holds the column to the one value core writes', async () => {
    const a = await fx.insertIssue();
    const refused = await harness.db
      .execute(sql`
        INSERT INTO comments (issue_id, author_id, body, announces)
        VALUES (${a}, ${ownerId}, 'x', 'shipped')
      `)
      .then(
        () => null,
        (err: unknown) => err as { cause?: { constraint_name?: string } },
      );
    expect(refused?.cause?.constraint_name).toBe('comments_announces_chk');
  });
});
