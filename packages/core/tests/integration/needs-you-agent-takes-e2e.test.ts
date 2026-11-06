// REQ-68 BC-3, judged red on 0.4.0-dev.325 (K98): Needs you lists only decisions the agent may not
// take. The decisions read left the master's out as `agent_takes`, but `GET /needs-you`, which
// Development's Needs you list and the menu badges draw, still listed every one of them as the
// person's. Both reads now list one set: what the agent takes is in neither. Who takes it is the
// one rule's (ISS-1058, `who-owes.ts`): the project's policy, never whether a master stands. A mockup on an issue
// is listed on the requirement the issue delivers, never as the issue's (REQ-68 BC-4, BC-6).
//
// @direct-test-of packages/core/src/development/needs-you-list.ts
// @direct-test-of packages/core/src/development/needs-you-decisions.ts
// @direct-test-of packages/core/src/master-accounts.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeWorld, type Doc, ok, requester, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { declareControls } from '../helpers/project-controls.js';

/** The project's master: the agent account its panes write under, when the test pairs one. */
const master = vi.hoisted(() => ({ id: null as string | null }));

vi.mock('../../src/master-accounts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/master-accounts.js')>()),
  masterAccountsOf: async () => ({ accounts: master.id ? [master.id] : [], unread: [] }),
}));

let app: Awaited<typeof import('../../src/index.js')>['app'];
let ownerId: string;
let memberId: string;
let agentId: string;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  testEnv();
  ({ app } = await import('../../src/index.js'));
  const { userToken } = await import('../helpers/api.js');
  ownerId = (await createTestUser({ verified: true })).id;
  memberId = (await createTestUser({ verified: true })).id;
  agentId = (await createTestUser({ kind: 'agent' })).id;
  tokens.owner = await userToken(ownerId);
  tokens.member = await userToken(memberId);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/**
 * A project where the member proposed a mockup on an issue delivering REQ-1, which the owner approves
 * or declines on REQ-1.
 */
async function proposed(profile: 'standard' | 'strict' = 'standard') {
  const { id: projectId } = await createTestProject(ownerId);
  await declareControls(projectId, ownerId, { gates: { profile } });
  await addProjectMember(projectId, memberId, 'member');
  await addProjectMember(projectId, agentId, 'admin');
  const issue = await createTestIssue(projectId, ownerId, 1, {
    status: 'open',
    createdAt: new Date(),
  });
  const req = await createTestRequirement(projectId, 1, 'Checkout takes one page');
  await rows(sql`UPDATE issues SET requirement_id = ${req.id} WHERE id = ${issue.id} RETURNING id`);
  const say = (who: 'owner' | 'member', method: string, path: string, body?: unknown) =>
    requester(app, tokens)(who, method, `/api/projects/${projectId}${path}`, body);
  ok(
    await say('member', 'POST', '/mockups', {
      target: { issue: issue.key },
      kind: 'html',
      name: 'checkout.html',
      mime: 'text/html',
      caption: 'the checkout as it should look',
      contentBase64: Buffer.from('<p>checkout</p>').toString('base64'),
    }),
    201,
  );
  return { say, issueKey: issue.key, reqKey: req.key };
}

const asks = (needs: Doc) => (needs.items as Doc[]).filter((i) => i.space === 'asks');

describe('Needs you lists only decisions the agent may not take (REQ-68 BC-3)', () => {
  // ISS-1058: whether a master stands no longer decides it; the project's own policy does
  it('lists the mockup as the owner’s on both reads where the project’s policy keeps it theirs', async () => {
    master.id = null;
    const { say, issueKey, reqKey } = await proposed('strict');
    const read = ok(await say('owner', 'GET', '/needs-you/decisions'));
    const mockup = (read.decisions as Doc[]).find((d) => d.title === 'checkout.html');
    expect(mockup?.area).toBe('requirements');
    expect(mockup?.opens).toEqual({ kind: 'requirement', key: reqKey });
    expect(JSON.stringify(read.decisions)).not.toContain('"kind":"issue"');
    const needs = ok(await say('owner', 'GET', '/needs-you'));
    expect(asks(needs).map((i) => i.title)).toContain('checkout.html');
    expect(asks(needs).map((i) => i.key)).not.toContain(issueKey);
  });

  it('lists it on neither read once the project’s master holds the approve, and counts one set', async () => {
    master.id = agentId;
    const { say } = await proposed();
    const read = ok(await say('owner', 'GET', '/needs-you/decisions'));
    expect(read.decisions.map((d: Doc) => d.title)).not.toContain('checkout.html');
    const taken = (read.notDecisions as Doc[]).find((n) => n.reason === 'agent_takes');
    expect(taken?.items.map((i: Doc) => i.title)).toContain('checkout.html');

    const needs = ok(await say('owner', 'GET', '/needs-you'));
    expect(asks(needs).map((i) => i.title)).not.toContain('checkout.html');
    // the menu badges count `areas`: the requirements area counts no row the master takes, and
    // there is no issues area to count
    expect((needs.areas as Record<string, { you: number }>).requirements?.you).toBe(
      asks(needs).filter((i) => i.area === 'requirements').length,
    );
    expect(Object.keys(needs.areas as Doc)).not.toContain('issues');
    const counted =
      read.total +
      (read.notDecisions as Doc[])
        .filter((n) => n.reason !== 'agent_takes')
        .reduce((n: number, x: Doc) => n + x.count, 0);
    expect(asks(needs)).toHaveLength(counted);
  });
});
