/**
 * ISS-1093 — pairing a box as an AGENT, driven through the three routes a
 * browser and a runner actually call.
 *
 * `issueDeviceCredential` is already proved on its own in
 * `agent-multi-project-fence-e2e.test.ts`. That test builds the holder itself,
 * so it stays green no matter what the approve route does with `agent_id` — it
 * cannot see a browser that never sends the field, or an approval that lets the
 * wrong person choose an agent. Everything below goes in at
 * `/api/devices/login/*` for that reason: the identity a box ends up with is
 * decided by what the APPROVAL recorded, and that is the only place it can be
 * measured.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestOrgMember,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let accounts: typeof import('../../src/orgs/agent-accounts.js');
let pat: typeof import('../../src/auth/pat.js');
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let resetRateLimits: () => void;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  accounts = await import('../../src/orgs/agent-accounts.js');
  pat = await import('../../src/auth/pat.js');
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ({ __resetRateLimitStore: resetRateLimits } = await import('../../src/middleware/rate-limit.js'));
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let orgId: string;
let ownerId: string;
let projectA: string;
let projectB: string;
let projectC: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  resetRateLimits();
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${ownerId}`);
  const a = await createTestProject(harness.db, ownerId);
  orgId = a.orgId;
  projectA = a.id;
  projectB = (await createTestProject(harness.db, ownerId, { orgId })).id;
  projectC = (await createTestProject(harness.db, ownerId, { orgId })).id;
});

const handle = () => `box-${randomUUID().slice(0, 8)}`;

/** What the CLI asks for: a pending code and the URL the browser opens. */
async function init(): Promise<string> {
  const res = await app.request('/api/devices/login/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device_label: 'a box',
      device_platform: 'linux',
      machine_id: randomUUID(),
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { pairing_code: string }).pairing_code;
}

/** What the browser posts. `agent_id` is omitted exactly as the screen omits it. */
async function approve(
  code: string,
  approverId: string,
  agentUserId?: string,
): Promise<Response> {
  return app.request('/api/devices/login/approve', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await signUserToken(approverId)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      pairing_code: code,
      ...(agentUserId ? { agent_id: agentUserId } : {}),
    }),
  });
}

/** What the runner polls for. */
async function poll(code: string): Promise<Response> {
  return app.request(`/api/devices/login/poll?pairing_code=${encodeURIComponent(code)}`);
}

async function restReaches(token: string, projectId: string): Promise<boolean> {
  const res = await app.request(`/api/projects/${projectId}/issues?limit=1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.status === 200;
}

describe('an org admin pairs a box as one of their agents', () => {
  // Criteria 31 (the server half of the drive), 32, 33.
  it('hands the box a credential belonging to the agent, fenced to the agent’s projects', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA, projectB],
      handle: handle(),
    });

    const code = await init();
    expect((await approve(code, ownerId, agent.userId)).status).toBe(200);

    const polled = await poll(code);
    expect(polled.status).toBe(200);
    const { device_token: token, device_id: deviceId } = (await polled.json()) as {
      device_token: string;
      device_id: string;
    };

    // cm:guard the token's OWNER is the assertion, and it is read back through `verifyPat`
    // — the same door a request arrives at. An approval that never recorded `agent_id`
    // mints for the approver instead, and every other assertion in this file stays green:
    // a person's box and an agent's box both pair, both poll, both get a token.
    expect((await pat.verifyPat(token))?.row.userId).toBe(agent.userId);

    const [device] = await harness.db.execute<{ owner_id: string }>(
      sql`SELECT owner_id FROM devices WHERE id = ${deviceId}`,
    );
    expect(device?.owner_id).toBe(agent.userId);

    expect(await restReaches(token, projectA)).toBe(true);
    expect(await restReaches(token, projectB)).toBe(true);
    expect(await restReaches(token, projectC)).toBe(false);
  });

  // cm:guard criterion 34, measured on THIS route rather than on the minting function:
  // a person's box is what every existing pairing is, and the fence it gets must not have
  // moved because the agent branch was added beside it.
  it('still pairs as the person, reaching no project, when no agent is chosen', async () => {
    const code = await init();
    expect((await approve(code, ownerId)).status).toBe(200);
    const { device_token: token } = (await (await poll(code)).json()) as { device_token: string };

    expect((await pat.verifyPat(token))?.row.userId).toBe(ownerId);
    expect(await restReaches(token, projectA)).toBe(false);
  });

  it('refuses an agent_id that is not a uuid, by name', async () => {
    const code = await init();
    const res = await approve(code, ownerId, 'not-a-uuid');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message?: string }).message).toContain('agent_id');
  });

  it('refuses an id that is a person rather than an agent', async () => {
    const code = await init();
    const res = await approve(code, ownerId, ownerId);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe('AGENT_NOT_FOUND');
  });
});

describe('who may hand a machine an agent’s identity', () => {
  // Criterion 35. The refusal is the deliverable: an ordinary member of the agent's own
  // org may approve a pairing for THEMSELVES all day, and may not approve one carrying
  // the agent.
  it('refuses a member of the agent’s org who is not an admin of it', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA],
      handle: handle(),
    });
    const member = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${member.id}`,
    );
    await createTestOrgMember(harness.db, { orgId, userId: member.id, role: 'member' });

    const code = await init();
    const res = await approve(code, member.id, agent.userId);
    expect([403, 404]).toContain(res.status);

    // cm:guard the code is still PENDING after the refusal, not approved-without-the-agent.
    // A route that refused the agent and approved the pairing anyway would hand that same
    // member a working box on the next poll — the refusal would read as honoured while the
    // machine came up regardless.
    expect((await poll(code)).status).toBe(204);
  });

  it('refuses an admin of a different org than the agent’s', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA],
      handle: handle(),
    });
    const stranger = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
    );
    // An owner of their own org, and nothing in this one.
    await createTestProject(harness.db, stranger.id);

    const code = await init();
    const res = await approve(code, stranger.id, agent.userId);
    expect([403, 404]).toContain(res.status);
    expect((await poll(code)).status).toBe(204);
  });

  it('lets the same member pair a box as themselves', async () => {
    const member = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${member.id}`,
    );
    await createTestOrgMember(harness.db, { orgId, userId: member.id, role: 'member' });

    const code = await init();
    expect((await approve(code, member.id)).status).toBe(200);
    const { device_token: token } = (await (await poll(code)).json()) as { device_token: string };
    expect((await pat.verifyPat(token))?.row.userId).toBe(member.id);
  });
});
