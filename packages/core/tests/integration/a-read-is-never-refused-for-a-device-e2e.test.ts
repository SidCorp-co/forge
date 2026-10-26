/**
 * ISS-1236 round 2 — judge-126's findings at b42ead7, against a real Postgres.
 *
 * The judge's shape: a project whose default device is paired and online with no runner row, and
 * no other runner online. A person opened a conversation and could not read it, because the
 * availability check behind the room read threw DEVICE_NOT_BOUND. A read asks whether a device is
 * available and is answered as data; only a door that dispatches a turn refuses. Onboarding, which
 * demanded a per-project skill no door can create, starts from Forge's own copy.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
type Refusal = { code?: string; message?: string; details?: Record<string, unknown> };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let published: Array<{ room: string; event: string; data: Record<string, unknown> }> = [];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  await registerIntegrationsForTest();
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
  const { registerConversationTransport } = await import('../../src/conversations/ports.js');
  const { webConversationPorts } = await import('../../src/assistant/conversation-adapter.js');
  registerConversationTransport(webConversationPorts);
  const { roomManager } = await import('../../src/ws/server.js');
  vi.spyOn(roomManager, 'publish').mockImplementation((room, envelope) => {
    const env = envelope as { event: string; data: Record<string, unknown> };
    published.push({ room, event: env.event, data: env.data });
    return 0;
  });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (harness) await harness.cleanup();
});

let ownerId: string;
let orgId: string;
let projectId: string;
let defaultDeviceId: string;

async function verifiedUser(): Promise<string> {
  const id = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${id}`);
  return id;
}

beforeEach(async () => {
  await truncateAll(harness.db);
  published = [];
  ownerId = await verifiedUser();
  orgId = (await seedOrg(harness.db, ownerId)).id;
  projectId = (
    await createTestProject(harness.db, ownerId, { slug: 'judge-p', name: 'Judge P', orgId })
  ).id;
  defaultDeviceId = (await createTestDevice(harness.db, ownerId, { name: 'judge-d1' })).id;
  await harness.db.execute(
    sql`UPDATE devices SET last_seen_at = now() WHERE id = ${defaultDeviceId}`,
  );
  await harness.db.execute(
    sql`UPDATE projects SET default_device_id = ${defaultDeviceId} WHERE id = ${projectId}`,
  );
});

async function as(userId: string, path: string, method = 'GET', body?: unknown): Promise<Response> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${await signUserToken(userId)}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function bindOnline(deviceId: string, path: string | null): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at, repo_path)
    VALUES (${randomUUID()}, ${projectId}, ${deviceId}, 'claude-code', 'bound', 'online', now(), ${path})
  `);
}

describe('a read that asks whether a device is available is answered, never refused', () => {
  it('opens a room and reads agent mode as unavailable, with the reason, while the default device is unbound', async () => {
    const opened = await as(ownerId, '/api/conversations', 'POST', { projectId });
    expect(opened.status, await opened.clone().text()).toBe(201);
    const { id } = (await opened.json()) as { id: string };

    const room = await as(ownerId, `/api/conversations/${id}`);
    expect(room.status, await room.clone().text()).toBe(200);
    const { agentMode } = (await room.json()) as {
      agentMode: { available: boolean; reason: string | null; unbound: unknown };
    };
    expect(agentMode.available).toBe(false);
    expect(agentMode.reason).toContain('judge-d1');
    expect(agentMode.reason).toContain('is not bound to project judge-p');
    // The room's panel names the device and links the project's Runners page from these.
    expect(agentMode.unbound).toEqual({
      deviceId: defaultDeviceId,
      deviceName: 'judge-d1',
      projectSlug: 'judge-p',
    });

    const offer = await as(ownerId, `/api/conversations/agent-mode?projectId=${projectId}`);
    expect(offer.status, await offer.clone().text()).toBe(200);
    expect(await offer.json()).toMatchObject({ available: false });
  });

  it('refuses the message door, which dispatches a turn, DEVICE_NOT_BOUND with the sentence', async () => {
    const opened = await as(ownerId, '/api/conversations', 'POST', { projectId });
    const { id } = (await opened.json()) as { id: string };
    const sent = await as(ownerId, `/api/conversations/${id}/messages`, 'POST', {
      content: 'what is open?',
      mode: 'agent',
    });
    expect(sent.status, await sent.clone().text()).toBe(409);
    const body = (await sent.json()) as Refusal;
    expect(body.code).toBe('DEVICE_NOT_BOUND');
    expect(body.message).toContain("judge-p's Runners page");
  });

  it('answers agent mode available once a device is bound', async () => {
    await bindOnline(defaultDeviceId, '/srv/judge-d1');
    const offer = await as(ownerId, `/api/conversations/agent-mode?projectId=${projectId}`);
    expect(await offer.json()).toMatchObject({ available: true, reason: null });
  });
});

describe('the DEVICE_NOT_BOUND sentence names only acts that work from its state', () => {
  it('names the Runners page before forge-runner bind, the slug written out', async () => {
    const offer = await as(ownerId, `/api/conversations/agent-mode?projectId=${projectId}`);
    const { reason } = (await offer.json()) as { reason: string };
    const assign = reason.indexOf("Assign the device on judge-p's Runners page");
    const bind = reason.indexOf(
      'once it is assigned, run `forge-runner bind judge-p --path <dir>` on that device',
    );
    expect(assign, reason).toBeGreaterThanOrEqual(0);
    expect(bind, reason).toBeGreaterThan(assign);
    expect(reason).not.toMatch(/<slug>|<project-slug>/);
  });
});

describe('onboarding needs no template and no per-project skill', () => {
  const INSTRUCTIONS = '# Forge Onboard — build the Project Brain\n\nOne question per turn.';

  it("opens the chat with Forge's own forge-onboard instructions in the first frame", async () => {
    await harness.db.execute(sql`
      INSERT INTO skills (id, scope, name, description, skill_md, prompt, source, content_hash)
      VALUES (${randomUUID()}, 'global', 'forge-onboard', 'onboard', ${INSTRUCTIONS}, '', 'builtin', 'h')
    `);
    await bindOnline(defaultDeviceId, '/srv/judge-d1');

    const res = await as(ownerId, `/api/projects/${projectId}/onboard`, 'POST');
    expect(res.status, await res.clone().text()).toBe(201);
    const start = published.find((p) => p.event === 'agent:start');
    expect(start?.room).toBe(`device:${defaultDeviceId}`);
    expect(String(start?.data.prompt)).toContain(INSTRUCTIONS);
    expect(String(start?.data.prompt)).not.toMatch(/^\/forge-onboard/);
    expect(start?.data.repoPath).toBe('/srv/judge-d1');
  });

  it("answers 503 ONBOARD_SKILL_MISSING naming the server's seed, and no act in the project, when Forge's own copy is not loaded", async () => {
    await bindOnline(defaultDeviceId, '/srv/judge-d1');
    const res = await as(ownerId, `/api/projects/${projectId}/onboard`, 'POST');
    expect(res.status, await res.clone().text()).toBe(503);
    const body = (await res.json()) as Refusal;
    expect(body.code).toBe('ONBOARD_SKILL_MISSING');
    expect(body.message).toContain('seeded when core starts');
    expect(body.message).not.toContain('template');
  });
});
