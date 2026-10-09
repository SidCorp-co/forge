import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

// The preview site, set before the process reads its environment: a development `host:port`.
vi.hoisted(() => {
  process.env.PREVIEW_DOMAIN = 'preview.localhost:7311';
});

import { db } from '../../src/db/client.js';
import { approvedPreviewOf } from '../../src/previews/index.js';
import { sweepPreviews } from '../../src/previews/service.js';
import { signViewer } from '../../src/previews/ticket.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import {
  atPreview,
  cookieOf,
  PREVIEW_ENVIRONMENTS,
  PreviewWorld,
  type Served,
  type StandInBox,
} from '../helpers/preview-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// REQ-39: a preview closes approved, abandoned or idle, says why it could not start, and fails when
// its box goes away. Driven over real sockets: core, a dev server, and a box speaking the runner's
// frames. How a preview is seen: preview-e2e.test.ts.

const poll = <T>(read: () => Promise<T>) => expect.poll(read, { timeout: 15_000, interval: 100 });

const world = new PreviewWorld();
const lane = (id: string) => api(owner, 'GET', `/api/issues/${id}/lane`);
let core: Served;
let box: StandInBox;
let projectId = '';
let ownerId = '';
let memberId = '';
let owner = '';
let member = '';
let issueId = '';

const open = (token = owner, id = issueId) => api(token, 'POST', `/api/issues/${id}/preview`);
const issueWithRun = () => world.issueWithRun();
const livePreview = (id: string) => world.livePreview(id);
const enter = (preview: { id: string; url: string }, token = owner) => world.enter(preview, token);

beforeAll(async () => {
  await world.start();
  ({ core, box, projectId, ownerId, memberId, owner, member, issueId } = world);
}, 120_000);

afterAll(() => world.stop());

it('closes approved with what the approver saw, and its link says so (BC-9)', async () => {
  const preview = await livePreview(issueId);
  const cookie = cookieOf((await enter(preview)).entered.headers['set-cookie']);
  const denied = await api(member, 'POST', `/api/previews/${preview.id}/approve`);
  expect(denied.status).toBe(403);
  expect(JSON.stringify(denied.body)).toContain('previews.approve');

  const watcher = new WebSocket(`ws://127.0.0.1:${core.port}/ws`, [`forge.bearer.${member}`]);
  const changes: { state: string; previewId: string }[] = [];
  await new Promise<void>((resolve, reject) => {
    watcher.on('open', () => {
      watcher.send(JSON.stringify({ type: 'subscribe', room: `project:${projectId}` }));
      setTimeout(resolve, 200);
    });
    watcher.on('error', reject);
  });
  watcher.on('message', (raw) => {
    const f = JSON.parse(String(raw)) as {
      event: string;
      data: { state: string; previewId: string };
    };
    if (f.event === 'preview.changed') changes.push(f.data);
  });
  const approving = api(owner, 'POST', `/api/previews/${preview.id}/approve`);
  await settleOutbox();
  const asked = await box.until('preview.snapshot.read');
  expect(asked.data).toEqual({ previewId: preview.id });
  const patchId = 'a'.repeat(40);
  const snap = await box.report(preview.id, {
    kind: 'snapshot',
    base: 'b'.repeat(40),
    patchId,
    files: ['packages/web-v2/src/app/page.tsx', 'packages/core/src/index.ts'],
  });
  expect(snap.status).toBe(200);
  const approved = await approving;
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  expect(approved.body).toMatchObject({
    patchId,
    preview: { state: 'approved', approvedPatchId: patchId },
    lane: { lane: 'full' },
  });
  await settleOutbox();
  expect(box.heardOf('preview.stop').at(-1)?.data).toEqual({
    previewId: preview.id,
    why: 'approved',
  });
  // the issue and chat showing it hear the move and refetch
  await poll(async () => changes.find((c) => c.previewId === preview.id)?.state).toBe('approved');
  watcher.close();
  const closed = await atPreview(core, preview.url, '/', { cookie });
  expect(closed.status).toBe(410);
  expect(closed.text).toContain('This preview was approved');
  expect((await api(owner, 'POST', `/api/previews/${preview.id}/ticket`)).body).toMatchObject({
    code: 'PREVIEW_CLOSED',
  });
});

it('hands the fast lane the patch id its approver saw, through the port core provides at boot (BC-7)', async () => {
  await seedProjectDocument(projectId, ownerId, {
    environments: PREVIEW_ENVIRONMENTS,
    extra: { fastLane: { paths: ['packages/web-v2/**'], deployTargets: ['web'] } },
  });
  world.serveVite();
  const fresh = await issueWithRun();
  const preview = await livePreview(fresh);
  const before = (await lane(fresh)).body;
  expect(before).toMatchObject({
    lane: 'full',
    approved: null,
    refusal: { code: 'FAST_LANE_NOT_APPROVED' },
  });
  const approving = api(owner, 'POST', `/api/previews/${preview.id}/approve`);
  await settleOutbox();
  await box.until('preview.snapshot.read', box.heardOf('preview.snapshot.read').length + 1);
  const patchId = 'c'.repeat(40);
  const files = ['packages/web-v2/src/app/buy-button.tsx'];
  await box.report(preview.id, { kind: 'snapshot', base: 'd'.repeat(40), patchId, files });
  expect((await approving).body).toMatchObject({ patchId, lane: { lane: 'fast' } });

  expect(await approvedPreviewOf(fresh)).toMatchObject({ previewId: preview.id, patchId, files });
  const after = await lane(fresh);
  expect(after.status, JSON.stringify(after.body)).toBe(200);
  expect(after.body).toMatchObject({
    lane: 'fast',
    approved: { previewId: preview.id, patchId, files, approvedBy: ownerId },
    refusal: null,
  });
  await seedProjectDocument(projectId, ownerId, { environments: PREVIEW_ENVIRONMENTS });
});

