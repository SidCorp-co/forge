/**
 * ISS-1021 (FB-525, agenfold ISS-175) — a verdict fence reads its judge. A run declared
 * `--role reviewer` posted its verdicts as a comment's `forge-record: verdict` fence, with
 * `judge: review` and without it, and both were refused VERDICT_JUDGE_NOT_RUN_ROLE: the block parser
 * dropped the line, so every fenced verdict was QA's, and the refusal told the run to send a
 * `judge` the fence then ignored. Now the line is read, a fence naming none is the recording run's own
 * role's judgement, a judge naming neither `qa` nor `review` is refused by name, and the refusal names
 * both doors that take a judge. Against real Postgres, through the box's routes and the comment door.
 *
 * @direct-test-of packages/core/src/issues/criteria/verdict-role.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-record.ts
 * @direct-test-of packages/core/src/issues/criteria/event-verdicts.ts
 * @direct-test-of packages/core/src/messaging/verdict-identity.ts
 */

import { randomUUID } from 'node:crypto';
import { recordAction } from '@forge/contracts/record-events';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { deviceTokenNameFor } from '../../src/credentials/pat-format.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

type Doc = Record<string, unknown>;

const FENCE = '```';
const SHA = '1994aff73882b8368c19355ebbaa208dbc1cd5f4';

const world = { ownerId: '', projectId: '', box: '', boxToken: '', issueId: '' };

const refusalsOf = (body: unknown): Doc[] =>
  ((body as { error?: { refusals?: Doc[] } }).error?.refusals ?? []) as Doc[];
const codes = (body: unknown): string[] => refusalsOf(body).map((r) => String(r.code));
const detailOf = (body: unknown): string =>
  refusalsOf(body)
    .map((r) => String(r.detail))
    .join(' ');

const declare = (runId: string, role: string) =>
  api(world.boxToken, 'POST', '/api/devices/me/run-sessions', {
    projectId: world.projectId,
    runId,
    issueKeys: ['ISS-1'],
    name: `run-${runId.slice(0, 4)}`,
    role,
  });

/** A credential of the box, as a judge pane posts with: its run is read off the issue's lease. */
async function judgeToken(): Promise<string> {
  return (
    await mintPat({ permissions: ['*'], userId: world.ownerId, name: 'judge', deviceId: world.box })
  ).plaintext;
}

/** A comment carrying one verdict fence on `criterion`, with `judge` as its line where given. */
const fenced = (token: string, criterion: number, judge?: string) =>
  api(token, 'POST', `/api/issues/${world.issueId}/comments`, {
    body: [
      'Read in the diff at the landing commit.',
      '',
      `${FENCE}forge-record: verdict · contract 1`,
      `criterion: ${criterion}`,
      'verdict: pass',
      ...(judge === undefined ? [] : [`judge: ${judge}`]),
      `commit: ${SHA}`,
      'why: the diff reads the reference code from one module',
      'evidence: https://ci.example.test/runs/7/review-log',
      FENCE,
    ].join('\n'),
    intent: 'note',
  });

async function judgesRecorded(): Promise<Array<{ n: number; judge: string }>> {
  return rows<{ n: number; judge: string }>(sql`
    SELECT c.n, v.judge FROM criterion_verdicts v JOIN issue_criteria c ON c.id = v.criterion_id
     WHERE v.issue_id = ${world.issueId} ORDER BY v.created_at`);
}

/** The `judge` field of the verdict record core wrote last on the issue. */
async function judgeOfKernelRecord(): Promise<string | null> {
  const [row] = await rows<{ judge: string | null }>(sql`
    SELECT (SELECT f ->> 'value' FROM jsonb_array_elements(a.payload -> 'fields') f
             WHERE f ->> 'key' = 'judge') AS judge
      FROM activity_log a
     WHERE a.issue_id = ${world.issueId} AND a.action = ${recordAction('verdict')}
     ORDER BY a.created_at DESC LIMIT 1`);
  return row?.judge ?? null;
}

async function opened(role: string): Promise<string> {
  const runId = randomUUID();
  const res = await declare(runId, role);
  expect([res.status, codes(res.body)], JSON.stringify(res.body)).toEqual([200, []]);
  return runId;
}

beforeEach(async () => {
  await truncateAll();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.box = await createTestDevice(world.ownerId);
  await bindTestRunner(world.projectId, world.box);
  world.boxToken = (
    await mintPat({
      userId: world.ownerId,
      name: deviceTokenNameFor(world.box),
      scopes: ['read', 'write'],
      permissions: ['*'],
      projectIds: [],
      onBehalfOf: world.ownerId,
      deviceId: world.box,
    })
  ).plaintext;
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: 'main',
    environments: { dev: { tier: 'dev', deploysFrom: 'dev', deployment: { mode: 'external' } } },
  });
  const master = await api(world.boxToken, 'POST', '/api/devices/me/master-session', {
    projectId: world.projectId,
    name: 'forge-master-judge',
    maxJobPanes: 2,
  });
  expect(master.status, JSON.stringify(master.body)).toBe(200);
  const issue = await createTestIssue(world.projectId, world.ownerId, 1, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  world.issueId = issue.id;
  // criterion 1 is classed nowhere, so either judge may record it; criterion 2 is a code property,
  // the review's (REQ-36 BC-13)
  await rows(sql`
    INSERT INTO issue_criteria (issue_id, n, statement, position)
    VALUES (${issue.id}, 1, 'the reference code is read in one place', 0)`);
  const [property] = await rows<{ id: string }>(sql`
    INSERT INTO issue_criteria (issue_id, n, statement, position)
    VALUES (${issue.id}, 2, 'the reference code is read from one module', 1) RETURNING id`);
  await rows(sql`
    INSERT INTO issue_designs (issue_id, project_id, revision, modules, contracts, recorded_by)
    VALUES (${issue.id}, ${world.projectId}, 1, '{}', '{}', ${world.ownerId})`);
  await rows(sql`
    INSERT INTO issue_design_criteria (criterion_id, issue_id, criterion_class, proof)
    VALUES (${property?.id}, ${issue.id}, 'code_property', 'the diff reads the code from one module')`);
});

