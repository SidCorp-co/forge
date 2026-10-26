/**
 * On a project that releases by merging its change requests, work the host already holds on the
 * project's target branch has nothing left to merge: the roster needs no change request for it, the
 * release carries it and closes it with the rest, and nothing reads it as unlanded. Planted from
 * catalog-api on dev (2026-10-25): release 0.2.0 read "Master: open a change request on ISS-1 and 1
 * more" while ISS-1 (f55026eb) and ISS-3 (c988d627) were on GitLab `dev` with no merge request, and
 * on 2026-10-23 the steward reopened ISS-3 three minutes after it reached awaiting_release, for "no
 * open linked change request or recorded landing". Beside them, catalog-api ISS-12's mark named a
 * commit only a box's local remote ever had: it still needs its change request.
 *
 * @direct-test-of packages/core/src/release-batch/landed-on-target.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { stewardReleaseFacts } from '../../src/release-batch/index.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// the repository host as the binding reads it: which commits `dev` holds, or a read that fails
const host = vi.hoisted(() => ({
  onDev: new Set<string>(),
  fail: null as Error | null,
}));

vi.mock('../../src/integrations/source-host/index.js', async (original) => ({
  ...(await original<typeof import('../../src/integrations/source-host/index.js')>()),
  resolveSourceHost: async () => ({
    fullName: 'sidcorp-it/canawan-api-reference',
    provider: 'gitlab',
    readCommit: async (ref: string) => ({
      sha: ref,
      message: 'feat',
      committedAt: '2026-10-22T10:00:00Z',
    }),
    branchContains: async (branch: string, sha: string) => {
      if (host.fail) throw host.fail;
      return branch === BRANCH && host.onDev.has(sha);
    },
    readFile: async (path: string) => ({ missing: `${path} is not read here` }),
  }),
}));

const BRANCH = 'dev';
const F550 = 'f55026ebac52172d1931be9514266cccac9f4b97';
const C988 = 'c988d627181577155de6de27162ca8ac8002c9dc';
const LOCAL = 'c451bfea41052afffd496326c04e02db12652590';
const NOTE = { section: 'Added', userFacing: 'An ePOD site deploys catalog designs.' };

const world = { projectId: '', ownerId: '', token: '' };

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function seedWorld(verdictsRequired: boolean): Promise<void> {
  await settleOutbox();
  await truncateAll();
  host.onDev = new Set([F550, C988]);
  host.fail = null;
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
  await seedProjectDocument(world.projectId, world.ownerId, {
    environments: {},
    defaultBranch: BRANCH,
    source: {
      type: 'git',
      git: {
        repository: 'gitlab.com/sidcorp-it/canawan-api-reference',
        defaultBranch: BRANCH,
        branches: [BRANCH],
      },
    },
    extra: {
      delivery: { verdictsRequired },
      release: { approval: { required: true }, changeRequests: true },
    } as never,
  });
  const connectionId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connectionId}, 'user', ${world.ownerId}, 'gitlab', true)
  `);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${randomUUID()}, ${connectionId}, ${world.projectId}, 'gitlab', 'source', true,
            ${JSON.stringify({ repository: 'sidcorp-it/canawan-api-reference' })}::jsonb)
  `);
}

/** An issue at awaiting_release whose merge mark, a box's, names `commit` on `dev`, and no request. */
async function marked(seq: number, commit: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes)
    VALUES (${id}, ${world.projectId}, ${seq}, ${`issue ${seq}`}, 'in_progress', ${world.ownerId},
            ${JSON.stringify(NOTE)}::jsonb)
  `);
  await replaceCriteria(id, [
    { n: 1, statement: 'An ePOD site passes the platform gate' },
    { n: 2, statement: 'A refused key fails the payload with ePOD’s words' },
  ]);
  await seedIssueStatus(id, 'awaiting_release');
  await db.execute(sql`
    UPDATE issues
       SET merged_at = '2026-10-22T12:29:23Z', merged_target = ${BRANCH},
           merged_paths = ${JSON.stringify({ read: 'box', commit, changes: [{ path: 'app/Services/EpodService.php', change: 'changed' }] })}::jsonb
     WHERE id = ${id}
  `);
  return id;
}

async function passedAt(issueId: string, commit: string) {
  const criteria = await rows<{ id: string }>(
    sql`SELECT id FROM issue_criteria WHERE issue_id = ${issueId} AND retired_at IS NULL ORDER BY n`,
  );
  for (const c of criteria) {
    await db.execute(sql`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                      author_user_id, author_agency, judge)
      VALUES (${c.id}, ${issueId}, 'pass', ${`suite green at ${commit}`}, 'commit', ${commit},
              ${world.ownerId}, 'agent', 'qa')
    `);
  }
}

type Blocker = { code: string; details?: { displayIds?: string[]; check?: string } };
async function blockers(): Promise<Blocker[]> {
  const res = await api(world.token, 'GET', `/api/projects/${world.projectId}/release-readiness`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { blockers: Blocker[] }).blockers;
}
const missingOf = async () =>
  (await blockers()).find((b) => b.code === 'RELEASE_CHANGE_REQUEST_MISSING')?.details
    ?.displayIds ?? [];

const cut = (issueIds: string[]) =>
  api(world.token, 'POST', `/api/projects/${world.projectId}/release-batches`, { issueIds });

const statusOf = async (id: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`))[0]?.status;

