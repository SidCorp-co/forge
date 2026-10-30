/**
 * A verdict names its criterion by number, or by the criterion's exact line. forge-plugin's
 * `forge record verdict` sends the whole line where it opens with a trace tag
 * (`criterion: (REQ-8 BC-1) A reload shows every saved card`), and both verdict doors refused it:
 * adminhub-fe FB-364 and the adminhub-api builders of ISS-83 and ISS-84 (coordinator, 2026-10-30).
 * The exact line, with or without its `n. ` and its trace tag, now resolves to its number at the
 * comment door (screen and record) and at `POST /api/issues/:id/verdicts`; a near miss stays refused
 * by name, listing the issue's criteria. No fuzzy match: one character off is refused.
 *
 * @direct-test-of packages/core/src/messaging/criterion-named.ts
 * @direct-test-of packages/core/src/issues/criteria/event-verdicts.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

const FENCE = '```';
const JUDGED = '3641ba21fec5096e2d1a91a40f2d9e50e9239068';
const LINE_1 = '(REQ-8 BC-1) A reload shows every saved card';
const LINE_2 = 'The board keeps its order after a reload';

let issueId: string;
let agent: string;

beforeEach(async () => {
  await truncateAll();
  const owner = await createTestUser({ verified: true });
  const author = await createTestUser({ kind: 'agent' });
  const project = await createTestProject(owner.id);
  await addProjectMember(project.id, owner.id, 'admin');
  await addProjectMember(project.id, author.id, 'member');
  const [issue] = await rows<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id)
    VALUES (${project.id}, 'saved board', ${owner.id})
    RETURNING id
  `);
  issueId = String(issue?.id);
  // the lines as the issue holds them: the first opens with the trace tag a plan writes
  await rows(sql`
    INSERT INTO issue_criteria (issue_id, n, statement, position)
    VALUES (${issueId}, 1, ${LINE_1}, 0), (${issueId}, 2, ${LINE_2}, 1)
  `);
  agent = await userToken(author.id);
});

/** A comment carrying one verdict fence, as `forge record verdict` writes it. */
const recordVerdict = (criterion: string, evidence = 'https://ci.example.test/runs/7/judge-log') =>
  api(agent, 'POST', `/api/issues/${issueId}/comments`, {
    body: [
      'The judged criterion passed at the head the review read.',
      '',
      `${FENCE}forge-record`,
      `criterion: ${criterion}`,
      'verdict: pass',
      `commit: ${JUDGED}`,
      `evidence: ${evidence}`,
      FENCE,
      '',
      '`forge-record: verdict · contract 1`',
    ].join('\n'),
    intent: 'note',
  });

const postVerdict = (criterion: string | number) =>
  api(agent, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion,
    verdict: 'pass',
    identity: { kind: 'commit', sha: JUDGED },
    judge: 'review',
  });

async function recorded(): Promise<number[]> {
  const found = await rows<{ n: number }>(sql`
    SELECT c.n FROM criterion_verdicts v JOIN issue_criteria c ON c.id = v.criterion_id
     WHERE v.issue_id = ${issueId} ORDER BY v.created_at`);
  return found.map((r) => Number(r.n));
}

const said = (res: ApiResponse) => JSON.stringify(res.body);

describe('a criterion named by its exact line, through the comment door', () => {
  it('records the trace-tagged whole line on its criterion', async () => {
    const res = await recordVerdict(LINE_1);
    expect(res.status, said(res)).toBe(201);
    expect(await recorded()).toEqual([1]);
  });

  it('takes the line with its number, and without its tag', async () => {
    expect((await recordVerdict(`1. ${LINE_1}`)).status).toBe(201);
    expect((await recordVerdict('A reload shows every saved card')).status).toBe(201);
    expect((await recordVerdict(`2. ${LINE_2}`)).status).toBe(201);
    expect(await recorded()).toEqual([1, 1, 2]);
  });

  it('refuses a near miss by name, listing the criteria, and writes nothing', async () => {
    for (const miss of [
      '(REQ-8 BC-1) A reload shows every saved cards',
      '(REQ-8 BC-2) A reload shows every saved card',
      'a reload shows every saved card',
    ]) {
      const res = await recordVerdict(miss);
      expect(res.status, miss).toBe(422);
      const text = said(res);
      expect(text).toContain("nor the exact line of one of this issue's criteria");
      expect(text).toContain('1 \\"A reload shows every saved card\\"');
      expect(text).toContain(`2 \\"${LINE_2}\\"`);
    }
    expect(await recorded()).toEqual([]);
  });
});

