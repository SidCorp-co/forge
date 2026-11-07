/**
 * ISS-980 (FB-500, FB-546, FB-547, epod): a merge request opened through core was refused
 * NO_PULL_REQUEST for ten to fifteen minutes while its title, branch and head all named the issue.
 * `Draft: ISS-70: …` on `batch-ISS-70` linked nothing (!139), `batch-ISS-54-69` linked ISS-69 alone
 * (!138), !214 merged only once a PATCH re-recorded it, and the refusal named no rule a caller could
 * act on. Driven here through the source door and the merge door against real Postgres, the host a
 * planted GitLab that opens, reads and merges from its own state, and answers a create the way GitLab
 * may: before it has computed the request's diff, with no head or base sha.
 *
 * @direct-test-of packages/core/src/integration-door/source-routes.ts
 * @direct-test-of packages/core/src/integration-door/issue-merge-routes.ts
 * @direct-test-of packages/core/src/integration-door/stored-pull-request.ts
 * @direct-test-of packages/core/src/issues/head-ref-link.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import type { ReadChangeRequest } from '../../src/integrations/source-host/types.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';

const HEAD = 'a1'.repeat(20);
const BASE = 'b'.repeat(40);
const LANDING = 'c'.repeat(40);
const TARGET = 'release/stg';

const world = { projectId: '', ownerId: '', token: '', bindingId: '' };
const requests = new Map<number, ReadChangeRequest>();
/** The fields the planted create answer leaves out, as GitLab does before its diff is computed. */
const unanswered = new Set<'headSha' | 'baseSha' | 'updatedAt'>();
const merges: number[] = [];
let opened = 200;
let clock = Date.parse('2026-11-06T22:00:00Z');
const tick = () => {
  clock += 1000;
  return new Date(clock).toISOString();
};

const planted = {
  provider: 'gitlab' as const,
  get bindingId() {
    return world.bindingId;
  },
  fullName: 'epod/epod',
  host: 'gitlab.example',
  words: { changeRequest: 'merge request', sigil: '!', mergeMethods: ['merge', 'squash'] },
  openChangeRequest: async (args: {
    head: string;
    base: string;
    title: string;
    body?: string;
    draft?: boolean;
  }) => {
    opened += 1;
    const number = opened;
    // GitLab marks a draft by prefixing its title, as the adapter asks it to
    const mr = {
      number,
      url: `https://gitlab.example/epod/epod/-/merge_requests/${number}`,
      title: args.draft ? `Draft: ${args.title}` : args.title,
      state: 'open',
      draft: args.draft === true,
      headRef: args.head,
      headSha: HEAD,
      baseRef: args.base,
      baseSha: BASE,
      updatedAt: tick(),
      body: args.body ?? null,
      mergedAt: null,
      mergeCommitSha: null,
    };
    requests.set(number, mr);
    const { body: _body, mergedAt: _at, mergeCommitSha: _sha, ...answer } = mr;
    return {
      ...answer,
      headSha: unanswered.has('headSha') ? null : answer.headSha,
      baseSha: unanswered.has('baseSha') ? null : answer.baseSha,
      updatedAt: unanswered.has('updatedAt') ? null : answer.updatedAt,
    };
  },
  readChangeRequest: async (number: number) => {
    const mr = requests.get(number);
    if (!mr) throw new Error(`GitLab answered 404 Not Found for merge request !${number}`);
    return { ...mr };
  },
  readChecks: async () => [],
  readChangeRequestChecks: async () => [],
  readCommit: async () => null,
  branchContains: async () => true,
  compare: async () => 'identical',
  sameTree: async () => true,
  merge: async ({ number }: { number: number }) => {
    merges.push(number);
    const mr = requests.get(number) as ReadChangeRequest;
    requests.set(number, {
      ...mr,
      state: 'merged',
      mergedAt: tick(),
      mergeCommitSha: LANDING,
      updatedAt: tick(),
    });
    return {
      kind: 'merged' as const,
      commitSha: LANDING,
      mergedAt: new Date(clock),
      target: TARGET,
      head: HEAD,
    };
  },
};

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => planted,
  sourceHostForBinding: async () => planted,
}));

const rows = async <T>(query: ReturnType<typeof sql>) =>
  [...(await db.execute(query))] as unknown as T[];