describe("a reviewer run's verdict fence", () => {
  it("with `judge: review` is recorded as the review's, as the REST door records it", async () => {
    await opened('forge:reviewer');
    const res = await fenced(await judgeToken(), 1, 'review');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await judgesRecorded()).toEqual([{ n: 1, judge: 'review' }]);
    expect(await judgeOfKernelRecord()).toBe('review');
  });

  it("with no judge line is recorded as the review's, its run's own role", async () => {
    await opened('reviewer');
    const res = await fenced(await judgeToken(), 1);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await judgesRecorded()).toEqual([{ n: 1, judge: 'review' }]);
    expect(await judgeOfKernelRecord()).toBe('review');
  });

  it("with no judge line records a code-property criterion, the review's by its class", async () => {
    await opened('reviewer');
    const res = await fenced(await judgeToken(), 2);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await judgesRecorded()).toEqual([{ n: 2, judge: 'review' }]);
  });
});

describe('a verdict fence with no run behind it', () => {
  it("records `judge: review` as the review's: the line is read, not inferred", async () => {
    const res = await fenced(await userToken(world.ownerId), 1, 'review');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await judgesRecorded()).toEqual([{ n: 1, judge: 'review' }]);
  });

  it("records a fence naming no judge as QA's, as before", async () => {
    const res = await fenced(await userToken(world.ownerId), 1);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await judgesRecorded()).toEqual([{ n: 1, judge: 'qa' }]);
  });
});

describe("a qa run's verdict fence", () => {
  it("with no judge line stays QA's", async () => {
    await opened('qa');
    const res = await fenced(await judgeToken(), 1);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await judgesRecorded()).toEqual([{ n: 1, judge: 'qa' }]);
    expect(await judgeOfKernelRecord()).toBe('qa');
  });

  it("sending the review's judgement is still refused, naming both doors that take its own", async () => {
    const runId = await opened('qa');
    const res = await fenced(await judgeToken(), 1, 'review');
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const said = detailOf(res.body);
    expect(said).toContain('rule VERDICT_JUDGE_NOT_RUN_ROLE');
    expect(said).toContain(runId);
    expect(said).toContain("`judge: qa` in a comment's verdict fence");
    expect(said).toContain('`"judge": "qa"` at `POST /api/issues/:id/verdicts`');
    expect(said).toContain("`judge: review` in a comment's verdict fence");
    expect(await judgesRecorded()).toEqual([]);
  });
});

describe('the REST door', () => {
  it("refuses a qa run's review verdict naming both doors that take a judge", async () => {
    const runId = await opened('qa');
    const res = await api(await judgeToken(), 'POST', `/api/issues/${world.issueId}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      reason: 'read in the diff',
      identity: { kind: 'commit', sha: SHA },
      judge: 'review',
      run: runId,
    });
    expect(codes(res.body), JSON.stringify(res.body)).toEqual(['VERDICT_JUDGE_NOT_RUN_ROLE']);
    const said = detailOf(res.body);
    expect(said).toContain("`judge: qa` in a comment's verdict fence");
    expect(said).toContain('`"judge": "qa"` at `POST /api/issues/:id/verdicts`');
  });

  it("still records a reviewer run's verdict naming no judge as QA's and refuses it, as documented", async () => {
    const runId = await opened('reviewer');
    const res = await api(await judgeToken(), 'POST', `/api/issues/${world.issueId}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      reason: 'read in the diff',
      identity: { kind: 'commit', sha: SHA },
      run: runId,
    });
    expect(codes(res.body), JSON.stringify(res.body)).toEqual(['VERDICT_JUDGE_NOT_RUN_ROLE']);
    expect(detailOf(res.body)).toContain("`judge: review` in a comment's verdict fence");
  });
});

describe('a judge naming neither qa nor review', () => {
  it('is refused by name at the comment door, quoting the line, and nothing is recorded', async () => {
    await opened('reviewer');
    const res = await fenced(await judgeToken(), 1, 'bogus');
    expect([res.status, codes(res.body)], JSON.stringify(res.body)).toEqual([
      422,
      ['MESSAGE_REFUSED'],
    ]);
    const said = detailOf(res.body);
    expect(said).toContain('rule verdict-judge');
    expect(said).toContain("criterion 1's `judge` line holds `bogus`");
    expect(said).toContain('`qa`, `review`');
    expect(await judgesRecorded()).toEqual([]);
  });
});
