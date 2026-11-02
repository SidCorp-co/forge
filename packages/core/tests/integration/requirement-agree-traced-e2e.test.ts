/**
 * ISS-691 (REQ-65 BC-7): a requirement's picture lights the steps each criterion touches, for every
 * kind, so the agree is refused while a live criterion traces no step or link of a linked design,
 * naming each untraced code and the trace that passes, and taken once each is traced. Where nothing
 * is linked the workflows question carries the gap alone: no refusal asks for a trace nothing could
 * hold. Run through the app's own routes against real Postgres, with requirement_ready enforced.
 *
 * @direct-test-of packages/core/src/requirements/checklist-record.ts
 * @direct-test-of packages/core/src/requirements/agree.ts
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, type Body, userToken } from '../helpers/api.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/factories.js';
import { enforceGates } from '../helpers/project-controls.js';

let token = '';
let projectId = '';

const at = (path: string) => `/api/projects/${projectId}${path}`;

async function ok(res: Promise<{ status: number; body: Body }>, status = 200): Promise<Body> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
}

type Refusal = { code: string; question?: string; path: string; detail: string };
const refusalsOf = (body: Body): Refusal[] =>
  (body.error as { refusals?: Refusal[] } | undefined)?.refusals ?? [];

const SPEC = {
  goal: 'Problem: buyers leave at a slow checkout.\nValue: a buyer pays in one step.\nMeasured by: checkouts finished per day.',
  personas: ['Buyer'],
};

/** An approved design, flow `flow`, from the post-discharge fixture: its steps are his, discharged, context, … */
async function approvedDesign(flow: string): Promise<void> {
  const document = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  document.project = projectId;
  document.flow = flow;
  const made = await ok(
    api(token, 'POST', at('/workflows'), { baseRevision: null, document }),
    201,
  );
  const id = (made.document as Body).id as string;
  await ok(api(token, 'POST', at(`/workflows/${id}/design/propose`), { revision: 1 }));
  await ok(
    api(token, 'POST', at(`/workflows/${id}/design/decision`), {
      revision: 1,
      decision: 'approve',
    }),
  );
}

/** A requirement of `kind` at a current r1 with two criteria, linking the designs named. */
async function requirementAtR1(kind: string, designs: string[]): Promise<string> {
  const key = (
    await ok(
      api(token, 'POST', at('/requirements'), {
        title: `Checkout as a ${kind}`,
        reason: 'buyers leave at checkout',
        spec: SPEC,
        criteria: [{ body: 'A buyer pays by card.' }, { body: 'A paid order is confirmed.' }],
        ...(designs.length ? { designs } : {}),
      }),
      201,
    )
  ).key as string;
  await ok(api(token, 'PUT', at(`/requirements/${key}/revisions/1/kind`), { kind }));
  await ok(api(token, 'POST', at(`/requirements/${key}/revisions/1/propose`), {}));
  await ok(api(token, 'POST', at(`/requirements/${key}/revisions/1/accept`), { reason: 'ok' }));
  return key;
}

const agree = (key: string) =>
  api(token, 'POST', at(`/requirements/${key}/agree`), {
    revision: 1,
    reason: 'Agreed for this test.',
  });

const trace = (key: string, code: string, steps: string[]) =>
  ok(
    api(token, 'PUT', at(`/requirements/${key}/criteria/${code}/steps`), {
      workflow: 'checkout',
      steps,
    }),
  );

beforeEach(async () => {
  await truncateAll();
  const owner = (await createTestUser({ verified: true })).id;
  token = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
  await enforceGates(projectId, owner, ['requirement_ready']);
  await approvedDesign('checkout');
}, 60_000);

describe('the agree of a requirement whose criteria trace no step', () => {
  for (const kind of ['process', 'screen']) {
    it(`refuses a ${kind} naming each untraced criterion, then takes it once each is traced`, async () => {
      const key = await requirementAtR1(kind, ['checkout']);
      const none = await agree(key);
      expect(none.status).toBe(422);
      const [refused, ...more] = refusalsOf(none.body);
      expect(more).toEqual([]);
      expect(refused).toMatchObject({
        code: 'CHECKLIST_INCOMPLETE',
        question: 'traced',
        path: '/answers/traced',
      });
      expect(refused?.detail).toContain(
        'BC-1, BC-2 trace no step or link of a linked workflow design.',
      );
      expect(refused?.detail).toContain(
        `PUT /api/projects/:id/requirements/${key}/criteria/BC-n/steps { "workflow": "checkout", "steps": [<step id>] }`,
      );

      await trace(key, 'BC-1', ['his']);
      const one = await agree(key);
      expect(one.status).toBe(422);
      const [still] = refusalsOf(one.body);
      expect(still?.question).toBe('traced');
      expect(still?.detail).toContain('BC-2 traces no step or link');
      expect(still?.detail).not.toContain('BC-1');

      await trace(key, 'BC-2', ['discharged']);
      await ok(agree(key));
    });
  }

  it('asks no trace of a requirement that links no design: the workflows question names that gap alone', async () => {
    const key = await requirementAtR1('report', []);
    const res = await agree(key);
    expect(res.status).toBe(422);
    expect(refusalsOf(res.body).map((r) => r.question)).toEqual(['workflows']);
  });
});
