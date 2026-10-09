/**
 * A business criterion's coverage is the newest verdict across every issue criterion tracing its
 * current wording (requirement-lifecycle `delivered`: "traced by an issue criterion whose latest
 * verdict on the running build is a pass"), not a vote every tracing row must win: a row nobody
 * judged does not mask a judged newer one, and an old fail stands only while it is the newest. Each
 * BC names the verdict that counts. A trace left on a reworded BC's earlier wording is refreshed to
 * the current wording from the issue's Criteria tab by the same tie act, matched by wording as
 * coverage matches it; the verdict the old wording earned stays on its retired row and does not
 * count for the new wording until it is judged again. Through the app's own routes, against real
 * Postgres.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';

const OLD = '1111111111111111111111111111111111111111';
const NEW = '2222222222222222222222222222222222222222';

let projectId: string;
let ownerId: string;
let token: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
});

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

async function ok(r: Promise<{ status: number; body: Record<string, unknown> }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

async function agreedRequirement(): Promise<string> {
  const created = await ok(
    onProject('POST', '/requirements', {
      title: 'Reminders',
      reason: 'planted',
      criteria: [{ body: 'A nurse sees the reminder' }, { body: 'A doctor sees the report' }],
    }),
  );
  const key = String(created.key);
  await ok(onProject('POST', `/requirements/${key}/revisions/1/propose`, {}));
  await ok(onProject('POST', `/requirements/${key}/revisions/1/accept`, {}));
  await ok(onProject('POST', `/requirements/${key}/agree`, { revision: 1 }));
  return key;
}

/** A closed issue delivering `req`, tied to `codes` through the Criteria tab's act. */
async function closedIssueTracing(req: string, seq: number, codes: string[]): Promise<string> {
  const { id } = await createTestIssue(projectId, ownerId, seq, {
    status: 'closed',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  await ok(onProject('POST', `/requirements/${req}/issues`, { issue: `ISS-${seq}` }));
  await ok(api(token, 'POST', `/api/issues/${id}/criteria/traces`, { codes }));
  return id;
}

/** A verdict on criterion `n` of `issueId` at `commit`, recorded as judged at `at`. */
async function judge(
  issueId: string,
  n: number,
  verdict: 'pass' | 'short' | 'fail',
  commit: string,
  at: string,
) {
  const r = await ok(
    api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
      criterion: n,
      verdict,
      reason: `${verdict} on the running build`,
      identity: { kind: 'commit', sha: commit },
      evidence: ['shot.png'],
    }),
  );
  await db.execute(sql`UPDATE criterion_verdicts SET created_at = ${at} WHERE id = ${r.verdictId}`);
}

type Link = { displayId: string; criterion: number; verdict: string | null; stale: boolean };
type Bc = {
  code: string;
  body: string;
  verdict: string;
  issues: Link[];
  counts: {
    displayId: string;
    criterion: number;
    verdict: string;
    at: string;
    commit: string | null;
  } | null;
};

async function standingOf(req: string) {
  const d = (await ok(onProject('GET', `/requirements/${req}`))) as {
    standing: { coverage: Bc[]; facts: { criteria: number; passing: number; judged: number } };
  };
  return d.standing;
}
const bc = async (req: string, code: string) =>
  (await standingOf(req)).coverage.find((c) => c.code === code) as Bc;

