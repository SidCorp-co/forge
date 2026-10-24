/**
 * Designs whose bases name each other in a ring, both resting on a base approved at a new revision
 * (FB-150, ISS-584): one act re-pins and approves the whole ring, each member pinned to the revision
 * the act approves for the other, and a design resting on a ring member follows after it. The ring
 * re-pins whole or not at all: a member with a real change pending is refused by name, the rest of
 * its ring is held by name, and nothing is written. The health of each member keeps its provenance
 * markers and its evidence markers under their own names across the act (REQ-18 BC-5).
 *
 * @direct-test-of packages/core/src/workflows/design-repin.ts
 * @direct-test-of packages/core/src/workflows/design-repin-service.ts
 * @direct-test-of packages/core/src/workflows/design-repin-take.ts
 */

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
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
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const agentId = (await createTestUser({ kind: 'agent' })).id;
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
const id = (flow: string) => ids.get(flow) as string;

async function approvedAt1(flow: string, basedOn?: Doc[]): Promise<void> {
  const made = ok(
    await say('master', 'POST', at('/workflows'), {
      baseRevision: null,
      document: design(flow, basedOn),
    }),
    201,
  );
  ids.set(flow, made.document.id as string);
  ok(await say('master', 'POST', at(`/workflows/${id(flow)}/design/propose`), { revision: 1 }));
  await approve(flow, 1);
}

async function approve(flow: string, revision: number): Promise<void> {
  ok(
    await say('owner', 'POST', at(`/workflows/${id(flow)}/design/decision`), {
      revision,
      decision: 'approve',
    }),
  );
}

/** The design written again with `edit` applied: its next revision, put to the approver. */
async function rewrite(flow: string, edit: (d: Doc) => void): Promise<number> {
  const current = ok(await say('master', 'GET', at(`/workflows/${id(flow)}`)));
  const { id: _id, createdAt, updatedAt, ...doc } = current.document;
  void _id;
  void createdAt;
  void updatedAt;
  edit(doc);
  const put = ok(
    await say('master', 'PUT', at(`/workflows/${id(flow)}`), {
      baseRevision: current.revision,
      document: doc,
    }),
  );
  return put.revision as number;
}

const read = async (flow: string) =>
  ok(await say('owner', 'GET', at(`/workflows/${id(flow)}/design`)));
const plan = async (base: string) =>
  ok(await say('owner', 'GET', at(`/workflows/${id(base)}/design/repins`)));
const act = (base: string, revision: number, designs: Doc[]) =>
  say('owner', 'POST', at(`/workflows/${id(base)}/design/repins`), { revision, designs });
const named = (p: Doc, flows: readonly string[]) =>
  flows.map((flow) => {
    const row = [...p.ready, ...p.refused].find((r: Doc) => r.flow === flow);
    return { workflowId: row.workflowId, revision: row.revision };
  });

/** Each marker of a design's health as `kind rule target source`, in a stable order. */
async function markers(flow: string): Promise<string[]> {
  const h = ok(await say('owner', 'GET', at(`/workflows/${id(flow)}/health`))).health;
  return h.markers
    .map(
      (m: Doc) =>
        `${m.kind} ${m.rule} ${m.target.kind}:${m.target.step ?? ''} ${m.source.type}:${m.source.key}`,
    )
    .sort();
}

/** `base` approved at r2, and `a`, `b` naming each other as bases, both resting on `base` r1. */
async function ring(base: string, a: string, b: string): Promise<void> {
  await approvedAt1(base);
  await approvedAt1(a, [{ workflow: base, revision: 1 }]);
  await approvedAt1(b, [
    { workflow: base, revision: 1 },
    { workflow: a, revision: 1 },
  ]);
  // `a` now names `b` as a base too: the two name each other
  await rewrite(a, (d) => {
    d.basedOn = [
      { workflow: base, revision: 1 },
      { workflow: b, revision: 1 },
    ];
  });
  await approve(a, 2);
  await rewrite(base, (d) => {
    d.steps[0].node.label = 'Hospital HIS (revised)';
  });
  await approve(base, 2);
}

