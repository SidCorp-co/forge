/**
 * What the approver reads before approving a design that builds on others: the base refusal core
 * already knows, with the facts a client words it from, and the designs approving a base strands.
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
    master: (await mintPat({ userId: agent, name: 'master', projectIds: [projectId] })).plaintext,
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
const read = async (id: string) => ok(await say('owner', 'GET', at(`/workflows/${id}/design`)));

describe('a design resting on a base approved at another revision', () => {
  it('names the designs approving the base strands, then refuses their approval with its facts', async () => {
    const base = await proposed('stale-base');
    ok(await approve(base, 1));
    const built = await proposed('stale-built', [{ workflow: 'stale-base', revision: 1 }]);
    expect((await read(built)).approvalBlocked).toBe(null);

    const next = design('stale-base');
    next.id = base;
    next.steps[0].node.label = 'Hospital HIS (revised)';
    ok(await say('master', 'PUT', at(`/workflows/${base}`), { baseRevision: 1, document: next }));
    expect((await read(base)).approvalLeavesStale).toEqual([
      { workflowId: built, flow: 'stale-built', revision: 1, basedOnRevision: 1 },
    ]);

    ok(await approve(base, 2));
    const fault = {
      workflow: 'stale-base',
      revision: 1,
      state: 'stale',
      approvedRevision: 2,
      designStatus: 'approved',
    };
    expect((await read(built)).approvalBlocked).toMatchObject({
      code: 'WORKFLOW_DESIGN_BASE_UNAPPROVED',
      revision: 1,
      bases: [fault],
    });

    const refused = await approve(built, 1);
    expect(refused.status, JSON.stringify(refused.json)).toBe(422);
    expect(refused.json.error.refusals).toEqual([
      expect.objectContaining({
        code: 'WORKFLOW_DESIGN_BASE_UNAPPROVED',
        path: '/revision',
        revision: 1,
        bases: [fault],
      }),
    ]);
  });
});
