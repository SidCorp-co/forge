import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let accounts: typeof import('../../src/orgs/agent-accounts.js');
let handles: typeof import('../../src/conversations/handles.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.NODE_ENV = 'test';
  accounts = await import('../../src/orgs/agent-accounts.js');
  handles = await import('../../src/conversations/handles.js');
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let orgId: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  const a = await createTestProject(harness.db, owner.id);
  orgId = a.orgId;
  projectA = a.id;
  projectB = (await createTestProject(harness.db, owner.id, { orgId })).id;
});

const handle = () => `master-${randomUUID().slice(0, 8)}`;

describe('a multi-project agent and a project’s conversational voice', () => {
  it('never makes a multi-project agent the handle of a project that has none', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA, projectB],
      handle: handle(),
    });

    const resolved = await harness.db.transaction((tx) =>
      handles.resolveProjectHandle(tx as never, projectA),
    );

    expect(resolved.userId).not.toBe(agent.userId);
    expect(resolved.minted).toBe(true);

    // And the account it did mint is the tokenless kind.
    const tokens = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM personal_access_tokens WHERE user_id = ${resolved.userId}`,
    );
    expect(Number(tokens[0]?.n)).toBe(0);
  });

  it('refuses to widen the agent carrying a project\u2019s own handle name, and the room still opens', async () => {
    const first = await harness.db.transaction((tx) =>
      handles.resolveProjectHandle(tx as never, projectA),
    );

    await expect(
      accounts.setAgentProjects(orgId, first.userId, [projectA, projectB]),
    ).rejects.toMatchObject({ status: 409 });

    const again = await harness.db.transaction((tx) =>
      handles.resolveProjectHandle(tx as never, projectA),
    );
    expect(again.userId).toBe(first.userId);
    expect(again.minted).toBe(false);
  });

  it('refuses the canonical-name holder even when another agent is the voice today', async () => {
    const older = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA],
      handle: handle(),
    });
    const [row] = await harness.db.execute<{ slug: string }>(
      sql`SELECT slug FROM projects WHERE id = ${projectA}`,
    );
    const canonicalName = handles.handleNameForProject(row?.slug as string, projectA);
    const canonical = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA],
      handle: canonicalName,
    });

    // The voice the resolver picks is the OLDER agent, not the one holding the canonical name.
    const voice = await harness.db.transaction((tx) =>
      handles.resolveProjectHandle(tx as never, projectA),
    );
    expect(voice.userId).toBe(older.agent.userId);

    await expect(
      accounts.setAgentProjects(orgId, canonical.agent.userId, [projectA, projectB]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('still widens an agent that is its project\u2019s only agent but carries its own name', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA],
      handle: handle(),
    });
    const out = await accounts.setAgentProjects(orgId, agent.userId, [projectA, projectB]);
    expect(out?.projects.sort()).toEqual([projectA, projectB].sort());
  });

  it('still allows a project handle to be set to the project it already has', async () => {
    const first = await harness.db.transaction((tx) =>
      handles.resolveProjectHandle(tx as never, projectA),
    );
    const out = await accounts.setAgentProjects(orgId, first.userId, [projectA]);
    expect(out?.projects).toEqual([projectA]);
  });

  it('still reuses the handle a project already has', async () => {
    const first = await harness.db.transaction((tx) =>
      handles.resolveProjectHandle(tx as never, projectA),
    );
    const again = await harness.db.transaction((tx) =>
      handles.resolveProjectHandle(tx as never, projectA),
    );
    expect(again.userId).toBe(first.userId);
    expect(again.minted).toBe(false);
  });
});
