/**
 * ISS-1322: an agent on a box's own device attaches its own tools to a browser box's CDP, served by
 * the device's proxy. Core hands the endpoint only to a caller on that device (`BOX_ATTACH_REMOTE`
 * elsewhere), never for a mode whose endpoint a take cannot revoke (`BOX_ATTACH_UNAVAILABLE`), and
 * writes what attached sessions did into the act feed `via: cdp`, beside the act door's acts.
 *
 * @direct-test-of packages/core/src/boxes/attach.ts
 * @direct-test-of packages/core/src/boxes/report.ts
 * @direct-test-of packages/core/src/boxes/routes.ts
 * @direct-test-of packages/core/src/boxes/acts.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeWorld, type Doc } from '../helpers/ecosystem-world.js';
import { type BoxWorld, boxFrames, boxWorld, healthy } from '../helpers/forge-box-world.js';

let w: BoxWorld;
const CDP = 'http://127.0.0.1:41733';

beforeAll(async () => {
  w = await boxWorld();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** Open a box and bring it up as the device would; `attach` is what its `ready` carries. */
async function runningBox(mode: 'browser' | 'android', attach?: { cdp: string }): Promise<string> {
  await w.beat(healthy());
  const opened = await w.say('agent', 'POST', `/api/projects/${w.projectId}/boxes`, {
    mode,
    issueId: w.issueId,
    criterion: 1,
    runId: 'run-a',
  });
  expect(opened.status, JSON.stringify(opened.json)).toBe(201);
  const id = (opened.json.box as Doc).id as string;
  const offer =
    mode === 'browser'
      ? { codec: 'jpeg-frames', width: 390, height: 844 }
      : { codec: 'scrcpy-h264', width: 1080, height: 2400 };
  const ready = await w.say('device', 'POST', `/api/boxes/${id}/report`, {
    kind: 'state',
    state: 'ready',
    offer,
    ...(attach ? { attach } : {}),
  });
  expect(ready.status, JSON.stringify(ready.json)).toBe(200);
  expect(JSON.stringify(ready.json)).not.toContain('41733');
  return id;
}

const feed = async (id: string) =>
  ((await w.say('agent', 'GET', `/api/boxes/${id}/acts`)).json.acts as Doc[]).map((a) => ({
    via: a.via,
    kind: a.kind,
    command: a.command,
    state: a.state,
    refusal: a.refusal,
    actor: a.actor,
  }));

