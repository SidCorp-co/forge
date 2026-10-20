/**
 * ISS-1229 r22 — judge-63 deleted its scratch organization and the agent account its room had
 * minted (qa-j63-names) stayed behind: no membership, no token, and no door left to remove it. An
 * organization's own agent accounts now go with it, in the transaction that deletes it; one that
 * also belongs to another organization stays, and one still holding a device refuses the delete by
 * name rather than being left half-removed.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let accounts: typeof import('../../src/orgs/agent-accounts.js');
let handles: typeof import('../../src/conversations/handles.js');

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
  handles = await import('../../src/conversations/handles.js');
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let teamId: string;
let otherTeamId: string;
let projectId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${ownerId}`);
  teamId = (await seedOrg(harness.db, ownerId)).id;
  otherTeamId = (await seedOrg(harness.db, ownerId)).id;
  projectId = (
    await createTestProject(harness.db, ownerId, {
      slug: `room-${randomUUID().slice(0, 8)}`,
      orgId: teamId,
    })
  ).id;
});

async function deleteOrg(orgId: string): Promise<Response> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  return app.request(`/api/orgs/${orgId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${await signUserToken(ownerId)}` },
  });
}

async function userExists(userId: string): Promise<boolean> {
  const rows = await harness.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM users WHERE id = ${userId}`,
  );
  return Number(rows[0]?.n) === 1;
}

/** The three agents an organization can hold: a room's handle, an admin's agent, and one shared. */
async function agentsOfTheTeam() {
  const handle = await harness.db.transaction((tx) =>
    handles.resolveProjectHandle(tx as never, projectId),
  );
  const { agent: made } = await accounts.createAgentAccount({
    orgId: teamId,
    projectIds: [projectId],
    handle: 'ops-bot',
  });
  const { agent: shared } = await accounts.createAgentAccount({
    orgId: teamId,
    projectIds: [projectId],
    handle: 'shared-bot',
  });
  await harness.db.execute(
    sql`INSERT INTO organization_members (org_id, user_id, role, handle)
        VALUES (${otherTeamId}, ${shared.userId}, 'member', 'shared-bot')`,
  );
  // The route deletes only an organization holding no project.
  await harness.db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  return { handle: handle.userId, made: made.userId, shared: shared.userId };
}

/** Returns once some session waits on a lock `pid` holds, or `pending` settled first. */
async function blockedBy(pid: number, pending: Promise<unknown>): Promise<void> {
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let tries = 0; tries < 250 && !settled; tries += 1) {
    const waiting = await harness.db.execute(
      sql`SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`,
    );
    if (waiting.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('deleting an organization takes its own agent accounts with it', () => {
  it('deletes the agents that belonged to it alone, and keeps one another organization holds', async () => {
    const agents = await agentsOfTheTeam();

    const res = await deleteOrg(teamId);

    expect(res.status, await res.clone().text()).toBe(204);
    expect(await userExists(agents.handle)).toBe(false);
    expect(await userExists(agents.made)).toBe(false);
    expect(await userExists(agents.shared)).toBe(true);
    const kept = await harness.db.execute<{ org_id: string }>(
      sql`SELECT org_id FROM organization_members WHERE user_id = ${agents.shared}`,
    );
    expect(kept.map((r) => r.org_id)).toEqual([otherTeamId]);
  });

  it('leaves the people who were its members', async () => {
    await agentsOfTheTeam();

    expect((await deleteOrg(teamId)).status).toBe(204);
    expect(await userExists(ownerId)).toBe(true);
  });

  it('takes a revoked device of its agent with it rather than standing on it', async () => {
    const agents = await agentsOfTheTeam();
    const deviceId = randomUUID();
    await harness.db.execute(
      sql`INSERT INTO devices (id, owner_id, name, platform, status)
          VALUES (${deviceId}, ${agents.made}, 'old-box', 'linux', 'revoked')`,
    );

    expect((await deleteOrg(teamId)).status).toBe(204);
    expect(await userExists(agents.made)).toBe(false);
    const left = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM devices WHERE id = ${deviceId}`,
    );
    expect(Number(left[0]?.n)).toBe(0);
  });

  it('refuses by name while one of its agents still holds a live device, and deletes nothing', async () => {
    const agents = await agentsOfTheTeam();
    await harness.db.execute(
      sql`INSERT INTO devices (id, owner_id, name, platform)
          VALUES (${randomUUID()}, ${agents.made}, 'build-box', 'linux')`,
    );

    const res = await deleteOrg(teamId);
    const body = (await res.json()) as { code?: string; message?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe('ORG_AGENT_HOLDS_A_DEVICE');
    expect(body.message).toContain('@ops-bot');
    expect(body.message).toContain('build-box');
    const left = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM organizations WHERE id = ${teamId}`,
    );
    expect(Number(left[0]?.n)).toBe(1);
    expect(await userExists(agents.handle)).toBe(true);
    expect(await userExists(agents.made)).toBe(true);
  });

  // Review F1: an agent joining a second organization while the delete waits for it stays.
  it('keeps an agent that joined another organization while the delete waited on it', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId: teamId,
      projectIds: [projectId],
      handle: 'late-bot',
    });
    await harness.db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
    const postgres = (await import('postgres')).default;
    const client = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
    const a = await client.reserve();
    try {
      const [row] = await a`SELECT pg_backend_pid() AS pid`;
      await a`BEGIN`;
      await a`INSERT INTO organization_members (org_id, user_id, role, handle)
              VALUES (${otherTeamId}, ${agent.userId}, 'member', 'late-bot')`;
      const deleting = deleteOrg(teamId);
      await blockedBy(Number(row?.pid), deleting);
      await a`COMMIT`;
      expect((await deleting).status).toBe(204);
    } finally {
      a.release();
      await client.end({ timeout: 5 });
    }
    expect(await userExists(agent.userId)).toBe(true);
    const kept = await harness.db.execute<{ org_id: string }>(
      sql`SELECT org_id FROM organization_members WHERE user_id = ${agent.userId}`,
    );
    expect(kept.map((r) => r.org_id)).toEqual([otherTeamId]);
  });
});
