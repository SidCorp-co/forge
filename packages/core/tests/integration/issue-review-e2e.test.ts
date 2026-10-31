/**
 * An issue's review (REQ-36 BC-8; Issue to release r20 `rule-merge`; ISS-473): the diff checked
 * against each chosen pattern's checklist and the evidence, one result per checklist line and per
 * code-property criterion, rerunning nothing. `GET /api/issues/:id/review` says what it owes;
 * `POST /api/issues/:id/review` records it, refused by name for a missing, repeated or unowed line,
 * a key carrying a rerun, or a reviewer who is the building run. The merge mark on a project that
 * declares the merge check is refused MERGE_REVIEW_MISSING until a passing review by another stands
 * at the commit it marks.
 *
 * It reaches its subject over HTTP, so it names what it guards:
 * @direct-test-of packages/core/src/issues/review.ts
 * @direct-test-of packages/core/src/issues/review-rules.ts
 * @direct-test-of packages/core/src/issues/merge-routes.ts
 * @direct-test-of packages/core/src/issues/merge-marker.ts
 * @direct-test-of packages/contracts/src/issue-review.ts
 * @direct-test-of packages/core/src/issues/record-events/store.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeWorld, type Doc } from '../helpers/ecosystem-world.js';
import { createTestIssue, rows } from '../helpers/factories.js';
import {
  API_ROUTE,
  BASE,
  boxToken,
  builtIssue,
  call,
  checklist,
  codes,
  detail,
  fieldsOf,
  HEAD,
  mark,
  nextSeq,
  personToken,
  post,
  projects,
  review,
  reviewRecords,
  runOnBox,
  startReviewWorld,
  userId,
} from '../helpers/review-world.js';

beforeAll(startReviewWorld, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('what a review owes (criterion 1)', () => {
  it('owes each line of the chosen pattern and each code-property criterion, and says the mark asks it', async () => {
    const { id } = await builtIssue(projects.catalog);
    const res = await call(personToken, 'GET', `/api/issues/${id}/review`);
    expect(res.status).toBe(200);
    expect(res.body.required).toBe(true);
    expect(res.body.owed.checklist).toHaveLength(API_ROUTE?.checklist.length ?? -1);
    expect(res.body.owed.criteria).toEqual([
      { criterion: 2, statement: 'The route holds no rule.' },
    ]);
    expect(res.body.reviews).toEqual([]);
  });
});

describe('a review is refused by name, recording nothing', () => {
  it('refuses the building run, naming who may review', async () => {
    const { id } = await builtIssue(projects.catalog);
    const res = await post(boxToken, id, review());
    expect([res.status, codes(res)]).toEqual([422, ['REVIEW_BY_BUILDER']]);
    expect(detail(res)).toContain('Send `run`');
    expect(await reviewRecords(id)).toEqual([]);
  });

  it('refuses a review missing a checklist line, and one giving a line twice', async () => {
    const { id } = await builtIssue(projects.catalog);
    const reviewer = await runOnBox(projects.catalog);
    const short = await post(
      boxToken,
      id,
      review({ checklist: checklist().slice(1), run: reviewer }),
    );
    expect(codes(short)).toEqual(['REVIEW_LINE_MISSING']);
    expect(detail(short)).toContain('api-route#1');
    const twice = await post(
      boxToken,
      id,
      review({ checklist: [...checklist(), checklist()[0]], run: reviewer }),
    );
    expect(codes(twice)).toEqual(['REVIEW_LINE_REPEATED']);
    expect(await reviewRecords(id)).toEqual([]);
  });

  it('refuses a result on an observable criterion: QA judges that on the running build', async () => {
    const { id } = await builtIssue(projects.catalog);
    const reviewer = await runOnBox(projects.catalog);
    const res = await post(
      boxToken,
      id,
      review({
        criteria: [
          ...review().criteria,
          { criterion: 1, result: 'pass', reason: 'r', evidence: ['e'] },
        ],
        run: reviewer,
      }),
    );
    expect([codes(res), res.body.error.refusals[0].path]).toEqual([
      ['REVIEW_LINE_UNKNOWN'],
      '/criteria/1',
    ]);
  });

  it('carries no rerun: a body sending checks or probe results is refused, naming the key', async () => {
    const { id } = await builtIssue(projects.catalog);
    const reviewer = await runOnBox(projects.catalog);
    for (const key of ['checks', 'probes']) {
      const res = await post(boxToken, id, { ...review({ run: reviewer }), [key]: [] });
      expect(res.status, key).toBe(400);
      expect(JSON.stringify(res.body), key).toContain(key);
    }
    expect(await reviewRecords(id)).toEqual([]);
  });
});

describe('a review recorded by another run (criteria 1 and 2)', () => {
  it('records one result per line and criterion, the diff, the evidence cited, and that it reran nothing', async () => {
    const { id } = await builtIssue(projects.catalog);
    const reviewer = await runOnBox(projects.catalog);
    const res = await post(boxToken, id, review({ run: reviewer }));
    expect(res.status).toBe(201);
    expect(res.body.review).toMatchObject({ head: HEAD, base: BASE, result: 'pass' });
    expect(res.body.review.reviewer.session).toBe(reviewer);
    const [record] = await reviewRecords(id);
    expect(record).toBeDefined();
    if (!record) return;
    expect(fieldsOf(record, 'line')).toHaveLength(API_ROUTE?.checklist.length ?? -1);
    expect(fieldsOf(record, 'criterion')).toEqual([
      '2 pass: the route calls one service (packages/core/src/issues/x.ts)',
    ]);
    expect(fieldsOf(record, 'diff')).toEqual([`${BASE}..${HEAD}`]);
    expect(fieldsOf(record, 'evidence')[0]).toContain('a passing merge check');
    expect(fieldsOf(record, 'reruns')[0]).toMatch(/^none: a review runs no check, test or probe/);
    // its time joins the issue's checks as kind review, never as one of the builder's checks (ISS-515)
    const checks = (await call(personToken, 'GET', `/api/issues/${id}/checks`)).body;
    const kind = (checks.kinds as Doc[]).find((k) => k.kind === 'review');
    expect(kind?.checks).toBe(1);
    expect(Number(kind?.totalMs)).toBeGreaterThanOrEqual(120_000);
    const keys = (record.fields as Doc[]).map((f) => f.key);
    for (const rerun of ['check', 'checks', 'probe', 'probes', 'tests']) {
      expect(keys).not.toContain(rerun);
    }
    const verdicts = await rows<{ judge: string; verdict: string; commit_sha: string }>(sql`
      SELECT v.judge, v.verdict, v.commit_sha FROM criterion_verdicts v
        JOIN issue_criteria c ON c.id = v.criterion_id
       WHERE v.issue_id = ${id} AND c.n = 2
    `);
    expect(verdicts).toEqual([{ judge: 'review', verdict: 'pass', commit_sha: HEAD }]);
  });

  it('on a project that reads no catalog, owes the code-property criteria only and says so', async () => {
    const { id } = await builtIssue(projects.noCatalog);
    const reviewer = await runOnBox(projects.noCatalog);
    const owed = await call(personToken, 'GET', `/api/issues/${id}/review`);
    expect(owed.body.owed.checklist).toEqual([]);
    expect(owed.body.owed.noCatalog).toContain('github.com/acme/shop');
    const sent = await post(boxToken, id, review({ run: reviewer }));
    expect(codes(sent)[0]).toBe('REVIEW_LINE_UNKNOWN');
    const res = await post(boxToken, id, review({ checklist: [], run: reviewer }));
    expect(res.status).toBe(201);
    const [record] = await reviewRecords(id);
    expect(fieldsOf(record ?? { fields: [] }, 'checklist')[0]).toMatch(/^none owed: /);
  });
});

const reviewTime = async (issue: string) =>
  ((await call(personToken, 'GET', `/api/issues/${issue}/checks`)).body.kinds as Doc[]).find(
    (k) => k.kind === 'review',
  );

describe('a review is timed with the issue checks (FB-121)', () => {
  it('counts a run review from the time it sends, keyed by its record, so a resend adds nothing', async () => {
    const { id } = await builtIssue(projects.catalog);
    const reviewer = await runOnBox(projects.catalog);
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    const res = await post(boxToken, id, review({ run: reviewer, startedAt }));
    expect(res.status).toBe(201);
    const time = await reviewTime(id);
    expect(time?.checks).toBe(1);
    expect(time?.totalMs).toBeGreaterThanOrEqual(90_000);
    expect(time?.slowest?.id).toBe(res.body.review.id);
  });

  it('times a run review that sends no start from its reviewing run', async () => {
    const { id } = await builtIssue(projects.catalog);
    const reviewer = await runOnBox(projects.catalog);
    expect((await post(boxToken, id, review({ run: reviewer, startedAt: undefined }))).status).toBe(
      201,
    );
    expect((await reviewTime(id))?.checks).toBe(1);
  });

  it('records a person review that sends no start untimed, never a made-up duration', async () => {
    const { id } = await builtIssue(projects.catalog);
    expect((await post(personToken, id, review({ startedAt: undefined }))).status).toBe(201);
    expect(await reviewTime(id)).toMatchObject({ checks: 0, totalMs: 0 });
  });

  it('refuses a start after now by name, recording nothing', async () => {
    const { id } = await builtIssue(projects.catalog);
    const reviewer = await runOnBox(projects.catalog);
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const res = await post(boxToken, id, review({ run: reviewer, startedAt: later }));
    expect([res.status, res.body.error.refusals[0].path]).toEqual([422, '/startedAt']);
    expect(await reviewRecords(id)).toEqual([]);
  });

  it('refuses a start over a day back by name, recording nothing', async () => {
    const { id } = await builtIssue(projects.catalog);
    const reviewer = await runOnBox(projects.catalog);
    const stale = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const res = await post(boxToken, id, review({ run: reviewer, startedAt: stale }));
    expect([res.status, res.body.error.refusals[0].path]).toEqual([422, '/startedAt']);
    expect(res.body.error.refusals[0].detail).toMatch(/over a day back/);
    expect(await reviewRecords(id)).toEqual([]);
  });

  it('keeps the reviewer a reviewer: its timed review does not make it the building run', async () => {
    const { id } = await builtIssue(projects.catalog);
    const reviewer = await runOnBox(projects.catalog);
    const startedAt = new Date(Date.now() - 1_000).toISOString();
    expect((await post(boxToken, id, review({ run: reviewer, startedAt }))).status).toBe(201);
    const again = await post(boxToken, id, review({ run: reviewer }));
    expect(again.status).toBe(201);
    const marked = await mark(id);
    expect([marked.status, marked.body.action]).toEqual([200, 'merged']);
  });
});

describe('the merge mark asks for the review (criterion 2)', () => {
  it('refuses a mark with no review by name, then marks once another run reviewed the commit', async () => {
    const { id } = await builtIssue(projects.catalog);
    const refused = await mark(id);
    expect([refused.status, codes(refused)]).toEqual([422, ['MERGE_REVIEW_MISSING']]);
    expect(detail(refused)).toContain('POST /api/issues/:id/review');
    const reviewer = await runOnBox(projects.catalog);
    expect((await post(boxToken, id, review({ run: reviewer }))).status).toBe(201);
    const marked = await mark(id);
    expect([marked.status, marked.body.action]).toEqual([200, 'merged']);
  });

  it('refuses a mark over a failing review, naming what failed', async () => {
    const { id } = await builtIssue(projects.catalog);
    const reviewer = await runOnBox(projects.catalog);
    const failing = review({
      run: reviewer,
      checklist: checklist().map((l, at) => (at === 0 ? { ...l, result: 'fail' } : l)),
    });
    expect((await post(boxToken, id, failing)).body.review.result).toBe('fail');
    const res = await mark(id);
    expect(codes(res)).toEqual(['MERGE_REVIEW_MISSING']);
    expect(detail(res)).toContain('failed api-route#1');
  });

  it('asks no review on a project that declares no merge check', async () => {
    const issue = await createTestIssue(projects.undeclared, userId, nextSeq(), {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const res = await mark(issue.id);
    expect([res.status, res.body.action]).toEqual([200, 'merged']);
  });
});
