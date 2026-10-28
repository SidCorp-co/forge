/**
 * ISS-625 (FB-230, REQ-48 BC-5) — a criterion traces a BC only where its line opens with the tag,
 * `(REQ-n BC-m) <statement>`. The same tag anywhere else in the line traced nothing, and the
 * criterion was stored untraced with no word until the issue-ready checklist refused the move to
 * `open` naming no shape. Now a write that states a tag the trace cannot come from is refused by
 * name on both doors that read a criterion's words (the `acceptanceCriteria` text and a PUT of
 * criteria sent without `requirementCriterionId`), and the checklist names the tag that is not
 * leading and the form that traces. Through the app's own routes, against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/criteria/store.ts
 * @direct-test-of packages/core/src/issues/criteria/criteria-text.ts
 * @direct-test-of packages/core/src/issues/checklist-record.ts
 * @direct-test-of packages/contracts/src/gate-profiles.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createReadyDraftIssue,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let token: string;
let issueId: string;
let bc1: string;
let bc2: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  const ready = await createReadyDraftIssue(projectId, ownerId, 1, 1);
  issueId = ready.id;
  const [first] = await rows<{ id: string }>(sql`
    SELECT id FROM requirement_criteria WHERE requirement_id = ${ready.requirementId} AND code = 'BC-1'
  `);
  bc1 = String(first?.id);
  const [second] = await rows<{ id: string }>(sql`
    INSERT INTO requirement_criteria (requirement_id, code, body, since_revision)
    VALUES (${ready.requirementId}, 'BC-2', 'it also holds', 1) RETURNING id
  `);
  bc2 = String(second?.id);
});

type Row = { n: number; statement: string; requirementCriterionId: string | null };
type Refusal = { code: string; path: string; detail: string };

const refusalOf = (body: Record<string, unknown>): Refusal | undefined =>
  (body.error as { refusals?: Refusal[] } | undefined)?.refusals?.[0];

async function criteriaOf(): Promise<Row[]> {
  const r = await api(token, 'GET', `/api/issues/${issueId}/criteria`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body.criteria as Row[]).map(({ n, statement, requirementCriterionId }) => ({
    n,
    statement,
    requirementCriterionId,
  }));
}

const writeText = (text: string) =>
  api(token, 'PATCH', `/api/issues/${issueId}`, { acceptanceCriteria: text });

const put = (criteria: Array<Record<string, unknown>>) =>
  api(token, 'PUT', `/api/issues/${issueId}/criteria`, { criteria });

const LEADING_SHAPE = '`(REQ-<n> BC-<m>) <statement>`';

describe('a criterion whose BC tag is not at the start of its line', () => {
  it.each([
    ['trailing', 'Something holds (REQ-1 BC-1)', '(REQ-1 BC-1)'],
    ['mid-line', 'Something (REQ-1 BC-1) holds', '(REQ-1 BC-1)'],
    ['lowercase', 'Something holds (req-1 bc-1)', '(req-1 bc-1)'],
    ['second of two', '(REQ-1 BC-1) Something holds (REQ-1 BC-2)', '(REQ-1 BC-2)'],
  ])(
    'is refused by name on the text path when %s, and nothing is written',
    async (_, line, tag) => {
      const before = await criteriaOf();

      const r = await writeText(`1. it holds here\n2. ${line}`);

      expect(r.status, JSON.stringify(r.body)).toBe(422);
      const refusal = refusalOf(r.body);
      expect(refusal?.code).toBe('CRITERIA_TRACE_NOT_LEADING');
      expect(refusal?.path).toBe('/acceptanceCriteria');
      expect(refusal?.detail).toContain(`criterion 2 carries ${tag}`);
      expect(refusal?.detail).toContain('traces nothing');
      expect(refusal?.detail).toContain(LEADING_SHAPE);
      expect(await criteriaOf()).toEqual(before);
    },
  );

  it('is refused by name on PUT /criteria where the criterion states no requirementCriterionId', async () => {
    const r = await put([
      { n: 1, statement: 'it holds here' },
      { n: 2, statement: 'Something holds (REQ-1 BC-1)' },
    ]);

    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const refusal = refusalOf(r.body);
    expect(refusal?.code).toBe('CRITERIA_TRACE_NOT_LEADING');
    expect(refusal?.path).toBe('/criteria');
    expect(refusal?.detail).toContain(LEADING_SHAPE);
    expect((await criteriaOf()).map((c) => c.n)).toEqual([1]);
  });

  it('is read as text on PUT /criteria where requirementCriterionId states the trace', async () => {
    const r = await put([
      { n: 1, statement: 'it holds here', requirementCriterionId: bc1 },
      { n: 2, statement: 'Something holds, as (REQ-1 BC-2) says', requirementCriterionId: bc2 },
    ]);

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await criteriaOf()).map((c) => c.requirementCriterionId)).toEqual([bc1, bc2]);
  });

  it('is not judged again on a write that keeps it word for word', async () => {
    await db.execute(sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position)
      VALUES (${issueId}, 2, 'Older holds (REQ-1 BC-1)', 1)
    `);

    const r = await writeText('1. it holds here\n2. Older holds (REQ-1 BC-1)\n3. A new one holds');

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await criteriaOf()).map((c) => c.n)).toEqual([1, 2, 3]);
  });
});

describe('a criterion whose line opens with its BC tag', () => {
  it('traces that BC on the text path', async () => {
    const r = await writeText('1. it holds here\n2. (REQ-1 BC-2) Something holds');

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await criteriaOf())[1]).toEqual({
      n: 2,
      statement: '(REQ-1 BC-2) Something holds',
      requirementCriterionId: bc2,
    });
  });

  it('traces that BC on PUT /criteria sent without requirementCriterionId', async () => {
    const r = await put([
      { n: 1, statement: 'it holds here' },
      { n: 2, statement: '(REQ-1 BC-2) Something holds' },
    ]);

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await criteriaOf()).map((c) => c.requirementCriterionId)).toEqual([bc1, bc2]);
  });

  it('is refused by name where the tag is lowercase, naming the form that traces', async () => {
    const r = await writeText('1. it holds here\n2. (req-1 bc-2) Something holds');

    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const refusal = refusalOf(r.body);
    expect(refusal?.code).toBe('CRITERIA_TRACE_INVALID');
    expect(refusal?.detail).toContain('"(req-1 bc-2)"');
    expect(refusal?.detail).toContain(LEADING_SHAPE);
  });
});

describe('a criterion that mentions a requirement in prose', () => {
  it('is accepted and traces nothing', async () => {
    const r = await writeText(
      '1. it holds here\n2. Holds as REQ-6 says\n3. Holds per REQ-1 BC-1, read in prose\n4. Holds (REQ-6) too',
    );

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await criteriaOf()).map((c) => [c.n, c.requirementCriterionId])).toEqual([
      [1, bc1],
      [2, null],
      [3, null],
      [4, null],
    ]);
  });
});

describe('the served guides', () => {
  it('state that a criterion traces a BC only where its line begins with the tag', async () => {
    const flow = await api(token, 'GET', '/api/guides/issue-flow.md');
    expect(flow.status).toBe(200);
    const text = String(flow.body.text ?? '').replace(/\s+/gu, ' ');
    expect(text).toContain(
      "A criterion traces a BC of the issue's requirement only where its line begins with the tag: `1. (REQ-n BC-m) <statement>`",
    );
    expect(text).toContain(
      'The same tag anywhere else in the line traces nothing, so it is refused `CRITERIA_TRACE_NOT_LEADING`',
    );

    const lifecycle = await api(token, 'GET', '/api/guides/requirement-lifecycle.md');
    expect(lifecycle.status).toBe(200);
    expect(String(lifecycle.body.text ?? '').replace(/\s+/gu, ' ')).toContain(
      'an issue criterion traces one where its line opens with the tag, `(REQ-n BC-m) <statement>`, and nowhere else',
    );
  });
});

describe('the issue-ready checklist', () => {
  it('names a criterion whose tag is not leading, and states the form that traces', async () => {
    await db.execute(sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position)
      VALUES (${issueId}, 2, 'Something holds (REQ-1 BC-1)', 1)
    `);

    const r = await api(token, 'POST', `/api/issues/${issueId}/transition`, { toStatus: 'open' });

    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(refusalOf(r.body)).toMatchObject({
      code: 'CHECKLIST_INCOMPLETE',
      path: '/answers/criteria',
      detail:
        'What are its criteria, each traced to a BC of that revision? Criterion 2 is not traced to a business criterion (BC) that stands at REQ-1 revision 1. Criterion 2 names its BC after the start of its line, which traces nothing. Start its line with the BC it proves, as "(REQ-1 BC-<m>) <statement>"; a BC tag anywhere else in the line traces nothing. Gate issue_ready is enforced by this project\'s gate profile standard (gates.profile); gates.overrides.issue_ready relaxes it.',
    });
  });
});
