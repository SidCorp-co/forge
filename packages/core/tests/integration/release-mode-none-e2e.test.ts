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
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import type { AncestryReader } from '../../src/release-batch/shipped-earlier-ancestry.js';
import { pairKey } from '../../src/runners/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProduction, seedProjectDocument } from '../helpers/release-world.js';

/** adminhub-api `release/stg`: c168d8b, then ISS-5's branch head d9fd508, merged as f4e5fb6. */
const C1 = 'c168d8bca2482c61b1ecfb39722bd75bd5bd2e90';
const D9 = 'd9fd508d7fe071acfc596010fb2717563768cee6';
const F4 = 'f4e5fb66700ba7b35c8c607c8f7309fc5980861a';
/** A later head of `release/stg`, holding the merge: it judges a newer build. */
const LATER = 'aaaa0000000000000000000000000000000000a1';
/** A commit on no line `release/stg` holds. */
const ASIDE = 'bbbb0000000000000000000000000000000000b2';

/** Each commit and every commit it holds, itself included. */
const HISTORY: Record<string, readonly string[]> = {
  [C1]: [C1],
  [D9]: [D9, C1],
  [F4]: [F4, D9, C1],
  [LATER]: [LATER, F4, D9, C1],
  [ASIDE]: [ASIDE],
};

const reader: AncestryReader = {
  async ask(pairs) {
    const out = new Map<string, boolean | { unread: string }>();
    for (const p of pairs) {
      const held = HISTORY[p.release];
      out.set(
        pairKey(p),
        held ? held.includes(p.commit) : { unread: `no history for ${p.release}` },
      );
    }
    return out;
  },
  witness: () => ({ via: 'source-host' }),
};

vi.mock('../../src/release-batch/shipped-earlier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/shipped-earlier.js')>()),
  ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
}));

const BRANCH = 'release/stg';
const NOTE = { section: 'Skip', userFacing: '-' };
const ACCOUNT = 'Merged into release/stg and judged on the box at that head by QA.';

let projectId: string;
let ownerId: string;
let token: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  await seedProjectDocument(projectId, ownerId, { environments: {}, defaultBranch: BRANCH });
});

async function ok(r: Promise<{ status: number; body: Record<string, unknown> }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

/** An issue with three criteria, its merge marked on `release/stg` naming `commit` (or none). */
async function landedIssue(
  seq: number,
  commit: string | null,
  statements: readonly string[] = [
    'One command builds the local test databases',
    'Two worktrees never share a database',
    'An unsafe host is refused before any change',
  ],
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'in_progress', ${ownerId},
            ${JSON.stringify(NOTE)}::jsonb)
  `);
  await replaceCriteria(
    id,
    statements.map((statement, i) => ({ n: i + 1, statement })),
  );
  await ok(
    api(token, 'POST', `/api/issues/${id}/merge`, {
      target: BRANCH,
      ...(commit ? { commit } : {}),
    }),
  );
  await seedIssueStatus(id, 'awaiting_release');
  return id;
}

/** QA's verdict on criterion `n`, at `commit`. */
async function verdict(issueId: string, n: number, word: 'pass' | 'fail', commit: string) {
  const [criterion] = (await db.execute(sql`
    SELECT id FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL
  `)) as unknown as Array<{ id: string }>;
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    author_user_id, author_agency, judge)
    VALUES (${criterion?.id}, ${issueId}, ${word}, ${`${word} on the box at ${commit}`}, 'commit',
            ${commit}, ${ownerId}, 'agent', 'qa')
  `);
}

async function judgedAll(issueId: string, commit: string) {
  for (const n of [1, 2, 3]) await verdict(issueId, n, 'pass', commit);
}

const record = (issueIds: string[], commit: string) =>
  api(token, 'POST', `/api/projects/${projectId}/release-records`, {
    issueIds,
    commit,
    account: ACCOUNT,
  });

async function statusOf(issueId: string): Promise<string> {
  const [row] = (await db.execute(
    sql`SELECT status FROM issues WHERE id = ${issueId}`,
  )) as unknown as Array<{ status: string }>;
  return row?.status ?? 'absent';
}

type Refused = { code?: string; error?: { refusals?: Array<{ code: string; detail: string }> } };
const refusalsOf = (body: unknown) =>
  (body as Refused).error?.refusals ?? [{ code: (body as Refused).code ?? '', detail: '' }];

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
    expect(list.releases).toEqual([]);

    const detail = await ok(api(token, 'GET', `/api/issues/${issue}`));
    expect(detail.landedIn).toEqual({ branch: BRANCH, commit: F4, at: expect.any(String) });
    expect(detail.shippedIn).toBeNull();

    const [note] = (await db.execute(sql`
      SELECT body FROM comments WHERE issue_id = ${issue} AND body LIKE 'Landed on%'
    `)) as unknown as Array<{ body: string }>;
    expect(note?.body).toContain(`Landed on \`${BRANCH}\` at \`${F4}\` — no environment.`);
    expect(note?.body).not.toMatch(/deployed to|serving/);
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
    expect(refusals[0]?.detail).toContain(`it needs a \`pass\` judged at \`${F4.slice(0, 12)}\``);
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

