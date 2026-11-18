/**
 * ISS-1276: a Forge Box is a kernel record core decides and the device only runs. Driven through the
 * REST doors as an agent (a token), a person (a session) and the device (its credential), with the
 * device's frames read off the outbox, as the runner reads them off its socket.
 *
 * @direct-test-of packages/core/src/boxes/service.ts
 * @direct-test-of packages/core/src/boxes/acts.ts
 * @direct-test-of packages/core/src/boxes/allocate.ts
 * @direct-test-of packages/core/src/boxes/hold.ts
 * @direct-test-of packages/core/src/boxes/report.ts
 * @direct-test-of packages/core/src/boxes/spans.ts
 * @direct-test-of packages/core/src/boxes/routes.ts
 * @direct-test-of packages/core/src/devices/run-slots-read.ts
 * @direct-test-of packages/core/src/devices/box-health.ts
 * @direct-test-of packages/core/src/devices/routes.ts
 */

import type { BoxHealthReport } from '@forge/contracts/box-wire';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { userToken } from '../helpers/api.js';
import {
  closeWorld,
  type Doc,
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

type Say = (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;
let say: Say;
let app: Hono;
let deviceToken = '';
let projectId = '';
let issueId = '';
let deviceId = '';

const healthy = (over: Partial<BoxHealthReport> = {}, held: string[] = []): BoxHealthReport => ({
  memory: { availableMb: 64 * 1024, reserveMb: 16 * 1024 },
  cpu: { pressureSomeAvg10: 4, ceiling: 40 },
  disk: { freeMb: 400 * 1024, reserveMb: 20 * 1024 },
  kvm: true,
  modes: [
    {
      mode: 'browser',
      serves: true,
      lacks: [],
      fix: null,
      cost: { memoryMb: 600, diskMb: 100, cpuCores: 1 },
      versions: { 'agent-browser': '0.43.0' },
    },
    {
      mode: 'android',
      serves: true,
      lacks: [],
      fix: null,
      cost: { memoryMb: 4096, diskMb: 512, cpuCores: 3 },
      versions: { emulator: '37.2' },
    },
    {
      mode: 'desktop',
      serves: false,
      lacks: ['agent-desktop'],
      fix: '`forge-runner setup`',
      cost: { memoryMb: 800, diskMb: 100, cpuCores: 1 },
      versions: {},
    },
    {
      mode: 'ios',
      serves: false,
      lacks: ['a Mac'],
      fix: null,
      cost: { memoryMb: 0, diskMb: 0, cpuCores: 0 },
      versions: {},
    },
  ],
  held,
  ...over,
});

const beat = async (box: BoxHealthReport) => {
  const r = await say('device', 'POST', '/api/devices/heartbeat', { box });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.box).toEqual({ accepted: true });
};

/** The frames the device was sent for a box, oldest first, as the runner reads them. */
async function frames(boxId: string, event?: string): Promise<Array<{ event: string; data: Doc }>> {
  const rows = (await db.execute(sql`
    SELECT payload FROM pipeline_outbox
     WHERE type = 'device.pushed' AND payload -> 'data' ->> 'boxId' = ${boxId}
     ORDER BY seq`)) as unknown as Array<{ payload: { event: string; data: Doc } }>;
  return [...rows].map((r) => r.payload).filter((p) => !event || p.event === event);
}

const box = async (id: string) => (await say('agent', 'GET', `/api/boxes/${id}`)).json.box as Doc;

/** Open a browser box and bring it up as the device would: ready, its recording started. */
async function runningBox(criterion = 1): Promise<string> {
  await beat(healthy());
  const opened = await say('agent', 'POST', `/api/projects/${projectId}/boxes`, {
    mode: 'browser',
    issueId,
    criterion,
    runId: 'run-k',
    viewport: { width: 390, height: 844 },
  });
  expect(opened.status, JSON.stringify(opened.json)).toBe(201);
  const id = (opened.json.box as Doc).id as string;
  const ready = await say('device', 'POST', `/api/boxes/${id}/report`, {
    kind: 'state',
    state: 'ready',
    offer: { codec: 'jpeg-frames', width: 390, height: 844 },
    recordingStartedAt: new Date().toISOString(),
  });
  expect(ready.status, JSON.stringify(ready.json)).toBe(200);
  expect((ready.json.box as Doc).state).toBe('agent');
  return id;
}

beforeAll(async () => {
  testEnv();
  app = (await import('../../src/index.js')).app as unknown as Hono;
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  deviceId = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
  const [row] = (await db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, priority, created_by_id)
    VALUES (${projectId}, 1, 'Redeem points at the counter', 'in_progress', 'high', ${ownerId})
    RETURNING id`)) as unknown as Array<{ id: string }>;
  issueId = (row as { id: string }).id;
  const mint = async (name: string, device?: string) =>
    (
      await mintPat({
        permissions: ['*'],
        userId: ownerId,
        name,
        projectIds: [projectId],
        grantEpoch: 99,
        ...(device ? { deviceId: device } : {}),
      })
    ).plaintext;
  deviceToken = await mint('device', deviceId);
  say = requester(app as never, {
    agent: await mint('agent'),
    device: deviceToken,
    person: await userToken(ownerId),
  }) as Say;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a box mode', () => {
  it('refuses ios by name, and a mode the device lacks with the fix', async () => {
    await beat(healthy());
    const ios = await say('agent', 'POST', `/api/projects/${projectId}/boxes`, { mode: 'ios' });
    expect(ios.status).toBe(409);
    expect(ios.json).toMatchObject({ code: 'BOX_MODE_UNAVAILABLE' });
    expect(JSON.stringify(ios.json)).toContain('no box serves ios yet');
    const desktop = await say('agent', 'POST', `/api/projects/${projectId}/boxes`, {
      mode: 'desktop',
    });
    expect(desktop.status).toBe(409);
    expect(JSON.stringify(desktop.json)).toContain(
      'it lacks agent-desktop. Fix: `forge-runner setup`',
    );
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM boxes WHERE project_id = ${projectId} AND mode = 'desktop'`)) as unknown as [
      { n: number },
    ];
    expect(n).toBe(0);
  });
});

