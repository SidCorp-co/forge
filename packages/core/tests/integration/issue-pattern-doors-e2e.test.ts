/**
 * The doors a new pattern holds an issue at, the run that wrote a pattern, and the issues that name
 * none (REQ-36 BC-2; Issue lifecycle r14 `design-check`; Issue to release r20 `admissible`).
 *
 * - A run session over a held issue and a pool job for it are refused PATTERN_REVIEW_PENDING. Each
 *   case here goes red when its door stops asking.
 * - A pattern a run named is refused only to that run. Another run on the same box account, or a
 *   person, decides it.
 * - An issue that names no pattern walks open → run session → in_progress → build →
 *   awaiting_release through the routes with no PATTERN_* refusal. This holds on a project declaring
 *   this repository, on one declaring another, and on one with no project document.
 * - The read says whether a project reads a catalog, and the served guide tells a run to read it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { THIS_REPOSITORY } from '../../src/lib/this-repository.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

type Res = { status: number; body: Doc };
interface World {
  id: string;
  box: string;
  pat: string;
}

const SHA = 'd'.repeat(40);
const worlds: Record<'forge' | 'other' | 'nodoc', World> = {
  forge: { id: '', box: '', pat: '' },
  other: { id: '', box: '', pat: '' },
  nodoc: { id: '', box: '', pat: '' },
};
let adminId = '';
let adminToken = '';
let authorToken = '';
let seq = 0;

async function projectBuiltFrom(ownerId: string, repository: string | null): Promise<string> {
  const { id } = await createTestProject(ownerId);
  if (repository) {
    await seedProjectDocument(id, ownerId, {
      environments: {
        dev: { tier: 'production', deploysFrom: 'main', deployment: { mode: 'external' } },
      },
      source: { type: 'git', git: { repository, defaultBranch: 'main', branches: ['main'] } },
    });
  }
  return id;
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const admin = await createTestUser({ verified: true });
  const author = await createTestUser({ kind: 'agent' });
  adminId = admin.id;
  const repositories = { forge: THIS_REPOSITORY, other: 'github.com/acme/shop', nodoc: null };
  for (const name of ['forge', 'other', 'nodoc'] as const) {
    const id = await projectBuiltFrom(admin.id, repositories[name]);
    await addProjectMember(id, admin.id, 'admin');
    await addProjectMember(id, author.id, 'member');
    const box = await createTestDevice(admin.id);
    await bindTestRunner(id, box);
    // the box's credential is its holder's account: every run on the box acts as the admin
    const pat = (
      await mintPat({
        permissions: ['*'],
        userId: admin.id,
        name: `box-${name}`,
        deviceId: box,
        projectIds: [id],
      })
    ).plaintext;
    worlds[name] = { id, box, pat };
  }
  adminToken = await userToken(admin.id);
  authorToken = await userToken(author.id);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function call(token: string, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  const res = await api(token, method, path, body, { 'X-Forge-Lifecycle': '10' });
  return { status: res.status, body: res.body as Doc } as Res;
}
const asBox = (w: World, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) =>
  call(w.pat, method, path, body);
const codes = (r: Res): string[] => (r.body?.error?.refusals ?? []).map((x: Doc) => x.code);
const patterns = (issue: string) => `/api/issues/${issue}/patterns`;

async function issueAt(w: World, status: string): Promise<{ id: string; key: string }> {
  seq += 1;
  const row = await createTestIssue(w.id, adminId, seq, { status, createdAt: new Date() });
  return { id: row.id, key: `ISS-${seq}` };
}

const statusOf = async (id: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`))[0]?.status;

/** A run session the box opens over `key`, which takes the issue's lease: the box's run id. */
async function openRun(w: World, key: string): Promise<string> {
  const runId = randomUUID();
  const opened = await asBox(w, 'POST', '/api/devices/me/run-sessions', {
    projectId: w.id,
    runId,
    issueKeys: [key],
    name: key,
  });
  expect([opened.status, codes(opened)]).toEqual([expect.any(Number), []]);
  expect(opened.status).toBeLessThan(300);
  return runId;
}

describe('a run session over an issue whose new pattern waits on its reviewer', () => {
  it('is refused PATTERN_REVIEW_PENDING at the preflight and the open, and let through once retracted', async () => {
    const w = worlds.forge;
    const { id, key } = await issueAt(w, 'open');
    const made = await call(authorToken, 'POST', patterns(id), {
      pattern: 'probe-door',
      summary: 'a door no entry covers',
    });
    expect(made.status).toBe(201);
    const pre = await asBox(w, 'POST', '/api/devices/me/run-sessions/preflight', {
      projectId: w.id,
      issueKeys: [key],
    });
    expect(codes(pre)).toContain('PATTERN_REVIEW_PENDING');
    const open = await asBox(w, 'POST', '/api/devices/me/run-sessions', {
      projectId: w.id,
      runId: randomUUID(),
      issueKeys: [key],
      name: key,
    });
    expect(codes(open)).toContain('PATTERN_REVIEW_PENDING');
    await call(authorToken, 'POST', `${patterns(id)}/${made.body.pattern.id}/retract`, {
      reason: 'the api-route entry serves it',
    });
    const again = await asBox(w, 'POST', '/api/devices/me/run-sessions/preflight', {
      projectId: w.id,
      issueKeys: [key],
    });
    expect([again.status, codes(again)]).toEqual([200, []]);
  });
});

