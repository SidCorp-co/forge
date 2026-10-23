/**
 * REQ-63: a project whose document sets `release.changeRequests` releases by merging its change
 * requests, in order, once the owner accepts the release in Forge (owner ruling 2026-10-23). Planted
 * from adminhub-api's stack: one merge request delivers several issues by its branch
 * (`feat/…-iss-1-2`) and its description (`ISS-3`), the issues it ships were closed by hand on a
 * local merge before Forge knew the host, and the owner merges nothing himself any more.
 *
 * Each block drives one BC through its own door against real Postgres. The source host is a planted
 * GitLab that merges what it is asked to and answers the commit it made.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const merged = new Map<number, string>();
const merges: number[] = [];

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  sourceHostForBinding: async () => ({
    provider: 'gitlab',
    words: { mergeMethods: ['merge', 'squash'], changeRequest: 'merge request', sigil: '!' },
    merge: async ({ number }: { number: number }) => {
      merges.push(number);
      const commitSha = `${String(number).padStart(4, '0')}${'c'.repeat(36)}`;
      merged.set(number, commitSha);
      return { kind: 'merged', commitSha, mergedAt: new Date('2026-10-23T09:00:00Z') };
    },
  }),
}));

const BRANCH = 'release/stg';
const HEAD_A = 'a1'.repeat(20);
const HEAD_B = 'b2'.repeat(20);
const HEAD_C = 'c3'.repeat(20);
const NOTE = { section: 'Added', userFacing: 'A site writes through to the catalog.' };

const world = { projectId: '', ownerId: '', token: '', bindingId: '' };

const rows = async <T>(query: ReturnType<typeof sql>) =>
  [...(await db.execute(query))] as unknown as T[];

async function seedWorld(release: Record<string, unknown> | null): Promise<void> {
  await truncateAll();
  merged.clear();
  merges.length = 0;
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
  await seedProjectDocument(world.projectId, world.ownerId, {
    environments: {},
    defaultBranch: BRANCH,
    source: {
      type: 'git',
      git: { repository: 'gitlab.com/acme/canawan-api', defaultBranch: BRANCH, branches: [BRANCH] },
    },
    extra: {
      delivery: { verdictsRequired: false },
      ...(release ? { release } : {}),
    } as never,
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
            ${JSON.stringify({ repository: 'acme/canawan-api' })}::jsonb)
  `);
}

const THROUGH_CHANGE_REQUESTS = { approval: { required: true }, changeRequests: true };

/** An issue at `status`, its release note written; `stamp` writes a local merge with no commit. */
async function issue(seq: number, status: string, stamp = false): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes)
    VALUES (${id}, ${world.projectId}, ${seq}, ${`issue ${seq}`}, 'in_progress', ${world.ownerId},
            ${JSON.stringify(NOTE)}::jsonb)
  `);
  if (stamp) await db.execute(sql`UPDATE issues SET merged_at = now() WHERE id = ${id}`);
  await seedIssueStatus(id, status);
  return id;
}

/** A merge request as the GitLab hook delivers it into the projection. */
async function mergeRequest(number: number, headRef: string, head: string, body: string | null) {
  await applyPullRequestEvent(
    { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
    {
      action: 'open',
      pull_request: {
        number,
        title: `MR ${number}`,
        body,
        html_url: `https://gitlab.com/acme/canawan-api/-/merge_requests/${number}`,
        state: 'open',
        head: { ref: headRef, sha: head },
        base: { ref: BRANCH, sha: 'f'.repeat(40) },
        updated_at: new Date().toISOString(),
      },
      repository: { full_name: 'acme/canawan-api' },
    },
  );
}

const linkedTo = (number: number) =>
  rows<{ key: number; linked_by: string }>(sql`
    SELECT i.iss_seq AS key, l.linked_by FROM repo_pull_request_issues l
      JOIN repo_pull_requests p ON p.id = l.pull_request_id
      JOIN issues i ON i.id = l.issue_id
     WHERE p.project_id = ${world.projectId} AND p.number = ${number}
     ORDER BY i.iss_seq`);

const issueRow = async (id: string) =>
  (
    await rows<{ status: string; merged_at: Date | null; merged_commit_sha: string | null }>(sql`
      SELECT status, merged_at, merged_commit_sha FROM issues WHERE id = ${id}`)
  )[0];

const cut = (issueIds: string[], changeRequests?: number[]) =>
  api(world.token, 'POST', `/api/projects/${world.projectId}/release-batches`, {
    issueIds,
    ...(changeRequests ? { changeRequests } : {}),
  });

const mergeOf = (issueId: string, pullRequest: number) =>
  api(world.token, 'POST', `/api/issues/${issueId}/merge-pull-request`, { pullRequest });

const codeOf = (body: unknown) => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