describe('the newest verdict across the rows tracing a BC is the one that counts', () => {
  it('an older fail on one issue and an unjudged row on another do not outvote a newer pass', async () => {
    const req = await agreedRequirement();
    const older = await closedIssueTracing(req, 1, ['BC-1']);
    const newer = await closedIssueTracing(req, 2, ['BC-1']);
    await closedIssueTracing(req, 3, ['BC-1']);
    await judge(older, 1, 'fail', OLD, '2026-10-01T10:00:00Z');
    await judge(newer, 1, 'pass', NEW, '2026-10-05T10:00:00Z');

    const one = await bc(req, 'BC-1');

    expect(one.issues).toHaveLength(3);
    expect(one.verdict).toBe('passing');
    expect(one.counts).toEqual({
      issueId: newer,
      displayId: 'ISS-2',
      criterion: 1,
      verdict: 'pass',
      at: '2026-10-05T10:00:00.000Z',
      commit: NEW,
      inLiveBuild: null,
    });
    expect((await standingOf(req)).facts).toMatchObject({ criteria: 2, passing: 1, judged: 1 });
  });

  it('a newer fail stands while it is the newest, and a later pass then counts again', async () => {
    const req = await agreedRequirement();
    const a = await closedIssueTracing(req, 1, ['BC-1']);
    const b = await closedIssueTracing(req, 2, ['BC-1']);
    await judge(a, 1, 'pass', OLD, '2026-10-01T10:00:00Z');
    await judge(b, 1, 'fail', NEW, '2026-10-05T10:00:00Z');

    expect(await bc(req, 'BC-1')).toMatchObject({
      verdict: 'failing',
      counts: { displayId: 'ISS-2', verdict: 'fail' },
    });

    await judge(a, 1, 'short', NEW, '2026-10-07T10:00:00Z');

    expect(await bc(req, 'BC-1')).toMatchObject({
      verdict: 'passing',
      counts: { displayId: 'ISS-1', verdict: 'short', commit: NEW },
    });
  });

  it('a BC traced only by rows nobody judged reads not judged, naming no verdict', async () => {
    const req = await agreedRequirement();
    await closedIssueTracing(req, 1, ['BC-2']);

    expect(await bc(req, 'BC-2')).toMatchObject({ verdict: 'not_judged', counts: null });
  });
});

describe('a trace left on a reworded BC is refreshed to the current wording', () => {
  async function reword(req: string) {
    await ok(
      onProject('POST', `/requirements/${req}/revisions`, {
        baseRevision: 1,
        reason: 'BC-1 reworded',
        criteria: [
          { code: 'BC-1', body: 'A nurse sees the reminder before the round' },
          { code: 'BC-2', body: 'A doctor sees the report' },
        ],
      }),
    );
    await ok(onProject('POST', `/requirements/${req}/revisions/2/propose`, {}));
    await ok(onProject('POST', `/requirements/${req}/revisions/2/accept`, { reason: 'ok' }));
  }

  it('the tie act refreshes the stale trace; the old verdict stays on its retired row and counts only once judged again', async () => {
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1']);
    await judge(issue, 1, 'pass', OLD, '2026-10-01T10:00:00Z');
    await reword(req);
    expect(await bc(req, 'BC-1')).toMatchObject({ verdict: 'stale', counts: null });

    const tied = await api(token, 'POST', `/api/issues/${issue}/criteria/traces`, {
      codes: ['BC-1'],
    });

    expect(tied.status, JSON.stringify(tied.body)).toBe(201);
    const rows = (tied.body as { criteria: Array<Record<string, unknown>> }).criteria;
    expect(rows).toEqual([
      expect.objectContaining({
        n: 1,
        statement: `(${req} BC-1) A nurse sees the reminder before the round`,
        latest: null,
      }),
    ]);
    const kept = [
      ...(await db.execute(sql`
        SELECT c.retired_at IS NOT NULL AS retired, v.verdict
          FROM criterion_verdicts v JOIN issue_criteria c ON c.id = v.criterion_id
         WHERE v.issue_id = ${issue}`)),
    ];
    expect(kept).toEqual([{ retired: true, verdict: 'pass' }]);
    const refreshed = await bc(req, 'BC-1');
    expect(refreshed.verdict).toBe('not_judged');
    expect(refreshed.issues).toEqual([
      expect.objectContaining({ displayId: 'ISS-1', criterion: 1, verdict: null, stale: false }),
    ]);

    await judge(issue, 1, 'pass', NEW, '2026-10-06T10:00:00Z');

    expect(await bc(req, 'BC-1')).toMatchObject({
      verdict: 'passing',
      counts: { displayId: 'ISS-1', commit: NEW },
    });
  });

  it('tying a BC the issue already traces at its current wording is refused, naming the criterion', async () => {
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1']);
    await reword(req);
    expect(
      (await api(token, 'POST', `/api/issues/${issue}/criteria/traces`, { codes: ['BC-1'] }))
        .status,
    ).toBe(201);

    const again = await api(token, 'POST', `/api/issues/${issue}/criteria/traces`, {
      codes: ['BC-1'],
    });

    expect(again.status).toBe(422);
    expect(JSON.stringify(again.body)).toContain('CRITERIA_TRACE_DUPLICATE');
    expect(JSON.stringify(again.body)).toContain('already traced by criterion 1');
  });
});
