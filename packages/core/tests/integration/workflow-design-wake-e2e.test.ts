import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let deviceId: string;
let publish: MockInstance;
let say: (who: 'owner' | 'master', method: string, path: string, body?: unknown) => Promise<Reply>;
let readAdmissibleIssues: typeof import('../../src/devices/admissible.js').readAdmissibleIssues;

const design = (): Doc =>
  JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  ({ readAdmissibleIssues } = await import('../../src/devices/admissible.js'));
  const { roomManager } = await import('../../src/lib/rooms.js');
  publish = vi.spyOn(roomManager, 'publish');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'member');
  const tokens = {
    owner: await signUserToken(ownerId),
    master: (await mintPat({ userId: agent, name: 'master', projectIds: [projectId] })).plaintext,
  };
  say = requester(app, tokens);
  deviceId = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
}, 120_000);

afterAll(async () => {
  publish?.mockRestore();
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  publish.mockClear();
});

const at = (path: string) => `/api/projects/${projectId}${path}`;
const codesOf = (r: Reply) => (r.json.error?.refusals ?? []).map((x: Doc) => x.code);

let seq = 100;
/** An issue planted at a status under the kernel's flag: the subject is what a design decision does to it. */
async function plantIssue(status: string, mergedAt: Date | null = null): Promise<string> {
  const id = randomUUID();
  seq += 1;
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
      VALUES (${id}, ${projectId}, ${seq}, ${`planted ${status}`}, ${status}, ${ownerId},
              ${mergedAt?.toISOString() ?? null}::timestamptz)
    `),
  );
  return id;
}

const admitted = async () => (await readAdmissibleIssues({ deviceId, projectId })).items;
const admittedIds = async () => (await admitted()).map((a) => a.issueId);

async function designWakes(): Promise<Doc[]> {
  await settleOutbox();
  return publish.mock.calls
    .map((c) => ({ room: c[0] as string, ...(c[1] as Doc) }))
    .filter((e) => e.event === 'master.wake' && e.data.source === 'workflow_design')
    .map((e) => ({ room: e.room, ...e.data }));
}

async function proposedDesign(flow: string, issue?: string): Promise<string> {
  const d = design();
  d.project = projectId;
  d.flow = flow;
  const made = ok(
    await say('master', 'POST', at('/workflows'), { baseRevision: null, document: d }),
    201,
  );
  const id = made.document.id as string;
  ok(
    await say('master', 'POST', at(`/workflows/${id}/design/propose`), {
      revision: 1,
      ...(issue ? { issue } : {}),
    }),
  );
  return id;
}

describe('the admissible list takes what forge next calls takeable', () => {
  it('admits a reopened issue whose merge mark is still on it, and not one awaiting its release', async () => {
    const reopened = await plantIssue('reopen', new Date('2026-10-02T09:19:03Z'));
    const merged = await plantIssue('awaiting_release', new Date('2026-10-02T09:19:03Z'));
    const ids = await admittedIds();
    expect(ids).toContain(reopened);
    expect(ids).not.toContain(merged);
    expect((await admitted()).find((a) => a.issueId === reopened)).toMatchObject({
      status: 'reopen',
      mergedAt: '2026-10-02T09:19:03.000Z',
    });
  });
});

describe('a design decision wakes its master', () => {
  it('on return, reopens the issue the design was drawn under, with the reason on its read', async () => {
    const designIssue = await plantIssue('awaiting_release', new Date());
    const workflowId = await proposedDesign('returned-flow', `ISS-${seq}`);
    expect(await admittedIds()).not.toContain(designIssue);
    await settleOutbox();
    publish.mockClear();

    const returned = ok(
      await say('owner', 'POST', at(`/workflows/${workflowId}/design/decision`), {
        revision: 1,
        decision: 'return',
        reason: 'the SLA is 48h by contract',
      }),
    );
    expect(returned.designIssue).toEqual({
      issueId: designIssue,
      action: 'reopened',
      status: 'reopen',
    });
    expect(await designWakes()).toEqual([
      expect.objectContaining({
        room: `device:${deviceId}`,
        projectId,
        workflowId,
        decision: 'return',
        issueId: designIssue,
      }),
    ]);
    expect(await admittedIds()).toContain(designIssue);
    const list = ok(await say('owner', 'GET', at('/workflows')));
    expect(list.workflows.find((w: Doc) => w.document.id === workflowId)?.design).toMatchObject({
      status: 'returned',
      approvedRevision: null,
      returnReason: 'the SLA is 48h by contract',
    });

    const issue = ok(await say('owner', 'GET', `/api/issues/${designIssue}`));
    expect(issue.status).toBe('reopen');
    expect(issue.proposesWorkflow).toMatchObject({
      workflowId,
      designStatus: 'returned',
      decision: 'return',
      reason: 'the SLA is 48h by contract',
    });
    const posted = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${designIssue}`,
    );
    expect(posted.map((c) => c.body).join('\n')).toContain('the SLA is 48h by contract');
  });

  it('on approve, wakes the master and leaves the design issue where it is', async () => {
    const designIssue = await plantIssue('awaiting_release', new Date());
    const workflowId = await proposedDesign('approved-flow', `ISS-${seq}`);
    await settleOutbox();
    publish.mockClear();
    ok(
      await say('owner', 'POST', at(`/workflows/${workflowId}/design/decision`), {
        revision: 1,
        decision: 'approve',
      }),
    );
    expect(await designWakes()).toEqual([
      expect.objectContaining({ workflowId, decision: 'approve', issueId: designIssue }),
    ]);
    expect(ok(await say('owner', 'GET', `/api/issues/${designIssue}`)).status).toBe(
      'awaiting_release',
    );
  });

  it('on return over a takeable issue, keeps its status and posts the reason on it', async () => {
    const designIssue = await plantIssue('open');
    const workflowId = await proposedDesign('takeable-flow', `ISS-${seq}`);
    const returned = ok(
      await say('owner', 'POST', at(`/workflows/${workflowId}/design/decision`), {
        revision: 1,
        decision: 'return',
        reason: 'name the consent owner',
      }),
    );
    expect(returned.designIssue).toEqual({
      issueId: designIssue,
      action: 'commented',
      status: 'open',
    });
    const posted = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${designIssue}`,
    );
    expect(posted.map((c) => c.body).join('\n')).toContain('name the consent owner');
  });

  it('wakes on a return even when no issue was named on the proposal', async () => {
    const workflowId = await proposedDesign('unnamed-flow');
    await settleOutbox();
    publish.mockClear();
    const returned = ok(
      await say('owner', 'POST', at(`/workflows/${workflowId}/design/decision`), {
        revision: 1,
        decision: 'return',
        reason: 'draw the consent check',
      }),
    );
    expect(returned.designIssue).toEqual({ issueId: null, action: 'none', status: null });
    expect(await designWakes()).toEqual([
      expect.objectContaining({ workflowId, decision: 'return', issueId: null }),
    ]);
  });

  it('refuses a return with no reason, and wakes nobody', async () => {
    const workflowId = await proposedDesign('reasonless-flow');
    await settleOutbox();
    publish.mockClear();
    const res = await say('owner', 'POST', at(`/workflows/${workflowId}/design/decision`), {
      revision: 1,
      decision: 'return',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(codesOf(res)).toEqual(['WORKFLOW_DESIGN_REASON_MISSING']);
    expect(await designWakes()).toEqual([]);
  });

  it('refuses the design issue as a build of its own design', async () => {
    await plantIssue('in_progress');
    const key = `ISS-${seq}`;
    const workflowId = await proposedDesign('self-build-flow', key);
    const linked = await say('master', 'POST', at(`/workflows/${workflowId}/builds`), {
      issue: key,
    });
    expect(linked.status, JSON.stringify(linked.json)).toBe(422);
    expect(codesOf(linked)).toEqual(['WORKFLOW_DESIGN_ISSUE_IS_BUILD']);
  });
});
