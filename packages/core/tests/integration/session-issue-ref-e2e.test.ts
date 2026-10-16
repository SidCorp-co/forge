/**
 * ISS-1228 round 9 — the sessions list names the issue a step session works by its key and title,
 * not only its id: the list's issue chip read "Issue" for a session the Pipeline page showed on
 * ISS-2. Read through the route the web reads, against a live database.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let ownerId: string;
let projectId: string;
let deviceId: string;
let jwt: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  projectId = (await createTestProject(harness.db, ownerId)).id;
  deviceId = (await createTestDevice(harness.db, ownerId)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  jwt = await signUserToken(ownerId);
});

async function issue(project: string, seq: number, title: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${project}::uuid, ${seq}, ${title}, 'in_progress', ${ownerId}::uuid)
  `);
  return id;
}

async function stepSession(metadata: Record<string, unknown>): Promise<string> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${projectId}::uuid, 'system', 'running')
  `);
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title, metadata)
    VALUES (${id}, ${projectId}::uuid, ${deviceId}::uuid, ${runId}, 'pipeline', 'running', 'forge-code: x',
            ${JSON.stringify(metadata)}::jsonb)
  `);
  return id;
}

async function listed(): Promise<Map<string, unknown>> {
  const res = await fetch(`${server.baseUrl}/api/agent-sessions?projectId=${projectId}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ id: string; issue: unknown }> };
  return new Map(body.items.map((i) => [i.id, i.issue]));
}

describe("the sessions list names a session's issue (ISS-1228 round 9)", () => {
  it('gives a step session the key and title of the issue its job works', async () => {
    const issueId = await issue(projectId, 2, 'Rename the export column');
    const step = await stepSession({ jobType: 'drive', issueId });
    const [project] = (await harness.db.execute(sql`
      SELECT issue_prefix FROM projects WHERE id = ${projectId}::uuid
    `)) as unknown as Array<{ issue_prefix: string | null }>;
    const { formatIssueRef } = await import('../../src/lib/issue-ref.js');
    expect((await listed()).get(step)).toEqual({
      id: issueId,
      displayId: formatIssueRef(project?.issue_prefix, 2),
      title: 'Rename the export column',
    });
  });

  it('names no issue for a session that records none', async () => {
    const step = await stepSession({ jobType: 'release_batch' });
    expect((await listed()).get(step)).toBeNull();
  });

  it('names no issue another project holds, nor one for an id that matches no issue', async () => {
    const elsewhere = (await createTestProject(harness.db, ownerId)).id;
    const foreign = await stepSession({ issueId: await issue(elsewhere, 9, 'Not yours') });
    const junk = await stepSession({ issueId: 'not-a-uuid' });
    const rows = await listed();
    expect(rows.get(foreign)).toBeNull();
    expect(rows.get(junk)).toBeNull();
  });
});
