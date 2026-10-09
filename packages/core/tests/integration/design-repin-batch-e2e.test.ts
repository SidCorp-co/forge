/**
 * The HOP shape (2026-10-07/08): approving access at a new revision left six approved designs on its
 * old revision, and each was re-proposed and approved one by one though only its pin moved. One act
 * now clears them: the pin-only ones are re-pinned and approved together, one recorded decision per
 * design naming the act, and a design with any other change is refused by name.
 */

import { readFileSync } from 'node:fs';
import { saidDisagreements } from '@forge/contracts/said';
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
let ownerId: string;
let agentId: string;
let say: (who: 'owner' | 'master', method: string, path: string, body?: Doc) => Promise<Reply>;

const DEPENDENTS = [
  'operational-case',
  'complaint-intake',
  'complaint-ux',
  'campaign-ux',
  'evaluation-ux',
  'loyalty-ux',
] as const;

/** What the owner's one act re-pins: the dependents the master filed nothing for. */
const ACTED = ['operational-case', 'complaint-ux', 'evaluation-ux', 'loyalty-ux'] as const;

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
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'member');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    master: (
      await mintPat({
        permissions: ['*'],
        userId: agentId,
        name: 'master',
        projectIds: [projectId],
      })
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
const ids = new Map<string, string>();

async function approvedAt1(flow: string, basedOn?: Doc[]): Promise<string> {
  const made = ok(
    await say('master', 'POST', at('/workflows'), {
      baseRevision: null,
      document: design(flow, basedOn),
    }),
    201,
  );
  const id = made.document.id as string;
  ids.set(flow, id);
  ok(await say('master', 'POST', at(`/workflows/${id}/design/propose`), { revision: 1 }));
  ok(
    await say('owner', 'POST', at(`/workflows/${id}/design/decision`), {
      revision: 1,
      decision: 'approve',
    }),
  );
  return id;
}

const read = async (flow: string) =>
  ok(await say('owner', 'GET', at(`/workflows/${ids.get(flow)}/design`)));
const plan = async () =>
  ok(await say('owner', 'GET', at(`/workflows/${ids.get('access')}/design/repins`)));
const act = (revision: number, designs: Doc[]) =>
  say('owner', 'POST', at(`/workflows/${ids.get('access')}/design/repins`), { revision, designs });

/** The master's own re-proposal: the approved document written again with `edit` applied. */
async function rewrite(flow: string, edit: (d: Doc) => void): Promise<void> {
  const current = ok(await say('master', 'GET', at(`/workflows/${ids.get(flow)}`)));
  const { id, createdAt, updatedAt, ...doc } = current.document;
  void createdAt;
  void updatedAt;
  edit(doc);
  ok(
    await say('master', 'PUT', at(`/workflows/${id}`), {
      baseRevision: current.revision,
      document: doc,
    }),
  );
}

describe('a base approved at a new revision, with designs that only need their pin moved', () => {
  it('approves a filed pin-only proposal by itself, clears the rest in one act, and refuses a real change by name', async () => {
    await approvedAt1('access');
    const onAccess = [{ workflow: 'access', revision: 1 }];
    for (const flow of DEPENDENTS) {
      await approvedAt1(
        flow,
        flow === 'complaint-ux'
          ? [...onAccess, { workflow: 'complaint-intake', revision: 1 }]
          : onAccess,
      );
    }
    await approvedAt1('billing-ux', onAccess);

    await rewrite('access', (d) => {
      d.steps[0].node.label = 'Hospital HIS (revised)';
    });
    ok(
      await say('owner', 'POST', at(`/workflows/${ids.get('access')}/design/decision`), {
        revision: 2,
        decision: 'approve',
      }),
    );

    // what the master did on HOP: re-propose with only the pin moved, and one with a real change
    for (const flow of ['complaint-intake', 'campaign-ux']) {
      await rewrite(flow, (d) => {
        d.basedOn = [{ workflow: 'access', revision: 2 }];
      });
    }
    await rewrite('billing-ux', (d) => {
      d.basedOn = [{ workflow: 'access', revision: 2 }];
      d.steps[0].node.label = 'Billing source (renamed)';
    });

    // a proposal that only moves its pin approves by itself (REQ-41 BC-23): the master's two never wait
    for (const flow of ['complaint-intake', 'campaign-ux']) {
      const d = await read(flow);
      expect(d.status, flow).toBe('approved');
      expect(d.revisions[0].decision, flow).toBe('approve');
      expect(d.revisions[0].says.reason.key, flow).toBe('designs.reason.pinOnlyKernel');
    }
    expect((await read('billing-ux')).pinOnly).toBe(null);
    expect((await read('billing-ux')).status).toBe('proposed');

    const before = await plan();
    expect(before.base).toMatchObject({ flow: 'access', approvedRevision: 2 });
    const ready = before.ready.map((r: Doc) => r.flow);
    expect([...ready].sort()).toEqual([...ACTED].sort());
    const item = (flow: string) => before.ready.find((r: Doc) => r.flow === flow);
    expect(item('operational-case')).toMatchObject({
      source: 'approved',
      approves: 2,
      pins: [{ workflow: 'access', from: 1, to: 2 }],
      proof: { changed: ['/basedOn/0/revision'] },
    });
    expect(item('complaint-ux').pins).toEqual([
      { workflow: 'access', from: 1, to: 2 },
      { workflow: 'complaint-intake', from: 1, to: 2 },
    ]);
    expect(before.refused).toEqual([
      expect.objectContaining({
        flow: 'billing-ux',
        refusal: expect.objectContaining({ code: 'WORKFLOW_REPIN_PENDING_CHANGE' }),
      }),
    ]);

    const needs = ok(await say('owner', 'GET', at('/needs-you')));
    const designs = needs.items.filter((i: Doc) => i.area === 'designs');
    expect(designs.map((i: Doc) => i.key).sort()).toEqual([
      'access',
      'billing-ux',
      'complaint-intake',
    ]);
    expect(designs.find((i: Doc) => i.key === 'access')).toMatchObject({
      title: '4 designs only need their pin moved → r2',
      waitingOn: { kind: 'you' },
    });

    const named = (flows: readonly string[]) =>
      flows.map((flow) => {
        const row = [...before.ready, ...before.refused].find((r: Doc) => r.flow === flow);
        return { workflowId: row.workflowId, revision: row.revision };
      });

    const refused = await act(2, named([...ACTED, 'billing-ux']));
    expect(refused.status, JSON.stringify(refused.json)).toBe(422);
    expect(refused.json.error.refusals).toEqual([
      expect.objectContaining({ code: 'WORKFLOW_REPIN_PENDING_CHANGE', flow: 'billing-ux' }),
    ]);
    expect((await read('operational-case')).revisions).toHaveLength(1);

    const stale = await act(1, named(ACTED));
    expect(stale.status, JSON.stringify(stale.json)).toBe(409);

    const done = ok(await act(2, named(ACTED)));
    expect(done.approved).toHaveLength(4);
    const actId = done.act as string;
    expect(actId).toMatch(/^[0-9a-f-]{36}$/);

    for (const flow of ACTED) {
      const d = await read(flow);
      const [latest] = d.revisions;
      expect(d.status, flow).toBe('approved');
      expect(d.approvedRevision, flow).toBe(latest.revision);
      expect(d.approvalBlocked, flow).toBe(null);
      expect(latest.decision, flow).toBe('approve');
      expect(latest.decidedBy, flow).toBe(ownerId);
      expect(latest.reason, flow).toContain(actId);
      expect(latest.reason, flow).toContain('access r1 → r2');
      // the act's reason is Forge's own sentence, so a vi reader reads it in vi (ISS-368)
      expect(latest.says?.reason?.key, flow).toBe('designs.reason.repinOnly');
      expect(saidDisagreements(d), flow).toEqual([]);
      expect(latest.proposedBy, flow).toBe(ownerId);
    }
    const ux = await read('complaint-ux');
    expect(ux.revisions[0].document.basedOn).toEqual([
      { workflow: 'access', revision: 2 },
      { workflow: 'complaint-intake', revision: 2 },
    ]);

    const after = await plan();
    expect(after.ready).toEqual([]);
    expect(after.refused.map((r: Doc) => r.flow)).toEqual(['billing-ux']);
    const settled = ok(await say('owner', 'GET', at('/needs-you')));
    expect(settled.items.filter((i: Doc) => i.area === 'designs').map((i: Doc) => i.key)).toEqual([
      'billing-ux',
    ]);
  });
});