describe('designs whose bases name each other in a ring', () => {
  it('re-pins the whole ring in one act, and a design resting on it after it', async () => {
    await ring('access', 'intake', 'care');
    await approvedAt1('care-ux', [{ workflow: 'care', revision: 1 }]);

    // the evidence and provenance the members carry before the act
    ok(
      await say('owner', 'POST', at('/feedback'), {
        kind: 'bug',
        title: 'The discharge step reads the wrong ward',
        workflow: 'intake',
        node: { step: 'his' },
      }),
      201,
    );
    for (const flow of ['intake', 'care']) {
      await db.execute(sql`
        INSERT INTO project_workflow_observations
          (project_id, workflow_id, at_sha, revision, document, source, written_by, written_by_agency)
        VALUES (${projectId}, ${id(flow)}, ${'a'.repeat(40)}, 1,
                ${JSON.stringify({ steps: [], edges: [], drift: null })}::jsonb,
                'observer', ${ownerId}, 'agent')`);
    }
    const before = { intake: await markers('intake'), care: await markers('care') };
    expect(before.intake.some((m) => m.startsWith('needs_update '))).toBe(true);
    expect(before.intake.some((m) => m.startsWith('upcoming '))).toBe(true);
    expect(before.care.some((m) => m.startsWith('upcoming '))).toBe(true);

    const p = await plan('access');
    expect(p.refused, 'FB-150: a ring is no reason to refuse').toEqual([]);
    expect(p.ready.map((r: Doc) => [r.flow, r.approves])).toEqual([
      ['care', 2],
      ['intake', 3],
      ['care-ux', 2],
    ]);
    expect(p.ready.find((r: Doc) => r.flow === 'intake').pins).toEqual([
      { workflow: 'access', from: 1, to: 2 },
      { workflow: 'care', from: 1, to: 2 },
    ]);
    expect(p.ready.find((r: Doc) => r.flow === 'care').pins).toEqual([
      { workflow: 'access', from: 1, to: 2 },
      { workflow: 'intake', from: 1, to: 3 },
    ]);

    const done = ok(await act('access', 2, named(p, ['intake', 'care', 'care-ux'])));
    expect(done.approved.map((a: Doc) => [a.flow, a.revision])).toEqual([
      ['care', 2],
      ['intake', 3],
      ['care-ux', 2],
    ]);
    const intake = await read('intake');
    const care = await read('care');
    expect([intake.status, intake.approvedRevision]).toEqual(['approved', 3]);
    expect([care.status, care.approvedRevision]).toEqual(['approved', 2]);
    expect(intake.revisions[0].document.basedOn).toEqual([
      { workflow: 'access', revision: 2 },
      { workflow: 'care', revision: 2 },
    ]);
    expect(care.revisions[0].document.basedOn).toEqual([
      { workflow: 'access', revision: 2 },
      { workflow: 'intake', revision: 3 },
    ]);
    expect(intake.revisions[0].reason).toContain(done.act);
    expect(care.revisions[0].reason).toContain(done.act);
    expect((await read('care-ux')).revisions[0].document.basedOn).toEqual([
      { workflow: 'care', revision: 2 },
    ]);
    expect((await plan('access')).ready).toEqual([]);

    // REQ-18 BC-5: neither set of markers is hidden or replaced by the act
    expect(await markers('intake')).toEqual(before.intake);
    expect(await markers('care')).toEqual(before.care);
  });

  it('refuses the whole ring by name when one member has a real change pending, writing nothing', async () => {
    await ring('orders', 'cart', 'checkout');
    await rewrite('cart', (d) => {
      d.steps[0].node.label = 'Cart source (renamed)';
    });

    const p = await plan('orders');
    expect(p.ready).toEqual([]);
    const codes = Object.fromEntries(p.refused.map((r: Doc) => [r.flow, r.refusal.code]));
    expect(codes).toEqual({
      cart: 'WORKFLOW_REPIN_PENDING_CHANGE',
      checkout: 'WORKFLOW_REPIN_RING_HELD',
    });
    expect(p.refused.find((r: Doc) => r.flow === 'checkout').refusal.detail).toContain('"cart"');

    const refused = await act('orders', 2, named(p, ['cart', 'checkout']));
    expect(refused.status, JSON.stringify(refused.json)).toBe(422);
    expect(refused.json.error.refusals.map((r: Doc) => [r.flow, r.code]).sort()).toEqual([
      ['cart', 'WORKFLOW_REPIN_PENDING_CHANGE'],
      ['checkout', 'WORKFLOW_REPIN_RING_HELD'],
    ]);
    expect((await read('checkout')).revisions).toHaveLength(1);
    expect((await read('cart')).status).toBe('proposed');
  });
});
