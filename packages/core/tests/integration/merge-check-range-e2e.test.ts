/**
 * A change rated high on a project that deploys on land owes its mark a passing merge check
 * (REQ-79 BC-5). A batch lands its issues, then fixes forward, so the check that passes is the
 * batch's, at a later head: it covers each commit its range base..head held, and the mark of an
 * issue landed inside that range is taken (ISS-845). A check whose range does not hold the commit
 * covers nothing, and the refusal names the commit and the ranges it saw.
 *
 * The batch runs that check once and records its one report on each issue it lands (ISS-1031): the
 * same check ids record on each, readable from each, a resend adds nothing, and a high-rated issue
 * later in the batch is marked on it. Before, the second record was refused CHECK_RUN_CONFLICT and
 * that issue's mark MERGE_CHECK_MISSING.
 *
 * @direct-test-of packages/core/src/issues/merge-check.ts
 * @direct-test-of packages/core/src/issues/merge-check-rules.ts
 * @direct-test-of packages/core/src/issues/check-run-rules.ts
 * @direct-test-of packages/core/src/issues/check-runs.ts
 */

import { FAST_LANE_MERGE_CHECKS } from '@forge/contracts/fast-lane';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { plantSource } from '../helpers/cleanup-source.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/factories.js';
import { passingCheck, passingReport } from '../helpers/merge-check-report.js';
import { releaseWorld, seedProductionDeployTrigger, stubProbe } from '../helpers/release-world.js';

// a cleanup report's base is read on the project's source host (ISS-912): planted, never a real one
vi.mock('../../src/integrations/source-host/index.js', async (original) =>
  (await import('../helpers/cleanup-source.js')).mockedSourceHost(
    await original<typeof import('../../src/integrations/source-host/index.js')>(),
  ),
);

const BASE = 'b'.repeat(40);
const LANDED = 'a'.repeat(40);
const FIXED_FORWARD = 'f'.repeat(40);
const ELSEWHERE = 'e'.repeat(40);

let projectId: string;
let ownerId: string;
let token: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  plantSource(projectId, {
    dev: ['b'.repeat(40), 'c'.repeat(40)],
    main: ['b'.repeat(40), 'c'.repeat(40)],
  });
  token = await userToken(ownerId);
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] });
  await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
  stubProbe({});
});

const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const res = await api(token, method, path, body);
  return { status: res.status, body: res.body as Doc };
};
const codes = (res: { body: Doc }): string[] =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.code);

/** The base is green: the cleanup rule a high-rated mark is asked passes. */
async function greenBase(): Promise<void> {
  const green = await call('POST', `/api/projects/${projectId}/cleanup-reports`, {
    base: { branch: 'dev', sha: 'c'.repeat(40) },
    result: 'green',
    cleared: [],
    remains: [],
  });
  expect(green.status, JSON.stringify(green.body)).toBe(201);
}

/** An issue at in_progress, rated high where `high`. */
async function issueOf(high: boolean): Promise<string> {
  const issue = await fx.insertIssue('in_progress');
  if (high) {
    const rated = await call('POST', `/api/issues/${issue}/impact`, {
      type: 'data',
      rating: 'high',
      reason: 'rated high',
    });
    expect(rated.status, JSON.stringify(rated.body)).toBeLessThan(300);
  }
  return issue;
}

/** One batch's passing report at `head`, over `commits` where given. */
const batchReport = (head: string, commits?: string[]) => ({
  ...passingReport({
    base: { branch: 'dev', sha: BASE },
    head,
    touched: [{ path: 'packages/core/src/x.ts', change: 'changed' }],
    checks: FAST_LANE_MERGE_CHECKS.map((n) => passingCheck(n)) as never,
  }),
  ...(commits ? { commits } : {}),
});

/** A high-rated issue on a green base, its batch's passing check recorded at `head` over `commits`. */
async function checkedAt(head: string, commits?: string[]): Promise<string> {
  await greenBase();
  const issue = await issueOf(true);
  const checked = await call(
    'POST',
    `/api/issues/${issue}/merge-check`,
    batchReport(head, commits),
  );
  expect(checked.status, JSON.stringify(checked.body)).toBe(201);
  return issue;
}

const mark = (issue: string, commit: string) =>
  call('POST', `/api/issues/${issue}/merge`, {
    target: 'dev',
    commit,
    note: 'landed in the batch',
  });