describe('attach (ISS-1322)', () => {
  it("hands a browser box's CDP URL to an agent on its device, records it, and refuses one elsewhere by name", async () => {
    const id = await runningBox('browser', { cdp: CDP });

    const here = await w.say('checkout', 'POST', `/api/boxes/${id}/attach`, { runId: 'run-a' });
    expect(here.status, JSON.stringify(here.json)).toBe(200);
    expect(here.json).toMatchObject({
      attach: { mode: 'browser', cdp: CDP },
      box: { id, state: 'agent' },
    });
    expect(await feed(id)).toEqual([
      {
        via: 'cdp',
        kind: 'read',
        command: ['attach'],
        state: 'done',
        refusal: null,
        actor: 'agent:run-a',
      },
    ]);
    const record = await w.box(id);
    expect(JSON.stringify(record)).not.toContain('41733');

    const nowhere = await w.say('agent', 'POST', `/api/boxes/${id}/attach`, {});
    expect(nowhere.status).toBe(409);
    expect(nowhere.json).toMatchObject({ code: 'BOX_ATTACH_REMOTE' });
    expect(String(nowhere.json.message)).toContain('bound to no device');
    const elsewhere = await w.say('elsewhere', 'POST', `/api/boxes/${id}/attach`, {});
    expect(elsewhere.status).toBe(409);
    expect(String(elsewhere.json.message)).toContain(`the box runs on device ${w.deviceId}`);
    expect(String(elsewhere.json.message)).toContain('forge-runner box act');
    expect(JSON.stringify([nowhere.json, elsewhere.json])).not.toContain('41733');
    expect((await feed(id)).length, 'a refused attach records nothing').toBe(1);

    const early = await w.say('checkout2', 'POST', `/api/boxes/${id}/attach`, {});
    expect(early.status).toBe(403);
    expect(early.json).toMatchObject({
      code: 'PAT_GRANT_PREDATES_ROUTE',
      details: { prefix: '/api/boxes', routeEpoch: 4, tokenEpoch: 2 },
    });
  });

  it('writes what attached sessions did into the feed via cdp, a refused write as refused, beside the act door', async () => {
    const id = await runningBox('browser', { cdp: CDP });
    const reading = w.say('agent', 'POST', `/api/boxes/${id}/acts`, { command: ['snapshot'] });
    await expect.poll(async () => (await boxFrames(id, 'box.act')).length).toBe(1);
    const sent = (await boxFrames(id, 'box.act'))[0]?.data as Doc;
    await w.say('device', 'POST', `/api/boxes/${id}/report`, {
      kind: 'act',
      actId: sent.actId,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 4,
    });
    expect((await reading).json).toMatchObject({ act: { via: 'act', state: 'done' } });

    const said = await w.say('device', 'POST', `/api/boxes/${id}/report`, {
      kind: 'cdp',
      acts: [
        { method: 'Page.navigate', count: 1, refused: false },
        { method: 'Input.dispatchMouseEvent', count: 3, refused: true },
      ],
    });
    expect(said.status, JSON.stringify(said.json)).toBe(200);
    expect((await feed(id)).slice(1)).toEqual([
      {
        via: 'cdp',
        kind: 'write',
        command: ['Page.navigate'],
        state: 'done',
        refusal: null,
        actor: 'agent:run-a',
      },
      {
        via: 'cdp',
        kind: 'write',
        command: ['Input.dispatchMouseEvent', '×3'],
        state: 'refused',
        refusal: 'BOX_HELD_BY_PERSON',
        actor: 'agent:run-a',
      },
    ]);
    const agentSide = (await w.say('agent', 'GET', `/api/boxes/${id}/acts?by=agent`)).json
      .acts as Doc[];
    expect(agentSide.map((a) => a.via)).toEqual(['act', 'cdp', 'cdp']);

    await w.say('agent', 'POST', `/api/boxes/${id}/close`, {});
    const late = await w.say('device', 'POST', `/api/boxes/${id}/report`, {
      kind: 'cdp',
      acts: [{ method: 'Page.reload', count: 1, refused: false }],
    });
    expect(late.status).toBe(409);
    expect(late.json).toMatchObject({ code: 'BOX_CLOSED' });
  });

  it('refuses an android box, and a browser box whose device reported no endpoint, BOX_ATTACH_UNAVAILABLE', async () => {
    const android = await runningBox('android');
    const a = await w.say('checkout', 'POST', `/api/boxes/${android}/attach`, {});
    expect(a.status).toBe(409);
    expect(a.json).toMatchObject({ code: 'BOX_ATTACH_UNAVAILABLE' });
    expect(String(a.json.message)).toContain(
      'adb serial cannot be taken back when a person takes the box',
    );

    const old = await runningBox('browser');
    const b = await w.say('checkout', 'POST', `/api/boxes/${old}/attach`, {});
    expect(b.json).toMatchObject({ code: 'BOX_ATTACH_UNAVAILABLE' });
    expect(String(b.json.message)).toContain('predates attach');
  });

  it("refuses a ready whose attach is not the device's loopback", async () => {
    await w.beat(healthy());
    const opened = await w.say('agent', 'POST', `/api/projects/${w.projectId}/boxes`, {
      mode: 'browser',
    });
    const id = (opened.json.box as Doc).id as string;
    const far = await w.say('device', 'POST', `/api/boxes/${id}/report`, {
      kind: 'state',
      state: 'ready',
      attach: { cdp: 'http://10.0.0.7:9222' },
    });
    expect(far.status).toBe(400);
    expect(JSON.stringify(far.json)).toContain('loopback');
  });
});
