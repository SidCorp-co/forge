/**
 * The routes the web's authoring screens write through (lane 3, "UI gaps for the BA"), driven with the
 * bodies those screens send: a new revision opened on an agreed requirement with its reason and a
 * scenario's Given / When / Then steps, the open draft rewritten and proposed, and a design created as
 * a draft, rewritten, proposed and — once approved — sent back to its approver by a save alone. The
 * business rules the screens lean on hold here, in core: an agreed revision and a proposal are frozen,
 * one revision is open at a time, and a save is checked against the revision it was read at. Through
 * the app's own routes, against real Postgres.
 */

import { WORKFLOW_V2_SCHEMA_ID } from '@forge/contracts/workflows';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, type Body, userToken } from '../helpers/api.js';
import {
  createTestProject,
  createTestUser,
  makeAgreeReady,
  truncateAll,
} from '../helpers/factories.js';

let token = '';
let projectId = '';
let ownerId = '';

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
});

const at = (path: string) => `/api/projects/${projectId}${path}`;

async function ok(res: Promise<{ status: number; body: Body }>, status = 200): Promise<Body> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
}

const refusalsOf = (body: Body) =>
  ((body.error as { refusals?: { code: string; path: string }[] } | undefined)?.refusals ?? []).map(
    (r) => `${r.code} ${r.path}`,
  );

/** An agreed requirement: r1 holds BC-1 and BC-2, accepted and agreed. */
async function agreedRequirement(): Promise<string> {
  const created = await ok(
    api(token, 'POST', at('/requirements'), {
      title: 'Clinics export their bookings',
      reason: 'planted',
      criteria: [
        { body: 'A clinic downloads its bookings' },
        { body: 'The sheet names each column' },
      ],
    }),
    201,
  );
  const key = String(created.key);
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  await ok(api(token, 'POST', at(`/requirements/${key}/revisions/1/propose`), {}));
  await ok(api(token, 'POST', at(`/requirements/${key}/revisions/1/accept`), { reason: 'ok' }));
  await ok(
    api(token, 'POST', at(`/requirements/${key}/agree`), { revision: 1, reason: 'Owner agreed.' }),
  );
  return key;
}

type Revision = {
  revision: number;
  state: string;
  criteria: { code: string; body: string; form: string }[];
};
const revisionOf = (detail: Body, n: number) =>
  (detail.revisions as Revision[]).find((r) => r.revision === n) as Revision;

// the body revision-editor.tsx sends for a scenario: each part's first step under its keyword, the rest under And
const SCENARIO =
  'Given the week ends\nAnd the clinic is open\nWhen the export runs\nThen a sheet is sent';

describe('a new revision opened by hand on an agreed requirement', () => {
  it('takes its reason and the head criteria, keeps each code, numbers an added one, and stores the scenario whole', async () => {
    const req = await agreedRequirement();
    const opened = await ok(
      api(token, 'POST', at(`/requirements/${req}/revisions`), {
        baseRevision: 1,
        reason: 'Clinics asked for a weekly export',
        tldr: null,
        changeSummary: null,
        criteria: [
          { code: 'BC-1', body: SCENARIO, form: 'scenario' },
          { code: 'BC-2', body: 'The sheet names each column', form: 'statement' },
          { body: 'The sheet is in the clinic language', form: 'statement' },
        ],
      }),
    );
    const r2 = revisionOf(opened, 2);
    expect(r2.state).toBe('draft');
    expect(r2.criteria.map((c) => [c.code, c.form])).toEqual([
      ['BC-1', 'scenario'],
      ['BC-2', 'statement'],
      ['BC-3', 'statement'],
    ]);
    expect(r2.criteria[0]?.body).toBe(SCENARIO);
    expect(revisionOf(opened, 1).state).toBe('current');
  });

  it('refuses a scenario missing its When by name, at that criterion, and writes nothing', async () => {
    const req = await agreedRequirement();
    const res = await api(token, 'POST', at(`/requirements/${req}/revisions`), {
      baseRevision: 1,
      reason: 'x',
      criteria: [
        { code: 'BC-1', body: 'A clinic downloads its bookings', form: 'statement' },
        { code: 'BC-2', body: 'Given a clinic\nThen a sheet', form: 'scenario' },
      ],
    });
    expect(res.status).toBe(422);
    expect(refusalsOf(res.body)).toEqual(['CRITERION_SCENARIO_UNPARSEABLE /criteria/1/body']);
    const read = await ok(api(token, 'GET', at(`/requirements/${req}`)));
    expect((read.revisions as Revision[]).map((r) => r.revision)).toEqual([1]);
  });

  it('refuses a second revision while one is open, and one written against a head that moved', async () => {
    const req = await agreedRequirement();
    const body = {
      reason: 'x',
      criteria: [{ code: 'BC-1', body: 'A clinic downloads its bookings' }],
    };
    const stale = await api(token, 'POST', at(`/requirements/${req}/revisions`), {
      baseRevision: null,
      ...body,
    });
    expect(refusalsOf(stale.body)).toEqual(['REQUIREMENT_REVISION_STALE /baseRevision']);
    await ok(
      api(token, 'POST', at(`/requirements/${req}/revisions`), { baseRevision: 1, ...body }),
    );
    const second = await api(token, 'POST', at(`/requirements/${req}/revisions`), {
      baseRevision: 1,
      ...body,
    });
    expect(refusalsOf(second.body)).toEqual(['REQUIREMENT_REVISION_OPEN /baseRevision']);
  });
});

