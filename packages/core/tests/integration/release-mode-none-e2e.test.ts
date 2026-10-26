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
    expect(list.landings).toEqual([
      { runId, branch: BRANCH, commit: F4, at: expect.any(String), issues: ['ISS-5'] },
    ]);
    // catalog-api run 9ed968de, 2026-10-26: a recorded landing is a release like any other
    expect(res.body.version).toBe('0.1.0');
    expect(list.releases).toMatchObject([{ version: '0.1.0', state: 'shipped' }]);

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

  it('counts a pass at a later head only on a record made at that head', async () => {
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, LATER);

    const atMerge = await record([issue], F4);

    expect(atMerge.status).toBe(422);
    expect(refusalsOf(atMerge.body)[0]?.detail).toContain(
      `it was judged at \`${LATER.slice(0, 12)}\`, not at \`${F4.slice(0, 12)}\``,
    );
    expect(await statusOf(issue)).toBe('awaiting_release');

    const atLater = await record([issue], LATER);

    expect(atLater.status, JSON.stringify(atLater.body)).toBe(201);
    expect(atLater.body).toMatchObject({ commit: LATER, branch: BRANCH });
    expect(await statusOf(issue)).toBe('closed');
  });

  it('refuses criteria judged only at the pre-merge head d9fd508, naming each', async () => {
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, D9);

    const res = await record([issue], F4);

    expect(res.status).toBe(422);
    const refusals = refusalsOf(res.body);
    expect(refusals.map((r) => r.code)).toEqual([
      'RELEASE_LANDING_UNJUDGED',
      'RELEASE_LANDING_UNJUDGED',
      'RELEASE_LANDING_UNJUDGED',
    ]);
    expect(refusals[0]?.detail).toContain('ISS-5 criterion 1');
    expect(refusals[0]?.detail).toContain(
      `it was judged at \`${D9.slice(0, 12)}\`, not at \`${F4.slice(0, 12)}\``,
    );
    expect(refusals[0]?.detail).toContain(
      `it needs a \`pass\` whose identity is commit \`${F4.slice(0, 12)}\``,
    );
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('refuses a fail at the landed head, naming the criterion', async () => {
    const issue = await landedIssue(5, F4);
    await verdict(issue, 1, 'pass', F4);
    await verdict(issue, 2, 'fail', F4);
    await verdict(issue, 3, 'pass', F4);

    const res = await record([issue], F4);

    expect(res.status).toBe(422);
    const refusals = refusalsOf(res.body);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ code: 'RELEASE_LANDING_UNJUDGED' });
    expect(refusals[0]?.detail).toContain('ISS-5 criterion 2: its verdict is `fail`');
    expect(await statusOf(issue)).toBe('awaiting_release');
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
