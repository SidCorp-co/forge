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

type Who = 'box' | 'otherBox' | 'owner';
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
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  say = requester(app, {
    owner: await signUserToken(ownerId),
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
    limit: { refusal: null, hooks: 'unheard', turnStartedAgoMs: null },
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

  // forge-dev 2026-10-07: an outdated master that dispatches back to back always holds a run, and was
  // left undriven for two hours while owed feedback waited on it.
  it('keeps and nudges an outdated master holding a working run, and says on its standing how long and why', async () => {
    ok(
      await say('box', 'POST', '/api/devices/me/master-session', {
        projectId,
        name: 'forge-master-verdict',
        maxJobPanes: 1,
      }),
    );
    const outdated = facts({
      pane: 'alive',
      capability: 'current',
      work: { admissible: 0, owed: 6, poolWaits: false, jobPanes: 0 },
      outdated: 'placed under 1.0.0, this box runs 1.1.0',
      holding: { kind: 'these', working: ['r7 (FB-89)'], over: [] },
      nudge: { digest: 'd9', last: null, since: 'unreported' },
    });
    expect(ok(await verdict({ projectId, runnerId, facts: outdated }))).toMatchObject({
      act: 'keep',
      nudge: true,
      drain: true,
    });
    const standing = () => say('owner', 'GET', `/api/projects/${projectId}/masters/standing`);
    const first = ok(await standing()).outdated;
    expect(first).toMatchObject({ why: 'placed under 1.0.0, this box runs 1.1.0', draining: true });
    expect(first.heldBy.join(' ')).toContain('r7 (FB-89)');

    const later = facts({ ...outdated, holding: { kind: 'these', working: ['r8'], over: [] } });
    ok(await verdict({ projectId, runnerId, facts: later }));
    const second = ok(await standing()).outdated;
    expect(second.since, 'since moved while the pane stayed outdated').toBe(first.since);
    expect(second.heldBy.join(' ')).toContain('r8');

    ok(await verdict({ projectId, runnerId, facts: facts({ ...outdated, outdated: null }) }));
    expect(ok(await standing()).outdated).toBeNull();
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
