/**
 * What counts as verified in a requirement's k/n (REQ-35 decision 7b261fca): only a pass from
 * someone other than the builder. BC-9 read passing on the ISS-463 builder's own verdicts alone, one
 * short and one pass, though the project runs independent QA. A short never counts and masks
 * nothing; under independent QA the builder's own pass does not count either, while its fail does.
 * Who built the issue is who `review.ts:buildersOf` names for a review — a run session that recorded
 * a check on it or holds its lease, live on the box the verdict came from when it was recorded, or an
 * account that recorded a check from no box (`issues/built-by.ts`). Through the app's own routes,
 * against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/built-by.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { DEFAULT_POLICY } from '../../src/project-config/default-policy.js';
import { api, userToken } from '../helpers/api.js';
import {
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestRunSession,
  createTestUser,
  makeAgreeReady,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const NEW = '2222222222222222222222222222222222222222';
const LIVE = '9999999999999999999999999999999999999999';
const BUILT = '2026-10-04T10:00:00Z';
const BUILDER_WHY = "passed by the run that built it, and a builder's own pass never counts";

let projectId: string;
let ownerId: string;
let token: string;
let box: string;
let unplant: (() => void) | null = null;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (
    await createTestProject(ownerId, { policy: { ...DEFAULT_POLICY, qa: 'independent' } })
  ).id;
  token = await userToken(ownerId);
  box = await createTestDevice(ownerId);
  unplant = plantLiveBuild(LIVE, { [NEW]: true });
});

afterEach(() => {
  unplant?.();
  unplant = null;
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
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  await ok(onProject('POST', `/requirements/${key}/revisions/1/propose`, {}));
  await ok(onProject('POST', `/requirements/${key}/revisions/1/accept`, {}));
  await ok(
    onProject('POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    }),
  );
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

/** A verdict on criterion `n` of `issueId` at NEW, recorded at `at`, from `device` where one is named. */
async function judge(
  issueId: string,
  n: number,
  verdict: 'pass' | 'short' | 'fail',
  at: string,
  device: string | null = null,
) {
  const r = await ok(
    api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
      criterion: n,
      verdict,
      reason: `${verdict} on the running build`,
      identity: { kind: 'commit', sha: NEW },
      evidence: ['shot.png'],
    }),
  );
  await db.execute(
    sql`UPDATE criterion_verdicts SET created_at = ${at}, author_device_id = ${device} WHERE id = ${r.verdictId}`,
  );
  return String(r.verdictId);
}

/** A run session on `device` from BUILT, ended at `ended` or still running. */
async function runOn(device: string, ended: string | null = null): Promise<string> {
  const runId = await createTestRunSession(
    projectId,
    device,
    new Date(BUILT),
    ended ? new Date(ended) : null,
  );
  const [s] = await rows<{ id: string }>(
    sql`SELECT id FROM agent_sessions WHERE pipeline_run_id = ${runId}`,
  );
  if (!s) throw new Error('no run session seeded');
  // a session keeps no end time of its own: its last update is when it ended
  if (ended) {
    await db.execute(sql`UPDATE agent_sessions SET updated_at = ${ended} WHERE id = ${s.id}`);
  }
  return s.id;
}

/** A timed check on `issueId`, by a run (`session`) or an account from no box; a review is the judge's. */
async function checked(issueId: string, session: string | null, kind = 'tests') {
  await db.execute(sql`
    INSERT INTO issue_check_runs (id, issue_id, kind, name, scope, command, result, duration_ms,
                                  started_at, head_sha, run_session_id, via, recorded_by)
    VALUES (${randomUUID()}, ${issueId}, ${kind}, 'unit', 'core', 'pnpm test', 'pass', 1000,
            ${BUILT}, ${NEW}, ${session}, 'report', ${ownerId})`);
}

type Bc = {
  code: string;
  verdict: string;
  issues: { notCounted: string | null }[];
  why: string | null;
  counts: { displayId: string; verdict: string } | null;
};

