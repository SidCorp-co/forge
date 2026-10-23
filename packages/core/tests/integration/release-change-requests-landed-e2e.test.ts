/**
 * REQ-71 (REQ-63 BC-3): on a project that releases by merging its change requests, nothing reads
 * as landed before the host merges. Planted from catalog-api ISS-12 on dev (2026-10-23): at
 * `reopen`, `merged_at` 2026-10-22T12:29:13Z from a box's mark, `merged_target` dev,
 * `merged_commit_sha` NULL, its commit only ever on local-bare and on no GitLab branch or MR. The
 * standings read it as `landed · claim it and judge what landed`, and the steward asked the master
 * to judge a landing that does not exist. The reopen that should have superseded the stamp ran on
 * 2026-10-22 at 11:26, before the supersede shipped, and the box marked it again at 12:29.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// the repository host as the binding reads it: which branches hold a commit, or a read that fails
const host = vi.hoisted(() => ({
  branches: new Set<string>(),
  fail: null as Error | null,
  checked: [] as string[],
}));

vi.mock('../../src/integrations/source-host/index.js', async (original) => ({
  ...(await original<typeof import('../../src/integrations/source-host/index.js')>()),
  resolveSourceHost: async () => ({
    fullName: 'acme/catalog-api',
    provider: 'gitlab',
    readCommit: async (ref: string) => ({
      sha: ref.length === 40 ? ref : C988,
      message: 'docs(api): Scribe for the admin REST API',
      committedAt: '2026-10-23T08:00:00Z',
    }),
    branchContains: async (branch: string, sha: string) => {
      if (host.fail) throw host.fail;
      host.checked.push(`${branch}@${sha}`);
      return host.branches.has(branch);
    },
    readFile: async (path: string) => ({ missing: `${path} is not read here` }),
  }),
}));

let reconcileIdleIssues: typeof import('../../src/pipeline/idle-issues.js').reconcileIdleIssues;
let detectOwedCloses: typeof import('../../src/pipeline/stranded-issues.js').detectOwedCloses;

const BRANCH = 'dev';
const LOCAL = 'c451bfea41052afffd496326c04e02db12652590';
const HOST_MERGE = 'a'.repeat(40);
const C988 = 'c988d627e2b0a3f4c5d6e7f8091a2b3c4d5e6f70';
const JUDGE_WHAT_LANDED = 'judge what landed';

const world = { projectId: '', ownerId: '', token: '', bindingId: '' };

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ({ reconcileIdleIssues } = await import('../../src/pipeline/idle-issues.js'));
  ({ detectOwedCloses } = await import('../../src/pipeline/stranded-issues.js'));
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function seedWorld(release: Record<string, unknown>): Promise<void> {
  await truncateAll();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
  await seedProjectDocument(world.projectId, world.ownerId, {
    environments: {},
    defaultBranch: BRANCH,
    source: {
      type: 'git',
      git: { repository: 'gitlab.com/acme/catalog-api', defaultBranch: BRANCH, branches: [BRANCH] },
    },
    extra: { release } as never,
  });
  const connectionId = randomUUID();
  world.bindingId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connectionId}, 'user', ${world.ownerId}, 'gitlab', true)
  `);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${world.bindingId}, ${connectionId}, ${world.projectId}, 'gitlab', 'source', true,
            ${JSON.stringify({ repository: 'acme/catalog-api' })}::jsonb)
  `);
}

/** ISS-12 as dev held it: at `status`, a box's local stamp on `dev` a day old, no host commit. */
async function iss12(status = 'reopen'): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${world.projectId}, 12, 'Document the admin REST API with Scribe', 'open', ${world.ownerId})
  `);
  await seedIssueStatus(id, status);
  await db.execute(sql`
    UPDATE issues
       SET merged_at = now() - interval '1 day', merged_target = ${BRANCH},
           merged_paths = ${JSON.stringify({ read: 'box', commit: LOCAL, changes: [{ path: 'CLAUDE.md', change: 'changed' }] })}::jsonb,
           updated_at = now() - interval '7 hours'
     WHERE id = ${id}
  `);
  return id;
}

/** A change request merged on the host at `mergedAt`, linked to `issueId` where one is named. */
async function mergedRequest(issueId: string | null, mergedAt: string): Promise<void> {
  await applyPullRequestEvent(
    { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
    {
      action: 'update',
      pull_request: {
        number: 1014,
        title: 'ISS-12: document the admin REST API',
        body: '',
        html_url: 'https://gitlab.com/acme/catalog-api/-/merge_requests/1014',
        state: 'closed',
        merged: true,
        merged_at: mergedAt,
        merge_commit_sha: HOST_MERGE,
        head: { ref: 'feat/iss-12-scribe', sha: 'b'.repeat(40) },
        base: { ref: BRANCH, sha: 'f'.repeat(40) },
        updated_at: mergedAt,
      },
      repository: { full_name: 'acme/catalog-api' },
    } as never,
  );
  if (issueId === null) return;
  await db.execute(sql`
    INSERT INTO repo_pull_request_issues (pull_request_id, issue_id, linked_by)
    SELECT id, ${issueId}, 'description' FROM repo_pull_requests WHERE project_id = ${world.projectId} AND number = 1014
    ON CONFLICT DO NOTHING
  `);
}

async function standingsOf(): Promise<string> {
  const res = await api(world.token, 'GET', `/api/projects/${world.projectId}/standings`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const { standings } = res.body as { standings: { subject: { key: string } }[] };
  const mine = standings.find((i) => i.subject.key === 'ISS-12');
  expect(mine, JSON.stringify(res.body)).toBeDefined();
  return JSON.stringify(mine);
}

async function strandOf(id: string) {
  const [row] = await rows<{ strand: { waitingFor: string; evidence: { merged: boolean } } }>(sql`
    SELECT session_context -> 'strand' AS strand FROM issues WHERE id = ${id}
  `);
  return row?.strand;
}

describe('REQ-71: on a change-request project a local stamp is not a landing', () => {
  beforeEach(() => seedWorld({ approval: { required: true }, changeRequests: true }));

  it('does not ask anyone to judge ISS-12’s local stamp, in the standings the steward reads', async () => {
    await iss12();
    expect(await standingsOf()).not.toContain(JUDGE_WHAT_LANDED);
  });

  it('does not record the local stamp as landed in the idle sweep’s finding', async () => {
    const id = await iss12();
    await reconcileIdleIssues(new Date(), { projectId: world.projectId });
    const strand = await strandOf(id);
    expect(strand, JSON.stringify(strand)).toBeDefined();
    expect(strand?.evidence.merged).toBe(false);
    expect(strand?.waitingFor).not.toContain(JUDGE_WHAT_LANDED);
  });

  it('does not report ISS-12 as shipped and owed a close', async () => {
    await iss12();
    const found = await detectOwedCloses(new Date(), { projectId: world.projectId });
    expect(found.detected).toBe(0);
  });

  it('refuses awaiting_release on the local stamp alone, naming the host merge it waits for', async () => {
    const id = await iss12('in_progress');
    const res = await api(world.token, 'POST', `/api/issues/${id}/transition`, {
      toStatus: 'awaiting_release',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(JSON.stringify(res.body)).toContain('MERGE_NOT_RECORDED');
    expect(JSON.stringify(res.body)).toContain('change request');
  });

  it('lets ISS-12 wait at awaiting_release on an open change request that links it', async () => {
    const id = await iss12('in_progress');
    await applyPullRequestEvent(
      { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
      {
        action: 'update',
        pull_request: {
          number: 1015,
          title: 'ISS-12: document the admin REST API',
          body: '',
          html_url: 'https://gitlab.com/acme/catalog-api/-/merge_requests/1015',
          state: 'open',
          head: { ref: 'feat/iss-12-scribe', sha: 'c'.repeat(40) },
          base: { ref: BRANCH, sha: 'f'.repeat(40) },
          updated_at: new Date().toISOString(),
        },
        repository: { full_name: 'acme/catalog-api' },
      },
    );
    await db.execute(sql`
      INSERT INTO repo_pull_request_issues (pull_request_id, issue_id, linked_by)
      SELECT id, ${id}, 'description' FROM repo_pull_requests WHERE project_id = ${world.projectId} AND number = 1015
      ON CONFLICT DO NOTHING
    `);
    const res = await api(world.token, 'POST', `/api/issues/${id}/transition`, {
      toStatus: 'awaiting_release',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('supersedes the stamp on a recovery back to reopen, as on every other reopen', async () => {
    const id = await iss12('in_progress');
    const res = await api(world.token, 'POST', `/api/issues/${id}/transition`, {
      toStatus: 'reopen',
      recovery: true,
      reason: 'the run ended without moving it',
    });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const [row] = await rows<{ merged_at: string | null; merged_target: string | null }>(sql`
      SELECT merged_at, merged_target FROM issues WHERE id = ${id}
    `);
    expect(row).toEqual({ merged_at: null, merged_target: null });
  });

  it('reads the host’s merge commit as landed', async () => {
    const id = await iss12();
    await db.execute(sql`UPDATE issues SET merged_commit_sha = ${HOST_MERGE} WHERE id = ${id}`);
    expect(await standingsOf()).toContain(JUDGE_WHAT_LANDED);
  });

  it('reads a linked request the host merged after the stamp as landed', async () => {
    const id = await iss12();
    await mergedRequest(id, new Date().toISOString());
    expect(await standingsOf()).toContain(JUDGE_WHAT_LANDED);
  });

  it('does not read a request merged before the stamp, an earlier delivery, as this landing', async () => {
    const id = await iss12();
    await mergedRequest(id, new Date(Date.now() - 3 * 86_400_000).toISOString());
    expect(await standingsOf()).not.toContain(JUDGE_WHAT_LANDED);
  });
});

/** A fresh ISS-12 at in_progress with no stamp, for a mark to be sent at. */
async function unmarked(): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${world.projectId}, 12, 'Document the admin REST API with Scribe', 'open', ${world.ownerId})
  `);
  await seedIssueStatus(id, 'in_progress');
  return id;
}

