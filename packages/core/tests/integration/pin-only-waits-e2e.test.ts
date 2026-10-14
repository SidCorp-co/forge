/**
 * REQ-41 BC-23 (docs/proposals/chat-first.md): nothing approves itself, a pin-only design revision
 * included (the owner's ruling of 2026-10-14). A proposal whose only change is its pins is read as
 * pin-only and waits inside its base's one "pin moved" act; its approver clears it there, or on its
 * own decision, and that approval names the person. The approval re-pins no requirement either
 * (BC-10): the requirement's mover does. Decisions the kernel wrote before the ruling still read as
 * Forge's, and the CHECKs that keep a kernel row from naming a person stay.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
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
import { createTestProject, createTestUser, makeAgreeReady, rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown) => say('owner', method, at(path), body);

const fixture = (flow: string, basedOn?: Doc[]): Doc => {
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

const ids = new Map<string, string>();

async function approvedAt1(flow: string, basedOn?: Doc[]): Promise<string> {
  const made = ok(
    await as('POST', '/workflows', { baseRevision: null, document: fixture(flow, basedOn) }),
    201,
  ).document as Doc;
  const id = made.id as string;
  ids.set(flow, id);
  ok(await as('POST', `/workflows/${id}/design/propose`, { revision: 1 }));
  ok(await as('POST', `/workflows/${id}/design/decision`, { revision: 1, decision: 'approve' }));
  return id;
}

const read = async (flow: string) => ok(await as('GET', `/workflows/${ids.get(flow)}/design`));

/** The design written again with `edit` applied, which proposes it. */
async function rewrite(flow: string, edit: (d: Doc) => void, issue?: string): Promise<void> {
  const current = ok(await as('GET', `/workflows/${ids.get(flow)}`));
  const { id, createdAt, updatedAt, ...doc } = current.document;
  void createdAt;
  void updatedAt;
  edit(doc);
  ok(
    await as('PUT', `/workflows/${id}`, {
      baseRevision: current.revision,
      document: doc,
      ...(issue ? { issue } : {}),
    }),
  );
}

/** Access written with a visible change and approved at its next revision. */
async function moveAccess(label: string): Promise<number> {
  const before = await read('access');
  const revision = (before.revisions[0].revision as number) + 1;
  await rewrite('access', (d) => {
    d.steps[0].node.label = label;
  });
  ok(
    await as('POST', `/workflows/${ids.get('access')}/design/decision`, {
      revision,
      decision: 'approve',
    }),
  );
  return revision;
}

const pinTo = (revision: number) => [{ workflow: 'access', revision }];

const needsYouDesigns = async (): Promise<string[]> =>
  (ok(await as('GET', '/needs-you')).items as Doc[])
    .filter((i) => i.area === 'designs')
    .map((i) => String(i.key));

/** The designs the owner's "pin moved" act on access would still take. */
const readyFlows = async (): Promise<string[]> =>
  (ok(await as('GET', `/workflows/${ids.get('access')}/design/repins`)).ready as Doc[]).map((r) =>
    String(r.flow),
  );

const ledger = (workflowId: string) =>
  rows<{ actor_type: string; reason: string | null }>(sql`
    SELECT actor_type, reason FROM kernel_transitions
     WHERE entity_id = ${workflowId} AND to_status = 'approved' ORDER BY created_at DESC`);

