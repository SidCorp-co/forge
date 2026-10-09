/**
 * The merge check's record (Issue to release r20 `rule-merge`; REQ-36 BC-9, BC-15; ISS-472): a
 * project's check sends its report to `POST /api/issues/:id/merge-check`, which refuses one a merge
 * may not rely on by the name of what failed and records a passing one on the issue: each check once,
 * as a check run with its kind and duration (ISS-474), and the verification record naming them without
 * a second copy of any duration. A mark where a check is owed — the project declares
 * `validation.mergeCheck: required` — is refused MERGE_CHECK_MISSING until a passing check stands at
 * the commit it marks; a project that declares none marks as before.
 *
 * It reaches its subject over HTTP, so it names what it guards:
 * @direct-test-of packages/core/src/issues/merge-check.ts
 * @direct-test-of packages/core/src/issues/merge-check-rules.ts
 * @direct-test-of packages/core/src/issues/merge-marker.ts
 * @direct-test-of packages/core/src/issues/merge-routes.ts
 * @direct-test-of packages/contracts/src/merge-check.ts
 * @direct-test-of packages/core/src/issues/record-events/store.ts
 */

import { randomUUID } from 'node:crypto';
import {
  MERGE_CHECK_KINDS,
  REQUIRED_MERGE_CHECKS,
  type RequiredMergeCheck,
} from '@forge/contracts/merge-check';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const environments = {
  dev: {
    tier: 'production' as const,
    deploysFrom: 'main',
    deployment: { mode: 'external' as const },
  },
};

const HEAD = 'a'.repeat(40);
const OTHER = 'd'.repeat(40);
const BASE = 'b'.repeat(40);

let token = '';
let userId = '';
let declared = '';
let undeclared = '';
let seq = 0;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const user = await createTestUser({ verified: true });
  userId = user.id;
  token = await userToken(user.id);
  for (const required of [true, false]) {
    const { id } = await createTestProject(user.id);
    await seedProjectDocument(id, user.id, {
      environments,
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
    await addProjectMember(id, user.id, 'admin');
    if (required) declared = id;
    else undeclared = id;
  }
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function issueIn(projectId: string): Promise<string> {
  seq += 1;
  return (
    await createTestIssue(projectId, userId, seq, { status: 'in_progress', createdAt: new Date() })
  ).id;
}

const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const res = await api(token, method, path, body);
  return { status: res.status, body: res.body as Doc };
};

const codes = (res: { body: Doc }): string[] =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.code);

const run = (name: RequiredMergeCheck, over: Doc = {}) => ({
  id: randomUUID(),
  kind: MERGE_CHECK_KINDS[name],
  startedAt: '2026-10-09T06:00:00.000Z',
  name,
  scope: 'workspace',
  command: `run ${name}`,
  files: name === 'direct-tests' ? ['packages/core/src/issues/x.test.ts'] : [],
  result: 'pass',
  durationMs: 1200,
  ...over,
});

const report = (over: Doc = {}) => ({
  base: { branch: 'dev', sha: BASE },
  head: HEAD,
  mode: 'pre-merge',
  touched: [{ path: 'packages/core/src/issues/x.ts', change: 'changed' }],
  checks: REQUIRED_MERGE_CHECKS.map((n) => run(n)),
  ...over,
});

const check = (issue: string, body: unknown) =>
  call('POST', `/api/issues/${issue}/merge-check`, body);

const mark = (issue: string, commit: string) =>
  call('POST', `/api/issues/${issue}/merge`, {
    target: 'dev',
    commit,
    note: 'landed',
    changedPaths: {
      commit,
      changes: [{ path: 'packages/core/src/issues/x.ts', change: 'changed' }],
    },
  });

const verifications = async (issue: string) =>
  ((await call('GET', `/api/issues/${issue}/events`)).body.items as Doc[]).filter(
    (e) => e.kind === 'verification',
  );

const mergedAt = async (issue: string) =>
  (await rows<{ merged_at: Date | null }>(sql`SELECT merged_at FROM issues WHERE id = ${issue}`))[0]
    ?.merged_at ?? null;