describe("the device's health decides, never a count", () => {
  it('holds a request over the headroom waiting with its place and reason, and starts it when headroom returns', async () => {
    await beat(healthy({ cpu: { pressureSomeAvg10: 88, ceiling: 40 } }));
    const asked = await say('agent', 'POST', `/api/projects/${projectId}/boxes`, {
      mode: 'android',
      issueId,
      criterion: 2,
    });
    expect(asked.status).toBe(409);
    expect(asked.json).toMatchObject({ code: 'BOX_SLOT_UNAVAILABLE' });
    const said = JSON.stringify(asked.json);
    expect(said).toContain('1st in this device');
    expect(said).toContain('CPU pressure is 88% (PSI some avg10), over the 40% ceiling');
    const id = /box ([0-9a-f-]{36}) waits/.exec(said)?.[1] as string;
    expect(await box(id)).toMatchObject({
      state: 'waiting',
      queue: { position: 1, reason: 'CPU pressure is 88% (PSI some avg10), over the 40% ceiling' },
    });
    expect(await frames(id, 'box.open')).toEqual([]);

    // pressure falls: the next heartbeat starts it, with nothing asked again
    await beat(healthy());
    expect(await box(id)).toMatchObject({ state: 'opening', queue: null });
    expect((await frames(id, 'box.open'))[0]?.data).toMatchObject({
      boxId: id,
      mode: 'android',
      warm: false,
    });
    await say('agent', 'POST', `/api/boxes/${id}/close`, {});
  });
});

