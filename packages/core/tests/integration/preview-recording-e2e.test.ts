import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// The preview site, set before the process reads its environment: a development `host:port`.
vi.hoisted(() => {
  process.env.PREVIEW_DOMAIN = 'preview.localhost:7311';
});

import { db } from '../../src/db/client.js';
import { sweepRecordings } from '../../src/previews/recordings.js';
import { signViewer } from '../../src/previews/ticket.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { createTestFeedback } from '../helpers/factories.js';
import { SHIPPED, SubjectsWorld } from '../helpers/preview-subjects-world.js';
import { atPreview, cookieOf } from '../helpers/preview-world.js';

// REQ-41 r1 BC-18, BC-21 (docs/proposals/chat-first.md "Reproduce"): a reproduce preview records
// what a member does in it with rrweb, inputs masked and every string scrubbed before it is
// stored, read as a timeline, and opened only to the project's signed-in members. Driven over real
// sockets: core, the project's app under its own `script-src 'self'`, and a box.

const world = new SubjectsWorld();
let owner = '';
let member = '';
let stranger = '';
let projectId = '';
let ownerId = '';
let preview: { id: string; url: string };
let cookie = '';
let recordingId = '';

const post = (path: string, headers: Record<string, string>, body: string) =>
  world.postAtPreview(preview.url, path, headers, body);

