/**
 * A draft requirement's turn tells the truth about its agree: while a linked design holds no approved
 * revision the agree is refused REQUIREMENT_DESIGN_UNAPPROVED, so the requirement waits on that
 * design, never on the signer to agree it (FB-73: it read "You · agree r1" and the agree was refused).
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, type Body, userToken } from '../helpers/api.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';

let token = '';
let projectId = '';
let workflowId = '';
let req = '';

const at = (path: string) => `/api/projects/${projectId}${path}`;

async function ok(res: Promise<{ status: number; body: Body }>, status = 200): Promise<Body> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
}

async function standing(): Promise<Body> {
  const read = await ok(api(token, 'GET', at(`/requirements/${req}`)));
  return read.standing as Body;
}

const codesOf = (body: Body): string[] =>
  ((body.error as { refusals?: { code: string }[] } | undefined)?.refusals ?? []).map(
    (r) => r.code,
  );

beforeAll(async () => {
  const owner = (await createTestUser({ verified: true })).id;
  token = await userToken(owner);
  projectId = (await createTestProject(owner)).id;

  const document = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  document.project = projectId;
  document.flow = 'checkout';
  const made = await ok(
    api(token, 'POST', at('/workflows'), { baseRevision: null, document }),
    201,
  );
  workflowId = (made.document as Body).id as string;
  await ok(api(token, 'POST', at(`/workflows/${workflowId}/design/propose`), { revision: 1 }));

  req = (
    await ok(
      api(token, 'POST', at('/requirements'), {
        title: 'Checkout takes a card',
        reason: 'buyers pay at the end',
        criteria: [{ body: 'A buyer pays by card at checkout.' }],
      }),
      201,
    )
  ).key as string;
  await ok(api(token, 'POST', at(`/requirements/${req}/workflows`), { workflowId }));
  await ok(api(token, 'POST', at(`/requirements/${req}/revisions/1/propose`), {}));
  await ok(api(token, 'POST', at(`/requirements/${req}/revisions/1/accept`), { reason: 'ok' }));
}, 60_000);

describe('a draft requirement linked to a design that is only proposed', () => {
  it('waits on the design approver to approve that design, not on the signer to agree', async () => {
    const s = await standing();
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn).toMatchObject({
      kind: 'person',
      who: 'A holder of workflow-designs.approve',
      act: 'approve design Post-discharge follow-up',
    });
    expect((s.facts as Body).unapprovedDesigns).toEqual([
      { flow: 'checkout', title: 'Post-discharge follow-up', designStatus: 'proposed' },
    ]);
  });

  it('is refused the agree by the same rule the turn names', async () => {
    const res = await api(token, 'POST', at(`/requirements/${req}/agree`), {
      revision: 1,
      reason: 'ok',
    });
    expect(res.status).toBe(422);
    expect(codesOf(res.body)).toContain('REQUIREMENT_DESIGN_UNAPPROVED');
  });
});

describe('once the design is approved', () => {
  it('waits on the signer to agree it, and the agree is taken', async () => {
    await ok(
      api(token, 'POST', at(`/workflows/${workflowId}/design/decision`), {
        revision: 1,
        decision: 'approve',
      }),
    );
    const s = await standing();
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn).toMatchObject({ kind: 'you', act: 'agree r1' });
    expect((s.facts as Body).unapprovedDesigns).toEqual([]);
    await ok(api(token, 'POST', at(`/requirements/${req}/agree`), { revision: 1, reason: 'ok' }));
  });
});
