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
} from '../helpers/factories.js';

// F32 / FB-84: a returned design or requirement revision waits on the project's master, so the
// master is woken for it and its box reads it on every sweep until the next revision is proposed.
// F37: a closed pass names how it ended, and a master with its own run out is not idle.

type Who = 'owner' | 'master' | 'box' | 'otherBox';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let otherProjectId = '';
let ownerId = '';
let deviceId = '';
let publish: MockInstance;

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
  const { roomManager } = await import('../../src/lib/rooms.js');
  publish = vi.spyOn(roomManager, 'publish');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  otherProjectId = (await createTestProject(ownerId)).id;
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'member');
  deviceId = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
  await bindTestRunner(otherProjectId, deviceId);
  const otherDevice = await createTestDevice(ownerId);
  say = requester(app, {
    owner: await signUserToken(ownerId),
    master: (await mintPat({ userId: agent, name: 'master', projectIds: [projectId] })).plaintext,
    box: (
      await mintPat({
        userId: ownerId,
        name: 'box',
        deviceId,
        projectIds: [projectId, otherProjectId],
      })
    ).plaintext,
    otherBox: (
      await mintPat({ userId: ownerId, name: 'other', deviceId: otherDevice, projectIds: [] })
    ).plaintext,
  }) as typeof say;
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

