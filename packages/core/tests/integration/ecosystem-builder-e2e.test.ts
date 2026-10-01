import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  type Doc,
  type EcosystemWorld,
  formEcosystem,
  openWorld,
  sender,
  writeInterfaces,
} from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProjectMember,
  createTestUser,
} from '../helpers/factories.js';

let w: EcosystemWorld;
let publish: MockInstance;
let master = '';
let otherMaster = '';
let deviceToken = '';
// Counted where the joins happen: the suite clears mock calls before each test.
let joinWakes = 0;
const box = { plugin: '', forge: '' };

const runs = () => `/api/projects/${w.project.plugin}/builder-runs`;

const buildWakes = (deviceId: string) =>
  publish.mock.calls.filter(
    ([room, msg]) =>
      String(room).includes(deviceId) &&
      (msg as Doc).event === 'master.wake' &&
      (msg as Doc).data?.source === 'ecosystem_build',
  ).length;

async function as(token: string, method: string, path: string, body?: unknown) {
  const res = await w.app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function agentOn(projectId: string, orgId: string, handle: string) {
  const { mintPat } = await import('../../src/auth/pat.js');
  const agent = (await createTestUser(w.harness.db, { kind: 'agent' })).id;
  await w.harness.db.execute(sql`
    INSERT INTO organization_members (org_id, user_id, role, handle)
    VALUES (${orgId}, ${agent}, 'member', ${handle})
  `);
  await createTestProjectMember(w.harness.db, { userId: agent, projectId, role: 'member' });
  return (await mintPat({ userId: agent, name: 'master', projectIds: [projectId] })).plaintext;
}

beforeAll(async () => {
  w = await openWorld();
  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({
    ownerId: w.user.plugin,
    name: 'plugin-box',
    platform: 'linux',
  });
  box.plugin = issued.device.id;
  deviceToken = issued.plaintext;
  box.forge = (await createTestDevice(w.harness.db, w.user.platform)).id;
  for (const side of ['plugin', 'forge'] as const) {
    await bindTestRunner(w.harness.db, { projectId: w.project[side], deviceId: box[side] });
  }
  const { roomManager } = await import('../../src/ws/server.js');
  publish = vi.spyOn(roomManager, 'publish');
  await formEcosystem(w);
  joinWakes = buildWakes(box.plugin);
  await writeInterfaces(w);
  master = await agentOn(w.project.plugin, w.org.plugin, 'forge-plugin-master');
  otherMaster = await agentOn(w.project.forge, w.org.platform, 'forge-master');
}, 120_000);

afterAll(async () => {
  publish?.mockRestore();
  await w.harness.cleanup();
});

describe('joining an ecosystem gives the joining project its builder run', () => {
  it('accept opens exactly one joined run, every step pending, and wakes that project once', async () => {
    const listed = await as(master, 'GET', runs());
    expect(listed.status, JSON.stringify(listed.json)).toBe(200);
    expect(listed.json.runs).toHaveLength(1);
    const run = listed.json.runs[0].document;
    expect(run).toMatchObject({ trigger: { kind: 'joined' }, findings: [], links: [] });
    expect(run.steps.map((s: Doc) => `${s.name}:${s.status}`)).toEqual([
      'read-repo:pending',
      'find-outbound-calls:pending',
      'match-contracts:pending',
      'write-links:pending',
      'check:pending',
      'publish-role:pending',
    ]);
    expect(joinWakes).toBe(1);
  });

  it("the open run is in the inbox the project's box reads every sweep", async () => {
    const inbox = await as(
      deviceToken,
      'GET',
      `/api/devices/me/channel/unanswered?projectId=${w.project.plugin}`,
    );
    expect(inbox.status, JSON.stringify(inbox.json)).toBe(200);
    expect(inbox.json.builderRuns).toHaveLength(1);
    expect(inbox.json.builderRuns[0]).toMatchObject({ trigger: { kind: 'joined' }, done: 0 });
  });
});

describe("only the project's own master works its run", () => {
  const step = (doc: Doc, i: number, status: string) => {
    const d = structuredClone(doc);
    d.steps[i].status = status;
    for (const k of ['id', 'createdAt', 'updatedAt']) delete d[k];
    return d;
  };

  it('refuses a person and another project’s master by name, and takes the master', async () => {
    const [held] = (await as(master, 'GET', runs())).json.runs;
    const next = step(held.document, 0, 'running');
    for (const token of [w.token.plugin, otherMaster]) {
      const r = await as(token, 'PUT', `${runs()}/${held.document.id}`, {
        baseRevision: held.revision,
        document: next,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(403);
      expect(r.json.code).toBe('BUILDER_RUN_WRITER_NOT_PROJECT');
    }
    const r = await as(master, 'PUT', `${runs()}/${held.document.id}`, {
      baseRevision: held.revision,
      document: next,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.report).toEqual({ open: true, declaredWithoutCallSite: [] });
  });

  it('refuses a step status outside the closed enum by name', async () => {
    const [held] = (await as(master, 'GET', runs())).json.runs;
    const r = await as(master, 'PUT', `${runs()}/${held.document.id}`, {
      baseRevision: held.revision,
      document: step(held.document, 0, 'done'),
    });
    expect(r.status).toBe(422);
    expect(r.json.error.refusals.map((x: Doc) => x.code)).toEqual(['STEP_STATUS_UNKNOWN']);
  });

  it('refuses a second open run for the same project and ecosystem by name', async () => {
    const [held] = (await as(master, 'GET', runs())).json.runs;
    const second = step(held.document, 0, 'pending');
    second.trigger = { kind: 'push', sha: 'a'.repeat(40) };
    const r = await as(master, 'POST', runs(), { baseRevision: null, document: second });
    expect(r.status, JSON.stringify(r.json)).toBe(422);
    expect(r.json.error.refusals.map((x: Doc) => `${x.code} ${x.path}`)).toEqual([
      'BUILDER_RUN_ALREADY_OPEN /steps',
    ]);
  });

  it('a finished run reports each declared consumption with no call site', async () => {
    const [held] = (await as(master, 'GET', runs())).json.runs;
    const done = structuredClone(held.document);
    for (const k of ['id', 'createdAt', 'updatedAt']) delete done[k];
    done.steps = done.steps.map((s: Doc) => ({ ...s, status: 'succeeded' }));
    const r = await as(master, 'PUT', `${runs()}/${held.document.id}`, {
      baseRevision: held.revision,
      document: done,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.report.open).toBe(false);
    expect(
      r.json.report.declaredWithoutCallSite.map((f: Doc) => `${f.classification} ${f.contract}`),
    ).toEqual([
      'declared_without_call_site forge/forge-api',
      'declared_without_call_site forge/forge-mcp',
    ]);
  });
});

describe('a push to the default branch reopens the run', () => {
  it('opens one push run and wakes once; another push while it is open folds into it', async () => {
    const { openPushedRuns } = await import('../../src/ecosystem/builder-trigger.js');
    const before = buildWakes(box.plugin);
    const push = (branch: string, defaultBranch: string | null, commit = 'b'.repeat(40)) =>
      openPushedRuns({ projectId: w.project.plugin, branch, defaultBranch, commit });
    expect(await push('feature', 'main')).toBe(0);
    expect(await push('main', null)).toBe(0);
    expect(await push('main', 'main')).toBe(1);
    expect(await push('main', 'main', 'c'.repeat(40))).toBe(0);
    expect(buildWakes(box.plugin) - before).toBe(1);
    const listed = (await as(master, 'GET', runs())).json.runs;
    expect(listed.map((r: Doc) => r.document.trigger.kind)).toEqual(['push', 'joined']);
  });
});
