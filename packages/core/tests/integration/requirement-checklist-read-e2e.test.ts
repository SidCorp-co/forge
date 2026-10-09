/**
 * A requirement's checklists read (REQ-34 r2 BC-5, BC-9, BC-26; ISS-457 criteria 1 and 3), through
 * the app's own routes against real Postgres: a draft reads its ready checklist against the head, each
 * gap in plain words and each non-blocking question assumed with its source, and no acceptance yet;
 * the agree keeps the answers it was judged by, the assumed kind among them; a later revision naming
 * the kind is read as given now while the agree's record still says what it assumed.
 *
 * @direct-test-of packages/core/src/requirements/checklist-routes.ts
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import type { Doc } from '../helpers/ecosystem-world.js';
import {
  createTestProject,
  createTestUser,
  makeAgreeReady,
  truncateAll,
} from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let token: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
});

const on = (method: 'GET' | 'POST', path: string, body?: unknown, as = token) =>
  api(as, method, `/api/projects/${projectId}${path}`, body);

async function ok(r: Promise<{ status: number; body: Doc }>): Promise<Doc> {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

async function draft(): Promise<string> {
  const created = await ok(
    on('POST', '/requirements', {
      title: 'The board keeps its filter',
      reason: 'planted',
      criteria: [{ body: 'A reload keeps the filter.' }],
    }),
  );
  return String(created.key);
}

const read = async (key: string) => ok(on('GET', `/requirements/${key}/checklist`));
const checklist = (r: Doc, id: string) =>
  (r.checklists as Doc[]).find((c) => c.id === id) as Doc;
const answerTo = (evaluation: Doc, question: string) =>
  (evaluation.answers as Doc[]).find((a) => a.question === question);
const gapOn = (evaluation: Doc, question: string) =>
  (evaluation.gaps as Doc[]).find((g) => g.question === question);

describe("a requirement's checklists read", () => {
  it('reads a draft with no head as having none, naming it on every question', async () => {
    const key = await draft();
    const r = await read(key);
    expect(r.revision).toBeNull();
    const now = checklist(r, 'requirement_ready').now as Doc;
    expect(now.complete).toBe(false);
    expect(gapOn(now, 'problem')?.detail).toContain(`${key} has no current revision yet.`);
  });

  it('reads a draft against its ready checklist: gaps in plain words, assumed answers with their source, no acceptance yet', async () => {
    const key = await draft();
    await ok(on('POST', `/requirements/${key}/revisions/1/propose`, {}));
    await ok(on('POST', `/requirements/${key}/revisions/1/accept`, {}));
    const r = await read(key);
    expect(r.key).toBe(key);
    expect(r.revision).toBe(1);
    expect((r.checklists as Doc[]).map((c) => c.id)).toEqual([
      'requirement_ready',
      'requirement_acceptance',
    ]);
    const ready = checklist(r, 'requirement_ready');
    expect(ready.form.fields.map((f: Doc) => f.name)).toContain('kind');
    const now = ready.now as Doc;
    expect(now.complete).toBe(false);
    expect(gapOn(now, 'who')?.detail).toContain('It names nobody it is for.');
    expect(gapOn(now, 'workflows')?.path).toBe('/answers/workflows');
    expect(answerTo(now, 'kind')).toMatchObject({
      value: 'Not stated.',
      provenance: 'assumed',
      source: 'recommended',
    });
    expect(answerTo(now, 'criteria')).toMatchObject({
      provenance: 'given',
      source: 'record:revision.criteria',
    });
    expect(ready.moves).toEqual([]);
    expect(checklist(r, 'requirement_acceptance').now).toBeNull();
  });

  it('keeps the answers the agree was judged by, and reads a later revision naming the kind as given now', async () => {
    const key = await draft();
    await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
    await ok(on('POST', `/requirements/${key}/revisions/1/propose`, {}));
    await ok(on('POST', `/requirements/${key}/revisions/1/accept`, {}));
    await ok(on('POST', `/requirements/${key}/agree`, { revision: 1 }));

    const agreed = await read(key);
    const ready = checklist(agreed, 'requirement_ready');
    const [move] = ready.moves as Doc[];
    expect(move).toMatchObject({ standing: 'passed', countsAsPassed: true, to: 'agreed' });
    expect((move?.answers as Doc[]).find((a) => a.question === 'kind')).toMatchObject({
      provenance: 'assumed',
      source: 'recommended',
    });
    const acceptance = checklist(agreed, 'requirement_acceptance').now as Doc;
    expect(acceptance.complete).toBe(false);
    expect(gapOn(acceptance, 'shipped')?.detail).toContain('No live issue delivers it');

    const head = await ok(on('GET', `/requirements/${key}`));
    const r1 = (head.revisions as Doc[]).find((x) => x.revision === 1) as Doc;
    await ok(
      on('POST', `/requirements/${key}/revisions`, {
        baseRevision: 1,
        reason: 'It is a rule.',
        spec: r1.spec,
        kind: 'rule',
        criteria: (r1.criteria as Doc[]).map((c) => ({ code: c.code, body: c.body })),
      }),
    );
    await ok(on('POST', `/requirements/${key}/revisions/2/propose`, {}));
    await ok(on('POST', `/requirements/${key}/revisions/2/accept`, {}));

    const corrected = await read(key);
    expect(corrected.revision).toBe(2);
    const after = checklist(corrected, 'requirement_ready');
    expect(answerTo(after.now as Doc, 'kind')).toMatchObject({
      value: 'rule',
      provenance: 'given',
      source: 'record:revision.kind',
    });
    expect(
      ((after.moves as Doc[])[0]?.answers as Doc[]).find((a) => a.question === 'kind'),
    ).toMatchObject({ provenance: 'assumed' });
  });

  it('refuses a requirement the project does not hold, and a reader outside the project', async () => {
    const missing = await on('GET', '/requirements/REQ-99/checklist');
    expect(missing.status).toBe(404);
    const key = await draft();
    const stranger = await userToken((await createTestUser({ verified: true })).id);
    const res = await on('GET', `/requirements/${key}/checklist`, undefined, stranger);
    expect(res.status).toBe(403);
  });
});
