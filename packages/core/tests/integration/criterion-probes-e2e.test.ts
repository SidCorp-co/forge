/**
 * A verdict keeps the probe it rests on (REQ-36 BC-6, BC-13; ISS-469). A verdict on an observable
 * criterion carries a stored probe naming what it runs against the running build and the result it
 * expects, and the criteria read answers it under its criterion (criterion 1). A pass or short on an
 * observable criterion with no probe sent and none kept is refused by name, at the REST door and at
 * the comment fence alike (criterion 2). A malformed probe is refused at its path, a credential in one
 * is refused without being echoed, a code property keeps none, and a criterion no design classes
 * owes none, which its verdict's record says.
 *
 * @direct-test-of packages/core/src/issues/criteria/probes.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-record.ts
 * @direct-test-of packages/core/src/issues/criteria/routes.ts
 * @direct-test-of packages/core/src/issues/criteria/input-schemas.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-input.ts
 * @direct-test-of packages/contracts/src/issues.ts
 * @direct-test-of packages/core/src/issues/criteria/service.ts
 * @direct-test-of packages/core/src/middleware/zod-validator.ts
 * @direct-test-of packages/core/src/db/schema-issue-criteria.ts
 * @direct-test-of packages/contracts/src/criterion-probes.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { THIS_REPOSITORY } from '../../src/lib/this-repository.js';
import { userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestModule,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import {
  callerFor,
  ok,
  projectBuiltFrom,
  type Res,
  refusalCodes as refused,
} from '../helpers/pattern-world.js';

const tokens = { admin: '', author: '', viewer: '' };
const call = callerFor(tokens);
let adminId = '';
let forge = '';
let seq = 0;

const SHA = 'c'.repeat(40);
const GITHUB_TOKEN = `ghp_${'A1b2C3d4'.repeat(5)}`;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const admin = await createTestUser({ verified: true });
  const author = await createTestUser({ kind: 'agent' });
  const viewer = await createTestUser({ verified: true });
  adminId = admin.id;
  forge = await projectBuiltFrom(admin.id, THIS_REPOSITORY);
  await createTestModule(forge, 'issues');
  await addProjectMember(forge, admin.id, 'admin');
  await addProjectMember(forge, author.id, 'member');
  await addProjectMember(forge, viewer.id, 'viewer');
  tokens.admin = await userToken(admin.id);
  tokens.author = await userToken(author.id);
  tokens.viewer = await userToken(viewer.id);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** An in-progress issue with three criteria; `designed` classes 1 observable, 2 a code property. */
async function issueWith(designed: boolean): Promise<string> {
  seq += 1;
  const { id } = await createTestIssue(forge, adminId, seq, {
    status: 'open',
    createdAt: new Date(),
  });
  ok(
    await call('admin', 'PATCH', `/api/issues/${id}`, {
      plan: 'Build it to the catalogued pattern.',
      acceptanceCriteria:
        '1. The page shows it.\n2. The rule lives in one module.\n3. The list shows it.',
    }),
  );
  if (designed) {
    ok(
      await call('author', 'PUT', `/api/issues/${id}/design`, {
        criteria: [
          { criterion: 1, class: 'observable', pattern: 'api-route', proof: 'GET it, see it' },
          { criterion: 2, class: 'code_property', pattern: 'core-module', proof: 'review' },
          { criterion: 3, class: 'observable', pattern: 'api-route', proof: 'list it' },
        ],
        modules: ['issues'],
        contracts: [],
      }),
    );
  }
  return id;
}

const requestProbe = {
  kind: 'request',
  request: {
    method: 'GET',
    path: '/api/health',
    headers: { Accept: 'application/json' },
    as: 'anonymous',
  },
  expect: { status: 200, bodyIncludes: ['"ok":true'] },
};

const commandProbe = {
  kind: 'command',
  command: { argv: ['node', 'scripts/probe-health.mjs'], cwd: 'packages/core' },
  expect: { exitCode: 0, stdoutIncludes: ['healthy'] },
};

const verdict = (issue: string, body: Doc) =>
  call('author', 'POST', `/api/issues/${issue}/verdicts`, {
    reason: 'ran it',
    identity: { kind: 'commit', sha: SHA },
    ...body,
  });

const criteriaOf = async (issue: string): Promise<Doc[]> =>
  ok(await call('viewer', 'GET', `/api/issues/${issue}/criteria`)).criteria;

