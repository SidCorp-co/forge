import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

// ADR 0009, What core takes over: Placement and Retirement. The box posts what only it can see and
// obeys the verdict; core adds its runner row's status and whether its master has a pass open.

type Who = 'box' | 'otherBox';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let runnerId = '';
let otherRunnerId = '';
let drainingProjectId = '';
let drainingRunnerId = '';

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const deviceId = await createTestDevice(ownerId);
  runnerId = await bindTestRunner(projectId, deviceId);
  drainingProjectId = (await createTestProject(ownerId)).id;
  drainingRunnerId = await bindTestRunner(drainingProjectId, deviceId, { status: 'draining' });
  const otherDevice = await createTestDevice(ownerId);
  otherRunnerId = await bindTestRunner(projectId, otherDevice);
  say = requester(app, {
    box: (
      await mintPat({
        userId: ownerId,
        name: 'box',
        deviceId,
        projectIds: [projectId, drainingProjectId],
      })
    ).plaintext,
    otherBox: (
      await mintPat({
        userId: ownerId,
        name: 'other',
        deviceId: otherDevice,
        projectIds: [projectId],
      })
    ).plaintext,
  }) as typeof say;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

function facts(over: Doc = {}): Doc {
  return {
    restarting: null,
    terminal: true,
    standing: 'proceed',
    pane: 'absent',
    capability: null,
    serversReadable: true,
    work: { admissible: 1, owed: 0, poolWaits: false, jobPanes: 0 },
    conversation: { id: 'conv-1', transcript: 'present', elsewhere: 'none' },
    outdated: null,
    holding: { kind: 'nothing' },
    turn: { kind: 'ended' },
    idle: {
      noWorkForSeconds: 0,
      pane: null,
      children: { total: 0, unfinished: [], lastClosedAgoSeconds: null },
    },
    limitHeld: false,
    nudge: { digest: 'd1', last: null, since: 'unreported' },
    ...over,
  };
}

const verdict = (body: Doc, who: Who = 'box') =>
  say(who, 'POST', '/api/devices/me/master-session/verdict', body);

describe('POST /api/devices/me/master-session/verdict', () => {
  it('places a master where work waits, resuming the conversation whose transcript the box holds', async () => {
    const v = ok(await verdict({ projectId, runnerId, facts: facts() }));
    expect(v).toMatchObject({ act: 'place', resume: 'conv-1', nudge: true });
  });

  it("withholds on the runner row's own status, which only core holds", async () => {
    const v = ok(
      await verdict({ projectId: drainingProjectId, runnerId: drainingRunnerId, facts: facts() }),
    );
    expect(v).toMatchObject({ act: 'withhold', reason: 'runner_not_accepting' });
  });

  it("holds a changed digest behind the master's open pass, from core's own pass record", async () => {
    const sessionId = ok(
      await say('box', 'POST', '/api/devices/me/master-session', {
        projectId,
        name: 'forge-master-verdict',
        maxJobPanes: 1,
      }),
    ).sessionId as string;
    const alive = facts({
      pane: 'alive',
      capability: 'current',
      nudge: { digest: 'd2', last: { digest: 'd1', agoSeconds: 0 }, since: 'working' },
    });
    expect(ok(await verdict({ projectId, runnerId, facts: alive }))).toMatchObject({
      act: 'keep',
      nudge: true,
    });
    const pass = (body: Doc) => say('box', 'POST', '/api/devices/me/master-session/pass', body);
    const opened = ok(await pass({ op: 'open', sessionId, verb: 'dispatch' }), 201).pass;
    expect(ok(await verdict({ projectId, runnerId, facts: alive }))).toMatchObject({
      act: 'keep',
      nudge: false,
    });
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
    expect(ok(await verdict({ projectId, runnerId, facts: alive })).nudge).toBe(true);
  });

  it("refuses a runner row that is not this device's, naming it", async () => {
    const res = await verdict({ projectId, runnerId: otherRunnerId, facts: facts() });
    expect(res.status, JSON.stringify(res.json)).toBe(404);
    expect(JSON.stringify(res.json)).toContain(otherRunnerId);
  });

  it('refuses a fact it does not know by name, rather than deciding without it', async () => {
    const res = await verdict({ projectId, runnerId, facts: facts({ pane: 'maybe' }) });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(JSON.stringify(res.json)).toContain('pane');
    const extra = await verdict({ projectId, runnerId, facts: facts({ placement: 'adopt' }) });
    expect(extra.status).toBe(400);
  });
});