const linked = async (number: number) =>
  (
    await rows<{ key: number }>(sql`
      SELECT i.iss_seq AS key FROM repo_pull_request_issues l
        JOIN repo_pull_requests p ON p.id = l.pull_request_id
        JOIN issues i ON i.id = l.issue_id
       WHERE p.binding_id = ${world.bindingId} AND p.number = ${number}
       ORDER BY l.position`)
  ).map((r) => r.key);

async function issue(seq: number): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${world.projectId}, ${seq}, ${`issue ${seq}`}, 'in_progress', ${world.ownerId})
  `);
  await seedIssueStatus(id, 'in_progress');
  return id;
}

/** A merge request the host holds and Forge has never been told of. */
function onHostOnly(number: number, over: Partial<ReadChangeRequest> = {}): void {
  requests.set(number, {
    number,
    url: `https://gitlab.example/epod/epod/-/merge_requests/${number}`,
    title: `MR ${number}`,
    state: 'open',
    draft: false,
    headRef: 'chore/lift',
    headSha: HEAD,
    baseRef: TARGET,
    baseSha: BASE,
    updatedAt: tick(),
    body: null,
    mergedAt: null,
    mergeCommitSha: null,
    ...over,
  });
}

/** The request as it stood when Forge last projected it, the host's copy left as it is. */
async function projectedAs(number: number, title: string, headRef: string): Promise<void> {
  await applyPullRequestEvent(
    { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
    {
      action: 'open',
      pull_request: {
        number,
        title,
        body: null,
        state: 'open',
        head: { ref: headRef, sha: HEAD },
        base: { ref: TARGET, sha: BASE },
        updated_at: new Date(Date.parse('2026-11-06T21:00:00Z')).toISOString(),
      },
      repository: { full_name: 'epod/epod' },
    },
  );
}

const door = (path = '') =>
  `/api/projects/${world.projectId}/integrations/source/change-requests${path}`;
const open = (body: Record<string, unknown>) =>
  api(world.token, 'POST', door(), { base: TARGET, ...body });
const mergeOf = (issueId: string, pullRequest: number) =>
  api(world.token, 'POST', `/api/issues/${issueId}/merge-pull-request`, { pullRequest });

type Refusal = { code: string; detail: string };
const refusalOf = (body: unknown) =>
  ((body as { error?: { refusals?: Refusal[] } }).error?.refusals ?? [])[0];

beforeEach(async () => {
  await truncateAll();
  requests.clear();
  unanswered.clear();
  merges.length = 0;
  opened = 200;
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
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
            ${JSON.stringify({ projectPath: 'epod/epod' })}::jsonb)
  `);
});

// FB-547: !214, titled `ISS-108: …` and opened through core, was refused for twelve minutes
describe('the create records the link whole', () => {
  it('reads back a request whose create answer carried no head or base sha, and links it at once', async () => {
    const id = await issue(108);
    unanswered.add('headSha');
    unanswered.add('baseSha');

    const res = await open({ head: 'chore/order-export', title: 'ISS-108: order export' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      number: 201,
      projection: { outcome: 'recorded', issueIds: [id] },
    });
    expect(await linked(201)).toEqual([108]);
    const merged = await mergeOf(id, 201);
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(merges).toEqual([201]);
  });

  it('still names what is missing where the read back lacks it too, and writes nothing', async () => {
    await issue(108);
    unanswered.add('updatedAt');
    const original = planted.readChangeRequest;
    planted.readChangeRequest = async (n: number) => ({ ...(await original(n)), updatedAt: null });
    try {
      const res = await open({ head: 'chore/order-export', title: 'ISS-108: order export' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const projection = (res.body as { projection: { outcome: string; reason: string } })
        .projection;
      expect(projection.outcome).toBe('not-recorded');
      expect(projection.reason).toContain('updated at');
      expect(projection.reason).toContain('Do NOT open it again');
      expect(await linked(201)).toEqual([]);
    } finally {
      planted.readChangeRequest = original;
    }
  });

  // FB-500: !139 was opened as a draft, so GitLab titled it `Draft: ISS-70: …`
  it('links a request opened as a draft by the key its title leads with', async () => {
    const id = await issue(70);
    const res = await open({ head: 'chore/lift', title: 'ISS-70: lift the hold', draft: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      title: 'Draft: ISS-70: lift the hold',
      projection: { outcome: 'recorded', issueIds: [id] },
    });
  });

  // FB-500: !138 on `batch-ISS-54-69` linked ISS-69 alone
  it('links every key a batch-<keys> branch lists', async () => {
    const first = await issue(54);
    const second = await issue(69);
    const res = await open({ head: 'batch-ISS-54-69', title: 'Batch: two fixes' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      projection: { outcome: 'recorded', issueIds: [first, second] },
    });
  });
});

// FB-546: !210 was titled `Batch ISS-103/105/106/107/28/109: …`, and its title linked nothing
describe('a Batch title links every key its list holds', () => {
  it('links the six keys of the !210 title on a keyless branch, and merges for the fifth', async () => {
    const ids = [];
    for (const seq of [103, 105, 106, 107, 28, 109]) ids.push(await issue(seq));
    const res = await open({
      head: 'chore/order-export',
      title: 'Batch ISS-103/105/106/107/28/109: order export',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ projection: { outcome: 'recorded', issueIds: ids } });
    const merged = await mergeOf(ids[4] as string, 201);
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(merges).toEqual([201]);
  });
});

describe('a request whose title changes is re-linked on its next refresh', () => {
  it('links past the draft marker, then follows the title to its new key', async () => {
    await issue(70);
    await issue(71);
    onHostOnly(139, { title: 'Draft: ISS-70: lift the hold' });

    const first = await api(world.token, 'POST', door('/139/refresh'));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await linked(139)).toEqual([70]);

    onHostOnly(139, { title: 'ISS-71: lift the hold' });
    const second = await api(world.token, 'POST', door('/139/refresh'));
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(await linked(139)).toEqual([71]);
  });
});

describe('the merge door re-reads a named request it does not hold for the issue', () => {
  it('merges a request the host holds and Forge was never told of', async () => {
    const id = await issue(108);
    onHostOnly(214, { title: 'ISS-108: order export' });

    const res = await mergeOf(id, 214);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ merged: true, commitSha: LANDING });
    expect(merges).toEqual([214]);
  });

  it('merges a request whose draft was lifted on the host after Forge projected it', async () => {
    const id = await issue(70);
    await projectedAs(139, 'Draft: lift the hold', 'chore/lift');
    onHostOnly(139, { title: 'ISS-70: lift the hold' });

    const res = await mergeOf(id, 139);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(merges).toEqual([139]);
  });
});

// FB-546: !210 was refused with no word on how a request links, or what it was linked to
describe('NO_PULL_REQUEST says how a request links and what Forge holds for it', () => {
  it('names the issues the projection holds for the request, and the linking rule', async () => {
    await issue(105);
    const id = await issue(103);
    onHostOnly(210, {
      title: 'Two fixes: the export for ISS-103 and ISS-105',
      headRef: 'fix/iss-105-wording',
    });

    const res = await mergeOf(id, 210);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusal = refusalOf(res.body);
    expect(refusal?.code).toBe('NO_PULL_REQUEST');
    expect(refusal?.detail).toContain('!210');
    expect(refusal?.detail).toContain('links ISS-105');
    expect(refusal?.detail).toContain('not ISS-103');
    expect(refusal?.detail).toContain('`fix/iss-105-wording`');
    expect(refusal?.detail).toContain('batch-iss-n-m');
    expect(refusal?.detail).toContain('Draft:');
    expect(refusal?.detail).toContain('Closes ISS-n');
    expect(merges).toEqual([]);
  });

  it('says the projection holds no record of a number the host does not answer either', async () => {
    const id = await issue(103);
    onHostOnly(12);
    await api(world.token, 'POST', door('/12/refresh'));

    const res = await mergeOf(id, 999);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusal = refusalOf(res.body);
    expect(refusal?.code).toBe('NO_PULL_REQUEST');
    expect(refusal?.detail).toContain('holds no record of !999');
    expect(refusal?.detail).toContain('404 Not Found');
    expect(refusal?.detail).toContain('batch-iss-n-m');
  });
});

// ISS-980: epod's empty projection was refused as a project that had bound no GitHub repository
describe('PROJECTION_EMPTY names the host the project bound', () => {
  it('names the GitLab binding of a GitLab project, never GitHub', async () => {
    const id = await issue(103);

    const res = await mergeOf(id, 999);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const refusal = refusalOf(res.body);
    expect(refusal?.code).toBe('PROJECTION_EMPTY');
    expect(refusal?.detail).toContain('its GitLab binding');
    expect(refusal?.detail).not.toContain('GitHub');
  });
});
