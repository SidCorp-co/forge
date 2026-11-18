/**
 * ISS-1321: a Forge Box records only when asked (owner 2026-11-18: recording costs resources). An
 * open without `record` asks the device for no recording, a criterion's span records its own clip
 * and stops at its end, a recording a person asked for runs past a span's end, and the record says
 * whether it records and why. Driven through the REST doors, the device's frames read off the outbox.
 *
 * @direct-test-of packages/core/src/boxes/recording.ts
 * @direct-test-of packages/core/src/boxes/spans.ts
 * @direct-test-of packages/core/src/boxes/service.ts
 * @direct-test-of packages/core/src/boxes/allocate.ts
 * @direct-test-of packages/core/src/boxes/report.ts
 * @direct-test-of packages/core/src/boxes/read.ts
 * @direct-test-of packages/core/src/boxes/routes.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userToken } from '../helpers/api.js';
import { closeWorld, type Doc, requester } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { type BoxWorld, boxFrames, boxWorld, healthy } from '../helpers/forge-box-world.js';

let w: BoxWorld;

beforeAll(async () => {
  w = await boxWorld();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** Open a browser box (a viewport, so never a warm one) and bring it up as the device would. */
async function running(open: Doc = {}, recordingStartedAt?: string): Promise<string> {
  await w.beat(healthy());
  const opened = await w.say('agent', 'POST', `/api/projects/${w.projectId}/boxes`, {
    mode: 'browser',
    issueId: w.issueId,
    runId: 'run-r',
    viewport: { width: 390, height: 844 },
    ...open,
  });
  expect(opened.status, JSON.stringify(opened.json)).toBe(201);
  const id = (opened.json.box as Doc).id as string;
  const ready = await w.say('device', 'POST', `/api/boxes/${id}/report`, {
    kind: 'state',
    state: 'ready',
    offer: { codec: 'jpeg-frames', width: 390, height: 844 },
    ...(recordingStartedAt ? { recordingStartedAt } : {}),
  });
  expect((ready.json.box as Doc).state).toBe('agent');
  return id;
}

const span = (id: string, criterion: number, edge: 'start' | 'end') =>
  w.say('agent', 'POST', `/api/boxes/${id}/spans`, { criterion, edge });

const lastMark = async (id: string) => (await boxFrames(id, 'box.span.mark')).at(-1)?.data;

describe('a box records only when asked', () => {
  it('asks the device for no recording on an open without record, and says it records nothing', async () => {
    const id = await running();
    expect((await boxFrames(id, 'box.open'))[0]?.data).toMatchObject({ record: false });
    expect((await w.box(id)).recording).toBeNull();
  });

  it('asks for the recording on an open naming record, and says it records because it was asked', async () => {
    const at = new Date().toISOString();
    const id = await running({ record: true }, at);
    expect((await boxFrames(id, 'box.open'))[0]?.data).toMatchObject({ record: true });
    expect((await w.box(id)).recording).toEqual({
      state: 'recording',
      why: 'asked',
      startedAt: at,
      session: null,
    });
  });
});

describe("a criterion's span records its own clip", () => {
  it('starts the recording at a span begun with it off, and stops it at the last open span’s end', async () => {
    const id = await running();
    const first = await span(id, 1, 'start');
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(await lastMark(id)).toMatchObject({ edge: 'start', recording: 'start' });
    expect((await w.box(id)).recording).toMatchObject({ state: 'recording', why: 'span' });
    const at = new Date().toISOString();
    await w.say('device', 'POST', `/api/boxes/${id}/report`, {
      kind: 'recording',
      state: 'on',
      at,
    });
    expect((await w.box(id)).recording).toEqual({
      state: 'recording',
      why: 'span',
      startedAt: at,
      session: null,
    });

    // a second span joins the running recording; the first's end leaves it for the second
    await span(id, 2, 'start');
    expect(await lastMark(id)).toMatchObject({ criterion: 2, recording: null });
    await span(id, 1, 'end');
    expect(await lastMark(id)).toMatchObject({ criterion: 1, edge: 'end', recording: null });
    expect((await w.box(id)).recording).toMatchObject({ state: 'recording' });
    await span(id, 2, 'end');
    expect(await lastMark(id)).toMatchObject({ criterion: 2, edge: 'end', recording: 'stop' });
    expect((await w.box(id)).recording).toEqual({
      state: 'kept',
      why: null,
      startedAt: at,
      session: null,
    });

    // the clip is still ordered from what the span recorded
    const spanId = (first.json.span as Doc).id as string;
    for (const [edge, offsetMs] of [
      ['start', 1_000],
      ['end', 6_000],
    ] as const) {
      await w.say('device', 'POST', `/api/boxes/${id}/report`, {
        kind: 'mark',
        spanId,
        edge,
        offsetMs,
      });
    }
    expect((await boxFrames(id, 'box.recording.fetch')).at(-1)?.data).toMatchObject({
      spanId,
      fromMs: 1_000,
      toMs: 6_000,
    });
  });

  it('leaves running a recording a person asked for past every span’s end', async () => {
    const id = await running();
    const on = await w.say('person', 'POST', `/api/boxes/${id}/recording`, { on: true });
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    expect((on.json.box as Doc).recording).toMatchObject({ state: 'recording', why: 'person' });
    expect((await boxFrames(id, 'box.recording.set')).map((f) => f.data)).toEqual([
      { boxId: id, on: true },
    ]);
    await span(id, 3, 'start');
    expect(await lastMark(id)).toMatchObject({ recording: null });
    await span(id, 3, 'end');
    expect(await lastMark(id)).toMatchObject({ recording: null });
    expect((await w.box(id)).recording).toMatchObject({ state: 'recording', why: 'person' });

    const off = await w.say('person', 'POST', `/api/boxes/${id}/recording`, { on: false });
    expect((off.json.box as Doc).recording).toMatchObject({ state: 'kept', why: null });
    expect((await boxFrames(id, 'box.recording.set')).at(-1)?.data).toEqual({
      boxId: id,
      on: false,
    });
  });

  it('says a recording that could not start records nothing, in the tool’s words', async () => {
    const id = await running();
    await w.say('person', 'POST', `/api/boxes/${id}/recording`, { on: true });
    expect((await w.box(id)).recording).toMatchObject({ state: 'recording', why: 'person' });
    await w.say('device', 'POST', `/api/boxes/${id}/report`, {
      kind: 'recording',
      state: 'failed',
      at: new Date().toISOString(),
      detail: '`agent-browser record start` exited 1: no page',
    });
    const after = await w.box(id);
    expect(after.recording).toBeNull();
    expect(after.detail).toContain('no page');
  });
});

describe('the recording toggle', () => {
  it('is refused by name to someone who may only read the project, and on a box not running', async () => {
    const id = await running();
    const viewer = (await createTestUser({ verified: true })).id;
    await addProjectMember(w.projectId, viewer, 'viewer');
    const say = requester(w.app as never, { viewer: await userToken(viewer) });
    const refused = await say('viewer', 'POST', `/api/boxes/${id}/recording`, { on: true });
    expect(refused.status, JSON.stringify(refused.json)).toBe(403);
    expect(JSON.stringify(refused.json)).toContain('FORBIDDEN');
    expect(await boxFrames(id, 'box.recording.set')).toEqual([]);

    await w.say('agent', 'POST', `/api/boxes/${id}/close`, {});
    const closed = await w.say('person', 'POST', `/api/boxes/${id}/recording`, { on: true });
    expect(closed.status).toBe(409);
    expect(closed.json).toMatchObject({ code: 'BOX_CLOSED' });
  });
});
