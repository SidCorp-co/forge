/**
 * ISS-1338 (FB-747): a box's kept whole-session recording a person or the open asked for is brought
 * to Forge once the box ends. Its close tells the device to send it, after `box.close`; the device
 * uploads it through the span clip's own door with `session` in the span's place, and it becomes an
 * attachment of the box's issue the record names. Past `BOX_LIMITS.sessionMaxBytes`, or with the
 * device gone, the record says why. A box nobody asked to record sends nothing and is refused one.
 * Driven through the REST doors, the device's frames read off the outbox.
 *
 * @direct-test-of packages/core/src/boxes/session.ts
 * @direct-test-of packages/core/src/boxes/service.ts
 * @direct-test-of packages/core/src/boxes/allocate.ts
 * @direct-test-of packages/core/src/boxes/report.ts
 * @direct-test-of packages/core/src/boxes/read.ts
 * @direct-test-of packages/core/src/boxes/routes.ts
 */

import { BOX_LIMITS } from '@forge/contracts/boxes';
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

const WEBM = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00];

/** A browser box brought up as the device would, recording from its open where `record`. */
async function running(open: Doc = {}): Promise<string> {
  await w.beat(healthy());
  const opened = await w.say('agent', 'POST', `/api/projects/${w.projectId}/boxes`, {
    mode: 'browser',
    issueId: w.issueId,
    runId: 'run-s',
    viewport: { width: 390, height: 844 },
    ...open,
  });
  expect(opened.status, JSON.stringify(opened.json)).toBe(201);
  const id = (opened.json.box as Doc).id as string;
  await w.say('device', 'POST', `/api/boxes/${id}/report`, {
    kind: 'state',
    state: 'ready',
    offer: { codec: 'jpeg-frames', width: 390, height: 844 },
    ...(open.record ? { recordingStartedAt: new Date().toISOString() } : {}),
  });
  return id;
}