async function standingOf(req: string) {
  const d = (await ok(onProject('GET', `/requirements/${req}`))) as {
    standing: { coverage: Bc[]; facts: { criteria: number; passing: number; judged: number } };
  };
  return d.standing;
}
const bc = async (req: string, code: string) =>
  (await standingOf(req)).coverage.find((c) => c.code === code) as Bc;

describe('a short is not verified', () => {
  it('a short alone reads not judged, saying why, and counts for nothing in k/n', async () => {
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1']);
    await judge(issue, 1, 'short', '2026-10-05T10:00:00Z', await createTestDevice(ownerId));

    const one = await bc(req, 'BC-1');

    expect(one).toMatchObject({ verdict: 'not_judged', counts: null });
    expect(one.why).toBe(
      'no verdict counts yet: ISS-1 criterion 1: judged short: met short of its wording, and only a pass counts as verified',
    );
    expect((await standingOf(req)).facts).toMatchObject({ criteria: 2, passing: 0, judged: 0 });
  });

  it('a newer short masks nothing: an older fail still stands', async () => {
    const req = await agreedRequirement();
    const a = await closedIssueTracing(req, 1, ['BC-1']);
    const b = await closedIssueTracing(req, 2, ['BC-1']);
    await judge(a, 1, 'fail', '2026-10-01T10:00:00Z');
    await judge(b, 1, 'short', '2026-10-05T10:00:00Z');

    expect(await bc(req, 'BC-1')).toMatchObject({
      verdict: 'failing',
      counts: { displayId: 'ISS-1', verdict: 'fail' },
    });
  });
});

describe("the builder's own pass is not verified", () => {
  it('a pass sent from the box while the run that checked the issue was live there does not count', async () => {
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1']);
    await checked(issue, await runOn(box));
    await judge(issue, 1, 'pass', '2026-10-05T10:00:00Z', box);

    const one = await bc(req, 'BC-1');

    expect(one).toMatchObject({ verdict: 'not_judged', counts: null });
    expect(one.issues[0]?.notCounted).toBe(BUILDER_WHY);
    expect((await standingOf(req)).facts).toMatchObject({ criteria: 2, passing: 0, judged: 0 });
  });

  it('a pass from the box of the run holding the lease does not count either', async () => {
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1']);
    const session = await runOn(box);
    await db.execute(sql`
      INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
      SELECT ${projectId}, 'ISS-1', ${box}, id, pipeline_run_id FROM agent_sessions WHERE id = ${session}`);
    await judge(issue, 1, 'pass', '2026-10-05T10:00:00Z', box);

    expect(await bc(req, 'BC-1')).toMatchObject({ verdict: 'not_judged', counts: null });
  });

  it('a pass from no box by the account that recorded checks from no box does not count', async () => {
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1']);
    await checked(issue, null);
    await judge(issue, 1, 'pass', '2026-10-05T10:00:00Z');

    expect(await bc(req, 'BC-1')).toMatchObject({ verdict: 'not_judged', counts: null });
  });

  it('a pass from another box, or from the same box once the building run ended there, counts', async () => {
    const req = await agreedRequirement();
    const a = await closedIssueTracing(req, 1, ['BC-1']);
    const b = await closedIssueTracing(req, 2, ['BC-2']);
    await checked(a, await runOn(box));
    await checked(b, await runOn(box, '2026-10-04T12:00:00Z'));
    await judge(a, 1, 'pass', '2026-10-05T10:00:00Z', await createTestDevice(ownerId));
    await judge(b, 1, 'pass', '2026-10-05T10:00:00Z', box);

    expect(await bc(req, 'BC-1')).toMatchObject({
      verdict: 'passing',
      counts: { displayId: 'ISS-1' },
    });
    expect(await bc(req, 'BC-2')).toMatchObject({
      verdict: 'passing',
      counts: { displayId: 'ISS-2' },
    });
    expect((await standingOf(req)).facts).toMatchObject({ criteria: 2, passing: 2, judged: 2 });
  });

  it('a pass from the box of a run that only reviewed the issue counts: a review is the judge, not a build', async () => {
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1']);
    await checked(issue, await runOn(box), 'review');
    await judge(issue, 1, 'pass', '2026-10-05T10:00:00Z', box);

    expect(await bc(req, 'BC-1')).toMatchObject({ verdict: 'passing' });
  });

  it("the builder's own fail counts: it is evidence the criterion does not hold", async () => {
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1']);
    await checked(issue, await runOn(box));
    await judge(issue, 1, 'fail', '2026-10-05T10:00:00Z', box);

    expect(await bc(req, 'BC-1')).toMatchObject({
      verdict: 'failing',
      counts: { displayId: 'ISS-1', verdict: 'fail' },
    });
  });

  it("the accept is refused on the builder's own passes, naming the criteria and why", async () => {
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1', 'BC-2']);
    await checked(issue, await runOn(box));
    await judge(issue, 1, 'pass', '2026-10-05T10:00:00Z', box);
    await judge(issue, 2, 'pass', '2026-10-05T10:00:00Z', box);

    const refused = await onProject('POST', `/requirements/${req}/accept`, { revision: 1 });

    expect(refused.status).toBe(422);
    const detail = JSON.stringify(refused.body);
    expect(detail).toContain('CHECKLIST_INCOMPLETE');
    expect(detail).toContain('BC-1 (not judged');
    expect(detail).toContain('passed by the run that built it');
  });

  it('under self QA the same builder pass does not count either (REQ-74 BC-2)', async () => {
    projectId = (await createTestProject(ownerId)).id;
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1']);
    await checked(issue, await runOn(box));
    await judge(issue, 1, 'pass', '2026-10-05T10:00:00Z', box);

    expect(await bc(req, 'BC-1')).toMatchObject({ verdict: 'not_judged' });
  });
});