async function wakes(source: string): Promise<Doc[]> {
  await settleOutbox();
  return publish.mock.calls
    .map((c): Doc => ({ room: c[0] as string, ...(c[1] as Doc) }))
    .filter((e) => e.event === 'master.wake' && e.data.source === source)
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

const returnDesign = async (id: string, reason: string) =>
  ok(
    await say('owner', 'POST', at(`/workflows/${id}/design/decision`), {
      revision: 1,
      decision: 'return',
      reason,
    }),
  );

const owedDesigns = async (): Promise<Doc[]> =>
  ok(await say('box', 'GET', `/api/devices/me/designs/owed?projectId=${projectId}`)).items;

describe('a returned design no issue carries is owed to the project master', () => {
  it('is listed for the box with its flow, revision and reason, and names the master on its read', async () => {
    const id = await proposedDesign('owed-flow');
    expect((await owedDesigns()).map((d) => d.workflowId)).not.toContain(id);
    await returnDesign(id, 'draw the edge proxy, not LE DNS-01');
    expect(await owedDesigns()).toContainEqual(
      expect.objectContaining({
        workflowId: id,
        flow: 'owed-flow',
        revision: 1,
        reason: 'draw the edge proxy, not LE DNS-01',
      }),
    );
    const read = ok(await say('owner', 'GET', at(`/workflows/${id}/design`)));
    expect(read.waitingOn).toMatchObject({
      kind: 'agent',
      who: "The project's master",
      act: 'revise revision 1',
    });
    expect(await wakes('workflow_design')).toEqual([
      expect.objectContaining({ room: `device:${deviceId}`, workflowId: id, decision: 'return' }),
    ]);
  });

  it('leaves the list once the next revision is proposed', async () => {
    const id = await proposedDesign('revised-flow');
    await returnDesign(id, 'name the consent owner');
    expect((await owedDesigns()).map((d) => d.workflowId)).toContain(id);
    const d = design();
    d.project = projectId;
    d.flow = 'revised-flow';
    d.id = id;
    d.title = `${d.title} (revised)`;
    ok(await say('master', 'PUT', at(`/workflows/${id}`), { baseRevision: 1, document: d }));
    const read = ok(await say('owner', 'GET', at(`/workflows/${id}/design`)));
    expect(read.status).toBe('proposed');
    expect((await owedDesigns()).map((x) => x.workflowId)).not.toContain(id);
  });

  it('is not listed while a live issue it was drawn under carries the return', async () => {
    const issue = ok(
      await say('owner', 'POST', at('/issues'), { title: 'draw the carried flow' }),
      201,
    );
    const id = await proposedDesign('carried-flow', issue.key ?? issue.id);
    await returnDesign(id, 'split the two pipelines');
    expect((await owedDesigns()).map((x) => x.workflowId)).not.toContain(id);
  });

  it('refuses a box not bound to the project by name', async () => {
    const res = await say('otherBox', 'GET', `/api/devices/me/designs/owed?projectId=${projectId}`);
    expect(res.status, JSON.stringify(res.json)).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

async function proposedRequirement(who: 'master' | 'owner', title: string): Promise<string> {
  const made = ok(
    await say(who, 'POST', at('/requirements'), {
      title,
      reason: 'the board asked for it',
      criteria: [{ body: 'Every pass names what it dispatched.' }],
    }),
    201,
  );
  ok(await say(who, 'POST', at(`/requirements/${made.key}/revisions/1/propose`), {}));
  return made.key as string;
}

const returnedRevisions = async (): Promise<Doc[]> =>
  ok(await say('box', 'GET', `/api/devices/me/requirements/returned?projectId=${projectId}`)).items;

describe('a returned requirement revision an agent wrote is owed to the project master', () => {
  it('wakes the master, is listed for the box, and reads as the master revising it', async () => {
    const key = await proposedRequirement('master', 'Passes name their close');
    await settleOutbox();
    publish.mockClear();
    ok(
      await say('owner', 'POST', at(`/requirements/${key}/revisions/1/return`), {
        reason: 'BC-1 is two rules',
      }),
    );
    expect(await wakes('requirement')).toEqual([
      expect.objectContaining({ room: `device:${deviceId}`, key, revision: 1 }),
    ]);
    expect(await returnedRevisions()).toContainEqual(
      expect.objectContaining({ key, revision: 1, reason: 'BC-1 is two rules' }),
    );
    const read = ok(await say('owner', 'GET', at(`/requirements/${key}`)));
    expect(JSON.stringify(read)).toContain('revise returned r1, then propose or drop it');

    ok(await say('master', 'POST', at(`/requirements/${key}/revisions/1/propose`), {}));
    expect((await returnedRevisions()).map((r) => r.key)).not.toContain(key);
  });

  it("neither wakes the master nor lists a person's own returned revision", async () => {
    const key = await proposedRequirement('owner', 'Owner wrote this one');
    await settleOutbox();
    publish.mockClear();
    ok(
      await say('owner', 'POST', at(`/requirements/${key}/revisions/1/return`), {
        reason: 'not yet',
      }),
    );
    expect(await wakes('requirement')).toEqual([]);
    expect((await returnedRevisions()).map((r) => r.key)).not.toContain(key);
  });
});

async function masterSession(): Promise<string> {
  return ok(
    await say('box', 'POST', '/api/devices/me/master-session', {
      projectId,
      name: 'forge-master-test',
      maxJobPanes: 2,
    }),
  ).sessionId as string;
}

const pass = (body: Doc) => say('box', 'POST', '/api/devices/me/master-session/pass', body);

describe('a closed pass names how it ended', () => {
  it('stores the reason the box sends, and reads null where a box sends none', async () => {
    const sessionId = await masterSession();
    const close = async (extra: Doc) => {
      const opened = ok(await pass({ op: 'open', sessionId, verb: 'dispatch' }), 201).pass;
      return ok(
        await pass({
          op: 'close',
          sessionId,
          passId: opened.id,
          dispatched: [],
          skipped: [],
          parked: [],
          ...extra,
        }),
      ).pass;
    };
    expect((await close({ closeReason: 'abandoned_quiet' })).closeReason).toBe('abandoned_quiet');
    expect((await close({ closeReason: 'turn_ended' })).closeReason).toBe('turn_ended');
    expect((await close({})).closeReason).toBeNull();
    const listed = ok(await say('owner', 'GET', at('/masters/passes?limit=3'))).items;
    expect(listed.map((p: Doc) => p.closeReason)).toEqual([null, 'turn_ended', 'abandoned_quiet']);
    expect(ok(await say('owner', 'GET', at('/masters/standing'))).lastPass.closeReason).toBeNull();
  });

  it('refuses a close reason it does not know, naming the field', async () => {
    const sessionId = await masterSession();
    const opened = ok(await pass({ op: 'open', sessionId, verb: 'dispatch' }), 201).pass;
    const res = await pass({
      op: 'close',
      sessionId,
      passId: opened.id,
      dispatched: [],
      skipped: [],
      parked: [],
      closeReason: 'gave_up',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(JSON.stringify(res.json)).toContain('closeReason');
    ok(
      await pass({
        op: 'close',
        sessionId,
        passId: opened.id,
        dispatched: [],
        skipped: [],
        parked: [],
        closeReason: 'turn_ended',
      }),
    );
  });

  it('refuses a close reason on a row still open, at the database', async () => {
    const sessionId = await masterSession();
    const opened = ok(await pass({ op: 'open', sessionId, verb: 'dispatch' }), 201).pass;
    const refusedBy = await db
      .execute(sql`UPDATE master_passes SET close_reason = 'turn_ended' WHERE id = ${opened.id}`)
      .then(
        () => 'written',
        (e: { cause?: { message?: string } }) => e.cause?.message ?? String(e),
      );
    expect(refusedBy).toMatch(/master_passes_close_reason_chk/);
    ok(
      await pass({
        op: 'close',
        sessionId,
        passId: opened.id,
        dispatched: [],
        skipped: [],
        parked: [],
        closeReason: 'turn_ended',
      }),
    );
  });
});

async function plantRun(project: string, status: string): Promise<string> {
  const id = randomUUID();
  const runId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${project}, 'interactive', 'running')
  `);
  await db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, kind, status, device_id)
    VALUES (${id}, ${project}, ${ownerId}, ${runId}, 'run_session', ${status}, ${deviceId})
  `);
  return id;
}

describe('a master between passes with its own run out is not idle', () => {
  it('reads runs_out with the runs it declared counted, and only this project’s', async () => {
    await masterSession();
    const before = ok(await say('owner', 'GET', at('/masters/standing')));
    expect(before.pass).toBeNull();
    expect(before.state).toBe('idle');
    expect(before.runsOut).toBe(0);

    await plantRun(otherProjectId, 'running');
    const elsewhere = ok(await say('owner', 'GET', at('/masters/standing')));
    expect(elsewhere.state).toBe('idle');
    expect(elsewhere.runsOut).toBe(0);
    expect(elsewhere.slots.runs).toBe(1);

    const run = await plantRun(projectId, 'running');
    const out = ok(await say('owner', 'GET', at('/masters/standing')));
    expect(out.state).toBe('runs_out');
    expect(out.runsOut).toBe(1);
    expect(out.slots.runs).toBe(2);

    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE agent_sessions SET status = 'completed' WHERE id = ${run}`),
    );
    expect(ok(await say('owner', 'GET', at('/masters/standing'))).state).toBe('idle');
  });
});
