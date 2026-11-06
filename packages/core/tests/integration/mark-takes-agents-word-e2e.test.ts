/**
 * ISS-1017 — the merge mark takes the agent's word (owner, 2026-11-05,
 * `owner-2026-11-05-done-is-the-agents-call`: whether work is done is the agent's call, never a
 * check hard-coded in core).
 *
 * Planted from epod ISS-74: its deliverable, the epod CLI guide (EN and VI) and What's New
 * v1.30.0–v1.43.0, is published on the docs.epodsystem.com docs store and was read live there. No
 * commit exists. On a git project every mark was refused: the master's with artifacts
 * `NO_WORK_EVIDENCE`, the orchestrator's with `landing` `LANDING_NOT_THIS_SHAPE`, the orchestrator's
 * with artifacts alone `TARGET_REQUIRED`. Each of those marks is accepted now, recorded as given
 * with who said it, and the ISS-74 shape goes through `awaiting_release` to a release that closes it.
 *
 * A commit the repository can be asked about is a reading on the mark, never its refusal; input of
 * the wrong shape is still refused by name at its path; and a close rests on the mark alone.
 *
 * @direct-test-of packages/core/src/issues/merge-marker.ts
 * @direct-test-of packages/core/src/issues/merge-routes.ts
 * @direct-test-of packages/core/src/issues/landing-evidence.ts
 * @direct-test-of packages/core/src/issues/merged-at.ts
 * @direct-test-of packages/core/src/issues/mark-trail.ts
 * @direct-test-of packages/core/src/issues/mark-said.ts
 * @direct-test-of packages/core/src/issues/commit-landing.ts
 * @direct-test-of packages/core/src/issues/work-evidence.ts
 * @direct-test-of packages/core/src/release-batch/blockers.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userToken } from '../helpers/api.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestDevice, createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { boxToken, liveRun } from '../helpers/preview-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

/** epod's production: deployed outside Forge by its own door, so a release is its agent's record. */
const LIVE = {
  live: {
    tier: 'production' as const,
    deployment: { mode: 'external' as const, target: 'epod-deploy' },
  },
};
const WHOLE = `${'c0ffee'.repeat(6)}abcd`;
const DOCS = 'https://docs.epodsystem.com/cli';
/** What ISS-74 delivered, as the master named it: the docs store's pages, each a `ui` artifact. */
const ARTIFACTS = [
  { surface: 'ui', ref: 'docs.epodsystem.com/cli/en', change: 'added' },
  { surface: 'ui', ref: 'docs.epodsystem.com/cli/vi', change: 'added' },
  { surface: 'ui', ref: 'docs.epodsystem.com/whats-new/v1.30.0-v1.43.0', change: 'added' },
];
const READ_LIVE = { url: DOCS, status: 200 };

