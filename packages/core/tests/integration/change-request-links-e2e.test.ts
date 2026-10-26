/**
 * ISS-705 (FB-295, REQ-63 BC-4): a change request links the issues it delivers and nothing else, its
 * branch issue first, and a person can take a stray link off it before the merge stamps it.
 *
 * Planted from adminhub-fe's !1979: branch `fix/iss-37-…`, a description that delivers ISS-37 and
 * names, as prose, a beta key (ISS-38) and two keys of adminhub-api (ISS-11, ISS-18). The issues'
 * ids are chosen so ISS-11 sorts first, which is the primary the projection answered at the time.
 *
 * Every block drives the request through the doors a client sends: the open, the link list, the
 * unlink and relink, the delivery that rewrites the links, and the merge. The host is a planted
 * GitLab that opens what it is asked to and merges what it is asked to.
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

const host = { opened: 0, merges: [] as number[] };
const BASE = 'dev';
const BASE_SHA = 'f'.repeat(40);
const headOf = (number: number) => `${String(number).padStart(4, '0')}${'a'.repeat(36)}`;
const mergeCommitOf = (number: number) => `${String(number).padStart(4, '0')}${'c'.repeat(36)}`;

const world = { projectId: '', otherProjectId: '', ownerId: '', token: '', bindingId: '' };

const plantedGitLab = () => ({
  bindingId: world.bindingId,
  provider: 'gitlab' as const,
  fullName: 'acme/adminhub-fe',
  words: { mergeMethods: ['merge', 'squash'], changeRequest: 'merge request', sigil: '!' },
  openChangeRequest: async (args: { head: string; base: string; title: string }) => {
    host.opened += 1;
    const number = 1978 + host.opened;
    return {
      number,
      url: `https://gitlab.com/acme/adminhub-fe/-/merge_requests/${number}`,
      title: args.title,
      state: 'open',
      draft: false,
      headRef: args.head,
      headSha: headOf(number),
      baseRef: args.base,
      baseSha: BASE_SHA,
      updatedAt: '2026-10-26T08:00:00.000Z',
    };
  },
  merge: async ({ number }: { number: number }) => {
    host.merges.push(number);
    return {
      kind: 'merged',
      commitSha: mergeCommitOf(number),
      mergedAt: new Date('2026-10-26T09:00:00Z'),
      target: BASE,
      head: headOf(number),
    };
  },
  sameTree: async () => true,
});

vi.mock('../../src/integrations/source-host/index.js', async (original) => ({
  ...(await original<typeof import('../../src/integrations/source-host/index.js')>()),
  resolveSourceHost: async () => plantedGitLab(),
}));
vi.mock('../../src/integrations/source-host/resolve.js', async (original) => ({
  ...(await original<typeof import('../../src/integrations/source-host/resolve.js')>()),
  sourceHostForBinding: async () => plantedGitLab(),
}));

const rows = async <T>(query: ReturnType<typeof sql>) =>
  [...(await db.execute(query))] as unknown as T[];

/** The ids sort ISS-11 < ISS-18 < ISS-37 < ISS-38, the order the stored links were read back in. */
const ID = {
  11: '11111111-0000-4000-8000-000000000011',
  18: '22222222-0000-4000-8000-000000000018',
  37: '33333333-0000-4000-8000-000000000037',
  38: '44444444-0000-4000-8000-000000000038',
} as const;
type Seq = keyof typeof ID;

async function seedWorld(): Promise<void> {
  await truncateAll();
  host.opened = 0;
  host.merges.length = 0;
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  world.otherProjectId = (await createTestProject(world.ownerId)).id;
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
            ${JSON.stringify({ repository: 'acme/adminhub-fe' })}::jsonb)
  `);
  // one statement, so every row carries the same created_at, as one delivery's links did
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES ${sql.join(
      (Object.keys(ID) as unknown as Seq[]).map(
        (seq) =>
          sql`(${ID[seq]}, ${world.projectId}, ${Number(seq)}, ${`issue ${seq}`}, 'in_progress', ${world.ownerId})`,
      ),
      sql`, `,
    )}
  `);
  for (const seq of Object.keys(ID) as unknown as Seq[]) {
    await seedIssueStatus(ID[seq], 'in_progress');
  }
}