describe('take control and hand back', () => {
  it("refuses an agent's write while a person holds the box, changes nothing, and still answers its read", async () => {
    const id = await runningBox();
    const taken = await say('person', 'POST', `/api/boxes/${id}/take`);
    expect(taken.status, JSON.stringify(taken.json)).toBe(200);
    expect(taken.json.box).toMatchObject({ state: 'person', holder: { kind: 'person' } });
    expect((await frames(id, 'box.take')).length).toBe(1);

    const before = (await frames(id, 'box.act')).length;
    const click = await say('agent', 'POST', `/api/boxes/${id}/acts`, {
      command: ['click', '@e33'],
    });
    expect(click.status).toBe(409);
    expect(click.json).toMatchObject({ code: 'BOX_HELD_BY_PERSON' });
    expect(JSON.stringify(click.json)).toMatch(/has held it since \d{4}-\d\d-\d\dT/);
    // the click never reached the device
    expect((await frames(id, 'box.act')).length).toBe(before);
    const feed = (await say('agent', 'GET', `/api/boxes/${id}/acts`)).json.acts as Doc[];
    expect(feed.at(-1)).toMatchObject({
      by: 'agent',
      kind: 'write',
      state: 'refused',
      refusal: 'BOX_HELD_BY_PERSON',
    });

    // a read still answers: the device runs it and reports
    const reading = say('agent', 'POST', `/api/boxes/${id}/acts`, { command: ['snapshot', '-i'] });
    await expect
      .poll(async () => (await frames(id, 'box.act')).length, { timeout: 10_000 })
      .toBe(before + 1);
    const sent = (await frames(id, 'box.act')).at(-1)?.data as Doc;
    expect(sent).toMatchObject({ kind: 'read', command: ['snapshot', '-i'] });
    await say('device', 'POST', `/api/boxes/${id}/report`, {
      kind: 'act',
      actId: sent.actId,
      exitCode: 0,
      stdout: '- button "Redeem" [ref=e33]',
      stderr: '',
      durationMs: 41,
    });
    expect((await reading).json).toMatchObject({
      act: { state: 'done', stdout: '- button "Redeem" [ref=e33]' },
    });

    // hand back: the agent writes again and learns what the person did
    const { recordPersonInput } = await import('../../src/boxes/acts.js');
    const personId = (taken.json.box as { holder: { userId: string } }).holder.userId;
    expect(await recordPersonInput(id, personId, { t: 'tap', x: 0.5, y: 0.8 })).toBe(true);
    expect((await say('person', 'POST', `/api/boxes/${id}/release`)).json.box).toMatchObject({
      state: 'agent',
    });
    expect(await recordPersonInput(id, personId, { t: 'tap', x: 0.5, y: 0.8 })).toBe(false);
    const writing = say('agent', 'POST', `/api/boxes/${id}/acts`, { command: ['click', '@e33'] });
    await expect
      .poll(async () => (await frames(id, 'box.act')).length, { timeout: 10_000 })
      .toBe(before + 2);
    const next = (await frames(id, 'box.act')).at(-1)?.data as Doc;
    await say('device', 'POST', `/api/boxes/${id}/report`, {
      kind: 'act',
      actId: next.actId,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 9,
    });
    expect((await writing).json).toMatchObject({
      act: { state: 'done' },
      personActed: { inputs: 1 },
    });
  });

  it('expires an idle hold back to the agent, on the record', async () => {
    const id = await runningBox();
    await say('person', 'POST', `/api/boxes/${id}/take`);
    await db.execute(
      sql`UPDATE boxes SET last_input_at = now() - interval '10 minutes' WHERE id = ${id}`,
    );
    const { sweepBoxes } = await import('../../src/boxes/index.js');
    await sweepBoxes();
    expect(await box(id)).toMatchObject({ state: 'agent', holder: { kind: 'agent' } });
    const moves = (await db.execute(sql`
      SELECT from_status, to_status, actor_type, reason FROM kernel_transitions
       WHERE entity = 'box' AND entity_id = ${id} ORDER BY created_at`)) as unknown as Doc[];
    expect(moves.at(-1)).toMatchObject({
      from_status: 'person',
      to_status: 'agent',
      actor_type: 'sweeper',
      reason: expect.stringContaining('the hold expired back to the agent'),
    });
    expect((await frames(id, 'box.release')).at(-1)?.data).toEqual({ boxId: id, why: 'expired' });
  });
});

