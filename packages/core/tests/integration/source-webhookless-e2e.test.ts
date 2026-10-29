/**
 * A source binding no webhook reaches (adminhub-fe → sidcorp-it/canawan-admin-hub-fe, 2026-10-26):
 * its master could not read a pipeline, fix or close a merge request opened with a wrong body, or
 * project one opened outside Forge, and each gap ended in a hand DB write. Driven here through the
 * source door against real Postgres, the host a planted GitLab answering from its own state.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { mergeStoredChangeRequest } from '../../src/integrations/source-host/merge.js';
import { readPullRequestsForIssues } from '../../src/integrations/source-host/repo-projection.js';
import type { HostCheck, ReadChangeRequest } from '../../src/integrations/source-host/types.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';

const HEAD = 'a1'.repeat(20);
const HEAD_2 = 'a2'.repeat(20);
const BASE = 'b'.repeat(40);
const LANDING = 'c'.repeat(40);

const world = { projectId: '', ownerId: '', token: '', bindingId: '', otherSlug: '' };
const requests = new Map<number, ReadChangeRequest>();
const checks = new Map<string, HostCheck[]>();
/** A merge request's own pipeline, run at a merge ref no head `sha` read finds (GitLab's merge request pipelines). */
const ownPipelines = new Map<number, HostCheck>();
let clock = Date.parse('2026-10-26T08:00:00Z');
const tick = () => {
  clock += 1000;
  return new Date(clock).toISOString();
};

const planted = {
  provider: 'gitlab' as const,
  get bindingId() {
    return world.bindingId;
  },
  fullName: 'sidcorp-it/canawan-admin-hub-fe',
  host: 'gitlab.example',
  words: { changeRequest: 'merge request', sigil: '!', mergeMethods: ['merge', 'squash'] },
  sameTree: async () => true,
  readChecks: async (sha: string) => checks.get(sha) ?? [],
  readChangeRequestChecks: async ({ number, headSha }: { number: number; headSha: string }) => {
    const own = ownPipelines.get(number);
    return [...(checks.get(headSha) ?? []), ...(own ? [{ ...own, headSha }] : [])];
  },
  readChangeRequest: async (number: number) => {
    const mr = requests.get(number);
    if (!mr) throw new Error(`no merge request !${number} planted`);
    return { ...mr };
  },
  updateChangeRequest: async (args: { number: number; title?: string; body?: string }) => {
    const mr = requests.get(args.number) as ReadChangeRequest;
    const next = {
      ...mr,
      ...(args.title === undefined ? {} : { title: args.title }),
      ...(args.body === undefined ? {} : { body: args.body }),
      updatedAt: tick(),
    };
    requests.set(args.number, next);
    return { ...next };
  },
  closeChangeRequest: async ({ number }: { number: number }) => {
    const next = {
      ...(requests.get(number) as ReadChangeRequest),
      state: 'closed',
      updatedAt: tick(),
    };
    requests.set(number, next);
    return { ...next };
  },
  merge: async ({ number }: { number: number }) => ({
    kind: 'merged' as const,
    commitSha: LANDING,
    mergedAt: new Date(tick()),
    target: requests.get(number)?.baseRef ?? 'release/stg',
    head: requests.get(number)?.headSha ?? null,
  }),
};

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => planted,
  sourceHostForBinding: async () => planted,
}));

const rows = async <T>(query: ReturnType<typeof sql>) =>
  [...(await db.execute(query))] as unknown as T[];

function mergeRequest(number: number, over: Partial<ReadChangeRequest> = {}): void {
  requests.set(number, {
    number,
    url: `https://gitlab.example/sidcorp-it/canawan-admin-hub-fe/-/merge_requests/${number}`,
    title: `MR ${number}`,
    state: 'open',
    draft: false,
    headRef: 'feat/admin-login-iss-1',
    headSha: HEAD,
    baseRef: 'release/stg',
    baseSha: BASE,
    updatedAt: tick(),
    body: null,
    mergedAt: null,
    mergeCommitSha: null,
    ...over,
  });
}

