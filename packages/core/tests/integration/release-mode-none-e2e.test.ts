/**
 * Release mode `none`: a project whose document declares a branch work lands on and no production
 * environment. Landing there IS the delivery (owner ruling 2026-10-22), so before this change an issue
 * at `awaiting_release` could never close: `closed` asks a release that claimed it, and the record door
 * refused `NO_RELEASE_GATE`. Planted from adminhub-api ISS-5, which landed on `release/stg` as merge
 * `f4e5fb6` (of the pre-merge head `d9fd508`) and was judged pass on all three criteria at `f4e5fb6`.
 *
 * One definition of what counts as the running build there (`release-batch/landed-build.ts`) is read
 * by the record that closes the issue, the steward's output check and a requirement's coverage, and
 * each is driven here through its own door against real Postgres. Ancestry is answered by a planted
 * reader from the real history, standing in for the box that reads the bare repository.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { makeAgreeReady } from '../helpers/factories.js';
import {
  ASIDE,
  BRANCH,
  D9,
  F4,
  judgedAll,
  LATER,
  landedIssue,
  ok,
  readingsOf,
  record,
  refusalsOf,
  seedLandedWorld,
  statusOf,
  verdict,
  world,
} from '../helpers/landed-world.js';
import { seedProduction } from '../helpers/release-world.js';

vi.mock('../../src/release-batch/shipped-earlier.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/shipped-earlier.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

let projectId: string;
let ownerId: string;
let token: string;

beforeEach(async () => {
  await seedLandedWorld();
  ({ projectId, ownerId, token } = world);
});

describe('a landing is recorded as the release of a project with no production environment', () => {
  it('closes ISS-5 at the landed head, recording the branch and commit and that nothing deployed', async () => {
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, F4);

    const res = await record([issue], F4);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      verification: 'landed',
      branch: BRANCH,
      commit: F4,
      closed: [issue],
      failed: [],
    });
    expect(await statusOf(issue)).toBe('closed');

    const runId = String(res.body.runId);
    const read = await ok(api(token, 'GET', `/api/projects/${projectId}/release-records/${runId}`));
    expect(read).toMatchObject({ verification: 'landed', branch: BRANCH, commit: F4 });

    const list = await ok(api(token, 'GET', `/api/projects/${projectId}/releases`));
    // a landing that took a version is a release on the list, never listed a second time beside it
    expect(list.landings).toEqual([]);
    // catalog-api run 9ed968de, 2026-10-26: a recorded landing is a release like any other
    expect(res.body.version).toBe('0.1.0');
    // a landing on release/stg is not production: it reads landed there (owner, 2026-10-26)
    expect(list.releases).toMatchObject([{ version: '0.1.0', state: 'landed', landedOn: BRANCH }]);

    const detail = await ok(api(token, 'GET', `/api/issues/${issue}`));
    expect(detail.landedIn).toEqual({ branch: BRANCH, commit: F4, at: expect.any(String) });
    expect(detail.shippedIn).toEqual({ version: '0.1.0', at: expect.any(String) });

    const [note] = (await db.execute(sql`
      SELECT body FROM comments WHERE issue_id = ${issue} AND body LIKE 'Landed on%'
    `)) as unknown as Array<{ body: string }>;
    expect(note?.body).toContain(`Landed on \`${BRANCH}\` at \`${F4}\` — no environment.`);
    expect(note?.body).not.toMatch(/deployed to|serving/);
  });

  // catalog-api, 2026-10-26: release 0.1.0 shipped through its change requests, then a landing
  // recorded as run 9ed968de took no version: GET /releases/0.2.0 answered 404 and the naming door
  // could not name it
  it('gives a recorded landing the next version, which its page reads and the naming door names', async () => {
    await db.execute(sql`
      INSERT INTO pipeline_runs (project_id, kind, status, metadata, release_version, release_released_at, finished_at)
      VALUES (${projectId}, 'system', 'completed',
              ${JSON.stringify({ source: 'release-batch', issueIds: [], changeRequests: [] })}::jsonb,
              '0.1.0', now() - interval '1 hour', now() - interval '1 hour')`);
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, F4);

    const res = await record([issue], F4);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.version).toBe('0.2.0');

    const page = await api(token, 'GET', `/api/projects/${projectId}/releases/0.2.0`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    const named = await api(token, 'PUT', `/api/projects/${projectId}/releases/0.2.0/naming`, {
      name: 'Triển khai lên cửa hàng ePOD',
      summary: 'The store receives the release. Drivers see the new delivery screens.',
    });
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    expect(named.body).toMatchObject({ version: '0.2.0', state: 'cut', runId: res.body.runId });
  });

  it("closes on the box's claim, as adminhub-api re-marked ISS-5: no observed merge, paths read at the sha", async () => {
    const issue = await landedIssue(5, null, undefined, {
      commit: F4,
      note: 'Merged into release/stg as f4e5fb6.',
      changedPaths: { commit: F4, changes: [{ path: 'src/db/setup.ts', change: 'changed' }] },
    });
    await judgedAll(issue, F4);
    const marked = await ok(api(token, 'GET', `/api/issues/${issue}`));
    expect(marked).toMatchObject({
      mergedTarget: BRANCH,
      mergedCommitSha: null,
      mergedPaths: { commit: F4 },
    });

    const res = await record([issue], F4);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ verification: 'landed', commit: F4, closed: [issue] });
    expect(await statusOf(issue)).toBe('closed');
  });

  // REQ-45 BC-11, BC-14: a landing that happened is recorded; its verdicts are read beside it
  it('records a landing whose passes stand at a later head, saying the commit does not hold them', async () => {
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, LATER);

    const atMerge = await record([issue], F4);

    expect(atMerge.status, JSON.stringify(atMerge.body)).toBe(201);
    expect(readingsOf(atMerge.body)).toContain(
      `ISS-5: 3 live criteria, c1-3 no pass: it was judged at \`${LATER.slice(0, 12)}\`, which \`${F4.slice(0, 12)}\` does not hold`,
    );
    expect(await statusOf(issue)).toBe('closed');
  });

  it('records a landing judged only at the pre-merge head d9fd508, reading it as an earlier commit', async () => {
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, D9);

    const res = await record([issue], F4);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(readingsOf(res.body)).toContain(
      `ISS-5: 3 live criteria, c1-3 pass at \`${D9.slice(0, 12)}\`, which \`${F4.slice(0, 12)}\` holds`,
    );
    expect(await statusOf(issue)).toBe('closed');
  });

  it('records a landing over a fail at the landed head, naming the criterion beside it', async () => {
    const issue = await landedIssue(5, F4);
    await verdict(issue, 1, 'pass', F4);
    await verdict(issue, 2, 'fail', F4);
    await verdict(issue, 3, 'pass', F4);

    const res = await record([issue], F4);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(readingsOf(res.body)[0]).toBe('Shipped with 1 failing criterion: ISS-5 c2');
    expect(readingsOf(res.body)).toContain(
      `ISS-5: 3 live criteria, c1, c3 pass at \`${F4.slice(0, 12)}\`; c2 failed at \`${F4.slice(0, 12)}\``,
    );
    expect(res.body.shippedFailing).toMatchObject({
      count: 1,
      criteria: [{ issueId: issue, issueKey: 'ISS-5', criterion: 2 }],
    });
    expect(await statusOf(issue)).toBe('closed');
    // the release says it whole, on its list and its page, as the follow-up's evidence
    const list = await ok(api(token, 'GET', `/api/projects/${projectId}/releases`));
    expect(list.releases).toMatchObject([
      {
        version: '0.1.0',
        shippedFailing: { count: 1, sentence: 'Shipped with 1 failing criterion: ISS-5 c2' },
      },
    ]);
  });

  it('refuses a merge commit that is not in the recorded commit', async () => {
    const issue = await landedIssue(5, ASIDE);
    await judgedAll(issue, F4);

    const res = await record([issue], F4);

    expect(res.status).toBe(422);
    const refusals = refusalsOf(res.body);
    expect(refusals.map((r) => r.code)).toEqual(['RELEASE_LANDING_NOT_IN_COMMIT']);
    expect(refusals[0]?.detail).toContain(`merge mark names \`${ASIDE.slice(0, 12)}\``);
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('refuses an issue whose merge records no commit, as ISS-5 stood on 2026-10-22', async () => {
    const issue = await landedIssue(5, null);
    await judgedAll(issue, F4);

    const res = await record([issue], F4);

    expect(res.status).toBe(422);
    const refusals = refusalsOf(res.body);
    expect(refusals.map((r) => r.code)).toEqual(['RELEASE_LANDING_UNRECORDED']);
    expect(refusals[0]?.detail).toContain("ISS-5's merge records no commit");
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('refuses a commit that is not a whole sha', async () => {
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, F4);

    const res = await record([issue], F4.slice(0, 7));

    expect(res.status).toBe(422);
    expect(refusalsOf(res.body)[0]?.code).toBe('RELEASE_LANDING_COMMIT_SHAPE');
  });

  it('names the record door where a release batch is refused NO_RELEASE_GATE', async () => {
    const readiness = await ok(api(token, 'GET', `/api/projects/${projectId}/release-readiness`));
    const blockers = readiness.blockers as Array<{ code: string; message: string }>;
    expect(blockers[0]?.code).toBe('NO_RELEASE_GATE');
    expect(blockers[0]?.message).toContain('POST /api/projects/:id/release-records');
  });

  it('defaults a verdict to the landed build', async () => {
    const issue = await landedIssue(5, F4);

    const build = await ok(api(token, 'GET', `/api/issues/${issue}/judged-build`));

    expect(build).toMatchObject({ sha: F4, source: 'landed', version: null });
  });
});

// catalog-fe run c7bdb9b9, 2026-10-26 04:57Z: 9 issues landed on `dev` at f44ff116 and recorded
// before a recorded landing cut a version (2207abfeb); 855e79d1 at 07:26Z then took 0.1.0. The row
// claimed no number then, and no number allocated now would be the one it was recorded under, so it
// is listed as what it is: a landing recorded before versioning.
describe('a landing recorded before Forge versioned recorded landings', () => {
  async function legacyLanding(
    seq: number,
    status: 'completed' | 'failed',
    at: string,
  ): Promise<string> {
    const issueId = randomUUID();
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
      VALUES (${issueId}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'closed', ${ownerId}, ${at}::timestamptz)
    `);
    const [row] = (await db.execute(sql`
      INSERT INTO pipeline_runs (project_id, kind, status, started_at, finished_at, metadata)
      VALUES (${projectId}, 'system', ${status}, ${at}::timestamptz, ${at}::timestamptz,
              ${JSON.stringify({
                source: 'release-record',
                gateStatus: 'awaiting_release',
                issueIds: [issueId],
                commit: F4,
                branch: BRANCH,
                identity: F4,
                verification: 'landed',
                providerRef: null,
                recordedBy: ownerId,
                issues: [],
              })}::jsonb)
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    return row?.id ?? '';
  }

  it('lists it as unversioned beside the releases, and the next landing still takes 0.1.0', async () => {
    const closedAll = await legacyLanding(1, 'completed', '2026-10-22T13:48:10Z');
    const incomplete = await legacyLanding(2, 'failed', '2026-10-26T04:57:01Z');
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, F4);

    const res = await record([issue], F4);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // a row recorded with no version claimed none, so the line starts where it would have
    expect(res.body.version).toBe('0.1.0');

    const list = await ok(api(token, 'GET', `/api/projects/${projectId}/releases`));
    expect(list.releases).toMatchObject([{ version: '0.1.0', state: 'landed' }]);
    expect(list.landings).toEqual([
      {
        runId: incomplete,
        branch: BRANCH,
        commit: F4,
        at: '2026-10-26T04:57:01.000Z',
        issues: ['ISS-2'],
        closedAll: false,
      },
      {
        runId: closedAll,
        branch: BRANCH,
        commit: F4,
        at: '2026-10-22T13:48:10.000Z',
        issues: ['ISS-1'],
        closedAll: true,
      },
    ]);
    const [unversioned] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pipeline_runs
       WHERE project_id = ${projectId} AND release_version IS NULL
    `)) as unknown as Array<{ n: number }>;
    // nothing versions a row recorded before versioning: the two stay as they were recorded
    expect(unversioned?.n).toBe(2);
  });

  it('still lists it once the project declares a production environment', async () => {
    const runId = await legacyLanding(1, 'completed', '2026-10-22T13:48:10Z');
    await seedProduction({ projectId, ownerId, probes: 'none' });

    const list = await ok(api(token, 'GET', `/api/projects/${projectId}/releases`));
    expect(list.landings).toMatchObject([{ runId, issues: ['ISS-1'], closedAll: true }]);
  });
});

describe('a project with a production environment records as it did', () => {
  it('reads the deployment record, never the landing', async () => {
    await seedProduction({ projectId, ownerId, probes: 'none' });
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, F4);

    const res = await record([issue], F4);

    expect(res.status).toBe(422);
    const codes = refusalsOf(res.body).map((r) => r.code);
    expect(codes).toEqual(['RELEASE_NOT_VERIFIED']);
    expect(await statusOf(issue)).toBe('awaiting_release');
  });
});

describe("a requirement's coverage counts a verdict on its issue's landing", () => {
  const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    api(token, method, `/api/projects/${projectId}${path}`, body);

  async function agreedRequirement(): Promise<string> {
    const created = await ok(
      onProject('POST', '/requirements', {
        title: 'Local test databases',
        reason: 'planted',
        criteria: [{ body: 'One command builds the local test databases' }],
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

  async function tracing(req: string, issue: string, seq: number) {
    await ok(onProject('POST', `/requirements/${req}/issues`, { issue: `ISS-${seq}` }));
    await db.execute(sql`
      UPDATE issue_criteria SET requirement_criterion_id = (
        SELECT rc.id FROM requirement_criteria rc JOIN requirements r ON r.id = rc.requirement_id
         WHERE r.project_id = ${projectId} AND rc.code = 'BC-1' AND rc.retired_revision IS NULL
         LIMIT 1)
       WHERE issue_id = ${issue} AND n = 1
    `);
  }

  type Bc = {
    code: string;
    verdict: string;
    why: string | null;
    issues: Array<{ notCounted: string | null }>;
  };
  async function bc1(req: string): Promise<Bc> {
    const d = (await ok(onProject('GET', `/requirements/${req}`))) as {
      standing: { coverage: Bc[] };
    };
    return d.standing.coverage.find((c) => c.code === 'BC-1') as Bc;
  }

  it('reads BC-1 passing on a pass at the landed head', async () => {
    const req = await agreedRequirement();
    const issue = await landedIssue(5, F4);
    await tracing(req, issue, 5);
    await verdict(issue, 1, 'pass', F4);

    expect(await bc1(req)).toMatchObject({ verdict: 'passing' });
  });

  it('does not count a pass at the pre-merge head, and says why', async () => {
    const req = await agreedRequirement();
    const issue = await landedIssue(5, F4);
    await tracing(req, issue, 5);
    await verdict(issue, 1, 'pass', D9);

    const read = await bc1(req);

    expect(read.verdict).toBe('not_live');
    expect(read.why).toContain("judged only at commits other than their issue's landing");
    expect(read.issues[0]?.notCounted).toContain(
      `judged at commit ${D9.slice(0, 12)}, not at its issue's landing ${F4.slice(0, 12)}`,
    );
  });

  it('names the missing landing rather than reading a silent not judged', async () => {
    const req = await agreedRequirement();
    const issue = await landedIssue(5, null);
    await tracing(req, issue, 5);
    await verdict(issue, 1, 'pass', F4);

    const read = await bc1(req);

    expect(read.verdict).toBe('not_judged');
    expect(read.why).toContain("ISS-5's merge records no commit");
  });
});
