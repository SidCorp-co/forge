/**
 * A design pinned to a base's newest revision while that revision waits on its approver (FB-145,
 * ISS-580): the base is proposed, not stale, and the next act is approving the base, not the
 * writer's re-pin. A pin the base has moved past, approved elsewhere, still reads stale and still
 * asks its writer to re-pin.
 *
 * @direct-test-of packages/core/src/workflows/design-bases.ts
 * @direct-test-of packages/core/src/workflows/design-standing.ts
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

let projectId: string;
let say: (who: 'owner' | 'master', method: string, path: string, body?: Doc) => Promise<Reply>;

const design = (flow: string, basedOn?: Doc[]): Doc => {
  const d = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  d.project = projectId;
  d.flow = flow;
  if (basedOn) d.basedOn = basedOn;
  return d;
};

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'member');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    master: (
      await mintPat({ permissions: ['*'], userId: agent, name: 'master', projectIds: [projectId] })
    ).plaintext,
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
});

const at = (path: string) => `/api/projects/${projectId}${path}`;

async function proposed(flow: string, basedOn?: Doc[]): Promise<string> {
  const made = ok(
    await say('master', 'POST', at('/workflows'), {
      baseRevision: null,
      document: design(flow, basedOn),
    }),
    201,
  );
  const id = made.document.id as string;
  ok(await say('master', 'POST', at(`/workflows/${id}/design/propose`), { revision: 1 }));
  return id;
}

const approve = (id: string, revision: number) =>
  say('owner', 'POST', at(`/workflows/${id}/design/decision`), { revision, decision: 'approve' });
const read = async (id: string, who: 'owner' | 'master' = 'owner') =>
  ok(await say(who, 'GET', at(`/workflows/${id}/design`)));
const health = async (id: string) =>
  ok(await say('owner', 'GET', at(`/workflows/${id}/health`))).health;
const listed = async (id: string) =>
  ok(await say('owner', 'GET', at('/workflows'))).workflows.find((w: Doc) => w.document.id === id);

/** The base written again with one label changed, which puts its next revision to the approver. */
async function revise(id: string, flow: string, from: number, label: string): Promise<void> {
  const next = design(flow);
  next.id = id;
  next.steps[0].node.label = label;
  ok(await say('master', 'PUT', at(`/workflows/${id}`), { baseRevision: from, document: next }));
}

describe('a design pinned to the revision its base has put to the approver', () => {
  it('reads the base as proposed and waits on its approver, never on the writer re-pinning', async () => {
    const base = await proposed('pending-base');
    ok(await approve(base, 1));
    await revise(base, 'pending-base', 1, 'Hospital HIS (r2)');
    expect((await read(base)).status).toBe('proposed');

    const built = await proposed('pending-built', [{ workflow: 'pending-base', revision: 2 }]);
    const fault = {
      workflow: 'pending-base',
      revision: 2,
      state: 'proposed',
      approvedRevision: 1,
      designStatus: 'proposed',
    };

    // the design page: the approval still waits on the base, named as proposed rather than stale
    const page = await read(built);
    expect(
      page.approvalBlocked,
      'FB-145: a pin at the newest proposed base is not stale',
    ).toMatchObject({
      code: 'WORKFLOW_DESIGN_BASE_UNAPPROVED',
      bases: [fault],
    });
    expect(page.approvalBlocked.detail).not.toContain('stale');
    expect(page.waitingOn.says.act).toEqual({
      key: 'designs.act.approveBase',
      vars: { bases: 'pending-base r2' },
    });
    expect(page.waitingOn.kind, 'the owner may approve the base, so it is theirs').toBe('you');
    expect(page.waitingOn.says.rule.key).toBe('designs.rule.baseAwaitsApproval');

    // the health reading and the workflows list say the same
    const h = await health(built);
    expect(h.proposal.waitingOn.says.act.key).toBe('designs.act.approveBase');
    expect(JSON.stringify(h.proposal.waitingOn)).not.toContain('designs.act.repin');
    expect(JSON.stringify(h.proposal.waitingOn)).not.toContain('designs.base.stale');
    const row = await listed(built);
    expect(row.design.waitingOn.says.act.key).toBe('designs.act.approveBase');

    // approving the base is the act that clears it: the design's own approval then goes through
    ok(await approve(base, 2));
    expect((await read(built)).approvalBlocked).toBe(null);
    ok(await approve(built, 1));
  });

  it('still reads a pin its base has moved past as stale, the writer owing the re-pin', async () => {
    const base = await proposed('moved-base');
    ok(await approve(base, 1));
    await revise(base, 'moved-base', 1, 'Hospital HIS (r2)');
    const built = await proposed('moved-built', [{ workflow: 'moved-base', revision: 2 }]);
    // the base moves on to r3 before r2 is decided: r2 is neither approved nor the one proposed
    await revise(base, 'moved-base', 2, 'Hospital HIS (r3)');

    const page = await read(built);
    expect(page.approvalBlocked.bases).toEqual([
      {
        workflow: 'moved-base',
        revision: 2,
        state: 'stale',
        approvedRevision: 1,
        designStatus: 'proposed',
      },
    ]);
    expect(page.waitingOn.kind).toBe('agent');
    expect(page.waitingOn.says.act.key).toBe('designs.act.repin');
    expect((await health(built)).proposal.waitingOn.says.act.key).toBe('designs.act.repin');
  });
});
