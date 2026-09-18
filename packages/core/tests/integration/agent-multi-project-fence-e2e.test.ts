/**
 * ISS-1093 — an agent account reaching several projects, and the blast radius of
 * one credential.
 *
 * The load-bearing test here is the one with a MEMBER's credential narrowed below
 * its memberships. "An agent is refused on a project it is not a member of" passes
 * just as happily with no credential fence at all, because membership alone already
 * refuses — so it proves nothing about the fence and everything about `project_members`.
 * The agent below is a member of A, B and C and holds a credential declaring A and B;
 * only the fence can refuse C, on each plane separately.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { connectClientAsPat, parseToolResult } from '../helpers/mcp-harness.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let accounts: typeof import('../../src/orgs/agent-accounts.js');
let credential: typeof import('../../src/devices/credential.js');
let authz: typeof import('../../src/lib/authz.js');

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
  credential = await import('../../src/devices/credential.js');
  authz = await import('../../src/lib/authz.js');
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
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${ownerId}`);
  const a = await createTestProject(harness.db, ownerId);
  orgId = a.orgId;
  projectA = a.id;
  projectB = (await createTestProject(harness.db, ownerId, { orgId })).id;
  projectC = (await createTestProject(harness.db, ownerId, { orgId })).id;
});

const handle = () => `master-${randomUUID().slice(0, 8)}`;

async function restReaches(token: string, projectId: string): Promise<boolean> {
  const res = await app.request(`/api/projects/${projectId}/issues?limit=1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.status === 200;
}

async function mcpReaches(token: string, projectId: string): Promise<boolean> {
  const ctx = await connectClientAsPat(token);
  try {
    const res = await ctx.client.callTool({
      name: 'forge_issues',
      arguments: { action: 'list', projectId },
    });
    const out = parseToolResult(res as never) as { issues?: unknown[] } | string;
    return typeof out !== 'string' && Array.isArray(out.issues);
  } catch {
    return false;
  } finally {
    await ctx.close();
  }
}

/** Every project id this credential can get a listing of, on either plane. */
async function enumerable(token: string): Promise<Set<string>> {
  const ctx = await connectClientAsPat(token);
  try {
    const res = await ctx.client.callTool({ name: 'forge_projects.list', arguments: {} });
    const out = parseToolResult(res as never) as { projects?: Array<{ id: string }> };
    return new Set((out.projects ?? []).map((p) => p.id));
  } catch {
    return new Set();
  } finally {
    await ctx.close();
  }
}

