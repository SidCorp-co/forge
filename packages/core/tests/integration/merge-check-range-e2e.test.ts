/**
 * A change rated high on a project that deploys on land owes its mark a passing merge check
 * (REQ-79 BC-5). A batch lands its issues, then fixes forward, so the check that passes is the
 * batch's, at a later head: it covers each commit its range base..head held, and the mark of an
 * issue landed inside that range is taken (ISS-845). A check whose range does not hold the commit
 * covers nothing, and the refusal names the commit and the ranges it saw.
 *
 * @direct-test-of packages/core/src/issues/merge-check.ts
 * @direct-test-of packages/core/src/issues/merge-check-rules.ts
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

/** A high-rated issue on a green base, its batch's passing check recorded at `head` over `commits`. */
async function checkedAt(head: string, commits?: string[]): Promise<string> {
  const green = await call('POST', `/api/projects/${projectId}/cleanup-reports`, {
    base: { branch: 'dev', sha: 'c'.repeat(40) },
    result: 'green',
    cleared: [],
    remains: [],
  });
  expect(green.status, JSON.stringify(green.body)).toBe(201);
  const issue = await fx.insertIssue('in_progress');
  await call('POST', `/api/issues/${issue}/impact`, {
    type: 'data',
    rating: 'high',
    reason: 'rated high',
  });
  const checked = await call('POST', `/api/issues/${issue}/merge-check`, {
    ...passingReport({
      base: { branch: 'dev', sha: BASE },
      head,
      touched: [{ path: 'packages/core/src/x.ts', change: 'changed' }],
      checks: FAST_LANE_MERGE_CHECKS.map((n) => passingCheck(n)) as never,
    }),
    ...(commits ? { commits } : {}),
  });
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