/** Two requests over three issues: !10 delivers ISS-1 and ISS-2 by branch and ISS-3 by description. */
async function stack() {
  const one = await issue(1, 'awaiting_release');
  const two = await issue(2, 'awaiting_release');
  const three = await issue(3, 'awaiting_release');
  const four = await issue(4, 'awaiting_release');
  await mergeRequest(
    10,
    'feat/req3-site-write-iss-1-2',
    HEAD_A,
    'Also delivers ISS-3. Serves REQ-4.',
  );
  await mergeRequest(11, 'fix/req4-token-iss-4', HEAD_B, null);
  return { one, two, three, four };
}

async function approve(runId: string) {
  const [pending] = await rows<{ id: string }>(sql`
    SELECT id FROM release_approvals WHERE run_id = ${runId} AND decision IS NULL`);
  const res = await api(
    world.token,
    'POST',
    `/api/projects/${world.projectId}/release-batches/${runId}/approvals/${pending?.id}/decision`,
    { decision: 'approve', reason: 'the owner read both merge requests and accepts them' },
  );
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

describe('BC-4: one change request delivers every issue its branch and description name', () => {
  beforeEach(async () => seedWorld(THROUGH_CHANGE_REQUESTS));

  it('links ISS-1 and ISS-2 by the branch and ISS-3 by the description, and not REQ-4', async () => {
    await stack();
    expect(await linkedTo(10)).toEqual([
      { key: 1, linked_by: 'head-ref' },
      { key: 2, linked_by: 'head-ref' },
      { key: 3, linked_by: 'description' },
    ]);
    expect(await linkedTo(11)).toEqual([{ key: 4, linked_by: 'head-ref' }]);
  });

  it('unlinks an issue whose key leaves the description', async () => {
    await stack();
    await mergeRequest(10, 'feat/req3-site-write-iss-1-2', HEAD_A, 'Serves REQ-4.');
    expect((await linkedTo(10)).map((r) => r.key)).toEqual([1, 2]);
  });
});

describe('BC-1: a change-request project releases by approval, with no deploy', () => {
  beforeEach(async () => seedWorld(THROUGH_CHANGE_REQUESTS));

  it('cuts a release that keeps its merge order, asks its approval and runs no job', async () => {
    const { one, two, three, four } = await stack();
    const res = await cut([one, two, three, four], [10, 11]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      jobId: null,
      verification: 'merged',
      changeRequests: [
        { number: 10, label: '!10', headSha: HEAD_A },
        { number: 11, label: '!11', headSha: HEAD_B },
      ],
    });
    const runId = String(res.body.runId);
    expect(await rows(sql`SELECT id FROM jobs WHERE pipeline_run_id = ${runId}`)).toEqual([]);
    expect(
      await rows(sql`
        SELECT evidence_environment, evidence_commit, decision FROM release_approvals
         WHERE run_id = ${runId}`),
    ).toEqual([{ evidence_environment: null, evidence_commit: HEAD_B, decision: null }]);
  });

  it('refuses a roster whose request also carries an issue the release does not', async () => {
    const { one, two } = await stack();
    const res = await cut([one, two]);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('RELEASE_CHANGE_REQUEST_CARRIES_UNRELEASED');
    expect(JSON.stringify(res.body)).toContain('!10 also delivers `ISS-3`');
  });

  it('refuses an issue no open change request delivers', async () => {
    await stack();
    const lone = await issue(9, 'awaiting_release');
    const res = await cut([lone]);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('RELEASE_CHANGE_REQUEST_MISSING');
  });

  it('refuses a declared order that leaves a request out, by name', async () => {
    const { one, two, three, four } = await stack();
    const res = await cut([one, two, three, four], [11]);
    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('RELEASE_CHANGE_REQUEST_ORDER');
  });

  it('refuses the change-request switch without approval required, naming the key', async () => {
    const got = await api(world.token, 'GET', `/api/projects/${world.projectId}/config`);
    const doc = (got.body as { document: Record<string, unknown> }).document;
    const res = await api(world.token, 'PUT', `/api/projects/${world.projectId}/config`, {
      baseRevision: (got.body as { revision: number }).revision,
      document: { ...doc, release: { approval: { required: false }, changeRequests: true } },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('CHANGE_REQUEST_RELEASE_UNSUPPORTED');
  });
});

describe('BC-2: the master merges in declared order, only after approval', () => {
  beforeEach(async () => seedWorld(THROUGH_CHANGE_REQUESTS));

  it('refuses every merge before the approval, and merges nothing', async () => {
    const { one, two, three, four } = await stack();
    expect((await cut([one, two, three, four], [10, 11])).status).toBe(201);
    const res = await mergeOf(one, 10);
    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('RELEASE_MERGE_NOT_APPROVED');
    expect(merges).toEqual([]);
  });

  it('refuses a merge of a request no running release carries', async () => {
    const { four } = await stack();
    const res = await mergeOf(four, 11);
    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('RELEASE_MERGE_UNRELEASED');
    expect(merges).toEqual([]);
  });

  it('refuses the second request before the first, then merges both in order and closes the release', async () => {
    const { one, two, three, four } = await stack();
    const runId = String((await cut([one, two, three, four], [10, 11])).body.runId);
    await approve(runId);

    const early = await mergeOf(four, 11);
    expect(early.status).toBe(422);
    expect(codeOf(early.body)).toBe('RELEASE_MERGE_OUT_OF_ORDER');
    expect(merges).toEqual([]);

    const first = await mergeOf(one, 10);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ release: { runId, settled: false } });
    const last = await mergeOf(four, 11);
    expect(last.status, JSON.stringify(last.body)).toBe(200);
    expect(last.body).toMatchObject({ release: { runId, settled: true } });
    expect(merges).toEqual([10, 11]);

    for (const id of [one, two, three, four]) expect((await issueRow(id))?.status).toBe('closed');
    const [run] = await rows<{ status: string; shipped: boolean }>(sql`
      SELECT status, release_released_at IS NOT NULL AS shipped FROM pipeline_runs WHERE id = ${runId}`);
    expect(run).toEqual({ status: 'completed', shipped: true });
  });

  it('leaves a project that does not release through change requests merging as before', async () => {
    await seedWorld({ approval: { required: true } });
    const { one } = await stack();
    const res = await mergeOf(one, 10);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(merges).toEqual([10]);
  });
});

