/**
 * ISS-1324 (with ISS-1315 and ISS-1321 on the hand-out): a warm box is handed to a request only once
 * the device says its screen still answers. Until then it reads `opening`; a warm box whose device
 * is gone is failed `BOX_DEVICE_GONE` by name and never handed out, and an open gets a live box. A
 * warm box never records; its hand-out records only when the open asked.
 *
 * @direct-test-of packages/core/src/boxes/service.ts
 * @direct-test-of packages/core/src/boxes/report.ts
 * @direct-test-of packages/core/src/boxes/allocate.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeWorld, type Doc } from '../helpers/ecosystem-world.js';
import { type BoxWorld, boxFrames, boxWorld, healthy } from '../helpers/forge-box-world.js';

let w: BoxWorld;

beforeAll(async () => {
  w = await boxWorld();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const offer = { codec: 'scrcpy-h264', width: 1080, height: 2400 };

/** The device's warm boxes of `mode`, each brought up as the device would: ready, recording nothing. */
async function warmBoxes(mode: 'browser' | 'android'): Promise<string[]> {
  await w.beat(healthy());
  const rows = (await db.execute(sql`
    SELECT id::text, state FROM boxes
     WHERE device_id = ${w.deviceId} AND project_id IS NULL AND mode = ${mode}
       AND state IN ('opening', 'warm')`)) as unknown as Array<{ id: string; state: string }>;
  for (const r of rows.filter((x) => x.state === 'opening')) {
    expect((await boxFrames(r.id, 'box.open'))[0]?.data).toMatchObject({
      warm: true,
      record: false,
    });
    await w.say('device', 'POST', `/api/boxes/${r.id}/report`, {
      kind: 'state',
      state: 'ready',
      offer,
    });
  }
  return rows.map((r) => r.id);
}

const open = (who: string, body: Doc) =>
  w.say(who, 'POST', `/api/projects/${w.projectId}/boxes`, { issueId: w.issueId, ...body });

