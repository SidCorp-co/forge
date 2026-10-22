/**
 * ISS-567 (FB-138) — a criteria write matches a live criterion by its wording before its number
 * (`issues/criteria/match.ts:matchCriteria`), so a criterion that only moved to another number keeps
 * its row, its trace and the verdicts it earned, through both doors that write criteria: the plan's
 * PUT and a write of the `acceptance_criteria` text. A reworded criterion is still retired. Two
 * criteria that swap numbers each keep their own row. A wording repeated on the issue that would
 * have to move is refused CRITERIA_RENUMBER_AMBIGUOUS with nothing written, since which row keeps the
 * verdicts cannot be told. Through the app's own routes, against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/criteria/store.ts
 * @direct-test-of packages/core/src/issues/criteria/match.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const SHIPPED = '3333333333333333333333333333333333333333';
const LIVE = '9999999999999999999999999999999999999999';

let projectId: string;
let ownerId: string;
let token: string;
let unplant: (() => void) | null = null;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  unplant = plantLiveBuild(LIVE, { [SHIPPED]: true });
});

afterEach(() => {
  unplant?.();
  unplant = null;
});

type Verdict = { verdict: string; commitSha: string | null };
type Row = {
  id: string;
  n: number;
  statement: string;
  requirementCriterionId: string | null;
  latest: Verdict | null;
};
type Retired = { id: string; n: number; statement: string; verdicts: Verdict[] };

async function ok(r: Promise<{ status: number; body: Record<string, unknown> }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

const refusalOf = (body: Record<string, unknown>) =>
  (body.error as { refusals?: Array<{ code: string; detail: string }> } | undefined)?.refusals?.[0];

async function criteriaOf(issueId: string): Promise<{ criteria: Row[]; retired: Retired[] }> {
  const body = await ok(api(token, 'GET', `/api/issues/${issueId}/criteria`));
  return body as unknown as { criteria: Row[]; retired: Retired[] };
}

const put = (issueId: string, criteria: Array<Record<string, unknown>>) =>
  api(token, 'PUT', `/api/issues/${issueId}/criteria`, { criteria });

const writeText = (issueId: string, text: string) =>
  api(token, 'PATCH', `/api/issues/${issueId}`, { acceptanceCriteria: text });

const judge = (issueId: string, n: number, verdict: 'pass' | 'fail') =>
  ok(
    api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
      criterion: n,
      verdict,
      reason: `${verdict} on the running build`,
      identity: { kind: 'commit', sha: SHIPPED },
      evidence: ['shot.png'],
    }),
  );

async function openIssue(seq = 1): Promise<string> {
  const { id } = await createTestIssue(projectId, ownerId, seq, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  return id;
}

const byStatement = (rows: readonly Row[], statement: string) =>
  rows.find((r) => r.statement === statement) as Row;

describe('a criterion that only moved to another number keeps its row and its verdicts', () => {
  it('on a PUT that inserts a criterion above it', async () => {
    const issueId = await openIssue();
    await ok(
      put(issueId, [
        { statement: 'A nurse sees the reminder' },
        { statement: 'A doctor sees the report' },
      ]),
    );
    const before = await criteriaOf(issueId);
    await judge(issueId, 2, 'pass');

    await ok(
      put(issueId, [
        { statement: 'A patient can opt out' },
        { statement: 'A nurse sees the reminder' },
        { statement: 'A doctor sees the report' },
      ]),
    );

    const after = await criteriaOf(issueId);
    const doctor = byStatement(after.criteria, 'A doctor sees the report');
    expect(doctor.id).toBe(byStatement(before.criteria, 'A doctor sees the report').id);
    expect(doctor.n).toBe(3);
    expect(doctor.latest).toMatchObject({ verdict: 'pass', commitSha: SHIPPED });
    expect(byStatement(after.criteria, 'A nurse sees the reminder')).toMatchObject({
      id: byStatement(before.criteria, 'A nurse sees the reminder').id,
      n: 2,
    });
    expect(after.retired).toEqual([]);
  });

  it('on a write of the acceptance_criteria text that renumbers it, re-wrapped or not', async () => {
    const issueId = await openIssue();
    await ok(writeText(issueId, '1. A nurse sees the reminder\n2. A doctor sees the report'));
    const doctorId = byStatement(
      (await criteriaOf(issueId)).criteria,
      'A doctor sees the report',
    ).id;
    await judge(issueId, 2, 'pass');

    await ok(writeText(issueId, '1. A doctor sees\n   the report\n2. A nurse sees the reminder'));

    const after = await criteriaOf(issueId);
    expect(after.criteria.map((r) => [r.id === doctorId, r.n])).toEqual([
      [true, 1],
      [false, 2],
    ]);
    expect(after.criteria[0]?.latest?.verdict).toBe('pass');
    expect(after.retired).toEqual([]);
  });

  it('while a reworded criterion is still retired, its verdict kept on the retired row only', async () => {
    const issueId = await openIssue();
    await ok(
      put(issueId, [
        { statement: 'A nurse sees the reminder' },
        { statement: 'A doctor sees the report' },
      ]),
    );
    await judge(issueId, 1, 'pass');

    await ok(
      put(issueId, [
        { statement: 'A doctor sees the report' },
        { statement: 'A nurse sees the reminder within a minute' },
      ]),
    );

    const after = await criteriaOf(issueId);
    expect(
      byStatement(after.criteria, 'A nurse sees the reminder within a minute').latest,
    ).toBeNull();
    expect(after.retired).toHaveLength(1);
    expect(after.retired[0]).toMatchObject({
      statement: 'A nurse sees the reminder',
      verdicts: [{ verdict: 'pass' }],
    });
  });

  it('two criteria that swap numbers each keep their own row and verdict', async () => {
    const issueId = await openIssue();
    await ok(
      put(issueId, [
        { statement: 'A nurse sees the reminder' },
        { statement: 'A doctor sees the report' },
      ]),
    );
    const before = await criteriaOf(issueId);
    await judge(issueId, 1, 'pass');
    await judge(issueId, 2, 'fail');

    await ok(
      put(issueId, [
        { statement: 'A doctor sees the report' },
        { statement: 'A nurse sees the reminder' },
      ]),
    );

    const after = await criteriaOf(issueId);
    expect(after.criteria.map((r) => [r.n, r.statement, r.latest?.verdict])).toEqual([
      [1, 'A doctor sees the report', 'fail'],
      [2, 'A nurse sees the reminder', 'pass'],
    ]);
    expect(after.criteria.map((r) => r.id)).toEqual(
      [...before.criteria].reverse().map((r) => r.id),
    );
    expect(after.retired).toEqual([]);
  });

  it('refuses a repeated wording that would have to move, writing nothing', async () => {
    const issueId = await openIssue();
    await ok(
      put(issueId, [
        { statement: 'A nurse sees the reminder' },
        { statement: 'A doctor sees the report' },
      ]),
    );
    const before = await criteriaOf(issueId);
    await judge(issueId, 1, 'pass');

    const twice = await put(issueId, [
      { statement: 'A doctor sees the report' },
      { statement: 'A nurse sees the reminder' },
      { statement: 'A nurse sees the reminder' },
    ]);
    const viaText = await writeText(
      issueId,
      '1. A doctor sees the report\n2. A nurse sees the reminder\n3. A nurse sees the reminder',
    );

    for (const r of [twice, viaText]) {
      expect(refusalOf(r.body)).toMatchObject({
        code: 'CRITERIA_RENUMBER_AMBIGUOUS',
        detail: expect.stringContaining('criteria 2 and 3'),
      });
    }
    const after = await criteriaOf(issueId);
    expect(after.criteria.map((r) => [r.id, r.n, r.latest?.verdict ?? null])).toEqual(
      before.criteria.map((r, i) => [r.id, r.n, i === 0 ? 'pass' : null]),
    );
    expect(after.retired).toEqual([]);
  });

  it('keeps a repeated wording that stays at its own numbers', async () => {
    const issueId = await openIssue();
    await ok(
      put(issueId, [
        { statement: 'A nurse sees the reminder' },
        { statement: 'A nurse sees the reminder' },
      ]),
    );
    const before = await criteriaOf(issueId);
    await judge(issueId, 2, 'pass');

    await ok(
      put(issueId, [
        { statement: 'A nurse sees the reminder' },
        { statement: 'A nurse sees the reminder' },
        { statement: 'A doctor sees the report' },
      ]),
    );

    const after = await criteriaOf(issueId);
    expect(after.criteria.slice(0, 2).map((r) => r.id)).toEqual(before.criteria.map((r) => r.id));
    expect(after.criteria[1]?.latest?.verdict).toBe('pass');
  });
});

describe('a renumbered criterion keeps its trace, and coverage keeps counting its verdict', () => {
  async function agreedRequirement(): Promise<string> {
    const created = await ok(
      api(token, 'POST', `/api/projects/${projectId}/requirements`, {
        title: 'Reminders',
        reason: 'planted',
        criteria: [{ body: 'A nurse sees the reminder' }, { body: 'A doctor sees the report' }],
      }),
    );
    const key = String(created.key);
    await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
    for (const [path, body] of [
      [`/requirements/${key}/revisions/1/propose`, {}],
      [`/requirements/${key}/revisions/1/accept`, {}],
      [
        `/requirements/${key}/agree`,
        { revision: 1, reason: 'Agreed with the owner for this test.' },
      ],
    ] as const) {
      await ok(api(token, 'POST', `/api/projects/${projectId}${path}`, body));
    }
    return key;
  }

  async function coverageOf(req: string, code: string) {
    const d = (await ok(api(token, 'GET', `/api/projects/${projectId}/requirements/${req}`))) as {
      standing: {
        coverage: Array<{
          code: string;
          verdict: string;
          counts: { criterion: number; verdict: string } | null;
        }>;
      };
    };
    return d.standing.coverage.find((c) => c.code === code);
  }

  for (const door of ['text', 'put'] as const) {
    it(`through the ${door === 'text' ? 'acceptance_criteria text' : 'PUT'} door`, async () => {
      const req = await agreedRequirement();
      const issueId = await openIssue();
      await ok(
        api(token, 'POST', `/api/projects/${projectId}/requirements/${req}/issues`, {
          issue: 'ISS-1',
        }),
      );
      await ok(api(token, 'POST', `/api/issues/${issueId}/criteria/traces`, { codes: ['BC-1'] }));
      const [traced] = (await criteriaOf(issueId)).criteria;
      expect(traced?.requirementCriterionId).not.toBeNull();
      await judge(issueId, 1, 'pass');
      expect(await coverageOf(req, 'BC-1')).toMatchObject({
        verdict: 'passing',
        counts: { criterion: 1, verdict: 'pass' },
      });

      const statement = String(traced?.statement);
      if (door === 'text') {
        await ok(writeText(issueId, `1. The reminder is sent on time\n2. ${statement}`));
      } else {
        await ok(put(issueId, [{ statement: 'The reminder is sent on time' }, { statement }]));
      }

      const after = await criteriaOf(issueId);
      expect(after.criteria[1]).toMatchObject({
        id: traced?.id,
        n: 2,
        requirementCriterionId: traced?.requirementCriterionId,
        latest: { verdict: 'pass' },
      });
      expect(after.retired).toEqual([]);
      expect(await coverageOf(req, 'BC-1')).toMatchObject({
        verdict: 'passing',
        counts: { criterion: 2, verdict: 'pass' },
      });
    });
  }
});