describe('a pool job for an issue whose new pattern waits on its reviewer', () => {
  it('is refused at the claim naming PATTERN_REVIEW_PENDING, and no longer for it once retracted', async () => {
    const w = worlds.forge;
    const { id } = await issueAt(w, 'open');
    const made = await call(authorToken, 'POST', patterns(id), {
      pattern: 'pool-door',
      summary: 'a door no entry covers',
    });
    expect(made.status).toBe(201);
    const master = await asBox(w, 'POST', '/api/devices/me/master-session', {
      projectId: w.id,
      name: 'pattern-doors-master',
      maxJobPanes: 1,
    });
    expect(master.status).toBeLessThan(300);
    const runId = randomUUID();
    const jobId = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status)
      VALUES (${runId}, ${w.id}, 'interactive', 'running')
    `);
    await db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, created_by, type, status, payload)
      VALUES (${jobId}, ${w.id}, ${runId}, ${id}, ${adminId}, 'smoke', 'queued',
              ${JSON.stringify({ promptString: 'work the issue' })}::jsonb)
    `);
    const claim = () =>
      asBox(w, 'POST', '/api/devices/me/pool/prepare', {
        jobId,
        sessionId: master.body.sessionId,
      });
    const held = await claim();
    expect(held.body?.error?.code).toBe('POOL_POLICY_REFUSED');
    expect(JSON.stringify(held.body)).toContain('PATTERN_REVIEW_PENDING');
    await call(authorToken, 'POST', `${patterns(id)}/${made.body.pattern.id}/retract`, {
      reason: 'the api-route entry serves it',
    });
    const after = await claim();
    expect(JSON.stringify(after.body)).not.toContain('PATTERN_REVIEW_PENDING');
  });
});

describe('a pattern a run named is decided by anyone holding patterns.approve but that run', () => {
  const w = () => worlds.forge;
  let issue = { id: '', key: '' };
  let runA = '';
  let runB = '';
  let pattern = '';

  it('records the run holding the issue as the one that named it', async () => {
    issue = await issueAt(w(), 'open');
    runA = await openRun(w(), issue.key);
    runB = await openRun(w(), (await issueAt(w(), 'open')).key);
    const made = await asBox(w(), 'POST', patterns(issue.id), {
      pattern: 'socket-door',
      summary: 'a socket as a door',
    });
    expect(made.status).toBe(201);
    expect(made.body.pattern.namedSession).toEqual(expect.any(String));
    pattern = made.body.pattern.id;
  });

  it('refuses that run, whether it names itself or is read off the lease it holds', async () => {
    const decide = (run?: string) =>
      asBox(w(), 'POST', `${patterns(issue.id)}/${pattern}/decision`, {
        decision: 'approved',
        reason: 'my own',
        ...(run ? { run } : {}),
      });
    expect(codes(await decide(runA))).toEqual(['PATTERN_REVIEWER_IS_AUTHOR']);
    expect(codes(await decide())).toEqual(['PATTERN_REVIEWER_IS_AUTHOR']);
    expect(codes(await decide(randomUUID()))).toEqual(['PATTERN_RUN_UNKNOWN']);
  });

  it('lets another run on the same box account decide it, and records that run', async () => {
    const res = await asBox(w(), 'POST', `${patterns(issue.id)}/${pattern}/decision`, {
      decision: 'approved',
      reason: 'reviewed by the other run',
      run: runB,
    });
    expect([res.status, codes(res)]).toEqual([200, []]);
    expect(res.body.pattern.decidedSession).toEqual(expect.any(String));
    expect(res.body.pattern.decidedSession).not.toBe(res.body.pattern.namedSession);
  });

  it('refuses a box call that cannot say which run it is while the naming run is live there', async () => {
    const other = await issueAt(w(), 'open');
    const unnamed = await asBox(w(), 'POST', patterns(other.id), {
      pattern: 'pipe-door',
      summary: 'a pipe as a door',
    });
    expect(codes(unnamed)).toEqual(['PATTERN_RUN_UNNAMED']);
    const made = await asBox(w(), 'POST', patterns(other.id), {
      pattern: 'pipe-door',
      summary: 'a pipe as a door',
      run: runA,
    });
    expect(made.status).toBe(201);
    const blind = await asBox(
      w(),
      'POST',
      `${patterns(other.id)}/${made.body.pattern.id}/decision`,
      {
        decision: 'approved',
        reason: 'who am I',
      },
    );
    expect(codes(blind)).toEqual(['PATTERN_REVIEWER_RUN_UNNAMED']);
  });

  it("lets a person decide a run's pattern, even the account the box's runs act as, and offers it on the read", async () => {
    const other = await issueAt(w(), 'open');
    const made = await asBox(w(), 'POST', patterns(other.id), {
      pattern: 'bus-door',
      summary: 'a bus as a door',
      run: runA,
    });
    const read = await call(adminToken, 'GET', patterns(other.id));
    expect(read.body.decidable).toEqual([made.body.pattern.id]);
    const res = await call(
      adminToken,
      'POST',
      `${patterns(other.id)}/${made.body.pattern.id}/decision`,
      {
        decision: 'approved',
        reason: 'a person reviews a run',
      },
    );
    expect([res.status, codes(res)]).toEqual([200, []]);
    expect(res.body.pattern.decidedSession).toBeNull();
  });
});