const stored = async (issue: string) =>
  (
    await rows<{ probes: number; verdicts: number }>(sql`
      SELECT (SELECT count(*)::int FROM criterion_probes WHERE issue_id = ${issue}) AS probes,
             (SELECT count(*)::int FROM criterion_verdicts WHERE issue_id = ${issue}) AS verdicts`)
  )[0];

const pathsOf = (res: Res): string[] =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.path as string);

/** The `probe` field of each verdict record on the issue, oldest first. */
async function probeFields(issue: string): Promise<(string | null)[]> {
  const body = ok(await call('viewer', 'GET', `/api/issues/${issue}/events`));
  const list: Doc[] = Array.isArray(body) ? body : (body.events ?? body.items ?? []);
  return list
    .filter((e) => e.kind === 'verdict')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((e) => (e.fields as Doc[]).find((f) => f.key === 'probe')?.value ?? null);
}

describe('a verdict keeps its probe, readable from the criterion (criterion 1)', () => {
  it('stores a request probe with a pass and answers it under its criterion', async () => {
    const issue = await issueWith(true);
    const res = ok(
      await verdict(issue, { criterion: 1, verdict: 'pass', probe: requestProbe }),
      201,
    );
    const probe = res.criterion.probe;
    expect(probe).toMatchObject(requestProbe);
    expect(probe.id).toMatch(/^[0-9a-f-]{36}$/);
    const [one] = await criteriaOf(issue);
    expect(one?.probe).toEqual(probe);
    expect(one?.latest.probeId).toBe(probe.id);
    expect(await probeFields(issue)).toEqual([probe.id]);
  });

  it('stores a command probe with a fail, and a later pass that sends none rests on it', async () => {
    const issue = await issueWith(true);
    const failed = ok(
      await verdict(issue, { criterion: 3, verdict: 'fail', probe: commandProbe }),
      201,
    );
    const kept = failed.criterion.probe.id;
    const passed = ok(await verdict(issue, { criterion: 3, verdict: 'pass' }), 201);
    expect(passed.criterion.probe).toMatchObject({ ...commandProbe, id: kept });
    expect(passed.criterion.latest.probeId).toBe(kept);
    expect(await stored(issue)).toEqual({ probes: 1, verdicts: 2 });
  });

  it('refuses a malformed probe at its path, writing nothing', async () => {
    const issue = await issueWith(true);
    const res = await verdict(issue, {
      criterion: 1,
      verdict: 'pass',
      probe: {
        kind: 'request',
        request: { method: 'GET', path: 'https://forge.example/api/health', as: 'anonymous' },
        expect: {},
      },
    });
    expect([res.status, [...new Set(refused(res))]]).toEqual([422, ['VERDICT_PROBE_SHAPE']]);
    expect(pathsOf(res).sort()).toEqual(['/probe/expect/status', '/probe/request/path']);
    const kinded = await verdict(issue, {
      criterion: 1,
      verdict: 'pass',
      probe: { kind: 'script', script: 'probe.sh' },
    });
    expect([kinded.status, refused(kinded)]).toEqual([422, ['VERDICT_PROBE_SHAPE']]);
    expect(pathsOf(kinded)).toEqual(['/probe/kind']);
    expect(await stored(issue)).toEqual({ probes: 0, verdicts: 0 });
  });

  it('refuses a probe holding a credential at its path, never echoing it, writing nothing', async () => {
    const issue = await issueWith(true);
    const headed = await verdict(issue, {
      criterion: 1,
      verdict: 'pass',
      probe: {
        ...requestProbe,
        request: { ...requestProbe.request, headers: { Authorization: 'Bearer abc.def.ghi1234' } },
      },
    });
    expect([headed.status, refused(headed)]).toEqual([422, ['VERDICT_PROBE_SECRET']]);
    expect(pathsOf(headed)).toEqual(['/probe/request/headers/Authorization']);
    expect(JSON.stringify(headed.body)).not.toContain('abc.def.ghi1234');
    const argued = await verdict(issue, {
      criterion: 1,
      verdict: 'pass',
      probe: {
        ...commandProbe,
        command: { argv: ['gh', 'api', GITHUB_TOKEN] },
      },
    });
    expect([argued.status, refused(argued)]).toEqual([422, ['VERDICT_PROBE_SECRET']]);
    expect(pathsOf(argued)).toEqual(['/probe/command/argv/2']);
    expect(JSON.stringify(argued.body)).not.toContain(GITHUB_TOKEN);
    expect(await stored(issue)).toEqual({ probes: 0, verdicts: 0 });
  });
});

