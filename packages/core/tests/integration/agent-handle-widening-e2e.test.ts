/**
 * ISS-1093 — where a multi-project agent meets a project's conversational voice.
 *
 * `docs/proposals/device-role-in-the-token-table.md` named this collision in advance
 * as the price of letting an agent hold more than one project membership, and ISS-1093
 * is the change that takes that step. Two rules meet here and neither may be relaxed
 * for the other: a project's handle is the agent that is a member of THIS project and
 * no other, and an agent's project set is the admin's to widen. The tests below are
 * about the one case where widening would leave a working project unable to open a
 * room, and about all the cases that look like it and are not.
 *
 * Kept apart from `agent-multi-project-fence-e2e.test.ts` because that file is about
 * the CREDENTIAL's reach and this one is about a NAME; they share a subject and not a
 * question.
 */

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
  /**
   * `docs/proposals/device-role-in-the-token-table.md` named this in advance as
   * the price of letting an agent hold more than one project membership, and
   * ISS-1093 is the change that takes that step.
   *
   * A project's handle is resolved as "the agent that is a member of this project,
   * oldest first". An agent covering eight projects is a member of every one of
   * them, so on the reading that held before this change it becomes the voice of
   * whichever has no handle yet — and it holds a write-capable credential, which a
   * minted handle deliberately does not.
   */
  // cm:guard the assertion is the MINT, not the absence of an error: resolving the handle has to
  // create a fresh handle-only account rather than return the multi-project agent. Asserting only
  // that some handle came back stays green over exactly the substitution this is about.
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

  // cm:guard the ONE widening a project cannot recover from is refused BY NAME, and the room that
  // depended on that handle still opens afterwards. Allowed through, the handle stops qualifying
  // as a candidate and the replacement is minted under the same slug-derived name, which
  // `(org_id, handle)` refuses by a decision ISS-1003 took on purpose — so a project that was
  // working stops opening rooms because of a write made about a different project. Asserting the
  // refusal alone would miss the second half.
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

  // cm:guard the refusal may not depend on this agent being the voice the resolver picks TODAY.
  // `existingProjectHandle` answers oldest-first, so a project holding an older differently-named
  // agent and a younger one carrying the canonical name selects the OLDER — and the first shape of
  // this refusal therefore let the younger one through. Two legal widenings then left the canonical
  // name occupied by an agent that no longer qualifies, which is the collision itself. The test
  // orders the two agents deliberately: without the ordering it passes against the broken code.
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

  // cm:guard and it is the NAME that decides, not being a project's only agent. An agent an admin
  // named for itself is also its project's voice today, and widening it is exactly what this issue
  // is for: the project simply mints its own slug-derived name next time, with nothing in the way.
  // Refusing here too would make the feature unusable for the ordinary case.
  it('still widens an agent that is its project\u2019s only agent but carries its own name', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectA],
      handle: handle(),
    });
    const out = await accounts.setAgentProjects(orgId, agent.userId, [projectA, projectB]);
    expect(out?.projects.sort()).toEqual([projectA, projectB].sort());
  });

  // cm:guard setting a handle's project set to the one it already has is not the widening this
  // refuses. An idempotent write must stay possible, or the refusal is a trap rather than a rule.
  it('still allows a project handle to be set to the project it already has', async () => {
    const first = await harness.db.transaction((tx) =>
      handles.resolveProjectHandle(tx as never, projectA),
    );
    const out = await accounts.setAgentProjects(orgId, first.userId, [projectA]);
    expect(out?.projects).toEqual([projectA]);
  });

  // cm:guard the narrowing may not take the EXISTING answer away. A handle minted for one project
  // is a member of that project and no other, so it must still be found — otherwise every room
  // already open would mint a second handle for a project that has one.
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
