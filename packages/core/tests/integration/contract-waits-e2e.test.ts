import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  closeWorld,
  type Doc,
  type EcosystemWorld,
  formEcosystem,
  ok,
  openWorld,
  refusal,
  seedContractVersion,
  sender,
  settleOutbox,
  writeInterfaces,
} from '../helpers/ecosystem-world.js';
import { bindTestRunner, createTestDevice } from '../helpers/factories.js';

let w: EcosystemWorld;
let say: ReturnType<typeof sender>;
let publish: MockInstance;
let box = '';
let readAdmissibleIssues: typeof import('../../src/devices/admissible.js').readAdmissibleIssues;

const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString();

beforeAll(async () => {
  w = await openWorld();
  await formEcosystem(w);
  await writeInterfaces(w);
  say = sender(w);
  box = await createTestDevice(w.user.plugin);
  await bindTestRunner(w.project.plugin, box);
  ({ readAdmissibleIssues } = await import('../../src/devices/admissible.js'));
  const { roomManager } = await import('../../src/lib/rooms.js');
  publish = vi.spyOn(roomManager, 'publish');
}, 120_000);

afterAll(async () => {
  publish?.mockRestore();
  await closeWorld();
});

const pluginIssues = () => `/api/projects/${w.project.plugin}/issues`;
const waits = (issue: string) => `/api/issues/${issue}/contract-waits`;

async function openIssue(title: string): Promise<string> {
  const made = ok(await say('plugin', 'POST', pluginIssues(), { title, status: 'open' }), 201);
  expect(made.status).toBe('open');
  return made.id as string;
}

const admittedIds = async () =>
  (await readAdmissibleIssues({ deviceId: box, projectId: w.project.plugin })).items.map(
    (a) => a.issueId,
  );

async function issueWakes(): Promise<Doc[]> {
  await settleOutbox();
  return publish.mock.calls
    .map((c) => c[1] as Doc)
    .filter((e) => e.event === 'master.wake' && e.data.issueId)
    .map((e) => e.data);
}

const ids = { held: '', wait: '', free: '' };

describe('an issue waits on a provider version no approval has reached', () => {
  it('writes the wait unsettled, and the issue read says it is held by name', async () => {
    ids.held = await openIssue('Send policyVersion on every run-session open');
    expect(await admittedIds()).toContain(ids.held);
    const made = ok(
      await say('plugin', 'POST', waits(ids.held), {
        contract: 'forge/forge-api',
        minVersion: '2026-10-15',
        reason: 'the run-session open takes policyVersion from that version',
      }),
      201,
    );
    expect(made.wait).toMatchObject({
      contract: 'forge/forge-api',
      provider: { id: w.project.forge, slug: 'forge' },
      inProject: false,
      minVersion: '2026-10-15',
      settled: false,
      settledVersion: null,
      current: '2026-09-20',
    });
    ids.wait = made.wait.id;
    const read = ok(await say('plugin', 'GET', `${waits(ids.held)}?live=false`));
    expect(read.dispatchable).toBe(false);
    expect(read.refusal).toMatchObject({ code: 'CONTRACT_WAIT_UNSETTLED' });
    expect(read.refusal.detail).toMatch(/waits on forge\/forge-api >= 2026-10-15/);
  });

  it('leaves the held issue off the admissible list, and keeps the rest on it', async () => {
    ids.free = await openIssue('Unrelated work');
    const admitted = await admittedIds();
    expect(admitted).not.toContain(ids.held);
    expect(admitted).toContain(ids.free);
  });

  const plants: [string, Doc, string][] = [
    [
      'a contract the interface does not name',
      { contract: 'forge/runner-api', minVersion: '2026-10-15' },
      'CONTRACT_WAIT_CONTRACT_UNKNOWN /contract',
    ],
    [
      'a version outside the provider scheme',
      { contract: 'forge/forge-api', minVersion: 'v2' },
      'CONTRACT_WAIT_VERSION_NOT_IN_SCHEME /minVersion',
    ],
    [
      'a deadline already past',
      { contract: 'forge/forge-mcp', minVersion: '2026-10-15', dueAt: day(-2) },
      'CONTRACT_WAIT_DUE_PAST /dueAt',
    ],
    [
      'a second live wait on one contract',
      { contract: 'forge/forge-api', minVersion: '2026-11-01' },
      'CONTRACT_WAIT_DUPLICATE /contract',
    ],
  ];

  it.each(plants)('refuses %s by name and writes nothing', async (_name, body, want) => {
    expect(refusal(await say('plugin', 'POST', waits(ids.held), body))).toEqual([want]);
    const read = ok(await say('plugin', 'GET', `${waits(ids.held)}?live=false`));
    expect(read.waits).toHaveLength(1);
  });

  it('refuses a viewer, who may read the waits but not add one', async () => {
    const res = await say('viewer', 'POST', waits(ids.free), {
      contract: 'forge/forge-api',
      minVersion: '2026-10-15',
    });
    expect([res.status, res.json.error.code]).toEqual([403, 'PERMISSION_FORBIDDEN']);
    expect(ok(await say('viewer', 'GET', `${waits(ids.held)}?live=false`)).waits).toHaveLength(1);
  });

  it('writes a wait on a version already approved settled, so it never holds its issue', async () => {
    const made = ok(
      await say('plugin', 'POST', waits(ids.free), {
        contract: 'forge/forge-mcp',
        minVersion: '2026-09-01',
      }),
      201,
    );
    expect(made.wait).toMatchObject({ settled: true, settledVersion: '2026-09-20' });
    expect(await admittedIds()).toContain(ids.free);
  });
});