describe('a pass on an observable criterion with no kept probe (criterion 2)', () => {
  it('is refused by name at the REST door, a short too, and a fail is not', async () => {
    const issue = await issueWith(true);
    for (const word of ['pass', 'short']) {
      const res = await verdict(issue, { criterion: 1, verdict: word });
      expect([res.status, refused(res)]).toEqual([422, ['VERDICT_PROBE_REQUIRED']]);
      expect(pathsOf(res)).toEqual(['/probe']);
      expect(res.body.error.refusals[0].detail).toContain('criterion 1 is observable');
    }
    ok(await verdict(issue, { criterion: 1, verdict: 'fail' }), 201);
    expect(await stored(issue)).toEqual({ probes: 0, verdicts: 1 });
  });

  it('is refused by name at the comment fence', async () => {
    const issue = await issueWith(true);
    const res = await call('author', 'POST', `/api/issues/${issue}/comments`, {
      intent: 'note',
      body: [
        'Criterion 1 passed.',
        '',
        '```forge-record: verdict · contract 1',
        'criterion: 1',
        'verdict: pass',
        `commit: ${SHA}`,
        'evidence: judge-log.txt',
        '```',
      ].join('\n'),
    });
    expect(res.status).toBe(422);
    expect(String(res.body.detail)).toContain('VERDICT_PROBE_REQUIRED');
    expect(await stored(issue)).toEqual({ probes: 0, verdicts: 0 });
  });

  it('routes a code property to the review: it keeps no probe and owes none', async () => {
    const issue = await issueWith(true);
    const sent = await verdict(issue, {
      criterion: 2,
      verdict: 'pass',
      judge: 'review',
      probe: requestProbe,
    });
    expect([sent.status, refused(sent)]).toEqual([422, ['VERDICT_PROBE_CODE_PROPERTY']]);
    ok(await verdict(issue, { criterion: 2, verdict: 'pass', judge: 'review' }), 201);
    expect(await probeFields(issue)).toEqual([
      'not owed: a code property is judged against the diff',
    ]);
  });

  it('exempts a criterion no design classes, by a rule its verdict record names', async () => {
    const issue = await issueWith(false);
    const res = ok(await verdict(issue, { criterion: 1, verdict: 'pass' }), 201);
    expect(res.criterion.probe).toBeNull();
    expect(await probeFields(issue)).toEqual(['not owed: no design classes this criterion']);
  });

  it('leaves a pass recorded before the criterion was classed standing', async () => {
    const issue = await issueWith(false);
    ok(await verdict(issue, { criterion: 1, verdict: 'pass' }), 201);
    ok(
      await call('author', 'PUT', `/api/issues/${issue}/design`, {
        criteria: [
          { criterion: 1, class: 'observable', pattern: 'api-route', proof: 'GET it' },
          { criterion: 2, class: 'code_property', pattern: 'core-module', proof: 'review' },
          { criterion: 3, class: 'observable', pattern: 'api-route', proof: 'list it' },
        ],
        modules: ['issues'],
        contracts: [],
      }),
    );
    const [one] = await criteriaOf(issue);
    expect([one?.class, one?.latest.verdict, one?.probe]).toEqual(['observable', 'pass', null]);
  });
});

describe('the table', () => {
  it('refuses a verdict resting on a probe of another criterion', async () => {
    const issue = await issueWith(true);
    const kept = ok(
      await verdict(issue, { criterion: 1, verdict: 'pass', probe: requestProbe }),
      201,
    ).criterion.probe.id;
    const [criterion3] = await rows<{ id: string }>(
      sql`SELECT id FROM issue_criteria WHERE issue_id = ${issue} AND n = 3`,
    );
    const raised = await db
      .execute(sql`
        INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, author_agency, probe_id)
        VALUES (${criterion3?.id}, ${issue}, 'fail', 'agent', ${kept})`)
      .then(
        () => 'written',
        (err: Error) => String(err.cause ?? err),
      );
    expect(raised).toMatch(/CRITERION_PROBE_MISMATCH: probe .* is not kept on criterion/);
  });
});
