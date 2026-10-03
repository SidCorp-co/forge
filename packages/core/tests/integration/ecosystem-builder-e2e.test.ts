import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  type Doc,
  type EcosystemWorld,
  formEcosystem,
  JOIN_HEAD,
  openWorld,
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
// The same master unfenced: /api/ecosystems is an account route a project-fenced token does not reach, so a fenced master supersedes through forge_ecosystem.
let masterAccount = '';
let otherMaster = '';
let otherMasterAccount = '';
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
  const fenced = (await mintPat({ userId: agent, name: 'master', projectIds: [projectId] }))
    .plaintext;
  const { PAT_GRANT_EPOCH } = await import('../../src/auth/pat-permissions.js');
  const account = (
    await mintPat({ userId: agent, name: 'master-account', grantEpoch: PAT_GRANT_EPOCH })
  ).plaintext;
  return { fenced, account };
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
  ({ fenced: master, account: masterAccount } = await agentOn(
    w.project.plugin,
    w.org.plugin,
    'forge-plugin-master',
  ));
  ({ fenced: otherMaster, account: otherMasterAccount } = await agentOn(
    w.project.forge,
    w.org.platform,
    'forge-master',
  ));
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
    expect(run).toMatchObject({
      trigger: { kind: 'joined', sha: JOIN_HEAD },
      findings: [],
      links: [],
    });
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
      expect(r.status, JSON.stringify(r.json)).toBe(422);
      expect(r.json.error.code).toBe('BUILDER_RUN_WRITER_NOT_PROJECT');
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