const pipeline = (id: number, sha: string, status: string, conclusion: string | null) => ({
  id: String(id),
  name: 'pipeline',
  app: 'gitlab-ci',
  headSha: sha,
  status,
  conclusion,
  detailsUrl: `https://gitlab.example/p/${id}`,
  startedAt: '2026-10-26T08:00:00.000Z',
  completedAt: status === 'completed' ? '2026-10-26T08:05:00.000Z' : null,
});

async function issue(seq: number): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${world.projectId}, ${seq}, ${`issue ${seq}`}, 'in_progress', ${world.ownerId})
  `);
  await seedIssueStatus(id, 'in_progress');
  return id;
}

const door = (path: string) =>
  `/api/projects/${world.projectId}/integrations/source/change-requests/${path}`;

const row = async (number: number) =>
  (
    await rows<{
      id: string;
      state: string;
      title: string;
      merge_commit_sha: string | null;
      checks: Record<string, HostCheck>;
    }>(sql`
      SELECT id, state, title, merge_commit_sha, checks FROM repo_pull_requests
       WHERE binding_id = ${world.bindingId} AND number = ${number}`)
  )[0];

const linked = async (number: number) =>
  rows<{ key: number; linked_by: string }>(sql`
    SELECT i.iss_seq AS key, l.linked_by FROM repo_pull_request_issues l
      JOIN repo_pull_requests p ON p.id = l.pull_request_id
      JOIN issues i ON i.id = l.issue_id
     WHERE p.binding_id = ${world.bindingId} AND p.number = ${number}
     ORDER BY i.iss_seq`);

beforeEach(async () => {
  await truncateAll();
  requests.clear();
  checks.clear();
  ownPipelines.clear();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  world.otherSlug = (await createTestProject(world.ownerId)).slug;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
  const connectionId = randomUUID();
  world.bindingId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connectionId}, 'user', ${world.ownerId}, 'gitlab', true)
  `);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${world.bindingId}, ${connectionId}, ${world.projectId}, 'gitlab', 'source', true,
            ${JSON.stringify({ projectPath: 'sidcorp-it/canawan-admin-hub-fe' })}::jsonb)
  `);
});

describe('refresh: a merge request opened outside Forge, projected by its number', () => {
  it('writes the row, its links by one rule, and its pipeline in the shape a hook stores', async () => {
    const one = await issue(1);
    await issue(2);
    await issue(3);
    mergeRequest(12, { body: `Delivers ISS-2.\nPairs with ${world.otherSlug} ISS-3.` });
    checks.set(HEAD, [pipeline(901, HEAD, 'completed', 'success')]);

    const res = await api(world.token, 'POST', door('12/refresh'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      number: 12,
      projection: { outcome: 'recorded', state: 'open', checks: { outcome: 'stored', checks: 1 } },
    });
    expect(await linked(12)).toEqual([
      { key: 1, linked_by: 'head-ref' },
      { key: 2, linked_by: 'description' },
    ]);
    expect((await row(12))?.checks).toEqual({ '901': pipeline(901, HEAD, 'completed', 'success') });
    const read = (await readPullRequestsForIssues([one])).get(one);
    expect(read?.[0]?.checks).toEqual({ total: 1, success: 1, failure: 0, pending: 0 });
  });

  it('records a merge made on the host, with its landing, and reports it as information', async () => {
    await issue(1);
    mergeRequest(14, {
      state: 'merged',
      mergedAt: '2026-10-26T09:00:00.000Z',
      mergeCommitSha: LANDING,
    });
    const res = await api(world.token, 'POST', door('14/refresh'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await row(14)).toMatchObject({ state: 'merged', merge_commit_sha: LANDING });
    const facts = await rows<{ payload: { commitSha: string; headRef: string } }>(sql`
      SELECT payload FROM pipeline_outbox
       WHERE type = 'source.merged' AND project_id = ${world.projectId}`);
    expect(facts.map((f) => f.payload)).toMatchObject([
      { commitSha: LANDING, headRef: 'feat/admin-login-iss-1' },
    ]);
  });

  it('refuses a request the host answers without a base, and writes nothing', async () => {
    mergeRequest(15, { baseSha: null });
    const res = await api(world.token, 'POST', door('15/refresh'));
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('base sha');
    expect(await row(15)).toBeUndefined();
  });
});

describe('edit and close: a merge request opened with the wrong body', () => {
  it('re-projects the links from the edited description', async () => {
    await issue(1);
    await issue(2);
    mergeRequest(12, { body: 'Delivers ISS-2.' });
    await api(world.token, 'POST', door('12/refresh'));
    expect((await linked(12)).map((l) => l.key)).toEqual([1, 2]);

    const res = await api(world.token, 'PATCH', door('12'), {
      title: 'feat: admin login',
      body: `Pairs with ${world.otherSlug} ISS-2.`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      title: 'feat: admin login',
      projection: { outcome: 'recorded' },
    });
    expect((await linked(12)).map((l) => l.key)).toEqual([1]);
    expect((await row(12))?.title).toBe('feat: admin login');
  });

  it('closes it, and the projection says closed', async () => {
    await issue(1);
    mergeRequest(12);
    const res = await api(world.token, 'POST', door('12/close'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ state: 'closed', projection: { state: 'closed' } });
    expect((await row(12))?.state).toBe('closed');
  });
});

describe('Forge’s own merge on a binding with no hook', () => {
  it('stores what the host says about the merged head’s checks', async () => {
    await issue(1);
    mergeRequest(16, { headSha: HEAD_2 });
    await api(world.token, 'POST', door('16/refresh'));
    checks.set(HEAD_2, [pipeline(950, HEAD_2, 'in_progress', null)]);

    const stored = await row(16);
    const outcome = await mergeStoredChangeRequest(
      { pullRequestId: stored?.id as string, requestedBy: `user:${world.ownerId}` },
      async () => ({ wrote: false }),
    );
    expect(outcome).toMatchObject({
      kind: 'merged',
      checks: { outcome: 'stored', headSha: HEAD_2, checks: 1 },
    });
    expect((await row(16))?.checks).toEqual({ '950': pipeline(950, HEAD_2, 'in_progress', null) });
  });
});

// adminhub-api → sidcorp-it/canawan-api, 2026-10-28: MR 5047 merged through Forge stored `checks: 0`,
// its pipeline having run as a merge request pipeline the head's commit read never finds (REQ-63 BC-7)
describe('the merge request pipeline at the merged head (REQ-63 BC-7)', () => {
  it('stores the request’s own pipeline at the head Forge merged, not none', async () => {
    await issue(1);
    mergeRequest(5047, { headSha: HEAD_2 });
    await api(world.token, 'POST', door('5047/refresh'));
    ownPipelines.set(5047, pipeline(3000879911, LANDING, 'completed', 'success'));

    const stored = await row(5047);
    const outcome = await mergeStoredChangeRequest(
      { pullRequestId: stored?.id as string, requestedBy: `user:${world.ownerId}` },
      async () => ({ wrote: false }),
    );
    expect(outcome).toMatchObject({
      kind: 'merged',
      checks: { outcome: 'stored', headSha: HEAD_2, checks: 1 },
    });
    expect((await row(5047))?.checks).toEqual({
      '3000879911': pipeline(3000879911, HEAD_2, 'completed', 'success'),
    });
  });

  it('refresh reads the same pipeline for a request it projects', async () => {
    await issue(1);
    mergeRequest(5048);
    ownPipelines.set(5048, pipeline(3000869553, LANDING, 'completed', 'success'));
    const res = await api(world.token, 'POST', door('5048/refresh'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ projection: { checks: { outcome: 'stored', checks: 1 } } });
  });
});

describe('a change request read by its number (REQ-63 BC-8)', () => {
  it('answers its title, description and state to a member, and writes nothing', async () => {
    mergeRequest(21, { title: 'fix: login', body: 'Delivers ISS-1\n\nWhy: the session expired.' });
    const res = await api(world.token, 'GET', door('21'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      number: 21,
      title: 'fix: login',
      body: 'Delivers ISS-1\n\nWhy: the session expired.',
      state: 'open',
      headRef: 'feat/admin-login-iss-1',
    });
    expect(await row(21)).toBeUndefined();
  });

  it('refuses a caller who is not a member of the project', async () => {
    mergeRequest(22);
    const stranger = await userToken((await createTestUser({ verified: true })).id);
    const res = await api(stranger, 'GET', door('22'));
    expect([403, 404]).toContain(res.status);
  });
});