describe('only a draft is written', () => {
  it('rewrites the open draft, then freezes it once proposed, and never rewrites the agreed head', async () => {
    const req = await agreedRequirement();
    await ok(
      api(token, 'POST', at(`/requirements/${req}/revisions`), {
        baseRevision: 1,
        reason: 'weekly',
        criteria: [{ code: 'BC-1', body: 'A clinic downloads its bookings' }],
      }),
    );
    const rewrite = {
      reason: 'weekly',
      criteria: [{ code: 'BC-1', body: SCENARIO, form: 'scenario' }],
    };
    const edited = await ok(api(token, 'PUT', at(`/requirements/${req}/revisions/2`), rewrite));
    expect(revisionOf(edited, 2).criteria[0]?.body).toBe(SCENARIO);

    const head = await api(token, 'PUT', at(`/requirements/${req}/revisions/1`), rewrite);
    expect(head.status).toBe(422);
    expect(refusalsOf(head.body)).toEqual(['REQUIREMENT_REVISION_NOT_DRAFT /revision']);

    await ok(api(token, 'POST', at(`/requirements/${req}/revisions/2/propose`), {}));
    const proposed = await api(token, 'PUT', at(`/requirements/${req}/revisions/2`), rewrite);
    expect(refusalsOf(proposed.body)).toEqual(['REQUIREMENT_REVISION_NOT_DRAFT /revision']);
  });
});

describe('what the requirement links', () => {
  it('reads a project with no interface as linking no contract, and refuses one by name', async () => {
    const req = await agreedRequirement();
    // the web reads its linkable contracts from this read (`requirements/revision-draft.ts:linkableContracts`)
    const read = await ok(api(token, 'GET', at('/interface')));
    expect(read).toMatchObject({ declared: false, document: null });
    const res = await api(token, 'POST', at(`/requirements/${req}/contracts`), {
      contract: 'kho/api',
    });
    expect(res.status).toBe(422);
    expect(refusalsOf(res.body)).toEqual(['REQUIREMENT_CONTRACT_UNKNOWN /contract']);
  });
});

/**
 * A state design as the web's New design dialog writes it from the state-machine template's example
 * (`workflows/design-draft.ts:newDesign`): retitled, its steps the example's shape.
 */
const newDesign = () => ({
  $schema: WORKFLOW_V2_SCHEMA_ID,
  version: 2,
  project: projectId,
  flow: 'dat-lich-kham',
  kind: 'state',
  title: 'Đặt lịch khám',
  summary: 'A patient books a visit.',
  template: { id: 'state-machine', version: 1 },
  steps: [
    { id: 'start', does: 'The machine starts.', after: [] as string[], node: { type: 'INITIAL' } },
    {
      id: 'booked',
      does: 'The visit is booked.',
      after: ['start'],
      node: { type: 'STATE', label: 'Booked' },
    },
    {
      id: 'done',
      does: 'The visit happened.',
      after: ['booked'],
      node: { type: 'FINAL', label: 'Done' },
    },
  ],
  edges: [
    { from: 'start', to: 'booked', label: 'booking.made' },
    { from: 'booked', to: 'done', label: 'visit.held' },
  ],
  writtenBy: {},
});

