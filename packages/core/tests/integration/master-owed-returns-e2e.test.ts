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
// master is woken for it and core counts it on every verdict its box asks for, naming it on the
// pass, until the next revision is proposed.
// F37: a closed pass names how core judged it ended, and a master with its own run out is not idle.

type Who = 'owner' | 'master' | 'box' | 'otherBox';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let otherProjectId = '';
let ownerId = '';
let deviceId = '';
let runnerId = '';
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
  runnerId = await bindTestRunner(projectId, deviceId);
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

const verdictFacts = {
  restarting: null,
  terminal: true,
  standing: 'proceed',
  pane: 'absent',
  capability: null,
  serversReadable: true,
  work: { poolWaits: false, jobPanes: 0 },
  conversation: { id: null, transcript: 'absent', elsewhere: 'none' },
  outdated: null,
  holding: { kind: 'nothing' },
  turn: { kind: 'ended' },
  idle: {
    noWorkForSeconds: 0,
    pane: null,
    children: { total: 0, unfinished: [], lastClosedAgoSeconds: null },
  },
  limit: { refusal: null, hooks: 'unheard', turnStartedAgoMs: null },
  nudge: { last: null, since: 'unreported' },
};

const askVerdict = (who: Who = 'box') =>
  say(who, 'POST', '/api/devices/me/master-session/verdict', {
    projectId,
    runnerId,
    facts: verdictFacts,
  });

/** What core told the box the master is owed besides issues, as the pass is told it. */
const owedLine = async (): Promise<string> => ok(await askVerdict()).work.owedLine;

describe('a returned design no issue carries is owed to the project master', () => {
  it('is named on the pass with its flow, revision and workflow, and names the master on its read', async () => {
    const id = await proposedDesign('owed-flow');
    expect(await owedLine()).not.toContain(id);
    await returnDesign(id, 'draw the edge proxy, not LE DNS-01');
    expect(await owedLine()).toContain(`owed-flow r1, workflow ${id}`);
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
    expect(await owedLine()).toContain(id);
    const d = design();
    d.project = projectId;
    d.flow = 'revised-flow';
    d.id = id;
    d.title = `${d.title} (revised)`;
    ok(await say('master', 'PUT', at(`/workflows/${id}`), { baseRevision: 1, document: d }));
    const read = ok(await say('owner', 'GET', at(`/workflows/${id}/design`)));
    expect(read.status).toBe('proposed');
    expect(await owedLine()).not.toContain(id);
  });

  it('is not listed while a live issue it was drawn under carries the return', async () => {
    const issue = ok(
      await say('owner', 'POST', at('/issues'), { title: 'draw the carried flow' }),
      201,
    );
    const id = await proposedDesign('carried-flow', issue.key ?? issue.id);
    await returnDesign(id, 'split the two pipelines');
    expect(await owedLine()).not.toContain(id);
  });

  it('refuses a box not bound to the project by name', async () => {
    const res = await askVerdict('otherBox');
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

describe('a returned requirement revision an agent wrote is owed to the project master', () => {
  it('wakes the master, is named on its pass, and reads as the master revising it', async () => {
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
    expect(await owedLine()).toContain(`(${key} r1)`);
    const read = ok(await say('owner', 'GET', at(`/requirements/${key}`)));
    expect(JSON.stringify(read)).toContain('revise returned r1, then propose or drop it');

    ok(await say('master', 'POST', at(`/requirements/${key}/revisions/1/propose`), {}));
    expect(await owedLine()).not.toContain(`${key} r1`);
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
    expect(await owedLine()).not.toContain(`${key} r1`);
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

const settleFacts = (openedBy: string) => ({
  openedBy,
  served: true,
  openedAgoMs: 1_000,
  hooks: null,
  writtenAgoMs: null,
  dispatched: [],
  record: { worked: false, refusal: null },
});

describe('a closed pass names how core judged it ended', () => {
  it('stores the reason core judged from what the box reported', async () => {
    const sessionId = await masterSession();
    const settle = async (openedBy: string) => {
      const opened = ok(await pass({ op: 'open', sessionId, verb: 'dispatch' }), 201).pass;
      return ok(
        await pass({ op: 'settle', sessionId, passId: opened.id, facts: settleFacts(openedBy) }),
      ).pass;
    };
    expect((await settle('earlier_daemon')).closeReason).toBe('abandoned_restart');
    expect((await settle('adopted')).closeReason).toBe('abandoned_orphan');
    expect((await settle('unrecorded')).closeReason).toBe('unrecorded');
    const listed = ok(await say('owner', 'GET', at('/masters/passes?limit=3'))).items;
    expect(listed.map((p: Doc) => p.closeReason)).toEqual([
      'unrecorded',
      'abandoned_orphan',
      'abandoned_restart',
    ]);
    expect(ok(await say('owner', 'GET', at('/masters/standing'))).lastPass.closeReason).toBe(
      'unrecorded',
    );
  });

  it('refuses an opener it does not know, naming the field', async () => {
    const sessionId = await masterSession();
    const opened = ok(await pass({ op: 'open', sessionId, verb: 'dispatch' }), 201).pass;
    const res = await pass({
      op: 'settle',
      sessionId,
      passId: opened.id,
      facts: settleFacts('gave_up'),
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(JSON.stringify(res.json)).toContain('openedBy');
    const close = await pass({
      op: 'close',
      sessionId,
      passId: opened.id,
      dispatched: [],
      skipped: [],
      parked: [],
      closeReason: 'turn_ended',
    });
    expect(close.status, 'a box closed a pass by its own judgement').toBe(400);
    ok(await pass({ op: 'settle', sessionId, passId: opened.id, facts: settleFacts('adopted') }));
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
    ok(await pass({ op: 'settle', sessionId, passId: opened.id, facts: settleFacts('adopted') }));
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