// forge-plugin quotes `--criterion N` as `N — <the line as it stood>` and clips it (adminhub-api
// ISS-85, 2026-10-30): the number names the criterion and the label is never read
describe('a number leading a label, through the comment door', () => {
  it('records the clipped quote forge-plugin writes on the number leading it', async () => {
    const res = await recordVerdict('1 — (REQ-8 BC-1) A reload shows every sa…');
    expect(res.status, said(res)).toBe(201);
    expect((await recordVerdict(`2. ${LINE_1}`)).status).toBe(201);
    expect(await recorded()).toEqual([1, 2]);
  });

  it('refuses a number the issue holds no criterion of, by name, and writes nothing', async () => {
    const res = await recordVerdict('3 — (REQ-8 BC-3) A criterion this issue lacks');
    expect(res.status, said(res)).toBe(422);
    expect(said(res)).toContain('this issue has no criterion 3; its criteria are 1, 2');
    expect(await recorded()).toEqual([]);
  });
});

// forge-plugin quotes `--criterion 1` as `1 — <the whole line>`, and adminhub-api ISS-49's criterion
// 1 lists 59 GET paths in 2,572 characters: the comment door refused the record `field-budget`
// (400) for a label it never reads (adminhub-api master, 2026-10-30)
const LONG_LABEL = `(REQ-8 BC-1) ${'GET /api/v1/catalog/things/:id/variants, '.repeat(55)}`;
/** Each refusal row as its rule and, for a budget refusal, the field it names. */
const refusedRules = (res: ApiResponse) =>
  ((res.body.error as { refusals?: Array<{ detail: string }> }).refusals ?? []).map((r) => [
    /\(rule ([\w-]+);/.exec(r.detail)?.[1],
    /^the `(\w+)` field is \d+ character/.exec(r.detail)?.[1],
  ]);

describe('a number leading a label past the field budget, through the comment door', () => {
  it('records `1 — <a label over 2,000 characters>` on criterion 1', async () => {
    expect(LONG_LABEL.length).toBeGreaterThan(2000);
    const res = await recordVerdict(`1 — ${LONG_LABEL}`);
    expect(res.status, said(res)).toBe(201);
    expect(await recorded()).toEqual([1]);
  });

  it('records a bare number as before', async () => {
    const res = await recordVerdict('2');
    expect(res.status, said(res)).toBe(201);
    expect(await recorded()).toEqual([2]);
  });

  it('still refuses a criterion with no leading number over the budget, by `field-budget`', async () => {
    const res = await recordVerdict(LONG_LABEL);
    expect(res.status, said(res)).toBe(422);
    expect(refusedRules(res)).toContainEqual(['field-budget', 'criterion']);
    expect(await recorded()).toEqual([]);
  });

  it('still refuses another field over the budget beside a long number-led criterion', async () => {
    const res = await recordVerdict(
      `1 — ${LONG_LABEL}`,
      `https://ci.example.test/runs/7/${'judge-log-'.repeat(50)}`,
    );
    expect(res.status, said(res)).toBe(422);
    expect(refusedRules(res).filter(([rule]) => rule === 'field-budget')).toEqual([
      ['field-budget', 'evidence'],
    ]);
    expect(await recorded()).toEqual([]);
  });
});

describe('a criterion named by its exact line, at POST /api/issues/:id/verdicts', () => {
  it('records a number leading a label over 2,000 characters on that number', async () => {
    const res = await postVerdict(`1 — ${LONG_LABEL}`);
    expect(res.status, said(res)).toBe(201);
    expect(await recorded()).toEqual([1]);
  });

  it('still refuses a line over 2,000 characters with no leading number', async () => {
    const res = await postVerdict(LONG_LABEL);
    expect(res.status, said(res)).toBe(400);
    expect(said(res)).toContain('name it by its number, or by its number leading the line');
    expect(await recorded()).toEqual([]);
  });

  it('records a number leading a clipped label on that number', async () => {
    const res = await postVerdict('2 — The board keeps its or…');
    expect(res.status, said(res)).toBe(201);
    expect((res.body.criterion as { n: number }).n).toBe(2);
    expect(await recorded()).toEqual([2]);
  });

  it('records the trace-tagged whole line on its criterion', async () => {
    const res = await postVerdict(LINE_1);
    expect(res.status, said(res)).toBe(201);
    expect((res.body.criterion as { n: number }).n).toBe(1);
    expect(await recorded()).toEqual([1]);
  });

  it('refuses a near miss VERDICT_CRITERION_UNKNOWN on /criterion, listing the criteria', async () => {
    const res = await postVerdict('(REQ-8 BC-1) A reload shows every saved cards');
    expect(res.status, said(res)).toBe(422);
    const refusals = (
      res.body.error as { refusals: Array<{ code: string; path: string; detail: string }> }
    ).refusals;
    expect(refusals.map((r) => [r.code, r.path])).toEqual([
      ['VERDICT_CRITERION_UNKNOWN', '/criterion'],
    ]);
    expect(refusals[0]?.detail).toContain(
      'its criteria are 1 "A reload shows every saved card", 2 "',
    );
    expect(await recorded()).toEqual([]);
  });

  it('still takes a number, and a number sent as text', async () => {
    expect((await postVerdict(2)).status).toBe(201);
    expect((await postVerdict('2')).status).toBe(201);
    expect(await recorded()).toEqual([2, 2]);
  });
});