describe('a warm box is handed out only while its device answers', () => {
  it('reads opening at its hand-out, and the agent’s only once the device says it answers', async () => {
    const warm = await warmBoxes('android');
    expect(warm.length).toBeGreaterThan(0);
    const opened = await open('agent', { mode: 'android', criterion: 1, runId: 'run-w' });
    expect(opened.status, JSON.stringify(opened.json)).toBe(201);
    const handed = opened.json.box as Doc;
    expect(warm).toContain(handed.id);
    expect(handed.state).toBe('opening');
    const id = handed.id as string;
    expect((await boxFrames(id, 'box.assign')).at(-1)?.data).toEqual({
      boxId: id,
      url: null,
      asPerson: false,
      record: false,
    });
    await w.say('device', 'POST', `/api/boxes/${id}/report`, {
      kind: 'state',
      state: 'ready',
      offer,
    });
    expect(await w.box(id)).toMatchObject({ state: 'agent', recording: null });
    await w.say('agent', 'POST', `/api/boxes/${id}/close`, {});
  });

  it('fails a warm box whose device is gone by name, and an open gets a live box, never the dead one', async () => {
    const [dead] = await warmBoxes('android');
    if (!dead) throw new Error('no warm android box');
    const gone = await w.say('device', 'POST', `/api/boxes/${dead}/report`, {
      kind: 'state',
      state: 'failed',
      failure: 'BOX_DEVICE_GONE',
      detail: "`adb -s emulator-5556 get-state` exited 1: error: device 'emulator-5556' not found",
    });
    expect(gone.status, JSON.stringify(gone.json)).toBe(200);
    const [row] = (await db.execute(
      sql`SELECT state, failure, detail FROM boxes WHERE id = ${dead}`,
    )) as unknown as Doc[];
    expect(row).toMatchObject({ state: 'failed', failure: 'BOX_DEVICE_GONE' });
    expect(String(row?.detail)).toContain('emulator-5556');
    expect((await boxFrames(dead, 'box.close')).at(-1)?.data).toEqual({
      boxId: dead,
      why: 'failed',
    });

    // a replacement warm box is starting; it is not up, so the open starts a fresh box of its own
    const opened = await open('agent', { mode: 'android', criterion: 2, runId: 'run-w' });
    expect(opened.status, JSON.stringify(opened.json)).toBe(201);
    const fresh = opened.json.box as Doc;
    expect(fresh.id).not.toBe(dead);
    expect(fresh.state).toBe('opening');
    expect((await boxFrames(fresh.id as string, 'box.open'))[0]?.data).toMatchObject({
      warm: false,
    });
    await w.say('agent', 'POST', `/api/boxes/${fresh.id}/close`, {});
  });

  it('fails a box whose device is gone at its hand-out, and its request goes on as a fresh box', async () => {
    await warmBoxes('android');
    const opened = await open('agent', { mode: 'android', criterion: 3, runId: 'run-w' });
    const id = (opened.json.box as Doc).id as string;
    expect((opened.json.box as Doc).state).toBe('opening');
    // the assign check and the warm sweep can both report it: one request, one replacement
    const report = {
      kind: 'state',
      state: 'failed',
      failure: 'BOX_DEVICE_GONE',
      detail: 'the emulator on emulator-5556 exited exit status: 1',
    };
    await Promise.all([
      w.say('device', 'POST', `/api/boxes/${id}/report`, report),
      w.say('device', 'POST', `/api/boxes/${id}/report`, report),
    ]);
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM boxes
       WHERE issue_id = ${w.issueId} AND criterion = 3 AND id <> ${id}`)) as unknown as [
      { n: number },
    ];
    expect(n).toBe(1);
    const failed = await w.box(id);
    expect(failed).toMatchObject({ state: 'failed', failure: 'BOX_DEVICE_GONE' });
    const next = /goes on as box ([0-9a-f-]{36})/.exec(String(failed.detail))?.[1];
    expect(next, String(failed.detail)).toBeDefined();
    expect(await w.box(next as string)).toMatchObject({
      state: 'opening',
      issueId: w.issueId,
      criterion: 3,
      holder: null,
    });
    expect((await boxFrames(next as string, 'box.open'))[0]?.data).toMatchObject({ warm: false });
    await w.say('agent', 'POST', `/api/boxes/${next}/close`, {});
  });
});

describe('a warm box handed out records only when its open asked (ISS-1315, ISS-1321)', () => {
  it('hands a person a warm box recording nothing, and records from the hand-out when asked', async () => {
    const warm = await warmBoxes('browser');
    const opened = await open('person', { mode: 'browser', criterion: 4, asPerson: true });
    const handed = opened.json.box as Doc;
    const id = handed.id as string;
    expect(warm).toContain(id);
    expect((await boxFrames(id, 'box.assign')).at(-1)?.data).toEqual({
      boxId: id,
      url: null,
      asPerson: true,
      record: false,
    });
    const ready = await w.say('device', 'POST', `/api/boxes/${id}/report`, {
      kind: 'state',
      state: 'ready',
      offer: { codec: 'jpeg-frames', width: 1280, height: 720 },
    });
    expect(ready.json.box).toMatchObject({ state: 'person', recording: null });
    await w.say('person', 'POST', `/api/boxes/${id}/close`, {});

    await warmBoxes('browser');
    const asked = await open('agent', { mode: 'browser', criterion: 5, record: true });
    const askedId = (asked.json.box as Doc).id as string;
    expect((await boxFrames(askedId, 'box.assign')).at(-1)?.data).toMatchObject({ record: true });
    const createdAt = (asked.json.box as Doc).createdAt as string;
    const startedAt = new Date(Date.parse(createdAt) + 250).toISOString();
    await w.say('device', 'POST', `/api/boxes/${askedId}/report`, {
      kind: 'state',
      state: 'ready',
      offer: { codec: 'jpeg-frames', width: 1280, height: 720 },
      recordingStartedAt: startedAt,
    });
    expect((await w.box(askedId)).recording).toEqual({
      state: 'recording',
      why: 'asked',
      startedAt,
      session: null,
    });
    await w.say('agent', 'POST', `/api/boxes/${askedId}/close`, {});
  });
});