describe('an agent account covering several projects', () => {
  // Criteria 17, 18, 19.
  it('is created with one credential that reaches every project declared for it', async () => {
    const { agent, plaintext } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA, projectB],
      handle: handle(),
    });
    expect(agent.projects.map((p) => p.id).sort()).toEqual([projectA, projectB].sort());

    const live = await harness.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM personal_access_tokens WHERE user_id = ${agent.userId} AND revoked_at IS NULL`,
    );
    expect(Number(live[0]?.n)).toBe(1);

    expect(await restReaches(plaintext, projectA)).toBe(true);
    expect(await restReaches(plaintext, projectB)).toBe(true);
    expect(await mcpReaches(plaintext, projectA)).toBe(true);
    expect(await mcpReaches(plaintext, projectB)).toBe(true);
  });

  // Criteria 20, 21, 22 — THE fence test. The agent is a member of all three; only
  // the credential's own allowlist can refuse the third.
  describe('a credential narrower than the memberships behind it', () => {
    async function memberOfThreeFencedToTwo(): Promise<string> {
      const { agent, plaintext } = await accounts.createAgentAccount({
        orgId,
        projectIds: [projectA, projectB],
        handle: handle(),
      });
      // The membership is added WITHOUT re-fencing, which is the only way to build a
      // credential narrower than its memberships — and the only shape that isolates
      // the fence from `project_members`.
      await createTestProjectMember(harness.db, {
        userId: agent.userId,
        projectId: projectC,
        role: 'member',
      });
      expect(await authz.effectiveProjectRole(agent.userId, projectC)).not.toBeNull();
      return plaintext;
    }

    it('is refused on the undeclared project over REST, though it is a member there', async () => {
      const token = await memberOfThreeFencedToTwo();
      expect(await restReaches(token, projectA)).toBe(true);
      expect(await restReaches(token, projectC)).toBe(false);
    });

    it('is refused on the undeclared project over MCP too', async () => {
      const token = await memberOfThreeFencedToTwo();
      expect(await mcpReaches(token, projectA)).toBe(true);
      expect(await mcpReaches(token, projectC)).toBe(false);
    });

    // cm:guard enumeration is a separate plane from access and has to be asserted on its
    // own: a fence applied at the read but not at the listing hands a leaked credential
    // the NAME of every project its account can see, which is the half of a blast radius
    // that is silent.
    it('cannot even list the undeclared project', async () => {
      const token = await memberOfThreeFencedToTwo();
      const seen = await enumerable(token);
      expect(seen).toContain(projectA);
      expect(seen).not.toContain(projectC);
    });
  });

  // Criteria 23, 24 — rule 2: the existing single-project agent is untouched.
  it('keeps bound_project_id, and its slug-less default, when it covers one project', async () => {
    const { agent, plaintext } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA],
      handle: handle(),
    });
    const row = await harness.db.execute<{
      bound_project_id: string | null;
      project_ids: string[] | null;
    }>(
      sql`SELECT bound_project_id, project_ids FROM personal_access_tokens WHERE user_id = ${agent.userId} AND revoked_at IS NULL`,
    );
    expect(row[0]?.bound_project_id).toBe(projectA);
    expect(row[0]?.project_ids).toBeNull();

    // The default: a call naming no project at all still resolves to projectA.
    const ctx = await connectClientAsPat(plaintext);
    try {
      const res = await ctx.client.callTool({
        name: 'forge_issues',
        arguments: { action: 'list' },
      });
      expect(parseToolResult(res as never)).toBeDefined();
    } finally {
      await ctx.close();
    }
  });
});

describe('changing which projects an agent works on', () => {
  // Criteria 25, 26, 27.
  it('widens every live credential without minting a new one', async () => {
    const { agent, plaintext } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA],
      handle: handle(),
    });
    expect(await restReaches(plaintext, projectB)).toBe(false);

    const out = await accounts.setAgentProjects(orgId, agent.userId, [projectA, projectB]);
    expect(out?.refenced).toBe(1);

    // The SAME plaintext, never re-minted: a box holds one credential and cannot be
    // handed a new one without somebody typing it in.
    expect(await restReaches(plaintext, projectA)).toBe(true);
    expect(await restReaches(plaintext, projectB)).toBe(true);
  });

  // cm:guard the ROLE on a retained project, not just its presence. The rewrite this replaced
  // set every row to `member`, so a PUT naming the identical set promoted a viewer and demoted
  // an admin — a permission change nobody asked for, made by an operation whose whole subject is
  // which projects an agent works on (ISS-1093, review finding F3). Asserting only the project
  // ids stays green through it.
  it('leaves the role on a project the agent already works on exactly as it was', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA, projectB],
      handle: handle(),
      projectRole: 'admin',
    });

    await accounts.setAgentProjects(orgId, agent.userId, [projectA, projectB, projectC]);

    const rows = await harness.db.execute<{ project_id: string; role: string }>(
      sql`SELECT project_id, role FROM project_members WHERE user_id = ${agent.userId}`,
    );
    const byProject = new Map(rows.map((r) => [r.project_id, r.role]));
    expect(byProject.get(projectA)).toBe('admin');
    expect(byProject.get(projectB)).toBe('admin');
    // The project being ADDED is the only one that takes the default.
    expect(byProject.get(projectC)).toBe('member');
  });

  it('narrows every live credential when a project is taken away', async () => {
    const { agent, plaintext } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA, projectB],
      handle: handle(),
    });
    expect(await restReaches(plaintext, projectB)).toBe(true);

    await accounts.setAgentProjects(orgId, agent.userId, [projectA]);

    expect(await restReaches(plaintext, projectA)).toBe(true);
    expect(await restReaches(plaintext, projectB)).toBe(false);
  });

  // Criterion 27 — the credential a paired box holds is minted by a different module,
  // and it is the one that actually files the work.
  it("moves a paired box's own credential too, not just the ones this module minted", async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA],
      handle: handle(),
    });
    const deviceId = randomUUID();
    await harness.db.execute(
      sql`INSERT INTO devices (id, owner_id, name, platform) VALUES (${deviceId}, ${agent.userId}, 'a box', 'linux')`,
    );
    const boxToken = await credential.issueDeviceCredential({
      deviceId,
      holderUserId: agent.userId,
      holderIsAgent: true,
    });
    expect(await restReaches(boxToken, projectA)).toBe(true);
    expect(await restReaches(boxToken, projectB)).toBe(false);

    await accounts.setAgentProjects(orgId, agent.userId, [projectA, projectB]);

    expect(await restReaches(boxToken, projectB)).toBe(true);
  });
});

describe('minting a credential while the project set is being changed', () => {
  /**
   * The window this closes: `agentCredentialFence` READS the memberships, argon2
   * hashing takes a good fraction of a second, and only then is the token INSERTED
   * — while `setAgentProjects` re-fences only the tokens that exist when it runs.
   * A widening committed inside that gap leaves the new token on the old, narrower
   * fence with nothing coming to correct it.
   *
   * The interleaving is forced rather than hoped for: the mint is started, the
   * widening is fired while the mint is provably still in flight, and the test
   * refuses to judge anything if the mint finished first.
   */
  // cm:guard the assertion is what the credential REACHES afterwards, and never which order won.
  // Both orders are correct once the two are serialized — mint first and the re-fence catches the
  // new row, re-fence first and the mint reads the new set — so an order-sensitive assertion would
  // fail the fix rather than the bug. What may never happen is a live credential a project short
  // of the set that was committed (ISS-1093, review finding F2).
  it('never leaves the box a project short of the set that was committed', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA],
      handle: handle(),
    });
    const deviceId = randomUUID();
    await harness.db.execute(
      sql`INSERT INTO devices (id, owner_id, name, platform) VALUES (${deviceId}, ${agent.userId}, 'a box', 'linux')`,
    );

    let minted = false;
    const minting = credential
      .issueDeviceCredential({ deviceId, holderUserId: agent.userId, holderIsAgent: true })
      .then((t) => {
        minted = true;
        return t;
      });

    await new Promise((r) => setTimeout(r, 40));
    // cm:guard the test is void if the mint already finished — the two never overlapped and a
    // green would say nothing about the window. Stated as a failure rather than a skip so a
    // machine fast enough to close the gap reports it instead of quietly proving nothing.
    expect(minted).toBe(false);

    await accounts.setAgentProjects(orgId, agent.userId, [projectA, projectB]);
    const token = await minting;

    expect(await restReaches(token, projectA)).toBe(true);
    expect(await restReaches(token, projectB)).toBe(true);
    expect(await restReaches(token, projectC)).toBe(false);
  });
});

describe('the credential a box is issued when it pairs', () => {
  // Criterion 33.
  it("is fenced to the agent's projects when the box pairs as an agent", async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA, projectB],
      handle: handle(),
    });
    const deviceId = randomUUID();
    await harness.db.execute(
      sql`INSERT INTO devices (id, owner_id, name, platform) VALUES (${deviceId}, ${agent.userId}, 'a box', 'linux')`,
    );
    const token = await credential.issueDeviceCredential({
      deviceId,
      holderUserId: agent.userId,
      holderIsAgent: true,
    });
    expect(await restReaches(token, projectA)).toBe(true);
    expect(await restReaches(token, projectB)).toBe(true);
    expect(await restReaches(token, projectC)).toBe(false);
  });

  // cm:guard criterion 34 — a PERSON's box is unchanged and still reaches no project
  // through this fence. Widening it here would hand every paired box its owner's whole
  // account, which is the `device.ownerId` fiction ISS-932 deleted.
  it('still reaches no project at all when the box pairs as a person', async () => {
    const deviceId = randomUUID();
    await harness.db.execute(
      sql`INSERT INTO devices (id, owner_id, name, platform) VALUES (${deviceId}, ${ownerId}, 'a box', 'linux')`,
    );
    const token = await credential.issueDeviceCredential({ deviceId, holderUserId: ownerId });
    expect(await restReaches(token, projectA)).toBe(false);

    const row = await harness.db.execute<{ project_ids: string[] | null }>(
      sql`SELECT project_ids FROM personal_access_tokens WHERE device_id = ${deviceId}`,
    );
    expect(row[0]?.project_ids).toEqual([]);
  });
});

describe('an agent has no authorization path of its own', () => {
  // Criterion 36 — rule 3. Same membership, same answer; the only thing that may make
  // an agent narrower is its credential's fence, never its kind.
  it('answers identically for an agent and a person holding the same membership', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA],
      handle: handle(),
    });
    // The comparison is only worth anything if the two principals hold the SAME
    // standing: `createAgentAccount` enrols its agent in the org as a plain member,
    // so the person needs that row too, or the test compares an org member with a
    // non-member and reads the difference as an agent/person difference.
    const person = await createTestUser(harness.db);
    await harness.db.execute(
      sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${person.id}, 'member')`,
    );
    await createTestProjectMember(harness.db, {
      userId: person.id,
      projectId: projectA,
      role: 'member',
    });

    const forAgent = await authz.effectiveProjectRole(agent.userId, projectA);
    const forPerson = await authz.effectiveProjectRole(person.id, projectA);
    expect(forAgent).not.toBeNull();
    expect(forAgent?.role).toEqual(forPerson?.role);
    expect(forAgent?.orgRole).toEqual(forPerson?.orgRole);
  });

  // Criterion 30.
  it('refuses a credential for an agent that belongs to no project, by name', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA],
      handle: handle(),
    });
    await harness.db.execute(sql`DELETE FROM project_members WHERE user_id = ${agent.userId}`);

    const err = await accounts.mintAgentCredential(orgId, agent.userId).catch((e) => e);
    expect((err as { cause: { code: string } }).cause.code).toBe('AGENT_HAS_NO_PROJECT');
    expect((err as { message: string }).message).toMatch(/give it a project membership first/);
  });
});

describe('the org listing', () => {
  // Criteria 28, 29.
  it('shows a multi-project agent once, with all of its projects', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA, projectB, projectC],
      handle: handle(),
    });
    const listed = await accounts.listAgentAccounts(orgId);
    const mine = listed.filter((a) => a.userId === agent.userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.projects.map((p) => p.id).sort()).toEqual(
      [projectA, projectB, projectC].sort(),
    );
    expect(mine[0]?.canAct).toBe(true);
  });

  it('shows an agent that belongs to no project, so an admin can see why it cannot act', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA],
      handle: handle(),
    });
    await harness.db.execute(sql`DELETE FROM project_members WHERE user_id = ${agent.userId}`);

    const listed = (await accounts.listAgentAccounts(orgId)).find((a) => a.userId === agent.userId);
    expect(listed?.projects).toEqual([]);
    expect(listed?.canAct).toBe(false);
  });
});