beforeAll(async () => {
  await world.start();
  ({ owner, member, stranger, projectId, ownerId } = world);
  const fb = await createTestFeedback(projectId, ownerId, 52);
  world.serveApp();
  const opened = await api(owner, 'POST', `/api/projects/${projectId}/previews`, {
    kind: 'reproduce',
    feedback: fb,
    build: { sha: SHIPPED },
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  preview = opened.body.preview as { id: string; url: string };
  await settleOutbox();
  const deadline = Date.now() + 15_000;
  let state = '';
  while (state !== 'live' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    state = String(
      ((await api(owner, 'GET', `/api/previews/${preview.id}`)).body.preview as { state: string })
        .state,
    );
  }
  expect(state).toBe('live');
  cookie = cookieOf((await world.enter(preview)).entered.headers['set-cookie']);
}, 120_000);

afterAll(() => world.stop());

it("puts the recorder after <head> of the app's HTML, asks for it unencoded, and serves it on the app's own origin", async () => {
  const page = await atPreview(world.core, preview.url, '/', {
    cookie,
    'accept-encoding': 'gzip, br',
  });
  expect(page.status).toBe(200);
  expect(page.text).toContain(
    '<head><script src="/__forge_preview/rec.js"></script><title>shop</title>',
  );
  expect(Number(page.headers['content-length'])).toBe(Buffer.byteLength(page.text));
  expect(String(page.headers['content-security-policy'])).toContain("script-src 'self'");
  expect(world.appSeen.at(-1)?.headers['accept-encoding']).toBe('identity');

  const script = await atPreview(world.core, preview.url, '/__forge_preview/rec.js', { cookie });
  expect(script.status).toBe(200);
  expect(script.headers['content-type']).toContain('text/javascript');
  expect(script.text).toContain('"maskAllInputs":true');
  expect(script.text).toContain('"recordHeaders":false');
  expect(script.text).toContain('getRecordNetworkPlugin');
  const [row] = (await db.execute(
    sql`SELECT id, state FROM preview_recordings WHERE preview_id = ${preview.id}`,
  )) as unknown as { id: string; state: string }[];
  expect(row?.state).toBe('recording');
  recordingId = String(row?.id);
  expect(script.text).toContain(`"recordingId":"${recordingId}"`);
  expect(world.appSeen.some((s) => s.url.startsWith('/__forge_preview/'))).toBe(false);
});

it('stores a batch scrubbed and reads it as clicks, typing, console errors and failed requests', async () => {
  const t = 1_760_000_000_000;
  const batch = {
    recordingId,
    seq: 0,
    events: [
      {
        type: 4,
        timestamp: t,
        data: {
          href: 'https://shop.test/orders?email=jane.doe@example.com',
          width: 1280,
          height: 720,
        },
      },
      {
        type: 5,
        timestamp: t + 100,
        data: { tag: 'forge.click', payload: { label: 'Save order' } },
      },
      {
        type: 3,
        timestamp: t + 200,
        data: { source: 5, text: '*******', isChecked: false, id: 7 },
      },
      {
        type: 6,
        timestamp: t + 300,
        data: {
          plugin: 'rrweb/console@1',
          payload: {
            level: 'error',
            trace: [],
            payload: [
              '"save failed for jane.doe@example.com with ghp_0123456789abcdefghijABCDEFGHIJ012345"',
            ],
          },
        },
      },
      {
        type: 6,
        timestamp: t + 400,
        data: {
          plugin: 'rrweb/network@1',
          payload: {
            requests: [{ name: 'https://api.shop.test/orders', method: 'POST', status: 500 }],
          },
        },
      },
    ],
  };
  const sent = await post('/__forge_preview/rec', { cookie }, JSON.stringify(batch));
  expect(sent.status, sent.text).toBe(202);

  const read = await api(member, 'GET', `/api/recordings/${recordingId}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  const recording = read.body.recording as {
    timeline: { kind: string; text: string; at: number }[];
    events: number;
  };
  expect(recording.events).toBe(5);
  expect(recording.timeline.map((e) => e.kind)).toEqual([
    'navigate',
    'viewport',
    'click',
    'input',
    'console_error',
    'request_failed',
  ]);
  expect(recording.timeline.find((e) => e.kind === 'click')?.text).toBe('Clicked Save order');
  expect(recording.timeline.find((e) => e.kind === 'request_failed')?.text).toBe(
    'POST https://api.shop.test/orders answered 500',
  );
  const stored =
    JSON.stringify(recording) +
    JSON.stringify((await api(member, 'GET', `/api/recordings/${recordingId}/events`)).body);
  expect(stored).not.toContain('jane.doe@example.com');
  expect(stored).not.toContain('ghp_0123456789abcdefghij');
  expect(stored).toContain('[email]');

  // the next batch is owed in order: a gap is refused naming the one owed
  const gap = await post('/__forge_preview/rec', { cookie }, JSON.stringify({ ...batch, seq: 5 }));
  expect(gap.status).toBe(409);
  expect(JSON.parse(gap.text)).toMatchObject({ code: 'RECORDING_SEQ_GAP', owes: 1 });
  const junk = await post('/__forge_preview/rec', { cookie }, '{"recordingId":1}');
  expect(JSON.parse(junk.text)).toMatchObject({ code: 'RECORDING_BATCH_INVALID' });
});

it('opens recordings only to signed-in members of the project (BC-21)', async () => {
  const outsider = await api(stranger, 'GET', `/api/recordings/${recordingId}`);
  expect(outsider.status).toBe(403);
  expect(outsider.body).toMatchObject({ code: 'RECORDING_FORBIDDEN' });
  expect((await api(stranger, 'GET', `/api/recordings/${recordingId}/events`)).status).toBe(403);
  expect((await api(null, 'GET', `/api/recordings/${recordingId}`)).status).toBe(401);
  expect(
    (await api(stranger, 'GET', `/api/projects/${projectId}/feedback/FB-52/recordings`)).body,
  ).toMatchObject({ code: 'RECORDING_FORBIDDEN' });
  const list = await api(member, 'GET', `/api/projects/${projectId}/feedback/FB-52/recordings`);
  expect((list.body.recordings as unknown[]).length).toBe(1);

  // the recorder's paths answer only this preview's viewer cookie of a current member
  const bare = await post('/__forge_preview/rec', {}, '{}');
  expect(bare.status).toBe(403);
  expect(bare.text).toContain('Open this preview from Forge');
  const [s] = (await db.execute(
    sql`SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM project_members WHERE project_id = ${projectId}) LIMIT 1`,
  )) as unknown as { id: string }[];
  const forged = await signViewer({ previewId: preview.id, userId: String(s?.id) });
  const notMember = await atPreview(world.core, preview.url, '/__forge_preview/rec.js', {
    cookie: `forge_preview=${forged}`,
  });
  expect(notMember.status).toBe(403);
  expect(notMember.text).toContain('not a member');
});

it('fails a recording no batch ever reached as RECORDER_BLOCKED, and stops one when its preview closes', async () => {
  const memberCookie = cookieOf((await world.enter(preview, member)).entered.headers['set-cookie']);
  await atPreview(world.core, preview.url, '/', { cookie: memberCookie });
  const later = new Date(Date.now() + 31_000);
  await sweepRecordings(later);
  const rows = (await db.execute(sql`
    SELECT r.state, r.reason, r.recorded_by = p.created_by AS owners FROM preview_recordings r
      JOIN previews p ON p.id = r.preview_id WHERE r.preview_id = ${preview.id} ORDER BY r.started_at
  `)) as unknown as { state: string; reason: string | null; owners: boolean }[];
  expect(rows).toEqual([
    { state: 'recording', reason: null, owners: true },
    { state: 'failed', reason: 'RECORDER_BLOCKED', owners: false },
  ]);
  const abandoned = await api(owner, 'POST', `/api/previews/${preview.id}/abandon`, {
    reason: 'done',
  });
  expect(abandoned.status).toBe(200);
  await sweepRecordings(new Date());
  const stopped = await api(member, 'GET', `/api/recordings/${recordingId}`);
  expect(stopped.body.recording).toMatchObject({ state: 'stopped' });
  expect((stopped.body.recording as { expiresAt: string }).expiresAt).not.toBeNull();
});
