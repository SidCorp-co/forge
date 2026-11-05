/**
 * REQ-34 BC-25, requirement-to-delivery r19 step `triage` (ISS-639): a person agrees a triage only
 * where the project's `approvals.triage` asks one. On, as it is wherever nothing sets it, routing an
 * item takes feedback.approve, and a writer without it proposes a `feedback_triage` suggestion a holder
 * accepts; off, any project writer routes it. A decline stays feedback.approve's either way.
 *
 * @direct-test-of packages/core/src/feedback/triage.ts
 * @direct-test-of packages/contracts/src/person-gates.ts
 * @direct-test-of packages/contracts/src/gate-profiles.ts
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { declareControls } from '../helpers/project-controls.js';
import { seedProjectDocument } from '../helpers/release-world.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

type Res = { status: number; body: Record<string, unknown> };

let projectId: string;
let ownerId: string;
let owner: string;
let member: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  owner = await userToken(ownerId);
  const memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, memberId, 'member');
  member = await userToken(memberId);
  await seedProjectDocument(projectId, ownerId, { environments: {} });
});

const on = (token: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body) as Promise<Res>;

/** Sets the project's `approvals`, through the project document's own write. */
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

async function fileBug(title: string): Promise<string> {
  const r = await on(member, 'POST', '/feedback', { kind: 'bug', title, screen: 'The board' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body.feedback as { key: string }).key;
}

const ROUTE = { route: 'issue', createIssue: {}, answers: TRIAGE_ANSWERS };
const triage = (token: string, fb: string, body: unknown = ROUTE) =>
  on(token, 'POST', `/feedback/${fb}/triage`, body);

const statusOf = async (fb: string) =>
  ((await on(owner, 'GET', `/feedback/${fb}`)).body.feedback as { status: string }).status;
const canTriage = async (token: string, fb: string) =>
  ((await on(token, 'GET', `/feedback/${fb}`)).body.feedback as { can: { triage: boolean } }).can
    .triage;

function refusalOf(r: Res): { code: string; detail: string } {
  expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
  const [first] = (r.body.error as { refusals: { code: string; detail: string }[] }).refusals;
  expect(first, JSON.stringify(r.body)).toBeDefined();
  return first as { code: string; detail: string };
}

describe('approvals.triage set nowhere: a person approves triage, as before the switch', () => {
  it('refuses a writer without feedback.approve, naming the gate and what turns it off', async () => {
    const fb = await fileBug('The board loses its cards');
    const refused = refusalOf(await triage(member, fb));
    expect(refused.code).toBe('PERMISSION_FORBIDDEN');
    expect(refused.detail).toContain('picking a feedback route');
    expect(refused.detail).toContain('needs feedback.approve');
    expect(refused.detail).toContain(
      "Gate approval_triage is enforced by this project's approvals.triage setting, which its gate profile standard defers to; changing approvals.triage, or gates.overrides.approval_triage, relaxes it",
    );
    expect(await statusOf(fb)).toBe('new');
    expect(await canTriage(member, fb)).toBe(false);
  });

  it('routes the item for a holder of feedback.approve', async () => {
    const fb = await fileBug('The board forgets its order');
    expect(await canTriage(owner, fb)).toBe(true);
    const r = await triage(owner, fb);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await statusOf(fb)).toBe('triaged');
  });

  it("lets the writer propose the triage instead, and a holder's accept routes it", async () => {
    const fb = await fileBug('The board drops a column');
    const proposed = await on(member, 'POST', '/suggestions', {
      kind: 'feedback_triage',
      feedback: fb,
      baseRevision: null,
      payload: { ...ROUTE, note: 'the dropped column' },
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    const id = (proposed.body.suggestion as { id: string }).id;
    expect(await statusOf(fb)).toBe('new');
    const accepted = await on(owner, 'POST', `/suggestions/${id}/accept`, { reason: 'Agreed.' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(await statusOf(fb)).toBe('triaged');
  });
});

describe('approvals.triage true: the same as set nowhere', () => {
  it('refuses the writer and routes for the approver', async () => {
    await setApprovals({ triage: true });
    const fb = await fileBug('The board hides a card');
    expect(refusalOf(await triage(member, fb)).code).toBe('PERMISSION_FORBIDDEN');
    expect(await statusOf(fb)).toBe('new');
    expect((await triage(owner, fb)).status).toBe(200);
    expect(await statusOf(fb)).toBe('triaged');
  });
});

describe('approvals.triage false: any project writer routes the item', () => {
  it('routes it for a writer without feedback.approve, and offers them the triage', async () => {
    await setApprovals({ triage: false });
    const fb = await fileBug('The board shows a stale count');
    expect(await canTriage(member, fb)).toBe(true);
    const r = await triage(member, fb);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await statusOf(fb)).toBe('triaged');
  });

  it('still asks feedback.approve to decline the item', async () => {
    await setApprovals({ triage: false });
    const fb = await fileBug('The board is slow');
    const refused = refusalOf(
      await triage(member, fb, { route: 'decline', note: 'Not something we will build.' }),
    );
    expect(refused.code).toBe('PERMISSION_FORBIDDEN');
    expect(refused.detail).toContain('declining feedback needs feedback.approve');
    expect(await statusOf(fb)).toBe('new');
  });

  it('is enforced again under strict, whatever the switch says', async () => {
    await setApprovals({ triage: false });
    await declareControls(projectId, ownerId, { gates: { profile: 'strict' } });
    const fb = await fileBug('The board double-saves');
    const refused = refusalOf(await triage(member, fb));
    expect(refused.detail).toContain(
      "Gate approval_triage is enforced by this project's gate profile strict (gates.profile)",
    );
    expect(await statusOf(fb)).toBe('new');
  });
});