describe("the provider's approval settles the wait in its own transaction and wakes the issue", () => {
  it('leaves the wait held while the reaching version is only proposed', async () => {
    await seedContractVersion({
      providerId: w.project.forge,
      ref: 'forge/forge-api',
      version: '2026-10-20',
      previous: '2026-09-20',
      classification: 'non-breaking',
      approval: 'proposed',
    });
    expect(await admittedIds()).not.toContain(ids.held);
  });

  it('settles on approval, names the version, and wakes the plugin master for that issue', async () => {
    await settleOutbox();
    publish.mockClear();
    const decided = ok(
      await say(
        'platform',
        'POST',
        `/api/projects/${w.project.forge}/contracts/forge-api/versions/2026-10-20/decision`,
        { decision: 'approve' },
      ),
    );
    expect(decided.approval).toMatchObject({ state: 'approved' });
    const read = ok(await say('plugin', 'GET', `${waits(ids.held)}?live=false`));
    expect(read).toMatchObject({ dispatchable: true, refusal: null });
    expect(read.waits[0]).toMatchObject({
      settled: true,
      settledVersion: '2026-10-20',
      current: '2026-10-20',
    });
    expect(await admittedIds()).toContain(ids.held);
    expect(await issueWakes()).toContainEqual(
      expect.objectContaining({ projectId: w.project.plugin, issueId: ids.held }),
    );
  });

  it('refuses a second decision on the decided version', async () => {
    const res = await say(
      'platform',
      'POST',
      `/api/projects/${w.project.forge}/contracts/forge-api/versions/2026-10-20/decision`,
      { decision: 'approve' },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(422);
  });
});

describe('a wait is retracted with a reason, and the row stays', () => {
  it('retracts once, then refuses the second by name', async () => {
    const path = `${waits(ids.held)}/${ids.wait}/retract`;
    const res = ok(await say('plugin', 'POST', path, { reason: 'the open no longer needs it' }));
    expect(res.wait).toMatchObject({
      retractReason: 'the open no longer needs it',
      retractedAt: expect.stringMatching(/^\d{4}-/),
    });
    expect(refusal(await say('plugin', 'POST', path, { reason: 'again' }))).toEqual([
      'CONTRACT_WAIT_RETRACTED /wait',
    ]);
    expect(ok(await say('plugin', 'GET', `${waits(ids.held)}?live=false`)).waits).toHaveLength(1);
  });

  it('answers 404 for a wait the issue does not hold', async () => {
    const res = await say('plugin', 'POST', `${waits(ids.free)}/${ids.wait}/retract`, {
      reason: 'not mine',
    });
    expect(res.status).toBe(404);
  });
});