let gitProject = '';
let outsideGit = '';
let ownerId = '';
let deviceId = '';
let call: (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;
/** The master's box: an agent's token on a paired device. */
const agent = (method: string, path: string, body?: unknown) => call('box', method, path, body);
/** The orchestrator, a person on the project. */
const person = (method: string, path: string, body?: unknown) => call('owner', method, path, body);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  gitProject = (await createTestProject(ownerId)).id;
  await seedProjectDocument(gitProject, ownerId, { environments: LIVE, defaultBranch: 'main' });
  outsideGit = (await createTestProject(ownerId)).id;
  await seedProjectDocument(outsideGit, ownerId, {
    environments: LIVE,
    source: { type: 'none' } as never,
  });
  deviceId = await createTestDevice(ownerId);
  call = requester(app, {
    box: await boxToken(ownerId, deviceId),
    owner: await userToken(ownerId),
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

let seq = 70;
async function issue(projectId: string): Promise<{ id: string; seq: number }> {
  const id = randomUUID();
  seq += 1;
  await rows(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`epod docs ${seq}`}, 'in_progress', ${ownerId})`);
  return { id, seq };
}

const mark = (by: typeof agent, id: string, body: Doc) =>
  by('POST', `/api/issues/${id}/merge`, body);
const move = (id: string, toStatus: string) =>
  person('POST', `/api/issues/${id}/transition`, { toStatus, reason: `moved to ${toStatus}` });
const release = (projectId: string, issueIds: string[], version: string) =>
  person('POST', `/api/projects/${projectId}/release-records`, {
    issueIds,
    version,
    account: `epod-docs published ${version} to docs.epodsystem.com; read live at ${DOCS}.`,
  });

async function row(id: string) {
  const [r] = await rows<{
    status: string;
    merged_at: unknown;
    merged_commit_sha: string | null;
    merged_landing: string | null;
    merged_artifacts: unknown;
  }>(sql`
    SELECT status, merged_at, merged_commit_sha, merged_landing, merged_artifacts
      FROM issues WHERE id = ${id}`);
  return r;
}

/** The newest mark record, as the trail keeps it. */
async function trailOf(id: string) {
  const [r] = await rows<{ actor_id: string; actor_agency: string; payload: Doc }>(sql`
    SELECT actor_id, actor_agency, payload FROM activity_log
     WHERE issue_id = ${id} AND action = 'issue.mergeMarked'
     ORDER BY created_at DESC LIMIT 1`);
  return r;
}

function refusalOf(r: Reply, status = 422): { code: string; path: string; detail: string } {
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  const [first] = r.json.error?.refusals ?? [];
  return {
    code: first?.code ?? r.json.error?.code,
    path: first?.path ?? '',
    detail: first?.detail ?? r.json.error?.message ?? '',
  };
}

describe('epod ISS-74: every mark the run made is accepted on a git project (outcome 1)', () => {
  it("takes the master's mark naming artifacts and a target, which was NO_WORK_EVIDENCE", async () => {
    const { id } = await issue(gitProject);
    const r = await mark(agent, id, { target: 'main', artifacts: ARTIFACTS });
    expect(r.json.error?.refusals?.[0]?.code ?? null).not.toBe('NO_WORK_EVIDENCE');
    const marked = ok(r);
    expect(marked.action).toBe('merged');
    expect((await row(id))?.merged_artifacts).toEqual(ARTIFACTS);
  });

  it("takes the orchestrator's mark naming where it landed, which was LANDING_NOT_THIS_SHAPE", async () => {
    const { id } = await issue(gitProject);
    const r = await mark(person, id, { landing: DOCS });
    expect(r.json.error?.refusals?.[0]?.code ?? null).not.toBe('LANDING_NOT_THIS_SHAPE');
    const marked = ok(r);
    expect(marked.mark).toBe('landed');
    expect((await row(id))?.merged_landing).toBe(DOCS);
  });

  it("takes the orchestrator's mark naming artifacts alone, which was TARGET_REQUIRED", async () => {
    const { id } = await issue(gitProject);
    const r = await mark(person, id, { artifacts: ARTIFACTS });
    expect(r.json.error?.refusals?.[0]?.code ?? null).not.toBe('TARGET_REQUIRED');
    ok(r);
    expect((await row(id))?.merged_at).not.toBeNull();
  });

  it('takes a mark naming nothing at all, and records that it names nothing', async () => {
    const { id } = await issue(gitProject);
    const marked = ok(await mark(agent, id, {}));
    expect(marked.action).toBe('merged');
    expect(marked.said).toEqual({});
    expect(marked.detail).toContain('names no evidence');
    expect((await trailOf(id))?.payload.said).toEqual({});
  });
});

describe('epod ISS-74 end to end: artifacts and a live reading, no commit (outcome 5)', () => {
  it('records the mark as given with who said it, moves to awaiting_release and a release closes it', async () => {
    const { id, seq: n } = await issue(gitProject);
    const { runId } = await liveRun(gitProject, deviceId, n);
    const marked = ok(
      await mark(agent, id, {
        artifacts: ARTIFACTS,
        liveReading: READ_LIVE,
        note: 'Published on the docs store; read live.',
      }),
    );
    expect(marked.action).toBe('merged');
    expect(marked.mark).toBe('asserted');
    expect(marked.artifacts).toEqual(ARTIFACTS);
    expect(marked.said).toEqual({
      artifacts: ARTIFACTS,
      liveReading: READ_LIVE,
      note: 'Published on the docs store; read live.',
    });
    expect(marked.by).toMatchObject({ agency: 'agent', run: runId });
    expect(marked.commitReading).toBeNull();
    expect(marked.detail).toContain(DOCS);

    const trail = await trailOf(id);
    expect(trail?.actor_id).toBe(ownerId);
    expect(trail?.actor_agency).toBe('agent');
    expect(trail?.payload).toMatchObject({
      run: runId,
      said: { artifacts: ARTIFACTS, liveReading: READ_LIVE },
    });

    // where the mark is read: the issue's own detail says what was said, and by whom
    const detail = ok(await person('GET', `/api/issues/${id}`));
    expect(detail.markSaid).toMatchObject({
      by: { agency: 'agent' },
      run: runId,
      said: { artifacts: ARTIFACTS, liveReading: READ_LIVE },
      commitReading: null,
    });

    ok(await move(id, 'awaiting_release'));
    expect((await row(id))?.status).toBe('awaiting_release');
    const recorded = ok(await release(gitProject, [id], '1.43.0'), 201);
    expect(recorded.closed).toEqual([id]);
    expect((await row(id))?.status).toBe('closed');
  });
});

describe('a commit the repository is asked about is a reading on the mark, never its refusal (outcome 2)', () => {
  it("records an agent's mark whose commit core cannot read, which was COMMIT_UNVERIFIED", async () => {
    const { id } = await issue(gitProject);
    const marked = ok(await mark(agent, id, { target: 'main', commit: WHOLE }));
    expect(marked.action).toBe('merged');
    expect(marked.mark).toBe('asserted');
    expect(marked.commitReading).toMatchObject({
      commit: WHOLE,
      outcome: 'unread',
      code: 'COMMIT_UNVERIFIED',
    });
    expect(marked.detail).toContain('COMMIT_UNVERIFIED');
    expect((await trailOf(id))?.payload.commitReading).toMatchObject({ outcome: 'unread' });
    const detail = ok(await person('GET', `/api/issues/${id}`));
    expect(detail.markSaid?.commitReading).toMatchObject({ commit: WHOLE, outcome: 'unread' });
    expect(detail.markedCommit).toEqual({ sha: WHOLE, provenance: 'asserted' });
  });
});

describe('input of the wrong shape is still refused by name at its path (outcome 3)', () => {
  it.each([
    ['a malformed sha', { commit: 'not-a-sha' }, '/commit'],
    ['an unknown field', { landedAt: 'yesterday' }, ''],
    [
      'an artifact without its ref',
      { artifacts: [{ surface: 'ui', change: 'added' }] },
      '/artifacts/0/ref',
    ],
    ['a live reading with no status', { liveReading: { url: DOCS } }, '/liveReading/status'],
    [
      'a live reading that is no URL',
      { liveReading: { url: 'the docs store', status: 200 } },
      '/liveReading/url',
    ],
    [
      'a live reading with an unknown key',
      { liveReading: { ...READ_LIVE, seen: true } },
      '/liveReading',
    ],
  ])('refuses %s and marks nothing', async (_, body, path) => {
    const { id } = await issue(gitProject);
    const r = await mark(agent, id, body);
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    const said = JSON.stringify(r.json);
    if (path) expect(said).toContain(path);
    expect((await row(id))?.merged_at).toBeNull();
  });
});

describe('a close rests on the mark alone (outcome 4)', () => {
  it('moves and closes a mark naming no landing outside git, which was LANDING_REQUIRED then MERGE_NOT_RECORDED', async () => {
    const { id } = await issue(outsideGit);
    const r = await mark(agent, id, { note: 'shipped to the store' });
    expect(r.json.error?.refusals?.[0]?.code ?? null).not.toBe('LANDING_REQUIRED');
    ok(r);
    ok(await move(id, 'awaiting_release'));
    ok(await release(outsideGit, [id], '2.0.0'), 201);
    expect((await row(id))?.status).toBe('closed');
  });

  it('still refuses an issue with no mark at all, by name', async () => {
    const { id } = await issue(gitProject);
    expect(refusalOf(await move(id, 'awaiting_release')).code).toBe('MERGE_NOT_RECORDED');
    expect((await row(id))?.status).toBe('in_progress');
  });

  // ISS-1062: a close is the issue met in scope, made with no release by one who may move it there
  it('closes met in scope on the mark alone, with no release', async () => {
    const { id } = await issue(gitProject);
    ok(await mark(agent, id, { liveReading: READ_LIVE }));
    ok(await move(id, 'awaiting_release'));
    ok(await move(id, 'closed'));
    expect((await row(id))?.status).toBe('closed');
  });
});