it('closes abandoned by a person, and idle when nobody views it; idle reopens at the same link (BC-9)', async () => {
  const abandonedOne = await livePreview(issueId);
  const abandoned = await api(owner, 'POST', `/api/previews/${abandonedOne.id}/abandon`, {
    reason: 'wrong direction',
  });
  expect(abandoned.status).toBe(200);
  expect(abandoned.body.preview).toMatchObject({ state: 'abandoned', detail: 'wrong direction' });
  const cookieA = cookieOf(await signViewerCookie(abandonedOne.id));
  const page = await atPreview(core, abandonedOne.url, '/', { cookie: cookieA });
  expect(page.status).toBe(410);
  expect(page.text).toContain('abandoned');
  expect(page.text).toContain('wrong direction');

  const idle = await livePreview(issueId);
  await db.execute(
    sql`UPDATE previews SET last_viewed_at = now() - interval '2 hours' WHERE id = ${idle.id}`,
  );
  await sweepPreviews();
  expect((await api(owner, 'GET', `/api/previews/${idle.id}`)).body.preview).toMatchObject({
    state: 'idle_closed',
  });
  await settleOutbox();
  expect(box.heardOf('preview.stop').at(-1)?.data).toEqual({ previewId: idle.id, why: 'idle' });

  const memberCookie = await signViewer({ previewId: idle.id, userId: memberId });
  const viewer = await createTestUser({ verified: true });
  await addProjectMember(projectId, viewer.id, 'viewer');
  const readerCookie = await signViewer({ previewId: idle.id, userId: viewer.id });
  const toReader = await atPreview(core, idle.url, '/', {
    cookie: `forge_preview=${readerCookie}`,
  });
  expect(toReader.status).toBe(410);
  expect(toReader.text).toContain('closed while nobody viewed it');

  const starts = box.heardOf('preview.start').length;
  const toWriter = await atPreview(core, idle.url, '/', {
    cookie: `forge_preview=${memberCookie}`,
  });
  expect(toWriter.status).toBe(503);
  expect(toWriter.text).toContain('starting');
  await settleOutbox();
  await box.until('preview.start', starts + 1);
  await poll(
    async () => (await api(owner, 'GET', `/api/previews/${idle.id}`)).body.preview,
  ).toMatchObject({ state: 'live' });
});

it('says on the issue why a preview could not start (BC-10)', async () => {
  const live = (await api(owner, 'GET', `/api/issues/${issueId}/preview`)).body.preview as {
    id: string;
  };
  await api(owner, 'POST', `/api/previews/${live.id}/abandon`, {});
  box.onStart = () => ({
    kind: 'failed',
    reason: 'PORT_IN_USE',
    detail: 'port 5173 is already held by another process on this box',
  });
  await seedProjectDocument(projectId, ownerId, {
    environments: PREVIEW_ENVIRONMENTS,
    extra: { preview: { command: 'pnpm dev', port: 5173 } },
  });
  const opened = await open();
  expect(opened.status).toBe(201);
  await settleOutbox();
  await poll(
    async () => (await api(owner, 'GET', `/api/issues/${issueId}/preview`)).body.preview,
  ).toMatchObject({
    state: 'failed',
    reason: 'PORT_IN_USE',
    detail: 'port 5173 is already held by another process on this box',
  });
  const lastStart = box.heardOf('preview.start').at(-1)?.data;
  expect(lastStart).toMatchObject({ settings: { command: 'pnpm dev', port: 5173 } });

  // a dev script with no port Forge can tell is refused by name, never guessed
  await seedProjectDocument(projectId, ownerId, { environments: PREVIEW_ENVIRONMENTS });
  box.onStart = (frame) =>
    frame.settings === null
      ? {
          kind: 'facts',
          facts: {
            cwd: '',
            packageJson: JSON.stringify({ scripts: { dev: 'node server.js' } }),
            lockfiles: [],
          },
        }
      : null;
  await open();
  await settleOutbox();
  await poll(
    async () => (await api(owner, 'GET', `/api/issues/${issueId}/preview`)).body.preview,
  ).toMatchObject({
    state: 'failed',
    reason: 'PORT_UNDECLARED',
  });
  box.onStart = (frame) =>
    frame.settings === null
      ? { kind: 'facts', facts: { cwd: '', packageJson: null, lockfiles: [] } }
      : null;
  await open();
  await settleOutbox();
  await poll(
    async () => (await api(owner, 'GET', `/api/issues/${issueId}/preview`)).body.preview,
  ).toMatchObject({
    state: 'failed',
    reason: 'NO_START_COMMAND',
  });
});

it('fails a live preview whose box tunnel stays away past the grace (BC-10)', async () => {
  world.serveVite();
  const preview = await livePreview(await issueWithRun());
  const cookie = `forge_preview=${await signViewer({ previewId: preview.id, userId: ownerId })}`;
  box.tunnel?.close();
  await poll(async () => (await atPreview(core, preview.url, '/', { cookie })).status).toBe(503);
  expect((await atPreview(core, preview.url, '/', { cookie })).text).toContain('not connected');
  await sweepPreviews(Date.now() + 61_000);
  await poll(
    async () => (await api(owner, 'GET', `/api/previews/${preview.id}`)).body.preview,
  ).toMatchObject({
    state: 'failed',
    reason: 'RUNNER_OFFLINE',
  });
});

async function signViewerCookie(previewId: string) {
  return `forge_preview=${await signViewer({ previewId, userId: ownerId })}`;
}