/** The design after an Edit-view save: one more end state, and the line to it. */
const withSteps = (doc: ReturnType<typeof newDesign>) => ({
  ...doc,
  steps: [
    ...doc.steps,
    {
      id: 'cancelled',
      does: 'The visit is called off.',
      after: ['booked'],
      node: { type: 'FINAL', label: 'Cancelled' },
    },
  ],
  edges: [...doc.edges, { from: 'booked', to: 'cancelled', label: 'booking.cancelled' }],
});

describe('a design authored by hand', () => {
  it('is created as a draft, stays a draft through a save, and is proposed by its own act at the revision read', async () => {
    const made = await ok(
      api(token, 'POST', at('/workflows'), { baseRevision: null, document: newDesign() }),
      201,
    );
    const id = (made.document as Body).id as string;
    expect(made).toMatchObject({ revision: 1, design: { status: 'draft' } });

    const saved = await ok(
      api(token, 'PUT', at(`/workflows/${id}`), {
        baseRevision: 1,
        document: withSteps(newDesign()),
      }),
    );
    expect(saved).toMatchObject({ revision: 2, design: { status: 'draft' } });

    const stale = await api(token, 'POST', at(`/workflows/${id}/design/propose`), { revision: 1 });
    expect(refusalsOf(stale.body)).toEqual(['WORKFLOW_DESIGN_REVISION_STALE /revision']);
    const proposed = await ok(
      api(token, 'POST', at(`/workflows/${id}/design/propose`), { revision: 2 }),
    );
    expect(proposed).toMatchObject({ status: 'proposed', proposedRevision: 2 });
  });

  it('refuses a save over a revision that moved, writing nothing', async () => {
    const made = await ok(
      api(token, 'POST', at('/workflows'), { baseRevision: null, document: newDesign() }),
      201,
    );
    const id = (made.document as Body).id as string;
    await ok(
      api(token, 'PUT', at(`/workflows/${id}`), {
        baseRevision: 1,
        document: withSteps(newDesign()),
      }),
    );
    const res = await api(token, 'PUT', at(`/workflows/${id}`), {
      baseRevision: 1,
      document: newDesign(),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(refusalsOf(res.body)[0]).toMatch(/^STALE_BASE/);
    const read = await ok(api(token, 'GET', at(`/workflows/${id}`)));
    expect(read.revision).toBe(2);
  });

  it('refuses a lone first step its template owes a line from, by name: why the dialog starts from the example', async () => {
    const lone = { ...newDesign(), steps: [newDesign().steps[0]], edges: [] };
    const res = await api(token, 'POST', at('/workflows'), { baseRevision: null, document: lone });
    expect(res.status).toBe(422);
    expect(refusalsOf(res.body)).toContain('WORKFLOW_NODE_LINES /steps/0');
  });

  it('refuses a step its template does not declare at that step, by name', async () => {
    const doc = newDesign();
    doc.steps[1] = {
      ...doc.steps[1],
      node: { type: 'SCREEN', label: 'Home' },
    } as (typeof doc.steps)[number];
    const res = await api(token, 'POST', at('/workflows'), { baseRevision: null, document: doc });
    expect(res.status).toBe(422);
    expect(refusalsOf(res.body)).toContain('WORKFLOW_NODE_TYPE_NOT_IN_TEMPLATE /steps/1/node/type');
  });

  it('once approved, goes back to its approver by a save alone', async () => {
    // the Edit view's optional fields answer the approval checklist: who owns a step, what happens on a failure
    const approvable = () => {
      const doc = withSteps(newDesign());
      const owned: Record<string, string> = { type: 'STATE', label: 'Booked', owner: 'Front desk' };
      doc.steps[1] = { ...doc.steps[1], node: owned } as (typeof doc.steps)[number];
      doc.edges[2] = {
        ...doc.edges[2],
        onFailure: 'the slot is released',
      } as (typeof doc.edges)[number];
      return doc;
    };
    const made = await ok(
      api(token, 'POST', at('/workflows'), { baseRevision: null, document: approvable() }),
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
    const changed = { ...approvable(), summary: 'A patient books and attends a visit.' };
    const saved = await ok(
      api(token, 'PUT', at(`/workflows/${id}`), { baseRevision: 1, document: changed }),
    );
    expect(saved).toMatchObject({
      revision: 2,
      design: { status: 'proposed', approvedRevision: 1 },
    });
  });
});