describe("the steward's output check reads the same landed build", () => {
  async function stewardReopens(
    issueId: string,
    issueKey: string,
    reason = 'Criterion 1 has no counting verdict on a running build and no release proof.',
  ) {
    const { callStewardDoor } = await import('../../src/steward/doors.js');
    const [run] = (await db.execute(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, not_before, started_at)
      VALUES (${projectId}, 'issue', ${issueId}, ${issueKey}, 'release.asked', '[]'::jsonb,
              ARRAY['output_check']::text[], 'running', now(), now())
      RETURNING id`)) as unknown as Array<{ id: string }>;
    const ctx = {
      projectId,
      runId: run?.id ?? '',
      act: 'output_check' as const,
      subject: { kind: 'issue', id: issueId, key: issueKey },
      standing: null,
      token,
      refused: [] as string[],
      broken: [] as string[],
      acts: [] as string[],
    };
    const answer = await callStewardDoor(
      'steward_move_issue',
      JSON.stringify({
        issue: issueKey,
        to: 'reopen',
        reason,
      }),
      ctx,
    );
    return { answer, refused: ctx.refused };
  }

  it('refuses to send back ISS-5 when every criterion passes at the landed head', async () => {
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, F4);

    const { answer, refused } = await stewardReopens(issue, 'ISS-5');

    expect(answer.ok).toBe(false);
    expect(answer.text).toContain('STEWARD_REOPEN_COUNTED');
    expect(refused[0]).toContain('STEWARD_REOPEN_COUNTED');
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('still sends it back when its passes stand only at the pre-merge head d9fd508', async () => {
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, D9);

    const { answer } = await stewardReopens(issue, 'ISS-5');

    expect(answer.ok, answer.text).toBe(true);
    expect(await statusOf(issue)).toBe('reopen');
  });

  it('still sends it back when its passes stand at a later head nothing has recorded', async () => {
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, LATER);

    const { answer } = await stewardReopens(issue, 'ISS-5');

    expect(answer.ok, answer.text).toBe(true);
    expect(await statusOf(issue)).toBe('reopen');
  });

  it('still sends it back when a verdict at the landed head fails', async () => {
    const issue = await landedIssue(5, F4);
    await verdict(issue, 1, 'pass', F4);
    await verdict(issue, 2, 'fail', F4);
    await verdict(issue, 3, 'pass', F4);

    const { answer } = await stewardReopens(issue, 'ISS-5');

    expect(answer.ok, answer.text).toBe(true);
    expect(await statusOf(issue)).toBe('reopen');
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

describe("the steward's second reason, the design's proof plan, reads the landed build too", () => {
  // adminhub-api ISS-1, reopened at 11:30 on 2026-10-22 with all 17 criteria passing at the
  // release/stg head it landed on: "every criterion has a verdict only at 5da145a1a260, none counting
  // on the running build, whose source cannot be read; and no evidence the release will run the
  // design's proof plan".
  const HEAD = '5da145a1a2600000000000000000000000000000';
  const BEFORE = '5da145a1a2610000000000000000000000000000';
  const REASON =
    "Criteria 1-17 have verdicts only at commit 5da145a1a260 and none counting on the running build, whose source cannot be read; nothing shows the release will run the design's proof plan.";
  const STATEMENTS = Array.from({ length: 17 }, (_, i) => `Criterion ${i + 1} holds on the box`);

  /** The design's line for every live criterion, each naming its proof. */
  async function proofPlan(issueId: string) {
    await db.execute(sql`
      INSERT INTO issue_designs (issue_id, project_id, revision, modules, contracts, recorded_by, recorded_agency)
      VALUES (${issueId}, ${projectId}, 1, ARRAY[${randomUUID()}]::uuid[], '{}'::text[], ${ownerId}, 'agent')
    `);
    await db.execute(sql`
      INSERT INTO issue_design_criteria (criterion_id, issue_id, criterion_class, pattern, proof)
      SELECT id, issue_id, 'observable', NULL, 'the probe replays it on the box'
        FROM issue_criteria WHERE issue_id = ${issueId} AND retired_at IS NULL
    `);
  }

  async function stewardOn(issueId: string) {
    const { callStewardDoor } = await import('../../src/steward/doors.js');
    const [run] = (await db.execute(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, not_before, started_at)
      VALUES (${projectId}, 'issue', ${issueId}, 'ISS-1', 'release.asked', '[]'::jsonb,
              ARRAY['output_check']::text[], 'running', now(), now())
      RETURNING id`)) as unknown as Array<{ id: string }>;
    return callStewardDoor(
      'steward_move_issue',
      JSON.stringify({ issue: 'ISS-1', to: 'reopen', reason: REASON }),
      {
        projectId,
        runId: run?.id ?? '',
        act: 'output_check',
        subject: { kind: 'issue', id: issueId, key: 'ISS-1' },
        standing: null,
        token,
        refused: [],
        broken: [],
        acts: [],
      },
    );
  }

  it('does not reopen ISS-1 with 17 passes at its landed head, by either reason', async () => {
    const issue = await landedIssue(1, HEAD, STATEMENTS);
    await proofPlan(issue);
    for (let n = 1; n <= 17; n += 1) await verdict(issue, n, 'pass', HEAD);

    const answer = await stewardOn(issue);

    expect(answer.ok).toBe(false);
    expect(answer.text).toContain('STEWARD_REOPEN_COUNTED');
    expect(answer.text).toContain(
      "The design's proof plan is met the same way: each of the 17 criteria",
    );
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('still reopens it where one planned criterion passes only before the landed head', async () => {
    const issue = await landedIssue(1, HEAD, STATEMENTS);
    await proofPlan(issue);
    for (let n = 1; n <= 16; n += 1) await verdict(issue, n, 'pass', HEAD);
    await verdict(issue, 17, 'pass', BEFORE);

    const answer = await stewardOn(issue);

    expect(answer.ok, answer.text).toBe(true);
    expect(await statusOf(issue)).toBe('reopen');
  });
});
