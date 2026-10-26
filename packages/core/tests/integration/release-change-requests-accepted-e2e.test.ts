/**
 * ISS-682 (REQ-71 BC-4, BC-6): an accepted merge-request release wakes the agent that merges it,
 * and ends at merge where the owner deploys. Planted from adminhub-api af0be6bc and catalog-api
 * 6c91e938 (dev, 2026-10-23): each cut, its approval asked, and nothing would have told the master
 * once the owner accepted, because a release that merges its change requests runs no job and holds
 * no session for the approval wake to reach; its page said "add a production environment, then
 * approve" on a project whose owner deploys. Absorbs ISS-591: a release waiting on its approval
 * request names the route that asks it, on its page and to the master.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const merges: number[] = [];

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  sourceHostForBinding: async () => ({
    provider: 'gitlab',
    words: { mergeMethods: ['merge', 'squash'], changeRequest: 'merge request', sigil: '!' },
    merge: async ({ number }: { number: number }) => {
      merges.push(number);
      return {
        kind: 'merged',
        commitSha: `${String(number).padStart(4, '0')}${'c'.repeat(36)}`,
        mergedAt: new Date('2026-10-25T09:00:00Z'),
        target: 'release/stg',
        head: null,
      };
    },
    sameTree: async () => true,
  }),
}));

const BRANCH = 'release/stg';
const HEAD_A = 'a1'.repeat(20);
const HEAD_B = 'b2'.repeat(20);
const MOVED = 'd4'.repeat(20);
const NOTE = { section: 'Added', userFacing: 'Orders read through the admin API.' };
const ACCEPT = { approval: { required: true }, changeRequests: true };

const world = { projectId: '', ownerId: '', token: '', box: '', bindingId: '', runnerId: '' };
let publish: MockInstance;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const { roomManager } = await import('../../src/lib/rooms.js');
  publish = vi.spyOn(roomManager, 'publish');
}, 120_000);

afterAll(async () => {
  publish?.mockRestore();
  await closeWorld();
});

async function seedWorld(release: Record<string, unknown>): Promise<void> {
  await settleOutbox();
  await truncateAll();
  merges.length = 0;
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
  const deviceId = await createTestDevice(world.ownerId);
  world.runnerId = await bindTestRunner(world.projectId, deviceId);
  const { mintPat } = await import('../../src/credentials/pat.js');
  world.box = (
    await mintPat({
      permissions: ['*'],
      userId: world.ownerId,
      name: 'box',
      deviceId,
      projectIds: [world.projectId],
    })
  ).plaintext;
  await seedProjectDocument(world.projectId, world.ownerId, {
    environments: {},
    defaultBranch: BRANCH,
    source: {
      type: 'git',
      git: {
        repository: 'gitlab.com/acme/adminhub-api',
        defaultBranch: BRANCH,
        branches: [BRANCH],
      },
    },
    extra: { delivery: { verdictsRequired: false }, release } as never,
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
            ${JSON.stringify({ repository: 'acme/adminhub-api' })}::jsonb)
  `);
  publish.mockClear();
}

async function issue(seq: number): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes)
    VALUES (${id}, ${world.projectId}, ${seq}, ${`issue ${seq}`}, 'in_progress', ${world.ownerId},
            ${JSON.stringify(NOTE)}::jsonb)
  `);
  await seedIssueStatus(id, 'awaiting_release');
  return id;
}

async function mergeRequest(number: number, headRef: string, head: string) {
  await applyPullRequestEvent(
    { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
    {
      action: 'update',
      pull_request: {
        number,
        title: `MR ${number}`,
        body: null,
        html_url: `https://gitlab.com/acme/adminhub-api/-/merge_requests/${number}`,
        state: 'open',
        head: { ref: headRef, sha: head },
        base: { ref: BRANCH, sha: 'f'.repeat(40) },
        updated_at: new Date().toISOString(),
      },
      repository: { full_name: 'acme/adminhub-api' },
    },
  );
}

/** !5008 delivers ISS-1, !5009 delivers ISS-2, cut in that order. */
async function cutRelease() {
  const one = await issue(1);
  const two = await issue(2);
  await mergeRequest(5008, 'feat/req1-openapi-iss-1', HEAD_A);
  await mergeRequest(5009, 'feat/req1-openapi-iss-2', HEAD_B);
  const res = await api(world.token, 'POST', `/api/projects/${world.projectId}/release-batches`, {
    issueIds: [one, two],
    changeRequests: [5008, 5009],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const body = res.body as { runId: string; version: string };
  return { one, two, runId: body.runId, version: body.version };
}

async function accept(runId: string) {
  const [pending] = [
    ...(await db.execute<{ id: string }>(sql`
      SELECT id FROM release_approvals WHERE run_id = ${runId} AND decision IS NULL`)),
  ];
  const res = await api(
    world.token,
    'POST',
    `/api/projects/${world.projectId}/release-batches/${runId}/approvals/${pending?.id}/decision`,
    { decision: 'approve', reason: 'the owner read both merge requests and accepts them' },
  );
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

const mergeOf = (issueId: string, pullRequest: number) =>
  api(world.token, 'POST', `/api/issues/${issueId}/merge-pull-request`, { pullRequest });

/** What core tells the project's master box it is owed besides issues, as the pass reads it. */
async function owedLine(): Promise<string> {
  const res = await api(world.box, 'POST', '/api/devices/me/master-session/verdict', {
    projectId: world.projectId,
    runnerId: world.runnerId,
    facts: {
      restarting: null,
      terminal: true,
      standing: 'proceed',
      pane: 'absent',
      capability: null,
      serversReadable: true,
      work: { poolWaits: false, jobPanes: 0 },
      conversation: { id: null, transcript: 'absent', elsewhere: 'none' },
      placement: null,
      holding: { kind: 'nothing' },
      turn: { kind: 'ended' },
      idle: {
        noWorkForSeconds: 0,
        pane: null,
        children: { total: 0, unfinished: [], lastClosedAgoSeconds: null },
      },
      limit: { refusal: null, hooks: 'unheard', turnStartedAgoMs: null },
      nudge: { last: null, since: 'unreported' },
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { work: { owedLine: string } }).work.owedLine;
}

async function wakes() {
  await settleOutbox();
  return publish.mock.calls
    .map((c) => ({
      room: c[0] as string,
      ...(c[1] as { event: string; data: Record<string, unknown> }),
    }))
    .filter((e) => e.event === 'master.wake')
    .map((e) => ({ room: e.room, ...e.data }));
}

const release = async (version: string) => {
  const res = await api(world.token, 'GET', `/api/projects/${world.projectId}/releases/${version}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { release: Record<string, unknown> & { waitingOn: Record<string, string> } })
    .release;
};

const codeOf = (body: unknown) => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

describe('BC-4: accept records the go, and the agent then merges the requests in order', () => {
  beforeEach(() => seedWorld(ACCEPT));

  it('wakes the project’s master when the owner accepts, which no job session hears', async () => {
    const { runId } = await cutRelease();
    await settleOutbox();
    publish.mockClear();
    await accept(runId);
    expect(await wakes()).toContainEqual(
      expect.objectContaining({
        source: 'issue',
        projectId: world.projectId,
        status: 'awaiting_release',
      }),
    );
  });

  it('tells the master the next merge owed, in order, until the last merge ends the release', async () => {
    const { one, two, runId } = await cutRelease();
    expect(await owedLine()).not.toContain('accepted release');

    await accept(runId);
    const first = await owedLine();
    expect(first).toContain('accepted release waits for you to merge its requests');
    expect(first).toContain('!5008 next, 0 of 2 merged');
    expect(first).toContain('merge-pull-request');

    expect((await mergeOf(one, 5008)).status).toBe(200);
    expect(await owedLine()).toContain('!5009 next, 1 of 2 merged');

    expect((await mergeOf(two, 5009)).status).toBe(200);
    expect(await owedLine()).not.toContain('accepted release');
    expect(merges).toEqual([5008, 5009]);
  });

  it('says on the release page that the master merges next, not that a run is going out', async () => {
    const { runId, version } = await cutRelease();
    await accept(runId);
    expect((await release(version)).waitingOn).toMatchObject({
      kind: 'agent',
      act: 'merge the requests in order',
    });
  });

  it('refuses a request whose head moved since the accept by its own code', async () => {
    const { one, runId } = await cutRelease();
    await accept(runId);
    await mergeRequest(5008, 'feat/req1-openapi-iss-1', MOVED);
    const res = await mergeOf(one, 5008);
    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('RELEASE_MERGE_HEAD_MOVED');
    expect(merges).toEqual([]);
  });
});

describe('BC-6: where the owner deploys, the release ends at merge', () => {
  it('marks a merge-request release as one its owner deploys', async () => {
    await seedWorld(ACCEPT);
    const { version } = await cutRelease();
    expect((await release(version)).ownerDeploys).toBe(true);
  });
});

describe('ISS-591: a release waiting on its approval request names the route that asks it', () => {
  beforeEach(() => seedWorld(ACCEPT));

  it('names the route on the release page and to the master', async () => {
    const { runId, version } = await cutRelease();
    await db.execute(sql`DELETE FROM release_approvals WHERE run_id = ${runId}`);
    const route = `POST /api/projects/${world.projectId}/release-batches/${runId}/approvals`;
    expect((await release(version)).waitingOn.rule).toContain(route);
    const line = await owedLine();
    expect(line).toContain('waits for an approval request');
    expect(line).toContain(runId);
  });
});