describe('a run that cannot finish truly is superseded, and a fresh one opens', () => {
  const supersede = (token: string, runId: string, body: unknown) =>
    as(token, 'POST', `/api/ecosystems/${w.eco}/builder-runs/${runId}/supersede`, body);
  const openRun = async () =>
    (await as(master, 'GET', runs())).json.runs.find((r: Doc) =>
      r.document.steps.some((s: Doc) => s.status === 'pending' || s.status === 'running'),
    );

  it('refuses a missing reason, another project’s master and a person who is no org admin, by name', async () => {
    const held = await openRun();
    const bare = await supersede(masterAccount, held.document.id, {});
    expect(bare.status, JSON.stringify(bare.json)).toBe(422);
    expect(bare.json.error.refusals.map((x: Doc) => `${x.code} ${x.path}`)).toEqual([
      'BUILDER_RUN_SUPERSEDE_WITHOUT_REASON /reason',
    ]);
    for (const token of [otherMasterAccount, w.token.viewer]) {
      const r = await supersede(token, held.document.id, { reason: 'not mine to close' });
      expect(r.status, JSON.stringify(r.json)).toBe(422);
      expect(r.json.error.code).toBe('BUILDER_RUN_SUPERSEDE_NOT_AUTHORISED');
    }
    expect((await openRun()).document.id).toBe(held.document.id);
  });

  it("closes the open run as superseded, opens a manual run at the head, and wakes the project's master", async () => {
    const held = await openRun();
    const before = buildWakes(box.plugin);
    const r = await supersede(masterAccount, held.document.id, {
      reason: 'opened on the old steps',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const { superseded, opened } = r.json;
    expect(superseded.document.supersededBy).toEqual({
      run: opened.document.id,
      reason: 'opened on the old steps',
    });
    expect(superseded.document.steps.every((s: Doc) => s.status === 'superseded')).toBe(true);
    expect(opened.document.trigger).toEqual({ kind: 'manual', sha: JOIN_HEAD });
    expect(opened.document.steps.every((s: Doc) => s.status === 'pending')).toBe(true);
    expect(buildWakes(box.plugin) - before).toBe(1);
    expect((await openRun()).document.id).toBe(opened.document.id);
    const bus = await as(w.token.platform, 'GET', `/api/ecosystems/${w.eco}/bus`);
    const mine = bus.json.projects.find((p: Doc) => p.id === w.project.plugin);
    expect(mine.builder).toMatchObject({ id: opened.document.id, stepsStale: false });
  });

  it('refuses superseding a run no longer open, and any write to a superseded run, by name', async () => {
    const listed = (await as(master, 'GET', runs())).json.runs;
    const gone = listed.find((r: Doc) => r.document.supersededBy);
    const again = await supersede(masterAccount, gone.document.id, { reason: 'twice' });
    expect(again.status, JSON.stringify(again.json)).toBe(422);
    expect(again.json.error.refusals.map((x: Doc) => x.code)).toEqual(['BUILDER_RUN_NOT_OPEN']);
    const doc = structuredClone(gone.document);
    for (const k of ['id', 'createdAt', 'updatedAt']) delete doc[k];
    const put = await as(master, 'PUT', `${runs()}/${gone.document.id}`, {
      baseRevision: gone.revision,
      document: doc,
    });
    expect(put.status, JSON.stringify(put.json)).toBe(422);
    expect(put.json.error.refusals.map((x: Doc) => x.code)).toEqual(['BUILDER_RUN_SUPERSEDED']);
  });

  it('lets an admin of the steward org supersede it, and refuses a head it cannot read without opening anything', async () => {
    const held = await openRun();
    w.head.mockRejectedValueOnce(new Error('this project has no active source host binding'));
    const blind = await supersede(w.token.platform, held.document.id, { reason: 'steward reset' });
    expect(blind.status, JSON.stringify(blind.json)).toBe(422);
    expect(blind.json.error.refusals.map((x: Doc) => `${x.code} ${x.path}`)).toEqual([
      'BUILDER_RUN_HEAD_UNREADABLE /trigger/sha',
    ]);
    expect((await openRun()).document.id).toBe(held.document.id);
    const r = await supersede(w.token.platform, held.document.id, { reason: 'steward reset' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.opened.document.trigger.kind).toBe('manual');
  });
});

describe("a provisioned checkout's credential is its project's own agent", () => {
  const checkout = async (deviceId: string, projectId: string, holderUserId: string) => {
    const { issueCheckoutCredential } = await import('../../src/devices/workspace-credential.js');
    return issueCheckoutCredential({ deviceId, projectId, holderUserId });
  };
  const opened = async () => {
    const listed = (await as(master, 'GET', runs())).json.runs as Doc[];
    const open = listed.find((r) => r.document.steps.some((s: Doc) => s.status !== 'succeeded'));
    if (!open) throw new Error('no open builder run to write');
    const doc = structuredClone(open.document);
    for (const k of ['id', 'createdAt', 'updatedAt']) delete doc[k];
    doc.steps[0].status = 'running';
    return { id: open.document.id as string, revision: open.revision as number, doc };
  };

  it("a box paired by a person writes its own project's builder run through the checkout's token", async () => {
    const own = await checkout(box.plugin, w.project.plugin, w.user.plugin);
    const run = await opened();
    const r = await as(own, 'PUT', `${runs()}/${run.id}`, {
      baseRevision: run.revision,
      document: run.doc,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });

  it("another project's checkout token is refused that run by name", async () => {
    const other = await checkout(box.forge, w.project.forge, w.user.platform);
    const run = await opened();
    const r = await as(other, 'PUT', `${runs()}/${run.id}`, {
      baseRevision: run.revision,
      document: run.doc,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(422);
    expect(r.json.error.code).toBe('BUILDER_RUN_WRITER_NOT_PROJECT');
  });

  it('a person below member is refused the project agent by name, and nothing is minted', async () => {
    const viewer = (await createTestUser(w.harness.db)).id;
    await createTestProjectMember(w.harness.db, {
      userId: viewer,
      projectId: w.project.plugin,
      role: 'viewer',
    });
    await expect(checkout(box.plugin, w.project.plugin, viewer)).rejects.toMatchObject({
      code: 'WORKSPACE_HOLDER_REFUSED',
      message: expect.stringContaining('holds viewer'),
    });
  });
});