describe('a hold ends with its box (ISS-1317)', () => {
  it('closes a box a person holds, its hold cleared and the move on the record', async () => {
    const id = await runningBox();
    expect((await say('person', 'POST', `/api/boxes/${id}/take`)).status).toBe(200);
    const closed = await say('person', 'POST', `/api/boxes/${id}/close`, {});
    expect(closed.status, JSON.stringify(closed.json)).toBe(200);
    expect(closed.json.box).toMatchObject({ state: 'closed' });
    const [row] = (await db.execute(
      sql`SELECT state, held_by, held_since FROM boxes WHERE id = ${id}`,
    )) as unknown as Doc[];
    expect(row).toEqual({ state: 'closed', held_by: null, held_since: null });
    const moves = (await db.execute(sql`
      SELECT from_status, to_status FROM kernel_transitions
       WHERE entity = 'box' AND entity_id = ${id} ORDER BY created_at`)) as unknown as Doc[];
    expect(moves.at(-1)).toEqual({ from_status: 'person', to_status: 'closed' });
    expect((await frames(id, 'box.close')).at(-1)?.data).toEqual({ boxId: id, why: 'done' });
  });

  it('closes a held box in one write the hold check admits, called past the door', async () => {
    const id = await runningBox();
    const taken = await say('person', 'POST', `/api/boxes/${id}/take`);
    const holder = (taken.json.box as { holder: { userId: string } }).holder.userId;
    const { closeBox } = await import('../../src/boxes/service.js');
    // past the door, a close that kept the hold throws Postgres's own refusal naming boxes_held_chk
    await expect(closeBox(id, { userId: holder, agency: 'human' })).resolves.toMatchObject({
      state: 'closed',
    });
  });

  it('fails a box a person holds with its hold cleared', async () => {
    const id = await runningBox();
    await say('person', 'POST', `/api/boxes/${id}/take`);
    const { failBox } = await import('../../src/boxes/allocate.js');
    const { boxes } = await import('../../src/db/schema-boxes.js');
    const { eq } = await import('drizzle-orm');
    const [row] = await db.select().from(boxes).where(eq(boxes.id, id));
    expect(row?.state).toBe('person');
    if (!row) throw new Error(`no box ${id}`);
    await failBox(row, 'BOX_GONE', 'gone', { type: 'runner', id: deviceId });
    const [after] = (await db.execute(
      sql`SELECT state, held_by, held_since FROM boxes WHERE id = ${id}`,
    )) as unknown as Doc[];
    expect(after).toEqual({ state: 'failed', held_by: null, held_since: null });
  });
});