describe('BC-3: a reopen supersedes the local merge stamp, and the merge records the host commit', () => {
  beforeEach(async () => seedWorld(THROUGH_CHANGE_REQUESTS));

  it('clears the stamp on reopen, keeps it on the record, and stamps the host commit on merge', async () => {
    const closed = await issue(1, 'closed', true);
    await mergeRequest(10, 'feat/req3-site-write-iss-1', HEAD_C, null);

    const reopened = await api(world.token, 'POST', `/api/issues/${closed}/transition`, {
      toStatus: 'reopen',
      reason: 'merged locally before Forge knew GitLab; it ships through !10 now',
    });
    expect(reopened.status, JSON.stringify(reopened.body)).toBeLessThan(300);
    expect(await issueRow(closed)).toMatchObject({ merged_at: null, merged_commit_sha: null });
    const [event] = await rows<{ payload: { before: { mergedAt: string | null } } }>(sql`
      SELECT payload FROM pipeline_outbox
       WHERE issue_id = ${closed} AND type = 'issue.updated'
         AND payload->'fields' ? 'mergedTarget'`);
    expect(event?.payload.before.mergedAt).not.toBeNull();

    await seedIssueStatus(closed, 'in_progress');
    const waiting = await api(world.token, 'POST', `/api/issues/${closed}/transition`, {
      toStatus: 'awaiting_release',
    });
    expect(waiting.status, JSON.stringify(waiting.body)).toBeLessThan(300);

    const runId = String((await cut([closed])).body.runId);
    await approve(runId);
    expect((await mergeOf(closed, 10)).status).toBe(200);
    expect(await issueRow(closed)).toMatchObject({
      status: 'closed',
      merged_commit_sha: merged.get(10),
    });
  });
});

describe('BC-5: the release page and Approvals show each issue with its change request', () => {
  beforeEach(async () => seedWorld(THROUGH_CHANGE_REQUESTS));

  it('names each issue’s request, its link, state and place in the order', async () => {
    const { one, two, three, four } = await stack();
    const res = await cut([one, two, three, four], [10, 11]);
    const version = String(res.body.version);

    const page = await api(
      world.token,
      'GET',
      `/api/projects/${world.projectId}/releases/${version}`,
    );
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    const release = page.body.release as { issues: Array<{ key: string; changeRequest: unknown }> };
    const shown = release.issues.map((i) => [i.key, i.changeRequest]);
    const mr = (number: number, order: number) => ({
      label: `!${number}`,
      number,
      title: `MR ${number}`,
      url: `https://gitlab.com/acme/canawan-api/-/merge_requests/${number}`,
      state: 'open',
      order,
    });
    expect(Object.fromEntries(shown)).toEqual({
      'ISS-1': mr(10, 1),
      'ISS-2': mr(10, 1),
      'ISS-3': mr(10, 1),
      'ISS-4': mr(11, 2),
    });

    const decisions = await api(
      world.token,
      'GET',
      `/api/projects/${world.projectId}/needs-you/decisions`,
    );
    expect(decisions.status, JSON.stringify(decisions.body)).toBe(200);
    const text = JSON.stringify(decisions.body);
    expect(text).toContain('so the master merges !10, !11 in that order');
    expect(text).toContain(
      JSON.stringify({
        label: '!10',
        url: 'https://gitlab.com/acme/canawan-api/-/merge_requests/10',
        state: 'open',
        order: 1,
        issues: ['ISS-1', 'ISS-2', 'ISS-3'],
      }),
    );
  });
});