describe('an issue that names no pattern', () => {
  for (const name of ['forge', 'other', 'nodoc'] as const) {
    it(`moves open → run session → in_progress → build → awaiting_release on the ${name} project with no PATTERN_* refusal`, async () => {
      const w = worlds[name];
      const { id, key } = await issueAt(w, 'open');
      const seen: Res[] = [];
      await openRun(w, key);
      if ((await statusOf(id)) !== 'in_progress') {
        const toProgress = await call(adminToken, 'POST', `/api/issues/${id}/transition`, {
          toStatus: 'in_progress',
        });
        seen.push(toProgress);
        expect(toProgress.status).toBe(200);
      }
      const build = await call(adminToken, 'PATCH', `/api/issues/${id}`, {
        workState: { step: 'build' },
      });
      seen.push(build);
      expect(build.status).toBe(200);
      seen.push(
        await call(adminToken, 'PATCH', `/api/issues/${id}`, {
          acceptanceCriteria: '1. It holds.',
        }),
      );
      await db.execute(
        sql`UPDATE issues SET merged_at = now(), merged_commit_sha = ${SHA} WHERE id = ${id}`,
      );
      seen.push(
        await call(adminToken, 'POST', `/api/issues/${id}/verdicts`, {
          criterion: 1,
          verdict: 'pass',
          reason: 'shown',
          identity: { kind: 'commit', sha: SHA },
        }),
      );
      const moved = await call(adminToken, 'POST', `/api/issues/${id}/transition`, {
        toStatus: 'awaiting_release',
      });
      seen.push(moved);
      expect([moved.status, codes(moved)]).toEqual([200, []]);
      expect(await statusOf(id)).toBe('awaiting_release');
      expect(JSON.stringify(seen)).not.toMatch(/PATTERN_/);
    });
  }
});

describe('whether a project reads a pattern catalog', () => {
  it('answers the read with catalog.declared false and why, so a run names none there', async () => {
    const there = await call(
      authorToken,
      'GET',
      patterns((await issueAt(worlds.other, 'open')).id),
    );
    expect(there.body.catalog.declared).toBe(false);
    expect(there.body.catalog.detail).toContain(THIS_REPOSITORY);
    const here = await call(authorToken, 'GET', patterns((await issueAt(worlds.forge, 'open')).id));
    expect(here.body.catalog).toEqual({ declared: true, detail: null });
  });

  it('is what the served issue-flow guide tells a run to read before it names a pattern', async () => {
    const guide = await api(authorToken, 'GET', '/api/guides/issue-flow.md');
    const text = String(guide.body.text ?? '');
    expect(guide.status).toBe(200);
    expect(text).toContain('catalog.declared');
    expect(text).toContain('PATTERN_ENTRY_MISSING');
  });
});

describe('the table keeps a decision', () => {
  it('refuses rewriting a decided row at the database', async () => {
    const { id } = await issueAt(worlds.forge, 'open');
    const made = await call(authorToken, 'POST', patterns(id), {
      pattern: 'kept-door',
      summary: 'a door no entry covers',
    });
    await call(adminToken, 'POST', `${patterns(id)}/${made.body.pattern.id}/decision`, {
      decision: 'approved',
      reason: 'fine',
    });
    const err = await db
      .execute(
        sql`UPDATE issue_patterns SET decision = 'returned' WHERE id = ${made.body.pattern.id}`,
      )
      .then(
        () => null,
        (e: { cause?: { message?: string } }) => e,
      );
    expect(err?.cause?.message).toMatch(/ISSUE_PATTERN_DECIDED_ONCE/);
    const [row] = await rows<{ decision: string }>(
      sql`SELECT decision FROM issue_patterns WHERE id = ${made.body.pattern.id}`,
    );
    expect(row?.decision).toBe('approved');
  });
});