describe('a box handed out or opened for a person (ISS-1315)', () => {
  it('starts a warm box’s evidence at the hand-out, never before its createdAt', async () => {
    await beat(healthy());
    const warm = (await db.execute(sql`
      SELECT id, state FROM boxes
       WHERE device_id = ${deviceId} AND project_id IS NULL AND mode = 'browser'
         AND state IN ('opening', 'warm')`)) as unknown as Array<{ id: string; state: string }>;
    // the device brought the warm box up a minute ago, recording from then
    const longAgo = new Date(Date.now() - 60_000).toISOString();
    for (const w of warm.filter((r) => r.state === 'opening')) {
      await say('device', 'POST', `/api/boxes/${w.id}/report`, {
        kind: 'state',
        state: 'ready',
        offer: { codec: 'jpeg-frames', width: 1280, height: 720 },
        recordingStartedAt: longAgo,
      });
    }
    expect(warm.length).toBeGreaterThan(0);

    const opened = await say('person', 'POST', `/api/projects/${projectId}/boxes`, {
      mode: 'browser',
      issueId,
      criterion: 3,
      asPerson: true,
    });
    expect(opened.status, JSON.stringify(opened.json)).toBe(201);
    const handed = opened.json.box as Doc;
    const id = handed.id as string;
    expect(warm.map((w) => w.id)).toContain(id);
    expect(handed.state).toBe('person');
    const startedAt = (handed.recording as Doc).startedAt as string;
    expect(Date.parse(startedAt)).toBeGreaterThanOrEqual(Date.parse(handed.createdAt as string));
    expect((await frames(id, 'box.assign')).at(-1)?.data).toEqual({
      boxId: id,
      url: null,
      asPerson: true,
    });

    // the device restarts the evidence at the assignment and says the instant
    const restarted = new Date(Date.parse(handed.createdAt as string) + 250).toISOString();
    const ready = await say('device', 'POST', `/api/boxes/${id}/report`, {
      kind: 'state',
      state: 'ready',
      offer: { codec: 'jpeg-frames', width: 1280, height: 720 },
      recordingStartedAt: restarted,
    });
    expect(ready.status, JSON.stringify(ready.json)).toBe(200);
    expect((await box(id)).recording).toEqual({ state: 'recording', startedAt: restarted });
    await say('person', 'POST', `/api/boxes/${id}/close`, {});
  });

  it('tells the device at open that a person holds a box opened for them', async () => {
    await beat(healthy());
    const opened = await say('person', 'POST', `/api/projects/${projectId}/boxes`, {
      mode: 'browser',
      issueId,
      criterion: 4,
      asPerson: true,
      viewport: { width: 390, height: 844 },
    });
    expect(opened.status, JSON.stringify(opened.json)).toBe(201);
    const id = (opened.json.box as Doc).id as string;
    expect((await frames(id, 'box.open'))[0]?.data).toMatchObject({
      boxId: id,
      warm: false,
      asPerson: true,
    });
    await say('person', 'POST', `/api/boxes/${id}/close`, {});
  });
});

describe("a criterion's span becomes its evidence", () => {
  it('cuts the span into a clip and still attached to the issue under the criterion', async () => {
    const id = await runningBox(2);
    const start = await say('agent', 'POST', `/api/boxes/${id}/spans`, {
      criterion: 2,
      edge: 'start',
    });
    expect(start.status, JSON.stringify(start.json)).toBe(201);
    const spanId = (start.json.span as Doc).id as string;
    await say('device', 'POST', `/api/boxes/${id}/report`, {
      kind: 'mark',
      spanId,
      edge: 'start',
      offsetMs: 4_000,
    });
    await say('agent', 'POST', `/api/boxes/${id}/spans`, { criterion: 2, edge: 'end' });
    await say('device', 'POST', `/api/boxes/${id}/report`, {
      kind: 'mark',
      spanId,
      edge: 'end',
      offsetMs: 13_500,
    });
    expect((await frames(id, 'box.recording.fetch')).at(-1)?.data).toMatchObject({
      spanId,
      fromMs: 4_000,
      toMs: 13_500,
      maxSeconds: 20,
    });

    const form = new FormData();
    form.set(
      'clip',
      new File([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01])], 'c.webm', {
        type: 'video/webm',
      }),
    );
    form.set(
      'still',
      new File([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])], 's.png', {
        type: 'image/png',
      }),
    );
    const uploaded = await app.request(`/api/boxes/${id}/spans/${spanId}/clip`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceToken}`, 'X-Forge-Lifecycle': '10' },
      body: form,
    });
    const body = (await uploaded.json()) as { span: Doc };
    expect(uploaded.status, JSON.stringify(body)).toBe(200);
    expect(body.span).toMatchObject({ criterion: 2, state: 'attached', issueId });
    const files = (await db.execute(sql`
      SELECT id::text, name, mime FROM issue_attachments WHERE issue_id = ${issueId} ORDER BY name`)) as unknown as Doc[];
    const short = `box-${id.slice(0, 8)}-c2-${spanId.slice(0, 8)}`;
    expect(files).toEqual(
      [
        {
          id: body.span.clipAttachmentId,
          name: `${short}.png`.replace('.png', '.webm'),
          mime: 'video/webm',
        },
        { id: body.span.stillAttachmentId, name: `${short}.png`, mime: 'image/png' },
      ].sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1)),
    );
  });
});
