/**
 * REQ-41 BC-23 (docs/proposals/chat-first.md): a design revision whose only change is re-pins approves
 * by itself. On dev five "approve N pin-only changes" rows waited on the owner though nothing in the
 * design changed but which revision of another design it pins. A pin-only proposal is approved by the
 * kernel in the transaction that proposes it, naming each pin moved; a pin plus one other change waits
 * on a person; a row already waiting when the rule shipped is cleared at boot by the same path; and
 * the requirement re-pin of BC-10 runs on that approval as on any other.
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
  for (const flow of ['ux', 'billing', 'summary', 'chain', 'legacy', 'opaque']) {
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

describe('BC-23: a revision whose only change is its pins approves by itself', () => {
  it('approves a proposal that only moves its pin, naming the pin, recorded as Forge and never a row for a person', async () => {
    const key = await agreedTracing(ids.get('ux') as string, 'case');
    const r2 = await moveAccess('Hospital HIS (revised)');
    await settleOutbox();

    await rewrite('ux', (d) => {
      d.basedOn = pinTo(r2);
    });

    const d = await read('ux');
    expect(d.status).toBe('approved');
    expect(d.approvedRevision).toBe(2);
    const [latest] = d.revisions;
    expect(latest).toMatchObject({
      revision: 2,
      decision: 'approve',
      decidedBy: null,
      decidedKind: 'kernel',
      decidedByName: 'Forge (pin-only)',
    });
    expect(latest.proposedBy, 'the proposer is the proposer, not the decider').toBe(ownerId);
    expect(latest.reason).toContain(`access r1 → r${r2}`);
    expect(latest.reason).toContain('Approved by Forge itself');
    expect(latest.says.reason.key).toBe('designs.reason.pinOnlyKernel');
    expect((await ledger(ids.get('ux') as string))[0]).toMatchObject({ actor_type: 'sweeper' });
    expect(await needsYouDesigns()).not.toContain('ux');

    // the ordinary approval's consequences follow: BC-10 re-pins the requirement on this approval
    await settleOutbox();
    expect((await baselineActs(key)).map((b) => b.act)).toEqual(['agree', 'repin']);
    // the follow was Forge's own, so the baseline names no person for it (state-never-lies)
    const [followed] = await rows<{ agreed_kind: string; agreed_by: string | null }>(sql`
      SELECT b.agreed_kind, b.agreed_by FROM requirement_baselines b JOIN requirements r ON r.id = b.requirement_id
       WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(key.slice(4))} AND b.act = 'repin'`);
    expect(followed).toEqual({ agreed_kind: 'kernel', agreed_by: null });
    const detail = ok(await as('GET', `/requirements/${key}`));
    expect((detail.baselines as Doc[]).find((b) => b.act === 'repin')).toMatchObject({
      agreedBy: null,
      agreedKind: 'kernel',
      agreedByName: 'Forge (pin-only)',
    });
    const history = detail.history as Doc[];
    const entry = history.find((h) => h.kind === 'Agreed' && h.source === 'system');
    expect(entry, JSON.stringify(history.map((h) => [h.kind, h.source, h.who]))).toBeDefined();
    expect(String(entry?.who)).toBe('Forge');
    expect(String(entry?.text)).toContain('Forge followed design ux r2 (pin-only)');
  });

  it('leaves a proposal that moves a pin and changes one step label waiting on a person', async () => {
    await rewrite('billing', (d) => {
      d.basedOn = pinTo(2);
      d.steps[0].node.label = 'Billing source (renamed)';
    });
    const d = await read('billing');
    expect(d.status).toBe('proposed');
    expect(d.revisions[0].decision).toBe(null);
    expect(await needsYouDesigns()).toContain('billing');
  });

  it('leaves a proposal that moves a pin and changes only the summary text waiting on a person', async () => {
    await rewrite('summary', (d) => {
      d.basedOn = pinTo(2);
      d.summary = 'the same steps, other words';
    });
    expect((await read('summary')).status).toBe('proposed');
  });

  it('approves a pin-only proposal resting on a base still waiting when the base is approved', async () => {
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
    const d = await read('chain');
    expect(d.status).toBe('approved');
    expect(d.revisions[0].says.reason.key).toBe('designs.reason.pinOnlyKernel');
  });

  it('clears a pin-only row that was already waiting when the rule shipped, through the same approval', async () => {
    const id = ids.get('legacy') as string;
    const r = (await read('access')).approvedRevision as number;
    await rewrite('legacy', (d) => {
      d.basedOn = pinTo(r);
    });
    expect((await read('legacy')).status).toBe('approved');
    // put the row back as dev held it: proposed, undecided, the approved revision the one before
    await rows(sql`
      UPDATE project_workflow_designs
         SET decision = NULL, decided_by_user = NULL, decided_kind = NULL, decided_at = NULL, reason = NULL, reason_says = NULL
       WHERE workflow_id = ${id} AND revision = 2`);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`);
      await tx.execute(
        sql`UPDATE project_workflows SET design_status = 'proposed', approved_revision = 1 WHERE id = ${id}`,
      );
    });
    expect((await read('legacy')).status).toBe('proposed');
    // a filed pin-only proposal is no row of its own: it waits inside its base's one "pin moved" act
    expect(await readyFlows()).toContain('legacy');

    const { reconcilePinOnlyDesigns } = await import('../../src/workflows/index.js');
    const settled = await reconcilePinOnlyDesigns();
    expect(settled.approved.map((a) => a.flow)).toContain('legacy');
    expect(settled.refused).toEqual([]);

    const d = await read('legacy');
    expect(d.status).toBe('approved');
    expect(d.revisions[0].says.reason.key).toBe('designs.reason.pinOnlyKernel');
    expect(await readyFlows()).not.toContain('legacy');
    expect((await ledger(id))[0]).toMatchObject({ actor_type: 'sweeper' });
    expect((await reconcilePinOnlyDesigns()).approved, 'a second boot writes nothing').toEqual([]);
  });

  it('refuses a design whose shape cannot be compared by name and approves nothing', async () => {
    const id = ids.get('opaque') as string;
    await rewrite('opaque', (d) => {
      d.basedOn = pinTo(1);
      d.steps[0].node.label = 'one real change, so it waits';
    });
    await rows(sql`
      UPDATE project_workflow_designs SET document = '{"unreadable": true}'::jsonb
       WHERE workflow_id = ${id} AND revision = 1`);
    const { reconcilePinOnlyDesigns } = await import('../../src/workflows/index.js');
    const settled = await reconcilePinOnlyDesigns();
    expect(settled.refused).toEqual([
      expect.objectContaining({ workflowId: id, code: 'WORKFLOW_DESIGN_UNCOMPARABLE' }),
    ]);
    expect(settled.approved.map((a) => a.workflowId)).not.toContain(id);
    expect((await read('opaque')).status).toBe('proposed');
  });
});

describe('BC-23: the design issue is told by Forge, not by a person', () => {
  it('posts the approval notice as the project agent, saying Forge approved it', async () => {
    const issue = randomUUID();
    const second = randomUUID();
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
        VALUES (${issue}, ${projectId}, 801, 'draws noticed', 'in_progress', ${ownerId})`),
    );
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
    ok(await as('POST', `/workflows/${made.id}/design/propose`, { revision: 1, issue: 'ISS-801' }));
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
    expect((await read('noticed')).status).toBe('approved');
    const notices = await rows<{ body: string; kind: string; author: string }>(sql`
      SELECT c.body, u.kind, c.author_id::text AS author FROM comments c JOIN users u ON u.id = c.author_id
       WHERE c.issue_id = ${second} ORDER BY c.created_at`);
    const told = notices.find((n) => n.body.includes('by Forge itself (pin-only'));
    expect(told, JSON.stringify(notices)).toBeDefined();
    expect(told).toMatchObject({ kind: 'agent' });
    expect(told?.author).not.toBe(ownerId);
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