async function agreedTracing(workflowId: string, step: string): Promise<string> {
  const key = ok(
    await as('POST', '/requirements', {
      title: `The coordinator reaches the patient (${step})`,
      reason: 'a discharged patient is called back',
      criteria: [{ body: 'A discharged patient who needs follow-up is called.' }],
    }),
    201,
  ).key as string;
  ok(await as('POST', `/requirements/${key}/workflows`, { workflowId }));
  ok(
    await as('PUT', `/requirements/${key}/criteria/BC-1/steps`, {
      workflow: workflowId,
      steps: [step],
    }),
  );
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
  ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'ok' }));
  ok(await as('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'ok' }));
  return key;
}

const baselineActs = (key: string) =>
  rows<{ act: string }>(sql`
    SELECT b.act FROM requirement_baselines b JOIN requirements r ON r.id = b.requirement_id
     WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(key.slice(4))} ORDER BY b.seq`);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await seedProjectDocument(projectId, ownerId, { environments: {} });
  say = requester(app, { owner: await signUserToken(ownerId) });
  await approvedAt1('access');
  // every dependent is approved on access r1, before access moves
  for (const flow of ['ux', 'billing', 'chain']) {
    await approvedAt1(flow, pinTo(1));
  }
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('BC-23: a decision names who made it', () => {
  const insertDecided = (kind: string, user: string | null) =>
    db.execute(sql`
      INSERT INTO project_workflow_designs
        (workflow_id, revision, document, proposed_by_user, decision, decided_by_user, decided_kind, decided_at)
      VALUES (${ids.get('access')}, 99, '{}'::jsonb, ${ownerId}, 'approve', ${user}, ${kind}, now())`);

  it('refuses a kernel decision that names a user, and a person decision that names none', async () => {
    await expect(insertDecided('kernel', ownerId)).rejects.toMatchObject({
      cause: { constraint_name: 'project_workflow_designs_decided_chk' },
    });
    await expect(insertDecided('person', null)).rejects.toMatchObject({
      cause: { constraint_name: 'project_workflow_designs_decided_chk' },
    });
    await expect(insertDecided('kernel', null)).resolves.toBeDefined();
    await db.execute(sql`DELETE FROM project_workflow_designs WHERE revision = 99`);
    await expect(insertDecided('person', ownerId)).resolves.toBeDefined();
    await db.execute(sql`DELETE FROM project_workflow_designs WHERE revision = 99`);
  });

  it('shows a person decision as that person', async () => {
    const [first] = (await read('access')).revisions.slice(-1);
    expect(first).toMatchObject({ decidedBy: ownerId, decidedKind: 'person' });
    expect(first.decidedByName).not.toBe('Forge (pin-only)');
  });
});

const RULE = 'REQ-41 BC-23: nothing approves itself, a pin-only revision included';

describe('BC-23: a revision whose only change is its pins waits on its approver', () => {
  it('leaves a proposal that only moves its pin proposed, read as pin-only, inside its base\'s act', async () => {
    const key = await agreedTracing(ids.get('ux') as string, 'case');
    const r2 = await moveAccess('Hospital HIS (revised)');
    await settleOutbox();

    await rewrite('ux', (d) => {
      d.basedOn = pinTo(r2);
    });
    await settleOutbox();

    const d = await read('ux');
    expect(d.status, RULE).toBe('proposed');
    expect(d.approvedRevision).toBe(1);
    expect(d.revisions[0]).toMatchObject({ revision: 2, decision: null, decidedKind: null });
    expect(d.pinOnly).toMatchObject({ pins: [{ workflow: 'access', from: 1, to: r2 }] });
    expect(await ledger(ids.get('ux') as string), 'no kernel approval is on the ledger').toHaveLength(1);
    expect(await readyFlows()).toContain('ux');
    // the requirement tracing ux moves with no approval: nothing re-pins it by itself (BC-10)
    expect((await baselineActs(key)).map((b) => b.act)).toEqual(['agree']);
  });

  it('approves it through its base\'s one act as the person who took it, and still re-pins no requirement', async () => {
    const plan = ok(await as('GET', `/workflows/${ids.get('access')}/design/repins`));
    const ux = (plan.ready as Doc[]).find((r) => r.flow === 'ux') as Doc;
    const done = ok(
      await as('POST', `/workflows/${ids.get('access')}/design/repins`, {
        revision: plan.base.approvedRevision,
        designs: [{ workflowId: ux.workflowId, revision: ux.revision }],
      }),
    );
    expect(done.approved).toHaveLength(1);
    await settleOutbox();
    const d = await read('ux');
    expect(d.status).toBe('approved');
    expect(d.revisions[0]).toMatchObject({
      decision: 'approve',
      decidedBy: ownerId,
      decidedKind: 'person',
    });
    expect(d.revisions[0].decidedByName).not.toBe('Forge (pin-only)');
    const [rows0] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM requirement_baselines b JOIN requirements r ON r.id = b.requirement_id
       WHERE r.project_id = ${projectId} AND b.act = 'repin'`);
    expect(rows0?.n, 'REQ-41 BC-10: a design approval re-pins no requirement by itself').toBe(0);
  });

  it('leaves a proposal that moves a pin and changes one step label waiting on a person, outside the act', async () => {
    await rewrite('billing', (d) => {
      d.basedOn = pinTo(2);
      d.steps[0].node.label = 'Billing source (renamed)';
    });
    const d = await read('billing');
    expect(d.status).toBe('proposed');
    expect(d.revisions[0].decision).toBe(null);
    expect(d.pinOnly).toBe(null);
    expect(await needsYouDesigns()).toContain('billing');
  });

  it('leaves a pin-only proposal resting on a base still waiting proposed once the base is approved', async () => {
    const before = await read('access');
    const r3 = (before.revisions[0].revision as number) + 1;
    await rewrite('access', (d) => {
      d.steps[0].node.label = 'Hospital HIS (third)';
    });
    await rewrite('chain', (d) => {
      d.basedOn = pinTo(r3);
    });
    expect((await read('chain')).status, 'its base is not approved yet').toBe('proposed');
    ok(
      await as('POST', `/workflows/${ids.get('access')}/design/decision`, {
        revision: r3,
        decision: 'approve',
      }),
    );
    await settleOutbox();
    const d = await read('chain');
    expect(d.status, RULE).toBe('proposed');
    expect(d.revisions[0].decision).toBe(null);
    expect(await readyFlows()).toContain('chain');
  });
});

describe('BC-23: the design issue hears of no approval nobody made', () => {
  it('posts no approval notice for a pin-only proposal drawn under an issue', async () => {
    const second = randomUUID();
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
        VALUES (${second}, ${projectId}, 802, 'draws the pin move', 'in_progress', ${ownerId})`),
    );
    const access = (await read('access')).approvedRevision as number;
    const made = ok(
      await as('POST', '/workflows', {
        baseRevision: null,
        document: fixture('noticed', pinTo(access)),
      }),
      201,
    ).document as Doc;
    ids.set('noticed', made.id as string);
    ok(await as('POST', `/workflows/${made.id}/design/propose`, { revision: 1 }));
    ok(
      await as('POST', `/workflows/${made.id}/design/decision`, {
        revision: 1,
        decision: 'approve',
      }),
    );
    await moveAccess('Hospital HIS (fourth)');
    const r = (await read('access')).approvedRevision as number;
    await rewrite(
      'noticed',
      (d) => {
        d.basedOn = pinTo(r);
      },
      'ISS-802',
    );
    await settleOutbox();
    expect((await read('noticed')).status, RULE).toBe('proposed');
    const notices = await rows<{ body: string }>(sql`
      SELECT c.body FROM comments c WHERE c.issue_id = ${second} ORDER BY c.created_at`);
    expect(notices.filter((n) => n.body.includes('by Forge itself'))).toEqual([]);
  });
});

describe('BC-23: a baseline names who filed it', () => {
  it('refuses a kernel baseline that names a user, and a person baseline that names none', async () => {
    const [b] = await rows<{ requirement_id: string; revision: number }>(
      sql`SELECT requirement_id, revision FROM requirement_baselines WHERE act = 'agree' LIMIT 1`,
    );
    const insert = (kind: string, user: string | null) =>
      db.execute(sql`INSERT INTO requirement_baselines
        (requirement_id, revision, seq, act, agreed_by, agreed_kind)
        VALUES (${b?.requirement_id}, ${b?.revision}, 99, 'repin', ${user}, ${kind})`);
    await expect(insert('kernel', ownerId)).rejects.toMatchObject({
      cause: { constraint_name: 'requirement_baselines_agreed_kind_chk' },
    });
    await expect(insert('person', null)).rejects.toMatchObject({
      cause: { constraint_name: 'requirement_baselines_agreed_kind_chk' },
    });
    await expect(insert('kernel', null)).resolves.toBeDefined();
  });
});
