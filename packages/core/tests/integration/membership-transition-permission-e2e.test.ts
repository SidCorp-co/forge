/**
 * Who may move an ecosystem membership (ISS-824 part 11): accept, decline and leave are the member
 * project's acts and declare project.admin on the membership's project, which `assertSide` checks
 * with `requireDeclaredOn`; remove is the steward's and declares org.admin on the ecosystem's steward
 * organization. Through the app, against real Postgres.
 *
 * @direct-test-of packages/core/src/ecosystem/membership-service.ts
 * @direct-test-of packages/core/src/ecosystem/routes.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type EcosystemWorld,
  ecosystemDoc,
  ok,
  openWorld,
  requester,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';

let w: EcosystemWorld;
let send: ReturnType<typeof requester>;

beforeAll(async () => {
  w = await openWorld();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.project.plugin, memberId, 'member');
  send = requester(w.app, { ...w.token, member: await signUserToken(memberId) });
  w.eco = ok(
    await send('platform', 'POST', '/api/ecosystems', {
      baseRevision: null,
      document: ecosystemDoc(w.org.platform, 'forge-platform', 'FP'),
    }),
  ).id;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function invited(): Promise<string> {
  return ok(
    await send('platform', 'POST', `/api/ecosystems/${w.eco}/invitations`, {
      project: w.project.plugin,
    }),
  ).id;
}

describe('a membership transition is taken only by whom it declares', () => {
  let membership: string;

  it('refuses accept to a member of the project without project.admin', async () => {
    membership = await invited();
    const refused = await send('member', 'POST', `/api/memberships/${membership}/accept`);
    expect(refused.status, JSON.stringify(refused.json)).toBe(403);
    expect(JSON.stringify(refused.json)).toContain('project.admin');
    const viewer = await send('viewer', 'POST', `/api/memberships/${membership}/accept`);
    expect(viewer.status, JSON.stringify(viewer.json)).toBe(403);
  });

  it("accepts for a project admin of the membership's project", async () => {
    const accepted = ok(await send('plugin', 'POST', `/api/memberships/${membership}/accept`));
    expect(accepted.id).toBe(membership);
    expect(accepted.document.state).toBe('active');
  });

  it('refuses remove to an admin of the member project who is no admin of the steward org', async () => {
    const refused = await send('plugin', 'POST', `/api/memberships/${membership}/remove`, {
      reason: 'the steward did not ask for this',
    });
    expect(refused.status, JSON.stringify(refused.json)).toBe(403);
    const still = ok(await send('platform', 'GET', `/api/memberships/${membership}`));
    expect(still.history.length).toBeGreaterThan(0);
  });
});