describe('a merge check covers each commit its range holds (REQ-79 BC-5)', () => {
  it('marks an issue landed mid-batch on the batch’s later passing check', async () => {
    const issue = await checkedAt(FIXED_FORWARD, [FIXED_FORWARD, LANDED]);
    const marked = await mark(issue, LANDED);
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);
  });

  it('refuses a commit no passing range holds, naming it and the ranges it saw', async () => {
    const issue = await checkedAt(FIXED_FORWARD, [FIXED_FORWARD, LANDED]);
    const refused = await mark(issue, ELSEWHERE);
    expect([refused.status, codes(refused)]).toEqual([422, ['MERGE_CHECK_MISSING']]);
    const said = JSON.stringify(refused.body);
    expect(said).toContain(`no passing merge check covers ${ELSEWHERE}`);
    expect(said).toContain(`${BASE.slice(0, 12)}..${FIXED_FORWARD.slice(0, 12)} (2 commit(s))`);
  });

  it('reads a report with no commits as its head alone', async () => {
    const issue = await checkedAt(FIXED_FORWARD);
    expect(codes(await mark(issue, LANDED))).toEqual(['MERGE_CHECK_MISSING']);
    expect((await mark(issue, FIXED_FORWARD)).status).toBe(200);
  });
});

describe("a batch's one merge check records on each issue it lands (ISS-1031)", () => {
  const checkIds = async (issue: string): Promise<string[]> =>
    ((await call('GET', `/api/issues/${issue}/checks`)).body.checks as Doc[])
      .map((c) => c.id as string)
      .sort();

  it('records the same report on the second, high-rated issue and marks it', async () => {
    await greenBase();
    const first = await issueOf(false);
    const second = await issueOf(true);
    const report = batchReport(FIXED_FORWARD, [FIXED_FORWARD, LANDED]);
    const sent = report.checks.map((c: Doc) => c.id as string).sort();

    const onFirst = await call('POST', `/api/issues/${first}/merge-check`, report);
    expect(onFirst.status, JSON.stringify(onFirst.body)).toBe(201);
    const onSecond = await call('POST', `/api/issues/${second}/merge-check`, report);
    const marked = await mark(second, LANDED);
    expect(
      {
        record: [onSecond.status, codes(onSecond)],
        mark: [marked.status, codes(marked)],
      },
      JSON.stringify({ record: onSecond.body, mark: marked.body }),
    ).toEqual({ record: [201, []], mark: [200, []] });

    // the same check ids, readable from each issue the batch lands
    expect(await checkIds(first)).toEqual(sent);
    expect(await checkIds(second)).toEqual(sent);
  });

  it('adds no check for a resend to an issue the report already covers', async () => {
    await greenBase();
    const first = await issueOf(false);
    const second = await issueOf(true);
    const report = batchReport(FIXED_FORWARD);
    expect((await call('POST', `/api/issues/${first}/merge-check`, report)).status).toBe(201);
    expect((await call('POST', `/api/issues/${second}/merge-check`, report)).status).toBe(201);
    const again = await call('POST', `/api/issues/${second}/checks`, {
      head: FIXED_FORWARD,
      checks: report.checks,
    });
    expect([again.status, again.body.recorded, again.body.alreadyRecorded]).toEqual([
      200,
      0,
      report.checks.length,
    ]);
    expect(await checkIds(second)).toHaveLength(report.checks.length);
  });

  it("still refuses the mark of an issue whose commit the report's range does not hold", async () => {
    await greenBase();
    const first = await issueOf(false);
    const second = await issueOf(true);
    const report = batchReport(FIXED_FORWARD, [FIXED_FORWARD, LANDED]);
    expect((await call('POST', `/api/issues/${first}/merge-check`, report)).status).toBe(201);
    expect((await call('POST', `/api/issues/${second}/merge-check`, report)).status).toBe(201);
    const refused = await mark(second, ELSEWHERE);
    expect([refused.status, codes(refused)]).toEqual([422, ['MERGE_CHECK_MISSING']]);
    expect(JSON.stringify(refused.body)).toContain(`no passing merge check covers ${ELSEWHERE}`);
  });

  it('still refuses a different check under an id the batch already recorded, by name', async () => {
    await greenBase();
    const first = await issueOf(false);
    const second = await issueOf(true);
    const report = batchReport(FIXED_FORWARD);
    expect((await call('POST', `/api/issues/${first}/merge-check`, report)).status).toBe(201);
    const other = {
      ...report,
      checks: report.checks.map((c: Doc, i: number) => (i === 0 ? { ...c, durationMs: 9 } : c)),
    };
    const res = await call('POST', `/api/issues/${second}/merge-check`, other);
    expect([res.status, codes(res)]).toEqual([409, ['CHECK_RUN_CONFLICT']]);
    expect(await checkIds(second)).toEqual([]);
  });
});
