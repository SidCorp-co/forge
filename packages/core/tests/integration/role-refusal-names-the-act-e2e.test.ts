/**
 * ISS-1421 r31 — a refusal for a role too low names the act and who may take it, at every REST door.
 *
 * judge-127 on criterion 340: a viewer's issue create, change, move and comment read "Requires
 * project member access.", a viewer's memory and knowledge writes read "Not a project member." of a
 * member, and the MCP tools refused the same viewer by act. The REST gate now takes the act, so
 * no door can refuse in role words alone. This file sends each of those writes as a viewer, an admin
 * act as a member, and a read as someone with no role, over a real server and database; criterion
 * 356's knowledge reads as a viewer; and criterion 354's create doors with a body whose fields
 * would be refused, so the role is what the sender is told.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestOrgMember,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

type Who = 'viewer' | 'member' | 'outsider';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let orgId: string;
let issueId: string;
let tokens: Record<Who, string>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  const { registerAllIntegrations } = await import('../../src/integrations/register-all.js');
  registerAllIntegrations();
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  projectId = project.id;
  orgId = project.orgId;
  issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 1, 'an issue', 'open', ${owner.id})`);
  await harness.db.execute(sql`
    INSERT INTO knowledge_entries (project_id, kind, slug, title, body)
    VALUES (${projectId}, 'guide', 'build', 'Build', 'How it builds.')`);
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const built: Partial<Record<Who, string>> = {};
  for (const who of ['viewer', 'member', 'outsider'] as const) {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    if (who !== 'outsider') {
      await createTestProjectMember(harness.db, { userId: user.id, projectId, role: who });
      await createTestOrgMember(harness.db, { orgId, userId: user.id, role: 'member' });
    }
    built[who] = await signUserToken(user.id);
  }
  tokens = built as Record<Who, string>;
});

async function send(who: Who, method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let message = text;
  try {
    message = (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {}
  return { status: res.status, message };
}

const viewerCannot = (act: string) =>
  `You are a viewer of this project, so you cannot ${act}. Only a member or admin of this project can, so ask one of them.`;

describe('a viewer refused a write, through REST', () => {
  const writes: Array<[string, string, () => string, () => unknown]> = [
    [
      'create an issue in it',
      'POST',
      () => `/api/projects/${projectId}/issues`,
      () => ({ title: 'New work' }),
    ],
    ['change its issues', 'PATCH', () => `/api/issues/${issueId}`, () => ({ title: 'Renamed' })],
    [
      'move its issues',
      'POST',
      () => `/api/issues/${issueId}/transition`,
      () => ({ toStatus: 'on_hold', reason: 'paused' }),
    ],
    [
      'comment on its issues',
      'POST',
      () => `/api/issues/${issueId}/comments`,
      () => ({ body: 'A comment.' }),
    ],
    [
      'steer its issues',
      'POST',
      () => `/api/issues/${issueId}/steer`,
      () => ({ body: 'Go left.' }),
    ],
    ['enrich its issues', 'POST', () => `/api/issues/${issueId}/enrich`, () => ({})],
    [
      'write to its memory',
      'POST',
      () => '/api/memory',
      () => ({ projectId, source: 'note', sourceRef: 'r31', textContent: 'A note.' }),
    ],
    [
      'write its knowledge',
      'PUT',
      () => `/api/projects/${projectId}/knowledge/build`,
      () => ({ title: 'Build', body: 'New.' }),
    ],
  ];

  it.each(writes)('names the act "%s" and who may take it', async (act, method, path, body) => {
    const answer = await send('viewer', method, path(), body());
    expect(answer.status).toBe(403);
    expect(answer.message).toBe(viewerCannot(act));
    expect(answer.message).not.toMatch(/not a project member|requires project/i);
  });

  it('leaves the issue, its comments and the knowledge as they were', async () => {
    for (const [, method, path, body] of writes) await send('viewer', method, path(), body());
    const [row] = (await harness.db.execute(
      sql`SELECT title, status FROM issues WHERE id = ${issueId}`,
    )) as unknown as Array<{ title: string; status: string }>;
    expect(row).toEqual({ title: 'an issue', status: 'open' });
    const [k] = (await harness.db.execute(
      sql`SELECT body FROM knowledge_entries WHERE project_id = ${projectId} AND slug = 'build'`,
    )) as unknown as Array<{ body: string }>;
    expect(k?.body).toBe('How it builds.');
    const [c] = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issueId}`,
    )) as unknown as Array<{ n: number }>;
    expect(c?.n).toBe(0);
  });
});

describe('a member refused an admin act, through REST', () => {
  it('names the act and that only an admin of the project may', async () => {
    const answer = await send('member', 'DELETE', `/api/issues/${issueId}`);
    expect(answer.status).toBe(403);
    expect(answer.message).toBe(
      'You are a member of this project, so you cannot delete its issues. Only an admin of this project can, so ask one of them.',
    );
  });
});

describe('the doors that kept the bare gate until ISS-1236 r2 and ISS-1300 r5 landed', () => {
  it('names the act at the release, onboarding and conversation doors', async () => {
    const readiness = await send('viewer', 'GET', `/api/projects/${projectId}/release-readiness`);
    expect([readiness.status, readiness.message]).toEqual([
      403,
      viewerCannot('read its release readiness'),
    ]);
    const onboard = await send('member', 'POST', `/api/projects/${projectId}/onboard`);
    expect([onboard.status, onboard.message]).toEqual([
      403,
      'You are a member of this project, so you cannot onboard it. Only an admin of this project can, so ask one of them.',
    ]);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
      VALUES (${runId}, ${projectId}, 'system', 'running', now(), '{"source":"release-batch"}'::jsonb)`);
    const abort = await send(
      'viewer',
      'POST',
      `/api/projects/${projectId}/release-batches/${runId}/abort`,
      {},
    );
    expect([abort.status, abort.message]).toEqual([403, viewerCannot('abort its release batches')]);
    const rooms = await send('outsider', 'GET', `/api/conversations?projectId=${projectId}`);
    expect([rooms.status, rooms.message]).toEqual([
      403,
      'You are not a member of this project, so you cannot read its conversations. An admin of this project can add you to it.',
    ]);
  });
});

describe("a project's knowledge, read through REST (criterion 356)", () => {
  it('is listed, searched and read by a viewer', async () => {
    expect((await send('viewer', 'GET', `/api/projects/${projectId}/knowledge`)).status).toBe(200);
    expect(
      (
        await send('viewer', 'POST', `/api/projects/${projectId}/knowledge/search`, {
          query: 'build',
        })
      ).status,
    ).toBe(200);
    expect((await send('viewer', 'GET', `/api/projects/${projectId}/knowledge/build`)).status).toBe(
      200,
    );
  });

  it('is refused to someone with no role, saying they are not a member and who can add them', async () => {
    const answer = await send('outsider', 'GET', `/api/projects/${projectId}/knowledge`);
    expect(answer.status).toBe(403);
    expect(answer.message).toBe(
      'You are not a member of this project, so you cannot read its knowledge. An admin of this project can add you to it.',
    );
  });
});

describe('a create refused by role before its fields are judged (criterion 354)', () => {
  it("refuses a viewer's integration create by who may connect one, whatever its fields hold", async () => {
    const answer = await send('viewer', 'POST', `/api/projects/${projectId}/integrations`, {
      provider: 'coolify',
      role: 'deploy',
      stages: ['live'],
      config: { baseUrl: 'https://coolify.r31.invalid' },
      secrets: { apiToken: 'x' },
    });
    expect(answer.status).toBe(403);
    expect(answer.message).toBe(
      'You are a viewer of this project, so you cannot connect an integration to it. Only an admin of this project can, so ask one of them.',
    );
  });

  it('refuses it by role even where the body asks an agent grant the provider cannot take', async () => {
    const answer = await send('viewer', 'POST', `/api/projects/${projectId}/integrations`, {
      provider: 'rocketchat',
      agentAccess: 'all',
    });
    expect([answer.status, answer.message]).toEqual([
      403,
      'You are a viewer of this project, so you cannot connect an integration to it. Only an admin of this project can, so ask one of them.',
    ]);
  });

  it("refuses a plain org member's organization connection create by who may, whatever its fields hold", async () => {
    const answer = await send('member', 'POST', '/api/integration-connections', {
      provider: 'coolify',
      orgId,
      config: { baseUrl: 'not a url' },
      secrets: { apiToken: 'x' },
    });
    expect(answer.status).toBe(403);
    expect(answer.message).toMatch(
      /^Only an owner or admin of the organization can create a connection it owns\./,
    );
  });
});
