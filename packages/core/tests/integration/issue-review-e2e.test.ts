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

import { PATTERN_CATALOG } from '@forge/contracts/pattern-catalog';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { THIS_REPOSITORY } from '../../src/lib/this-repository.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestIssue,
  createTestModule,
  createTestProject,
  createTestRunSession,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { passingChecksRunning, passingReport } from '../helpers/merge-check-report.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const API_ROUTE = PATTERN_CATALOG.find((e) => e.slug === 'api-route');

let personToken = '';
let boxToken = '';
let userId = '';
let deviceId = '';
const projects = { catalog: '', noCatalog: '', undeclared: '' };
let seq = 0;

async function project(repository: string, required: boolean): Promise<string> {
  const { id } = await createTestProject(userId);
  await seedProjectDocument(id, userId, {
    environments: {
      dev: { tier: 'production', deploysFrom: 'main', deployment: { mode: 'external' } },
    },
    source: { type: 'git', git: { repository, defaultBranch: 'main', branches: ['main'] } },
    ...(required
      ? {
          extra: {
            validation: {
              gate: { type: 'github-check', name: 'ci-passed' },
              mergeCheck: 'required',
            },
          },
        }
      : {}),
  });
  await addProjectMember(id, userId, 'admin');
  await createTestModule(id, 'issues');
  return id;
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const user = await createTestUser({ verified: true });
  userId = user.id;
  personToken = await userToken(user.id);
  deviceId = await createTestDevice(user.id);
  boxToken = (await mintPat({ permissions: ['*'], userId, name: 'box', deviceId })).plaintext;
  projects.catalog = await project(THIS_REPOSITORY, true);
  projects.noCatalog = await project('github.com/acme/shop', true);
  projects.undeclared = await project(THIS_REPOSITORY, false);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const call = async (
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
) => {
  const res = await api(token, method, path, body);
  return { status: res.status, body: res.body as Doc };
};

const codes = (res: { body: Doc }): string[] =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.code);
const detail = (res: { body: Doc }): string =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.detail).join(' | ');

/** A run session on the box; `hold` gives it the issue's lease, as a building run holds it. */
async function runOnBox(projectId: string, hold?: string): Promise<string> {
  const runId = await createTestRunSession(projectId, deviceId, new Date(), null);
  const [session] = await rows<{ id: string }>(
    sql`SELECT id FROM agent_sessions WHERE pipeline_run_id = ${runId}`,
  );
  if (!session) throw new Error('no run session seeded');
  if (hold) {
    await rows(sql`
      INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
      VALUES (${projectId}, ${hold}, ${deviceId}, ${session.id}, ${runId})
      RETURNING session_id
    `);
  }
  return session.id;
}

/**
 * An issue at in_progress with two criteria and its design recorded: criterion 1 observable,
 * criterion 2 a code property, both to `api-route` where the project reads the catalog. Criterion 1
 * keeps a probe, which the passing merge check its building run records at HEAD ran.
 */
async function builtIssue(projectId: string): Promise<{ id: string; builder: string }> {
  seq += 1;
  const issue = await createTestIssue(projectId, userId, seq, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  const patched = await call(personToken, 'PATCH', `/api/issues/${issue.id}`, {
    plan: 'Build the route.',
    acceptanceCriteria: '1. The route answers.\n2. The route holds no rule.',
  });
  expect(patched.status).toBe(200);
  const pattern = projectId === projects.noCatalog ? null : 'api-route';
  const design = await call(personToken, 'PUT', `/api/issues/${issue.id}/design`, {
    criteria: [
      { criterion: 1, class: 'observable', pattern, proof: 'call it' },
      { criterion: 2, class: 'code_property', pattern, proof: 'review: one service call' },
    ],
    modules: ['issues'],
    contracts: [],
  });
  expect(design.status).toBe(200);
  const proved = await call(personToken, 'POST', `/api/issues/${issue.id}/verdicts`, {
    criterion: 1,
    verdict: 'pass',
    reason: 'ran it',
    identity: { kind: 'commit', sha: HEAD },
    probe: { kind: 'command', command: { argv: ['node', 'probe.mjs'] }, expect: { exitCode: 0 } },
  });
  expect(proved.status).toBe(201);
  const builder = await runOnBox(projectId, issue.key);
  const check = await call(
    boxToken,
    'POST',
    `/api/issues/${issue.id}/merge-check`,
    passingReport({
      base: { branch: 'dev', sha: BASE },
      head: HEAD,
      touched: [{ path: 'packages/core/src/issues/x.ts', change: 'changed' }],
      ...passingChecksRunning([{ criterion: 1, probe: proved.body.criterion.probe.id }]),
    }),
  );
  expect(check.status).toBe(201);
  return { id: issue.id, builder };
}

const checklist = (result = 'pass') =>
  (API_ROUTE?.checklist ?? []).map((_, at) => ({
    pattern: 'api-route',
    line: at + 1,
    result,
    note: `checked in packages/core/src/issues/x.ts (line ${at + 1})`,
  }));

const review = (over: Doc = {}) => ({
  base: BASE,
  head: HEAD,
  startedAt: new Date(Date.now() - 120_000).toISOString(),
  checklist: checklist(),
  criteria: [
    {
      criterion: 2,
      result: 'pass',
      reason: 'the route calls one service',
      evidence: ['packages/core/src/issues/x.ts'],
    },
  ],
  ...over,
});

const post = (token: string, issue: string, body: unknown) =>
  call(token, 'POST', `/api/issues/${issue}/review`, body);

const mark = (issue: string) =>
  call(personToken, 'POST', `/api/issues/${issue}/merge`, {
    target: 'dev',
    commit: HEAD,
    note: 'landed',
    changedPaths: {
      commit: HEAD,
      changes: [{ path: 'packages/core/src/issues/x.ts', change: 'changed' }],
    },
  });

const reviewRecords = async (issue: string) =>
  ((await call(personToken, 'GET', `/api/issues/${issue}/events`)).body.items as Doc[]).filter(
    (e) => e.kind === 'review',
  );

const fieldsOf = (record: Doc, key: string): string[] =>
  (record.fields as Doc[]).filter((f) => f.key === key).map((f) => f.value);

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
    seq += 1;
    const issue = await createTestIssue(projects.undeclared, userId, seq, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const res = await mark(issue.id);
    expect([res.status, res.body.action]).toEqual([200, 'merged']);
  });
});