describe('a report the merge check refuses, recording nothing', () => {
  it('refuses a body that is not a report, naming the shape', async () => {
    const issue = await issueIn(declared);
    const res = await check(issue, { ...report(), head: 'abc', extra: true });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('head');
    expect(await verifications(issue)).toEqual([]);
  });

  it('refuses one missing a check every merge needs', async () => {
    const issue = await issueIn(declared);
    const res = await check(issue, report({ checks: [run('typecheck')] }));
    expect([res.status, codes(res)]).toEqual([422, ['MERGE_CHECK_INCOMPLETE']]);
  });

  it('refuses one filing a required check under another kind, recording nothing', async () => {
    const issue = await issueIn(declared);
    const checks = REQUIRED_MERGE_CHECKS.map((n) =>
      run(n, n === 'typecheck' ? { kind: 'tests' } : {}),
    );
    const res = await check(issue, report({ checks }));
    expect([res.status, codes(res)]).toEqual([422, ['MERGE_CHECK_KIND_MISMATCH']]);
    expect((await call('GET', `/api/issues/${issue}/checks`)).body.checks).toEqual([]);
  });

  it('refuses one reusing a recorded check id for another check, writing neither record', async () => {
    const issue = await issueIn(declared);
    const first = report();
    expect((await check(issue, first)).status).toBe(201);
    const other = await issueIn(declared);
    const reused = REQUIRED_MERGE_CHECKS.map((n, i) =>
      run(n, i === 0 ? { id: first.checks[0]?.id, durationMs: 9 } : {}),
    );
    const res = await check(other, report({ checks: reused }));
    expect([res.status, codes(res)]).toEqual([409, ['CHECK_RUN_CONFLICT']]);
    expect(res.body.error.refusals[0].path).toBe('/checks/0/id');
    expect(await verifications(other)).toEqual([]);
    expect((await call('GET', `/api/issues/${other}/checks`)).body.checks).toEqual([]);
  });

  it('refuses one behind its base, by name', async () => {
    const issue = await issueIn(declared);
    const checks = REQUIRED_MERGE_CHECKS.map((n) =>
      run(n, n === 'rebased-on-base' ? { result: 'fail' } : {}),
    );
    const res = await check(issue, report({ checks }));
    expect([res.status, codes(res)]).toEqual([422, ['MERGE_BEHIND_BASE']]);
  });

  it('refuses one with a red check, naming the check and its files', async () => {
    const issue = await issueIn(declared);
    const checks = REQUIRED_MERGE_CHECKS.map((n) =>
      run(n, n === 'direct-tests' ? { result: 'fail' } : {}),
    );
    const res = await check(issue, report({ checks }));
    expect([res.status, codes(res)]).toEqual([422, ['MERGE_CHECK_RED']]);
    expect(res.body.error.refusals[0].detail).toContain('packages/core/src/issues/x.test.ts');
    expect(await verifications(issue)).toEqual([]);
  });
});

describe('a passing check is recorded on its issue', () => {
  it("each check once with its kind and duration, and core's verification record naming them", async () => {
    const issue = await issueIn(declared);
    const sent = report();
    const res = await check(issue, sent);
    expect([res.status, res.body.allowed, res.body.head]).toEqual([201, true, HEAD]);
    const [record, ...rest] = await verifications(issue);
    expect(rest).toEqual([]);
    expect(record?.writer).toBe('core');
    const fields = (record?.fields ?? []) as Doc[];
    const field = (key: string) => fields.find((f) => f.key === key)?.value;
    expect([field('check'), field('result'), field('head')]).toEqual(['merge', 'pass', HEAD]);
    expect(field('checks')).toContain('direct-tests (workspace)');
    expect(fields.some((f) => /\d+\.\ds\b/.test(String(f.value)))).toBe(false);

    const read = (await call('GET', `/api/issues/${issue}/checks`)).body;
    expect(read.checks.map((c: Doc) => c.id).sort()).toEqual(sent.checks.map((c) => c.id).sort());
    expect(read.checks.every((c: Doc) => c.via === 'merge-check' && c.durationMs === 1200)).toBe(
      true,
    );
    expect(read.kinds.find((k: Doc) => k.kind === 'tests')).toMatchObject({
      checks: 2,
      totalMs: 2400,
    });
    expect(read.totalMs).toBe(6000);
  });
});

describe('the mark asks for a passing check where one is owed', () => {
  it('refuses a mark on a project that declares the check while none is recorded, marking nothing', async () => {
    const issue = await issueIn(declared);
    const res = await mark(issue, HEAD);
    expect([res.status, codes(res)]).toEqual([422, ['MERGE_CHECK_MISSING']]);
    expect(res.body.error.refusals[0].detail).toContain('`validation.mergeCheck: required`');
    expect(await mergedAt(issue)).toBeNull();
  });

  it("does not take a caller's own verification record for core's", async () => {
    const issue = await issueIn(declared);
    const posted = await call('POST', `/api/issues/${issue}/events`, {
      kind: 'verification',
      contract: 1,
      fields: [
        { key: 'check', value: 'merge' },
        { key: 'result', value: 'pass' },
        { key: 'head', value: HEAD },
      ],
    });
    expect(posted.status).toBe(201);
    expect(codes(await mark(issue, HEAD))).toEqual(['MERGE_CHECK_MISSING']);
  });

  it('refuses a mark at a commit no check passed at, naming the head that did', async () => {
    const issue = await issueIn(declared);
    expect((await check(issue, report())).status).toBe(201);
    const res = await mark(issue, OTHER);
    expect(codes(res)).toEqual(['MERGE_CHECK_MISSING']);
    expect(res.body.error.refusals[0].detail).toContain(HEAD.slice(0, 12));
  });

  it('marks the commit a passing check is recorded at', async () => {
    const issue = await issueIn(declared);
    expect((await check(issue, report())).status).toBe(201);
    const res = await mark(issue, HEAD);
    expect([res.status, res.body.action]).toEqual([200, 'merged']);
    expect(await mergedAt(issue)).not.toBeNull();
  });

  it('asks nothing on a project that declares no check, for an issue with no new pattern', async () => {
    const issue = await issueIn(undeclared);
    const res = await mark(issue, HEAD);
    expect([res.status, res.body.action]).toEqual([200, 'merged']);
  });
});