async function approve(runId: string) {
  const [pending] = await rows<{ id: string }>(
    sql`SELECT id FROM release_approvals WHERE run_id = ${runId} AND decision IS NULL`,
  );
  const res = await api(
    world.token,
    'POST',
    `/api/projects/${world.projectId}/release-batches/${runId}/approvals/${pending?.id}/decision`,
    { decision: 'approve', reason: 'ISS-1 is on GitLab dev already; nothing is left to merge' },
  );
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

async function stewardReopens(issueId: string, key: string) {
  const { callStewardDoor } = await import('../../src/steward/doors.js');
  const [run] = await rows<{ id: string }>(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                              acts_to_run, state, not_before, started_at)
    VALUES (${world.projectId}, 'issue', ${issueId}, ${key}, 'release.asked', '[]'::jsonb,
            ARRAY['output_check']::text[], 'running', now(), now())
    RETURNING id`);
  return callStewardDoor(
    'steward_move_issue',
    JSON.stringify({
      issue: key,
      to: 'reopen',
      // the steward's own words on catalog-api ISS-3, 2026-10-23 12:55
      reason: `Reopen for the required pre-release verdicts. ${key} has no open linked change request or recorded landing, so no running build has a counting verdict.`,
    }),
    {
      projectId: world.projectId,
      runId: run?.id ?? '',
      act: 'output_check' as const,
      subject: { kind: 'issue', id: issueId, key },
      standing: null,
      token: world.token,
      refused: [] as string[],
      broken: [] as string[],
      acts: [] as string[],
    },
  );
}

describe('the roster needs no change request for work already on the target branch', () => {
  beforeEach(() => seedWorld(false));

  it('asks a change request only of the issue whose commit the host’s dev does not hold', async () => {
    await marked(1, F550);
    await marked(12, LOCAL);

    expect(await missingOf()).toEqual(['ISS-12']);
  });

  it('cuts a release of work already on dev with nothing to merge, and its approval closes it', async () => {
    const one = await marked(1, F550);

    const res = await cut([one]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ changeRequests: [], verification: 'merged' });
    const runId = String(res.body.runId);
    const [run] = await rows<{ landed: unknown; reading: string }>(sql`
      SELECT r.metadata -> 'alreadyLanded' AS landed, a.evidence_reading AS reading
        FROM pipeline_runs r JOIN release_approvals a ON a.run_id = r.id WHERE r.id = ${runId}`);
    expect(run?.landed).toEqual([{ issueId: one, branch: BRANCH, commit: F550, from: 'branch' }]);
    expect(run?.reading).toContain('Nothing to merge');
    const [stamp] = await rows<{ sha: string | null }>(
      sql`SELECT merged_commit_sha AS sha FROM issues WHERE id = ${one}`,
    );
    expect(stamp?.sha, 'the host landing the cut read is the host record a close reads').toBe(F550);

    await approve(runId);
    await settleOutbox();
    expect(await statusOf(one)).toBe('closed');
    const [after] = await rows<{ status: string }>(
      sql`SELECT status FROM pipeline_runs WHERE id = ${runId}`,
    );
    expect(after?.status).toBe('completed');
  });

  it('still refuses a cut of the issue whose commit is on no host branch, naming the request it lacks', async () => {
    const twelve = await marked(12, LOCAL);

    const res = await cut([twelve]);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('RELEASE_CHANGE_REQUEST_MISSING');
  });

  it('says the host could not be read rather than reading the issue as landed or silently unlanded', async () => {
    await marked(1, F550);
    host.fail = new Error('GitLab answered 503');

    const found = await blockers();
    expect(found.find((b) => b.code === 'RELEASE_CHECK_UNEVALUATED')?.details?.check).toBe(
      'host-landing',
    );
    expect(await missingOf()).toEqual(['ISS-1']);
  });
});

describe('nothing reads work already on the target branch as unlanded', () => {
  beforeEach(() => seedWorld(true));

  it('tells the steward ISS-3 misses nothing when every criterion passes at its commit on dev', async () => {
    const three = await marked(3, C988);
    await passedAt(three, C988);

    const facts = await stewardReleaseFacts(world.projectId, three);
    expect(facts).toContain('already on `dev`');
    expect(facts).toContain('no evidence is missing');
    const answer = await stewardReopens(three, 'ISS-3');
    expect(answer.ok, answer.text).toBe(false);
    expect(await statusOf(three)).toBe('awaiting_release');
  });

  it('defaults a verdict on ISS-3 to its commit on dev, saying it is already there', async () => {
    const three = await marked(3, C988);

    const res = await api(world.token, 'GET', `/api/issues/${three}/judged-build`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ sha: C988, source: 'merged' });
    expect(String(res.body.basis)).toContain('already on `dev`');
  });

  it('sends nothing back while the host cannot be read', async () => {
    const three = await marked(3, C988);
    await passedAt(three, C988);
    host.fail = new Error('GitLab answered 503');

    expect(await stewardReleaseFacts(world.projectId, three)).toContain('could not be read');
    const answer = await stewardReopens(three, 'ISS-3');
    expect(answer.ok, answer.text).toBe(false);
    expect(await statusOf(three)).toBe('awaiting_release');
  });

  it('sends ISS-12 back no more than the others: its mark names a commit no host branch holds, and the note says so', async () => {
    const twelve = await marked(12, LOCAL);
    await passedAt(twelve, LOCAL);

    expect(await stewardReleaseFacts(world.projectId, twelve)).not.toContain(
      'no evidence is missing',
    );
    const answer = await stewardReopens(twelve, 'ISS-12');
    expect(answer.ok, answer.text).toBe(false);
    expect(await statusOf(twelve)).toBe('awaiting_release');
  });
});