/** The device's upload of the whole recording, through the span clip's door. */
async function upload(id: string, clip: Buffer = Buffer.from(WEBM)) {
  const form = new FormData();
  form.set('clip', new File([clip], 'clip.webm', { type: 'video/webm' }));
  form.set('still', new File([Buffer.from(PNG)], 'still.png', { type: 'image/png' }));
  const r = await w.app.request(`/api/boxes/${id}/spans/session/clip`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${w.deviceToken}`, 'X-Forge-Lifecycle': '10' },
    body: form,
  });
  return { status: r.status, json: (await r.json()) as Doc };
}

/** The device goes offline or comes back, as its heartbeat stopping or resuming reads. */
async function deviceIs(status: 'online' | 'offline'): Promise<void> {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`UPDATE devices SET status = ${status} WHERE id = ${w.deviceId}`);
  });
}

const attachments = async (id: string) =>
  (await db.execute(sql`
    SELECT id::text, name, mime FROM issue_attachments
     WHERE issue_id = ${w.issueId} AND name LIKE ${`box-${id.slice(0, 8)}-session%`}
     ORDER BY name`)) as unknown as Doc[];

describe('a kept recording a person asked for is brought to Forge once its box ends', () => {
  it('tells the device to send it after the close, and names the attachment it became', async () => {
    const id = await running({ record: true });
    const closed = await w.say('agent', 'POST', `/api/boxes/${id}/close`, {});
    expect(closed.status, JSON.stringify(closed.json)).toBe(200);
    // the close seals the last segment on the device, so the send is ordered after it
    expect((await boxFrames(id)).map((f) => f.event).slice(-2)).toEqual([
      'box.close',
      'box.recording.upload',
    ]);
    expect((await boxFrames(id, 'box.recording.upload'))[0]?.data).toEqual({
      boxId: id,
      maxBytes: BOX_LIMITS.sessionMaxBytes,
    });
    expect((await w.box(id)).recording).toMatchObject({
      state: 'kept',
      session: { state: 'sending', clipAttachmentId: null, fault: null },
    });

    const sent = await upload(id);
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    const files = await attachments(id);
    expect(files.map((f) => [f.name, f.mime])).toEqual([
      [`box-${id.slice(0, 8)}-session.png`, 'image/png'],
      [`box-${id.slice(0, 8)}-session.webm`, 'video/webm'],
    ]);
    const session = ((await w.box(id)).recording as Doc).session as Doc;
    expect(session).toMatchObject({
      state: 'attached',
      clipAttachmentId: files[1]?.id,
      stillAttachmentId: files[0]?.id,
      fault: null,
      detail: null,
    });

    // sent twice, it is attached once
    expect((await upload(id)).status).toBe(200);
    expect(await attachments(id)).toHaveLength(2);
  });

  it('sends one a person turned on and off before the close, which a span alone never would', async () => {
    const id = await running();
    await w.say('person', 'POST', `/api/boxes/${id}/recording`, { on: true });
    await w.say('person', 'POST', `/api/boxes/${id}/recording`, { on: false });
    await w.say('person', 'POST', `/api/boxes/${id}/close`, {});
    expect(await boxFrames(id, 'box.recording.upload')).toHaveLength(1);
  });
});

describe('where the recording cannot come, the box says why', () => {
  it('says TOO_LARGE past the size limit, from the device or from core, and attaches nothing', async () => {
    const id = await running({ record: true });
    await w.say('agent', 'POST', `/api/boxes/${id}/close`, {});
    const over = await upload(id, Buffer.alloc(BOX_LIMITS.sessionMaxBytes + 1, 1));
    expect(over.status, JSON.stringify(over.json)).toBe(409);
    expect(over.json).toMatchObject({ code: 'BOX_SPAN_INVALID' });
    expect(await attachments(id)).toEqual([]);
    const session = ((await w.box(id)).recording as Doc).session as Doc;
    expect(session).toMatchObject({ state: 'failed', fault: 'TOO_LARGE', clipAttachmentId: null });
    expect(session.detail).toContain(`over the ${BOX_LIMITS.sessionMaxBytes}`);
    // the device's word on core's refusal does not overwrite the fault core found
    await w.say('device', 'POST', `/api/boxes/${id}/report`, {
      kind: 'session_failed',
      fault: 'SEND_FAILED',
      detail: 'core refused the clip 422',
    });
    expect(((await w.box(id)).recording as Doc).session).toMatchObject({ fault: 'TOO_LARGE' });

    const big = await running({ record: true });
    await w.say('agent', 'POST', `/api/boxes/${big}/close`, {});
    const said = await w.say('device', 'POST', `/api/boxes/${big}/report`, {
      kind: 'session_failed',
      fault: 'TOO_LARGE',
      detail: 'the recording is 31457280 bytes at its smallest, over the 10485760 a box sends',
    });
    expect(said.status, JSON.stringify(said.json)).toBe(200);
    expect(((await w.box(big)).recording as Doc).session).toMatchObject({
      state: 'failed',
      fault: 'TOO_LARGE',
      detail: 'the recording is 31457280 bytes at its smallest, over the 10485760 a box sends',
    });
  });

  it('says DEVICE_GONE where the device went offline before sending it', async () => {
    const id = await running({ record: true });
    await w.say('agent', 'POST', `/api/boxes/${id}/close`, {});
    await deviceIs('offline');
    const { sweepBoxes } = await import('../../src/boxes/index.js');
    await sweepBoxes(new Date(Date.now() + (BOX_LIMITS.sessionAnswerSeconds + 60) * 1000));
    expect(((await w.box(id)).recording as Doc).session).toMatchObject({
      state: 'failed',
      fault: 'DEVICE_GONE',
      detail: 'the device went offline before it sent the recording',
    });
    await deviceIs('online');
  });

  it('says NO_ISSUE for a box tested by hand with no issue, and tells the device to send nothing', async () => {
    const id = await running({ record: true, issueId: undefined });
    await w.say('agent', 'POST', `/api/boxes/${id}/close`, {});
    expect(await boxFrames(id, 'box.recording.upload')).toEqual([]);
    expect(((await w.box(id)).recording as Doc).session).toMatchObject({
      state: 'failed',
      fault: 'NO_ISSUE',
    });
  });
});

describe('recording stays optional', () => {
  it('sends nothing for a box only a span recorded, and refuses a send nobody asked for', async () => {
    const id = await running();
    await w.say('agent', 'POST', `/api/boxes/${id}/spans`, { criterion: 1, edge: 'start' });
    await w.say('agent', 'POST', `/api/boxes/${id}/spans`, { criterion: 1, edge: 'end' });
    expect((await w.box(id)).recording).toMatchObject({ state: 'kept', session: null });
    await w.say('agent', 'POST', `/api/boxes/${id}/close`, {});
    expect(await boxFrames(id, 'box.recording.upload')).toEqual([]);
    expect(((await w.box(id)).recording as Doc).session).toBeNull();
    const refused = await upload(id);
    expect(refused.status, JSON.stringify(refused.json)).toBe(409);
    expect(refused.json).toMatchObject({ code: 'BOX_SESSION_NOT_OWED' });
    expect(await attachments(id)).toEqual([]);
  });

  it('sends nothing for a box nobody asked to record', async () => {
    const id = await running();
    await w.say('agent', 'POST', `/api/boxes/${id}/close`, {});
    expect(await boxFrames(id, 'box.recording.upload')).toEqual([]);
    expect((await w.box(id)).recording).toBeNull();
  });
});
