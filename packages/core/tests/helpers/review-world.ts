/**
 * The ground the issue review suites stand on (`issue-review-e2e`, `issue-review-declared-run-e2e`):
 * a person and a box of theirs, projects that declare the merge check, an issue built by a run on the
 * box with its design and a passing merge check at `HEAD`, the review body and the calls that send it.
 */

import { randomUUID } from 'node:crypto';
import { PATTERN_CATALOG } from '@forge/contracts/pattern-catalog';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { verdictByBuilderSql } from '../../src/issues/built-by.js';
import { THIS_REPOSITORY } from '../../src/lib/this-repository.js';
import { api, userToken } from './api.js';
import { type Doc, startQueue, testEnv } from './ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestIssue,
  createTestModule,
  createTestProject,
  createTestRunSession,
  createTestUser,
  rows,
} from './factories.js';
import { passingChecksRunning, passingReport } from './merge-check-report.js';
import { seedProjectDocument } from './release-world.js';

export const HEAD = 'a'.repeat(40);
export const BASE = 'b'.repeat(40);
export const API_ROUTE = PATTERN_CATALOG.find((e) => e.slug === 'api-route');

// read by the suites as live bindings, filled in by `startReviewWorld`
export let personToken = '';
export let boxToken = '';
export let userId = '';
export let deviceId = '';
export const projects = { catalog: '', noCatalog: '', undeclared: '' };
let seq = 0;

/** The next issue number of the world, unique across its projects. */
export function nextSeq(): number {
  seq += 1;
  return seq;
}

export async function project(repository: string, required: boolean): Promise<string> {
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

/** The world every review suite stands on: a person, a box of theirs, and three projects. */
export async function startReviewWorld(): Promise<void> {
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
}

export const call = async (
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
) => {
  const res = await api(token, method, path, body);
  return { status: res.status, body: res.body as Doc };
};

export const codes = (res: { body: Doc }): string[] =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.code);
export const detail = (res: { body: Doc }): string =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.detail).join(' | ');

/** A run session on the box; `hold` gives it the issue's lease, as a building run holds it. */
export async function runOnBox(projectId: string, hold?: string): Promise<string> {
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
export async function builtIssue(projectId: string): Promise<{ id: string; builder: string }> {
  const issue = await createTestIssue(projectId, userId, nextSeq(), {
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
    withoutClip: 'judged by its probe: nothing on screen to record',
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

export const checklist = (result = 'pass') =>
  (API_ROUTE?.checklist ?? []).map((_, at) => ({
    pattern: 'api-route',
    line: at + 1,
    result,
    note: `checked in packages/core/src/issues/x.ts (line ${at + 1})`,
  }));

export const review = (over: Doc = {}) => ({
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

export const post = (token: string, issue: string, body: unknown) =>
  call(token, 'POST', `/api/issues/${issue}/review`, body);

export const mark = (issue: string) =>
  call(personToken, 'POST', `/api/issues/${issue}/merge`, {
    target: 'dev',
    commit: HEAD,
    note: 'landed',
    changedPaths: {
      commit: HEAD,
      changes: [{ path: 'packages/core/src/issues/x.ts', change: 'changed' }],
    },
  });

export const reviewRecords = async (issue: string) =>
  ((await call(personToken, 'GET', `/api/issues/${issue}/events`)).body.items as Doc[]).filter(
    (e) => e.kind === 'review',
  );

export const fieldsOf = (record: Doc, key: string): string[] =>
  (record.fields as Doc[]).filter((f) => f.key === key).map((f) => f.value);

/**
 * `forge-runner run declare --role <role>`: the box opens the declared run's session at core through
 * its own door, as the sweep does (`runner-daemon/src/run_record.rs`), under the id the box minted.
 */
export async function declareOnBox(
  projectId: string,
  issueKey: string,
  role: string,
): Promise<{ runId: string; sessionId: string }> {
  const runId = randomUUID();
  const opened = await call(boxToken, 'POST', '/api/devices/me/run-sessions', {
    projectId,
    runId,
    issueKeys: [issueKey],
    name: `${issueKey.toLowerCase()}-${role.replace(':', '-')}`,
    role,
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  return { runId, sessionId: String(opened.body.sessionId) };
}

/** The building run ends: its box closes its session, which gives the issue's lease back. */
export async function closeOnBox(session: string): Promise<void> {
  const closed = await call(boxToken, 'POST', `/api/devices/me/run-sessions/${session}/close`, {
    outcome: 'ended',
  });
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
}

export const keyOf = async (issue: string): Promise<string> => {
  const [row] = await rows<{ iss_seq: number }>(
    sql`SELECT iss_seq FROM issues WHERE id = ${issue}`,
  );
  return `ISS-${row?.iss_seq}`;
};

/** Criterion 2's verdict as recorded: the session credited with it and whether it reads as the builder's. */
export async function reviewVerdictOf(
  issue: string,
): Promise<Array<{ session: string | null; byBuilder: boolean }>> {
  return rows<{ session: string | null; byBuilder: boolean }>(sql`
    SELECT v.run_session_id AS session, ${verdictByBuilderSql({
      issueId: sql`v.issue_id`,
      authorUser: sql`v.author_user_id`,
      authorDevice: sql`v.author_device_id`,
      at: sql`v.created_at`,
      runSession: sql`v.run_session_id`,
    })} AS "byBuilder"
      FROM criterion_verdicts v JOIN issue_criteria c ON c.id = v.criterion_id
     WHERE v.issue_id = ${issue} AND c.n = 2 AND v.judge = 'review'
  `);
}