async function stampOf(id: string) {
  const [row] = await rows<{ merged_at: string | null; merged_commit_sha: string | null }>(sql`
    SELECT merged_at::text, merged_commit_sha FROM issues WHERE id = ${id}
  `);
  return row;
}

describe('REQ-71: on a change-request project a mark names a host merge or is refused', () => {
  beforeEach(async () => {
    host.branches = new Set();
    host.fail = null;
    host.checked = [];
    await seedWorld({ approval: { required: true }, changeRequests: true });
  });

  it('takes a commit the host’s target branch contains, recorded as that landing', async () => {
    const id = await unmarked();
    host.branches = new Set([BRANCH, 'release/production']);
    const res = await api(world.token, 'POST', `/api/issues/${id}/merge`, {
      target: BRANCH,
      commit: 'c988d627',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(host.checked).toEqual([`${BRANCH}@${C988}`]);
    expect((await stampOf(id))?.merged_commit_sha).toBe(C988);
  });

  it('refuses a commit the host holds on another branch only, naming what it checked', async () => {
    const id = await unmarked();
    host.branches = new Set(['feat/iss-12-scribe']);
    const res = await api(world.token, 'POST', `/api/issues/${id}/merge`, {
      target: BRANCH,
      commit: C988,
    });
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    const said = JSON.stringify(res.body);
    expect(said).toContain('MARK_NOT_A_HOST_MERGE');
    expect(said).toContain('Checked gitlab acme/catalog-api');
    expect(said).toContain(`does not contain`);
    expect((await stampOf(id))?.merged_at).toBeNull();
  });

  it('refuses by name, never accepts, where the host cannot be read', async () => {
    const id = await unmarked();
    host.fail = new Error('GitLab answered 503 for /repository/commits/c988d627/refs');
    const res = await api(world.token, 'POST', `/api/issues/${id}/merge`, {
      target: BRANCH,
      commit: C988,
    });
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    const said = JSON.stringify(res.body);
    expect(said).toContain('MARK_HOST_UNREACHABLE');
    expect(said).toContain('503');
    expect((await stampOf(id))?.merged_at).toBeNull();
  });

  it('refuses ISS-12’s local mark by name, writing nothing, and says to open a change request', async () => {
    const id = await unmarked();
    const res = await api(world.token, 'POST', `/api/issues/${id}/merge`, {
      target: BRANCH,
      commit: LOCAL,
    });
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    const said = JSON.stringify(res.body);
    expect(said).toContain('MARK_NOT_A_HOST_MERGE');
    expect(said).toContain('change request that links this issue');
    expect(said).toContain('merge-pull-request');
    expect(await stampOf(id)).toEqual({ merged_at: null, merged_commit_sha: null });
  });

  it('refuses a bare mark naming no commit the same way', async () => {
    const id = await unmarked();
    const res = await api(world.token, 'POST', `/api/issues/${id}/merge`, { target: BRANCH });
    expect(JSON.stringify(res.body)).toContain('MARK_NOT_A_HOST_MERGE');
    expect((await stampOf(id))?.merged_at).toBeNull();
  });

  it('takes a mark naming a host merge commit, recorded as that merge', async () => {
    const id = await unmarked();
    await mergedRequest(null, new Date().toISOString());
    const res = await api(world.token, 'POST', `/api/issues/${id}/merge`, {
      target: BRANCH,
      commit: HOST_MERGE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stampOf(id))?.merged_commit_sha).toBe(HOST_MERGE);
  });

  it('takes a mark over the host merge of a request linking the issue', async () => {
    const id = await unmarked();
    await mergedRequest(id, new Date().toISOString());
    const res = await api(world.token, 'POST', `/api/issues/${id}/merge`, { target: BRANCH });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stampOf(id))?.merged_commit_sha).toBe(HOST_MERGE);
  });

  it('keeps a design approval’s stamp, which is the approval’s own write', async () => {
    const id = await unmarked();
    const { markApprovedDesign } = await import('../../src/issues/design-landing.js');
    const outcome = await db.transaction((tx) =>
      markApprovedDesign(tx, {
        issueId: id,
        flow: 'admin-rest',
        revision: 2,
        actor: { type: 'user', id: world.ownerId } as never,
        builds: null,
      }),
    );
    expect(outcome.action).toBe('marked');
    expect((await stampOf(id))?.merged_at).not.toBeNull();
  });
});

describe('on any other project the stamp is the landing, as before', () => {
  beforeEach(() => seedWorld({ approval: { required: true } }));

  it('asks the next run to judge what landed on ISS-12', async () => {
    const id = await iss12();
    expect(await standingsOf()).toContain(JUDGE_WHAT_LANDED);
    await reconcileIdleIssues(new Date(), { projectId: world.projectId });
    expect((await strandOf(id))?.evidence.merged).toBe(true);
  });

  it('takes ISS-12’s local mark, as before', async () => {
    const id = await unmarked();
    const res = await api(world.token, 'POST', `/api/issues/${id}/merge`, {
      target: BRANCH,
      commit: LOCAL,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stampOf(id))?.merged_at).not.toBeNull();
  });

  it('reports an owed close for a stamped issue left at a live status', async () => {
    await iss12();
    const found = await detectOwedCloses(new Date(), { projectId: world.projectId });
    expect(found.detected).toBe(1);
  });
});