/** The description !1979 was opened with, in the shape adminhub-fe's master wrote it. */
const NINETEEN_SEVENTY_NINE = [
  'Closes ISS-37.',
  '',
  'The beta carries the same defect as ISS-38, which lands in its own merge request.',
  'This calls the two endpoints adminhub-api ISS-11 and adminhub-api ISS-18 added:',
  '- adminhub-api ISS-11',
  '- adminhub-api ISS-18',
].join('\n');

const crPath = (suffix = '') =>
  `/api/projects/${world.projectId}/integrations/source/change-requests${suffix}`;

async function open(head: string, body: string | null) {
  const res = await api(world.token, 'POST', crPath(), {
    head,
    base: BASE,
    title: `MR on ${head}`,
    ...(body === null ? {} : { body }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    number: number;
    projection: { outcome: string; issueId: string | null; issueIds: string[] };
  };
}

/** The links Forge holds for the request, by key, in the order it reads them. */
const linkedTo = async (number: number) =>
  (
    await rows<{ key: number }>(sql`
      SELECT i.iss_seq AS key FROM repo_pull_request_issues l
        JOIN repo_pull_requests p ON p.id = l.pull_request_id
        JOIN issues i ON i.id = l.issue_id
       WHERE p.project_id = ${world.projectId} AND p.number = ${number}
       ORDER BY i.iss_seq`)
  ).map((r) => Number(r.key));

const codeOf = (body: unknown) => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

/** The host's later delivery of the same request: the links are rewritten from branch and body. */
async function redeliver(number: number, headRef: string, body: string) {
  await applyPullRequestEvent(
    { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
    {
      action: 'update',
      pull_request: {
        number,
        title: `MR on ${headRef}`,
        body,
        state: 'open',
        head: { ref: headRef, sha: headOf(number) },
        base: { ref: BASE, sha: BASE_SHA },
        updated_at: '2026-10-26T08:30:00.000Z',
      },
      repository: { full_name: 'acme/adminhub-fe' },
    },
  );
}

const issueMerge = async (seq: Seq) =>
  (
    await rows<{ merged_commit_sha: string | null }>(sql`
      SELECT merged_commit_sha FROM issues WHERE id = ${ID[seq]}`)
  )[0]?.merged_commit_sha ?? null;

describe('c1, c2: the !1979 shape links its branch issue alone, and that issue is primary', () => {
  beforeEach(seedWorld);

  it('opens fix/iss-37-… with ISS-37 primary and the only link', async () => {
    const opened = await open('fix/iss-37-gitlab-merge-delivery', NINETEEN_SEVENTY_NINE);
    expect(opened.projection.issueId).toBe(ID[37]);
    expect(opened.projection.issueIds).toEqual([ID[37]]);
    expect(await linkedTo(opened.number)).toEqual([37]);
  });

  it('a key named in prose links nothing, a lone key and a closing verb link', async () => {
    const opened = await open(
      'chore/bump-deps',
      'Bumps the client the way ISS-11 asked for.\n\nISS-18\nAlso delivers ISS-38.',
    );
    expect(await linkedTo(opened.number)).toEqual([18, 38]);
  });

  it("another project's prefix links nothing, wherever it stands", async () => {
    const opened = await open('chore/bump-deps', 'Closes AH-11\nAH-18');
    expect(opened.projection.issueIds).toEqual([]);
    expect(opened.projection.issueId).toBeNull();
  });

  it('with no branch key, the first delivered description key is primary, not the lowest', async () => {
    const opened = await open('chore/bump-deps', 'Delivers:\n- ISS-38\n- ISS-18');
    expect(opened.projection.issueId).toBe(ID[38]);
    expect(opened.projection.issueIds).toEqual([ID[38], ID[18]]);
  });

  it('a branch key and a delivered description key both link, the branch first', async () => {
    const opened = await open('fix/iss-37-cr-links', 'Closes ISS-11');
    expect(opened.projection.issueIds).toEqual([ID[37], ID[11]]);
  });

  it('a request naming no key links nothing and has no primary', async () => {
    const opened = await open('chore/bump-deps', 'Bumps the client.');
    expect(opened.projection).toMatchObject({ outcome: 'recorded', issueId: null, issueIds: [] });
  });
});

describe('c3: a stray link is taken off through Forge and the merge does not stamp it', () => {
  beforeEach(seedWorld);

  const STRAY = 'Closes ISS-37\nCloses ISS-38';

  it('lists the links with the primary first', async () => {
    const opened = await open('fix/iss-37-cr-links', STRAY);
    const res = await api(world.token, 'GET', crPath(`/${opened.number}/issues`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      number: opened.number,
      state: 'open',
      primary: 'ISS-37',
      linked: [
        { issue: 'ISS-37', linkedBy: 'head-ref' },
        { issue: 'ISS-38', linkedBy: 'description' },
      ],
      unlinked: [],
    });
  });

  it('unlinks ISS-38, a later delivery keeps it off, and the merge stamps ISS-37 alone', async () => {
    const opened = await open('fix/iss-37-cr-links', STRAY);
    const off = await api(world.token, 'DELETE', crPath(`/${opened.number}/issues/ISS-38`));
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ primary: 'ISS-37', unlinked: [{ issue: 'ISS-38' }] });
    expect(await linkedTo(opened.number)).toEqual([37]);

    await redeliver(opened.number, 'fix/iss-37-cr-links', STRAY);
    expect(await linkedTo(opened.number)).toEqual([37]);

    const merge = await api(world.token, 'POST', `/api/issues/${ID[37]}/merge-pull-request`, {
      pullRequest: opened.number,
    });
    expect(merge.status, JSON.stringify(merge.body)).toBe(200);
    expect(host.merges).toEqual([opened.number]);
    expect(await issueMerge(37)).toBe(mergeCommitOf(opened.number));
    expect(await issueMerge(38)).toBeNull();
  });

  it('relinks what was unlinked, and refuses a relink of an issue never unlinked', async () => {
    const opened = await open('fix/iss-37-cr-links', STRAY);
    await api(world.token, 'DELETE', crPath(`/${opened.number}/issues/ISS-38`));
    const back = await api(world.token, 'PUT', crPath(`/${opened.number}/issues/ISS-38`));
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({
      linked: [
        { issue: 'ISS-37', linkedBy: 'head-ref' },
        { issue: 'ISS-38', linkedBy: 'description' },
      ],
      unlinked: [],
    });
    const again = await api(world.token, 'PUT', crPath(`/${opened.number}/issues/ISS-38`));
    expect(again.status).toBe(409);
    expect(codeOf(again.body)).toBe('CHANGE_REQUEST_ISSUE_NOT_UNLINKED');
  });

  it('refuses an unlink of an issue the request does not link, by name', async () => {
    const opened = await open('fix/iss-37-cr-links', STRAY);
    const res = await api(world.token, 'DELETE', crPath(`/${opened.number}/issues/ISS-18`));
    expect(res.status).toBe(409);
    expect(codeOf(res.body)).toBe('CHANGE_REQUEST_ISSUE_NOT_LINKED');
    expect(await linkedTo(opened.number)).toEqual([37, 38]);
  });

  it("refuses another project's issue, by uuid and by a prefix this project does not hold", async () => {
    const opened = await open('fix/iss-37-cr-links', STRAY);
    const foreign = randomUUID();
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${foreign}, ${world.otherProjectId}, 11, 'adminhub-api issue 11', 'open', ${world.ownerId})
    `);
    const byId = await api(world.token, 'DELETE', crPath(`/${opened.number}/issues/${foreign}`));
    expect(codeOf(byId.body)).toBe('CHANGE_REQUEST_ISSUE_OF_ANOTHER_PROJECT');
    const byKey = await api(world.token, 'DELETE', crPath(`/${opened.number}/issues/AH-11`));
    expect(codeOf(byKey.body)).toBe('CHANGE_REQUEST_ISSUE_OF_ANOTHER_PROJECT');
  });

  it('refuses a request Forge holds no record of, and a merged one, by name', async () => {
    const missing = await api(world.token, 'DELETE', crPath('/4242/issues/ISS-38'));
    expect(missing.status).toBe(404);
    expect(codeOf(missing.body)).toBe('CHANGE_REQUEST_NOT_FOUND');

    const opened = await open('fix/iss-37-cr-links', STRAY);
    await api(world.token, 'POST', `/api/issues/${ID[37]}/merge-pull-request`, {
      pullRequest: opened.number,
    });
    const res = await api(world.token, 'DELETE', crPath(`/${opened.number}/issues/ISS-38`));
    expect(res.status).toBe(409);
    expect(codeOf(res.body)).toBe('CHANGE_REQUEST_MERGED');
  });
});
