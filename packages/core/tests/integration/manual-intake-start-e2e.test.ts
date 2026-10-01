/**
 * ISS-29 — on a project whose policy intake is `manual`, a person holding project `member` starts
 * an open issue, and that start is what puts it in front of the project's masters.
 *
 * "In front of the masters" is asserted at the door a box reads, `GET /api/devices/me/issues/
 * admissible`, because that route's `items` is the whole of what a master is offered: a start
 * that stamped the row and left it out of that set would be a 202 that did nothing.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import { DEFAULT_POLICY } from '../../src/project-config/default-policy.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  ({ app } = (await import('../../src/index.js')) as unknown as { app: typeof app });
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let deviceToken: string;
let deviceId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({ ownerId, name: 'intake-box', platform: 'linux' });
  deviceToken = issued.plaintext;
  deviceId = issued.device.id;
});

async function project(intake: 'auto' | 'manual'): Promise<string> {
  const { id } = await createTestProject(harness.db, ownerId, {
    policy: { ...DEFAULT_POLICY, intake: { mode: intake } },
  });
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, name, type, status)
    VALUES (${randomUUID()}, ${id}, ${deviceId}, 'intake-runner', 'claude-code', 'online')
  `);
  return id;
}

async function person(projectId: string, role: 'viewer' | 'member' | 'admin'): Promise<string> {
  const { id } = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${id}`);
  await createTestProjectMember(harness.db, { userId: id, projectId, role });
  return signUserToken(id);
}

async function openIssue(projectId: string, seq: number): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'open', ${ownerId})
  `);
  return id;
}

async function start(issueId: string, token: string): Promise<Response> {
  return app.request(`/api/issues/${issueId}/run-pipeline-step`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
}

async function offered(): Promise<string[]> {
  const res = await app.request('/api/devices/me/issues/admissible', {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ issueKey: string }> };
  return body.items.map((i) => i.issueKey);
}

async function stamp(issueId: string): Promise<string | null> {
  const rows = (await harness.db.execute(
    sql`SELECT session_context->>'runRelease' AS at FROM issues WHERE id = ${issueId}`,
  )) as unknown as Array<{ at: string | null }>;
  return rows[0]?.at ?? null;
}

describe('ISS-29 starting an issue on a manual-intake project (real Postgres, through the routes)', () => {
  it('a member starts an open issue, and only then is it offered to the masters', async () => {
    const projectId = await project('manual');
    const issueId = await openIssue(projectId, 1);
    const member = await person(projectId, 'member');
    expect(await offered()).toEqual([]);

    const res = await start(issueId, member);

    expect(res.status).toBe(202);
    const body = (await res.json()) as { issueId: string; status: string; startedAt: string };
    expect(body).toMatchObject({ issueId, status: 'open' });
    expect(await stamp(issueId)).toBe(body.startedAt);
    expect(await offered()).toEqual(['ISS-1']);
  });

  it('a second start reports the first start time rather than restarting it', async () => {
    const projectId = await project('manual');
    const issueId = await openIssue(projectId, 1);
    const member = await person(projectId, 'member');

    const first = (await (await start(issueId, member)).json()) as { startedAt: string };
    const again = await start(issueId, member);

    expect(again.status).toBe(202);
    expect(((await again.json()) as { startedAt: string }).startedAt).toBe(first.startedAt);
  });

  it('refuses a viewer by name and leaves the issue unoffered', async () => {
    const projectId = await project('manual');
    const issueId = await openIssue(projectId, 1);
    const viewer = await person(projectId, 'viewer');

    const res = await start(issueId, viewer);

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('START_REQUIRES_MEMBER');
    expect(body.message).toContain('role on the project is viewer');
    expect(await stamp(issueId)).toBeNull();
    expect(await offered()).toEqual([]);
  });

  it('refuses a start on an auto-intake project by name, where masters already take the issue', async () => {
    const projectId = await project('auto');
    const issueId = await openIssue(projectId, 1);
    const admin = await person(projectId, 'admin');
    expect(await offered()).toEqual(['ISS-1']);

    const res = await start(issueId, admin);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('INTAKE_NOT_MANUAL');
    expect(await stamp(issueId)).toBeNull();
  });
});