// Coverage read only each issue criterion's newest verdict, so a builder pass recorded after the
// judge's pass hid it and the criterion read not judged; the history is read now
describe("a newer verdict that is not the judge's does not hide the judge's", () => {
  it("the builder's pass after the judge's pass on the same criterion leaves the judge's counted", async () => {
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1']);
    await checked(issue, await runOn(box));
    await judge(issue, 1, 'pass', '2026-10-05T08:00:00Z', await createTestDevice(ownerId));
    await judge(issue, 1, 'pass', '2026-10-05T10:00:00Z', box);

    expect(await bc(req, 'BC-1')).toMatchObject({
      verdict: 'passing',
      counts: { displayId: 'ISS-1', verdict: 'pass', at: '2026-10-05T08:00:00.000Z' },
    });
  });

  it("the builder's fail after the judge's pass counts: a fail is everyone's", async () => {
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1']);
    await checked(issue, await runOn(box));
    await judge(issue, 1, 'pass', '2026-10-05T08:00:00Z', await createTestDevice(ownerId));
    await judge(issue, 1, 'fail', '2026-10-05T10:00:00Z', box);

    expect(await bc(req, 'BC-1')).toMatchObject({
      verdict: 'failing',
      counts: { verdict: 'fail', at: '2026-10-05T10:00:00.000Z' },
    });
  });
});

describe('a pass that names no author', () => {
  it('does not count under independent QA, and its line says why', async () => {
    const req = await agreedRequirement();
    const issue = await closedIssueTracing(req, 1, ['BC-1']);
    const id = await judge(issue, 1, 'pass', '2026-10-05T10:00:00Z');
    await db.execute(sql`UPDATE criterion_verdicts SET author_user_id = NULL WHERE id = ${id}`);

    const one = await bc(req, 'BC-1');

    expect(one).toMatchObject({ verdict: 'not_judged', counts: null });
    expect(one.issues[0]?.notCounted).toBe(
      "passed with no recorded author, so nothing shows it is the independent judge's",
    );
  });
});
