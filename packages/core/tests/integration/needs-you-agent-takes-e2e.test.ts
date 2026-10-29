// REQ-68 BC-3, judged red on 0.4.0-dev.325 (K98): Needs you lists only decisions the agent may not
// take. The decisions read left the master's out as `agent_takes`, but `GET /needs-you`, which
// Development's Needs you list and the menu badges draw, still listed every one of them as the
// person's. Both reads now list one set: what the agent takes is in neither.
//
// @direct-test-of packages/core/src/development/needs-you-list.ts
// @direct-test-of packages/core/src/development/needs-you-decisions.ts
// @direct-test-of packages/core/src/master-accounts.ts

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeWorld, type Doc, ok, requester, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

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

/** A project where the member proposed a mockup on an issue, which the owner approves or declines. */
async function proposed() {
  const { id: projectId } = await createTestProject(ownerId);
  await addProjectMember(projectId, memberId, 'member');
  await addProjectMember(projectId, agentId, 'admin');
  const issue = await createTestIssue(projectId, ownerId, 1, {
    status: 'open',
    createdAt: new Date(),
  });
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
  return { say, issueKey: issue.key };
}

const asks = (needs: Doc) => (needs.items as Doc[]).filter((i) => i.space === 'asks');

describe('Needs you lists only decisions the agent may not take (REQ-68 BC-3)', () => {
  it('lists the mockup as the owner’s on both reads while no master may take it', async () => {
    master.id = null;
    const { say } = await proposed();
    const read = ok(await say('owner', 'GET', '/needs-you/decisions'));
    expect(read.decisions.map((d: Doc) => d.title)).toContain('checkout.html');
    const needs = ok(await say('owner', 'GET', '/needs-you'));
    expect(asks(needs).map((i) => i.title)).toContain('checkout.html');
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
    // the menu badges count `areas`: the issues area counts no row the master takes
    expect((needs.areas as Record<string, { you: number }>).issues?.you).toBe(
      asks(needs).filter((i) => i.area === 'issues').length,
    );
    const counted =
      read.total +
      (read.notDecisions as Doc[])
        .filter((n) => n.reason !== 'agent_takes')
        .reduce((n: number, x: Doc) => n + x.count, 0);
    expect(asks(needs)).toHaveLength(counted);
  });
});
