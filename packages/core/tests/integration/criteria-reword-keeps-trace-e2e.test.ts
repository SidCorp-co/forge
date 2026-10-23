/**
 * catalog-api ISS-3, 2026-10-23: a master reworded one criterion through the plain-text field
 * (`PATCH /api/issues/:id { acceptanceCriteria }`) and the line's trace to its requirement's BC-3 was
 * gone, with a 200 and no word; it was restored by hand with `PUT /criteria`. A reworded line is a new
 * criterion (`match.ts:matchCriteria` keeps a row only for an unchanged wording), so the text cannot
 * tell it still proves the BC. The guard that refuses a dropped trace counted BCs, not lines: a BC
 * another line still traced, or a BC traced at an earlier wording its requirement has since revised,
 * let the line's trace go in silence. Now every traced line a text write rewords or removes without
 * restating is refused by name, pointing at `PUT /criteria` with `requirementCriterionId`.
 *
 * @direct-test-of packages/core/src/issues/criteria/store.ts
 * @direct-test-of packages/core/src/issues/criteria/match.ts
 * @direct-test-of packages/core/src/requirements/criterion-trace.ts
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

let token: string;
let issueId: string;
let requirementId: string;
const bc: Record<string, string> = {};

beforeEach(async () => {
  await truncateAll();
  const ownerId = (await createTestUser({ verified: true })).id;
  const projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  const ready = await createReadyDraftIssue(projectId, ownerId, 3, 1);
  issueId = ready.id;
  requirementId = ready.requirementId;
  const [first] = await rows<{ id: string }>(sql`
    SELECT id FROM requirement_criteria WHERE requirement_id = ${requirementId} AND code = 'BC-1'`);
  bc['BC-1'] = String(first?.id);
  for (const code of ['BC-2', 'BC-3']) {
    const [row] = await rows<{ id: string }>(sql`
      INSERT INTO requirement_criteria (requirement_id, code, body, since_revision)
      VALUES (${requirementId}, ${code}, ${`${code} holds`}, 1) RETURNING id`);
    bc[code] = String(row?.id);
  }
});

type Refusal = { code: string; path: string; detail: string };
const refusalOf = (body: Record<string, unknown>): Refusal | undefined =>
  (body.error as { refusals?: Refusal[] } | undefined)?.refusals?.[0];

/** Each live criterion as `[n, statement, the BC wording it traces]`. */
async function traced(): Promise<[number, string, string | null][]> {
  const r = await api(token, 'GET', `/api/issues/${issueId}/criteria`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const name = (id: string | null) => Object.entries(bc).find(([, v]) => v === id)?.[0] ?? null;
  return (
    r.body.criteria as { n: number; statement: string; requirementCriterionId: string | null }[]
  ).map((c) => [c.n, c.statement, name(c.requirementCriterionId)]);
}

const put = (criteria: Record<string, unknown>[]) =>
  api(token, 'PUT', `/api/issues/${issueId}/criteria`, { criteria });
const writeText = (text: string) =>
  api(token, 'PATCH', `/api/issues/${issueId}`, { acceptanceCriteria: text });

const ISS_3 = [
  { n: 1, statement: 'A site lists its products', requirementCriterionId: 'BC-1' },
  { n: 2, statement: 'A product page shows its price', requirementCriterionId: 'BC-3' },
  { n: 3, statement: 'A price shows in the site currency', requirementCriterionId: 'BC-3' },
];

async function planned(plan: typeof ISS_3) {
  const r = await put(
    plan.map((c) => ({ ...c, requirementCriterionId: bc[c.requirementCriterionId] })),
  );
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

const REWORDED =
  '1. A site lists its products\n2. A product page shows its price\n3. A price shows in the currency the site sells in';

describe('a text write that rewords a traced criterion', () => {
  it('is refused by name where another line still traces the same BC (ISS-3), and nothing moves', async () => {
    await planned(ISS_3);
    const before = await traced();

    const r = await writeText(REWORDED);

    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const refusal = refusalOf(r.body);
    expect(refusal?.code).toBe('CRITERIA_TRACE_DROPPED');
    expect(refusal?.path).toBe('/acceptanceCriteria');
    expect(refusal?.detail).toContain('criterion 3');
    expect(refusal?.detail).toContain('REQ-1 BC-3');
    expect(refusal?.detail).toContain('PUT /api/issues/:id/criteria');
    expect(refusal?.detail).toContain('requirementCriterionId');
    expect(refusal?.detail).not.toContain('criterion 2');
    expect(await traced()).toEqual(before);
  });

  it('is refused by name where the line traces an earlier wording of a BC the requirement still holds', async () => {
    await planned([
      { n: 1, statement: 'A site lists its products', requirementCriterionId: 'BC-1' },
      { n: 2, statement: 'A product page shows its price', requirementCriterionId: 'BC-2' },
      { n: 3, statement: 'A price shows in the site currency', requirementCriterionId: 'BC-3' },
    ]);
    // the requirement rewords BC-3 at r2; the issue still traces the r1 wording
    await db.execute(sql`
      INSERT INTO requirement_revisions (requirement_id, revision, state, spec, reason, author_id, author_agency)
      SELECT requirement_id, 2, 'draft', spec, 'reword BC-3', author_id, author_agency
        FROM requirement_revisions WHERE requirement_id = ${requirementId} AND revision = 1`);
    await db.execute(
      sql`UPDATE requirement_criteria SET retired_revision = 2 WHERE id = ${bc['BC-3'] as string}`,
    );
    await db.execute(sql`
      INSERT INTO requirement_criteria (requirement_id, code, body, since_revision)
      VALUES (${requirementId}, 'BC-3', 'A price shows in the buyer currency', 2)`);

    const r = await writeText(REWORDED);

    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(refusalOf(r.body)?.code).toBe('CRITERIA_TRACE_DROPPED');
    expect(refusalOf(r.body)?.detail).toContain('criterion 3');
    expect(refusalOf(r.body)?.detail).toContain('REQ-1 BC-3');
  });

  it('is refused naming every line, where two traced lines are reworded at once', async () => {
    await planned(ISS_3);
    const r = await writeText(
      '1. A site lists its products\n2. A product page shows a price\n3. Prices are local',
    );
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(refusalOf(r.body)?.detail).toContain('criteria 2 and 3');
  });

  it('keeps the trace where the line opens with its tag', async () => {
    await planned(ISS_3);
    const r = await writeText(
      '1. A site lists its products\n2. A product page shows its price\n3. (REQ-1 BC-3) A price shows in the currency the site sells in',
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await traced())[2]).toEqual([
      3,
      '(REQ-1 BC-3) A price shows in the currency the site sells in',
      'BC-3',
    ]);
  });

  it('keeps the trace on the PUT the refusal names, sending requirementCriterionId on the reworded line', async () => {
    await planned(ISS_3);
    const r = await put([
      { n: 1, statement: 'A site lists its products' },
      { n: 2, statement: 'A product page shows its price' },
      {
        n: 3,
        statement: 'A price shows in the currency the site sells in',
        requirementCriterionId: bc['BC-3'],
      },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await traced()).map(([n, , code]) => [n, code])).toEqual([
      [1, 'BC-1'],
      [2, 'BC-3'],
      [3, 'BC-3'],
    ]);
  });

  it('writes an unchanged wording, a moved one and a new untraced line without a word', async () => {
    await planned(ISS_3);
    const r = await writeText(
      '1. Search narrows the list\n2. A site lists its products\n3. A product page shows its price\n4. A price shows in the site currency',
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await traced()).map(([n, , code]) => [n, code])).toEqual([
      [1, null],
      [2, 'BC-1'],
      [3, 'BC-3'],
      [4, 'BC-3'],
    ]);
  });

  it('drops the trace on purpose where every criterion states its trace', async () => {
    await planned(ISS_3);
    const r = await put([
      { n: 1, statement: 'A site lists its products', requirementCriterionId: bc['BC-1'] },
      { n: 2, statement: 'A product page shows its price', requirementCriterionId: bc['BC-3'] },
      { n: 3, statement: 'Prices are out of scope here', requirementCriterionId: null },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await traced())[2]).toEqual([3, 'Prices are out of scope here', null]);
  });
});
