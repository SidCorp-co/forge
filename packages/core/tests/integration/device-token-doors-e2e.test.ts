/**
 * ISS-1421 r15 — judge-65 sent a paired box's own device token to two doors of its owner's project:
 * the issue attachments route answered 404 "Project not found." and the session list 403 "Not a
 * project member.". Neither was true. The box's token reaches no project through a person's door,
 * so that door says so; the session list answers the box the sessions dispatched to it, as the
 * session read it already passes does; a session route that acts for a person says that.
 * Against real Postgres, through the real routes and the app's own error handler.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { anIssue } from '../helpers/comment-credential-fixture.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { pairDevice } from '../helpers/pair-device.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
let DEVICE_TOKEN_REACHES_NO_PROJECT: string;
let DEVICE_SPEAKS_FOR_NO_PERSON: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';

  const [sessions, attachments, errMod, jwtMod, surface, access] = await Promise.all([
    import('../../src/agent-sessions/routes.js'),
    import('../../src/issues/attachment-routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/pat-rest-surface.js'),
    import('../../src/agent-sessions/session-access.js'),
  ]);
  signUserToken = jwtMod.signUserToken;
  DEVICE_TOKEN_REACHES_NO_PROJECT = surface.DEVICE_TOKEN_REACHES_NO_PROJECT;
  DEVICE_SPEAKS_FOR_NO_PERSON = access.DEVICE_SPEAKS_FOR_NO_PERSON;
  app = new Hono();
  app.route('/api/issues', attachments.issueAttachmentRoutes);
  app.route('/api/agent-sessions', sessions.agentSessionRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

interface World {
  projectId: string;
  issueId: string;
  deviceToken: string;
  personToken: string;
  onTheBox: string;
  elsewhere: string;
}

let w: World;

async function session(projectId: string, deviceId: string): Promise<string> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}::uuid, 'system', 'running')
  `);
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title,
                                started_at)
    VALUES (${id}, ${projectId}::uuid, ${deviceId}::uuid, ${runId}, 'run_session', 'running',
            'a run', now())
  `);
  return id;
}

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  const project = await createTestProject(harness.db, owner.id);
  await createTestProjectMember(harness.db, {
    userId: owner.id,
    projectId: project.id,
    role: 'admin',
  });
  const box = await pairDevice({ ownerId: owner.id, name: 'box', platform: 'linux' });
  const other = await pairDevice({ ownerId: owner.id, name: 'other box', platform: 'linux' });
  w = {
    projectId: project.id,
    issueId: await anIssue(harness.db, project.id, owner.id),
    deviceToken: box.plaintext,
    personToken: await signUserToken(owner.id),
    onTheBox: await session(project.id, box.device.id),
    elsewhere: await session(project.id, other.device.id),
  };
});

const get = (path: string, token: string) =>
  app.request(path, { headers: { authorization: `Bearer ${token}` } });

describe("a paired box's device token on its owner's project", () => {
  it('is refused at the issue attachments door in a true sentence, never "Project not found."', async () => {
    const res = await get(`/api/issues/${w.issueId}/attachments`, w.deviceToken);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({
      code: 'DEVICE_TOKEN_REACHES_NO_PROJECT',
      message: DEVICE_TOKEN_REACHES_NO_PROJECT,
    });
    expect(body.message).not.toMatch(/not found/i);
  });

  it("leaves the same door open to the owner's own session", async () => {
    const res = await get(`/api/issues/${w.issueId}/attachments`, w.personToken);
    expect(res.status).toBe(200);
  });

  it('lists the sessions dispatched to the box, as the session read it passes does', async () => {
    const res = await get(`/api/agent-sessions?projectId=${w.projectId}`, w.deviceToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((s: { id: string }) => s.id)).toEqual([w.onTheBox]);
    const read = await get(`/api/agent-sessions/${w.onTheBox}`, w.deviceToken);
    expect(read.status).toBe(200);
  });

  it("lists every session of the project to the owner's session", async () => {
    const res = await get(`/api/agent-sessions?projectId=${w.projectId}`, w.personToken);
    expect(res.status).toBe(200);
    const ids = (await res.json()).items.map((s: { id: string }) => s.id).sort();
    expect(ids).toEqual([w.onTheBox, w.elsewhere].sort());
  });

  it("is refused another box's sessions by name", async () => {
    const res = await get(
      `/api/agent-sessions?projectId=${w.projectId}&deviceId=${randomUUID()}`,
      w.deviceToken,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe('A box lists only the sessions dispatched to it.');
  });

  it('is told a session route that acts for a person does, never "Not a project member."', async () => {
    const res = await get(`/api/agent-sessions/${w.onTheBox}/cost`, w.deviceToken);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toBe(DEVICE_SPEAKS_FOR_NO_PERSON);
    expect(body.message).not.toMatch(/member/i);
  });

  // ISS-1421 r16 — judge-69 read a membership or role sentence at these three, the box's owner
  // being an admin of the project all along.
  type Door = [string, () => string, (() => Record<string, string>) | undefined];
  const doors: Door[] = [
    ['GET', () => `/api/agent-sessions/queue-stats?projectId=${w.projectId}`, undefined],
    ['POST', () => '/api/agent-sessions', () => ({ projectId: w.projectId, title: 'a chat' })],
    ['POST', () => `/api/agent-sessions/sweep-zombies?projectId=${w.projectId}`, undefined],
    ['POST', () => '/api/agent-sessions/start', () => ({ projectSlug: 'x', prompt: 'p' })],
  ];
  it.each(doors)('is refused %s as a box, never as a non-member', async (method, path, body) => {
    const res = await app.request(path(), {
      method,
      headers: { authorization: `Bearer ${w.deviceToken}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body()) } : {}),
    });
    expect(res.status).toBe(403);
    const said = await res.json();
    expect(said.message).toBe(DEVICE_SPEAKS_FOR_NO_PERSON);
    expect(said.message).not.toMatch(/member|role/i);
  });

  it("answers the same queue read to the owner's session", async () => {
    const res = await get(
      `/api/agent-sessions/queue-stats?projectId=${w.projectId}`,
      w.personToken,
    );
    expect(res.status).toBe(200);
  });
});
