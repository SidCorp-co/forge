// @direct-test-of packages/core/src/guides/
/**
 * What the served guides tell a REST-only reader holds against the running app (ISS-612, ISS-579):
 * the judging guide answers with no credential, and a design written and traced exactly as the
 * workflow-design guide gives the body is taken, while each refusal it names is the one core returns.
 */

import { readFileSync } from 'node:fs';
import { WORKFLOW_LIMITS } from '@forge/contracts/workflows';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, type Body, userToken } from '../helpers/api.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';

let token: string;
let projectId: string;

const at = (path: string) => `/api/projects/${projectId}${path}`;
const refusals = (body: Body) =>
  ((body.error as { refusals?: { code: string; path: string }[] } | undefined)?.refusals ?? []).map(
    (r) => `${r.code} ${r.path}`,
  );

/** A design document carrying every field the guide's create body names. */
function document(flow: string): Body {
  const d = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  ) as Body;
  return { ...d, project: projectId, flow };
}

beforeAll(async () => {
  const owner = (await createTestUser({ verified: true })).id;
  token = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
}, 60_000);

describe('the judging guide, read with no credential', () => {
  it('is in the index and served as markdown at its address', async () => {
    const index = await api(null, 'GET', '/api/guides');
    expect(index.status).toBe(200);
    expect((index.body.guides as { slug: string }[]).map((g) => g.slug)).toContain('qa');
    const res = await api(null, 'GET', '/api/guides/qa.md');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(String(res.body.text)).toContain('## Judging an issue');
  });

  it('answers not found for an address no guide holds', async () => {
    expect((await api(null, 'GET', '/api/guides/qa-judging.md')).status).toBe(404);
  });
});

describe('a design created with the body the guide gives', () => {
  it('is taken with { baseRevision: null, document } and an empty writtenBy', async () => {
    const res = await api(token, 'POST', at('/workflows'), {
      baseRevision: null,
      document: { ...document('guide-made'), writtenBy: {} },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('is refused at /writtenBy without it, at /baseRevision with a base, and with another key', async () => {
    const { writtenBy: _dropped, ...bare } = document('no-writer');
    const missing = await api(token, 'POST', at('/workflows'), {
      baseRevision: null,
      document: bare,
    });
    expect(missing.status).toBe(422);
    expect(refusals(missing.body)).toContain('SCHEMA_VIOLATION /writtenBy');

    const based = await api(token, 'POST', at('/workflows'), {
      baseRevision: 1,
      document: document('based'),
    });
    expect(refusals(based.body).map((r) => r.split(' ')[1])).toContain('/baseRevision');

    const extra = await api(token, 'POST', at('/workflows'), {
      baseRevision: null,
      document: document('extra'),
      issue: 'ISS-1',
    });
    expect(extra.status).toBe(400);
    expect(JSON.stringify(extra.body)).toContain('CONFIG_WRITE_SHAPE');
  });

  it('holds each cap the guide lists: at the cap it is taken, one over it is refused at its path', async () => {
    const d = document('at-cap');
    const steps = d.steps as Body[];
    const first = { ...steps[0], does: 'x'.repeat(WORKFLOW_LIMITS.does) };
    const atCap = await api(token, 'POST', at('/workflows'), {
      baseRevision: null,
      document: { ...d, steps: [first, ...steps.slice(1)] },
    });
    expect(atCap.status, JSON.stringify(atCap.body)).toBe(201);

    const over = await api(token, 'POST', at('/workflows'), {
      baseRevision: null,
      document: {
        ...document('over-cap'),
        steps: [{ ...first, does: 'x'.repeat(WORKFLOW_LIMITS.does + 1) }, ...steps.slice(1)],
      },
    });
    expect(refusals(over.body)).toContain('SCHEMA_VIOLATION /steps/0/does');

    const many = Array.from({ length: WORKFLOW_LIMITS.steps + 1 }, (_, i) => ({
      id: `s${i}`,
      does: 'a step',
      after: [],
    }));
    const tooMany = await api(token, 'POST', at('/workflows'), {
      baseRevision: null,
      document: { ...document('too-many'), steps: many },
    });
    expect(refusals(tooMany.body)).toContain('SCHEMA_VIOLATION /steps');
  });
});

describe('a criterion traced onto a design as the guides give the act', () => {
  it('takes the flow name or the uuid with step ids, and refuses an unlinked design and an unknown step by name', async () => {
    const made = await api(token, 'POST', at('/workflows'), {
      baseRevision: null,
      document: document('traced'),
    });
    expect(made.status).toBe(201);
    const workflowId = (made.body.document as Body).id as string;
    const req = await api(token, 'POST', at('/requirements'), {
      title: 'A discharged patient is followed up',
      reason: 'follow-up after discharge',
      criteria: [{ body: 'A discharged patient who needs follow-up has one owned case.' }],
    });
    expect(req.status).toBe(201);
    const key = req.body.key as string;
    const trace = (body: Body) =>
      api(token, 'PUT', at(`/requirements/${key}/criteria/BC-1/steps`), body);

    expect(refusals((await trace({ workflow: 'traced', steps: ['his'] })).body)).toContain(
      'REQUIREMENT_DESIGN_UNLINKED /workflow',
    );
    expect(
      (await api(token, 'POST', at(`/requirements/${key}/workflows`), { workflowId })).status,
    ).toBe(200);
    expect(refusals((await trace({ workflow: 'traced', steps: ['nope'] })).body)).toContain(
      'WORKFLOW_NODE_UNKNOWN /steps/0',
    );
    expect((await trace({ workflow: 'traced', steps: ['his'] })).status).toBe(200);
    expect((await trace({ workflow: workflowId, steps: [] })).status).toBe(200);
  });
});
