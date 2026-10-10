// REQ-34 r2 gates (ISS-453): each gated step stops only on a blocking gap, naming it on its question
// (BC-1, BC-18); a person agrees or approves only where the project's `approvals` setting turns that
// step on (BC-20, BC-25); the same refusal reaches a browser session and an agent's token (C3); and a
// revision reads back the criteria it added, changed and removed, computed (BC-7).

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

type Res = { status: number; body: Record<string, unknown> };

let projectId: string;
let ownerId: string;
let owner: string;
let member: string;
let memberId: string;
let agent: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  owner = await userToken(ownerId);
  memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, memberId, 'member');
  member = await userToken(memberId);
  const bot = await createTestUser({ kind: 'agent' });
  await addProjectMember(projectId, bot.id, 'member');
  agent = await patToken(bot.id, [projectId]);
  await seedProjectDocument(projectId, ownerId, {
    environments: {
      beta: { tier: 'staging', deploysFrom: 'main', deployment: { mode: 'external' } },
    } as never,
  });
});

const on = (token: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body) as Promise<Res>;

const refusals = (r: Res) =>
  (
    (r.body.error as { refusals?: { code: string; path: string }[] } | undefined)?.refusals ?? []
  ).map((x) => `${x.code} ${x.path}`);

/** Turns the project's person gates to `approvals`, through the project document's own write. */
async function setApprovals(approvals: Record<string, boolean>): Promise<void> {
  const held = (await on(owner, 'GET', '/config')).body as {
    revision: number;
    document: Record<string, unknown>;
  };
  const put = await on(owner, 'PUT', '/config', {
    baseRevision: held.revision,
    document: { ...held.document, approvals },
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
}

const seqOf = (key: string) => Number(key.slice(4));

/** `REQ-n` at revision 1 current, as its author left it: a title and criteria, nothing else. */
async function currentRequirement(ready = false): Promise<string> {
  const made = await on(owner, 'POST', '/requirements', {
    title: 'Reminders reach the nurse',
    reason: 'planted',
    criteria: [{ body: 'A nurse sees the reminder' }, { body: 'A patient can opt out' }],
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const key = String(made.body.key);
  if (ready) await makeAgreeReady(projectId, seqOf(key), ownerId);
  for (const path of [
    `/requirements/${key}/revisions/1/propose`,
    `/requirements/${key}/revisions/1/accept`,
  ]) {
    const r = await on(owner, 'POST', path, {});
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
  }
  return key;
}

describe('agreeing a requirement (ready_check)', () => {
  it('stops on each blocking gap, naming its question, the same through a session and an agent token', async () => {
    const key = await currentRequirement();
    const bySession = await on(member, 'POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    });
    const byAgent = await on(agent, 'POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    });
    const named = [
      'CHECKLIST_INCOMPLETE /answers/problem',
      'CHECKLIST_INCOMPLETE /answers/who',
      'CHECKLIST_INCOMPLETE /answers/value',
      'CHECKLIST_INCOMPLETE /answers/measured',
      'CHECKLIST_INCOMPLETE /answers/workflows',
    ];
    expect(bySession.status).toBe(422);
    expect(refusals(bySession)).toEqual(named);
    expect(byAgent.status).toBe(422);
    expect(refusals(byAgent)).toEqual(named);
    const [row] = (await db.execute(
      sql`SELECT status FROM requirements WHERE project_id = ${projectId} AND req_seq = ${seqOf(key)}`,
    )) as unknown as { status: string }[];
    expect(row?.status).toBe('draft');
  });

  it('setting off (the default): a member with no approve permission agrees a complete one', async () => {
    const key = await currentRequirement(true);
    const r = await on(member, 'POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('setting on: the member is refused naming the permission, and an approver agrees it', async () => {
    await setApprovals({ agree: true });
    const key = await currentRequirement(true);
    const refused = await on(agent, 'POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('requirements.approve');
    const agreed = await on(owner, 'POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    });
    expect(agreed.status, JSON.stringify(agreed.body)).toBe(200);
  });
});

describe('admitting an issue (Issue lifecycle ready-check)', () => {
  const create = (token: string) =>
    on(token, 'POST', '/issues', {
      title: 'Show the reminder',
      status: 'open',
      priority: 'medium',
      category: 'feature',
    });

  it('a birth asked at open with a gap stays at draft, its admission naming the gap', async () => {
    const r = await create(agent);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const admission = r.body.admission as {
      status: string;
      refusals: { code: string; path: string }[];
    };
    expect(admission.status).toBe('draft');
    expect(admission.refusals.map((x) => `${x.code} ${x.path}`)).toContain(
      'CHECKLIST_INCOMPLETE /answers/requirement',
    );
  });

  it('setting on: a member asking open is refused naming the permission, and may file at draft', async () => {
    await setApprovals({ admit: true });
    const r = await create(member);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(JSON.stringify(r.body)).toContain('its approvals.admit setting is on');
    const drafted = await on(member, 'POST', '/issues', {
      title: 'Show the reminder',
      priority: 'medium',
      category: 'feature',
    });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
  });
});

describe('approving a workflow design (design_check)', () => {
  const fixture = () => {
    const d = JSON.parse(
      readFileSync(
        new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
        'utf8',
      ),
    );
    d.project = projectId;
    return d as {
      flow: string;
      steps: { node?: Record<string, unknown> }[];
      edges?: Record<string, unknown>[];
    };
  };
  async function proposed(document: { flow: string }): Promise<string> {
    const made = await on(member, 'POST', '/workflows', { baseRevision: null, document });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = String((made.body.document as { id: string }).id);
    const p = await on(member, 'POST', `/workflows/${id}/design/propose`, { revision: 1 });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    return id;
  }

  const approve = (token: string, id: string) =>
    on(token, 'POST', `/workflows/${id}/design/decision`, { revision: 1, decision: 'approve' });

  it('stops on a design a requirement links with no criterion traced to a step, the same for an agent', async () => {
    const linked = fixture();
    linked.flow = 'linked';
    const id = await proposed(linked);
    const key = await currentRequirement();
    const link = await on(owner, 'POST', `/requirements/${key}/workflows`, { workflowId: id });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const bySession = await approve(member, id);
    const byAgent = await approve(agent, id);
    expect(bySession.status, JSON.stringify(bySession.body)).toBe(422);
    expect(refusals(bySession)).toEqual(['CHECKLIST_INCOMPLETE /answers/criteria']);
    expect(JSON.stringify(bySession.body)).toContain(
      `${key} links it, and none of their business criteria is traced to a step`,
    );
    expect(refusals(byAgent)).toEqual(refusals(bySession));
  });

  it('setting off: a member approves a complete design; setting on: refused, and the approver approves', async () => {
    const ok = await approve(member, await proposed(fixture()));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    await setApprovals({ designs: true });
    const second = fixture();
    second.flow = 'post-discharge-two';
    const id = await proposed(second);
    const refused = await approve(member, id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('workflow-designs.approve');
    const approved = await approve(owner, id);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  });
});

describe('a revision reads back what it did to the criteria (rev_check)', () => {
  it('names the codes added, reworded and removed against the head it was written against', async () => {
    const key = await currentRequirement();
    const wrote = await on(owner, 'POST', `/requirements/${key}/revisions`, {
      baseRevision: 1,
      reason: 'the nurse also hears it',
      spec: {},
      criteria: [
        { code: 'BC-1', body: 'A nurse sees and hears the reminder' },
        { body: 'A doctor sees the report' },
      ],
    });
    expect(wrote.status, JSON.stringify(wrote.body)).toBe(200);
    const read = await on(owner, 'GET', `/requirements/${key}`);
    const revisions = read.body.revisions as { revision: number; criteriaChanges: unknown }[];
    expect(revisions.find((r) => r.revision === 2)?.criteriaChanges).toEqual({
      against: 1,
      added: ['BC-3'],
      changed: ['BC-1'],
      removed: ['BC-2'],
    });
    expect(revisions.find((r) => r.revision === 1)?.criteriaChanges).toBeNull();
  });
});
