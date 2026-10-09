import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

// The preview site, set before the process reads its environment: a development `host:port`.
vi.hoisted(() => {
  process.env.PREVIEW_DOMAIN = 'preview.localhost:7311';
});

import { db } from '../../src/db/client.js';
import { signViewer } from '../../src/previews/ticket.js';
import { api, userToken } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestDevice, createTestUser } from '../helpers/factories.js';
import {
  atPreview,
  boxToken,
  cookieOf,
  type DevServer,
  PREVIEW_ENVIRONMENTS,
  PreviewWorld,
  type Served,
  StandInBox,
  VITE_PACKAGE,
} from '../helpers/preview-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// REQ-39: a run's dev server is seen live from a Forge link, by members only, over a tunnel the box
// dialled, and takes a person's change to the run. Driven over real sockets: core, a dev server, and
// a box speaking the runner's frames. How a preview closes: preview-close-e2e.test.ts.

const world = new PreviewWorld();
let core: Served;
let dev: DevServer;
let box: StandInBox;
let projectId = '';
let ownerId = '';
let owner = '';
let member = '';
let stranger = '';
let issueId = '';

const open = (token = owner, id = issueId) => api(token, 'POST', `/api/issues/${id}/preview`);
const issueWithRun = () => world.issueWithRun();
const livePreview = (id: string) => world.livePreview(id);
const enter = (preview: { id: string; url: string }, token = owner) => world.enter(preview, token);

beforeAll(async () => {
  await world.start();
  ({ core, dev, box, projectId, ownerId, owner, member, stranger, issueId } = world);
}, 120_000);

afterAll(() => world.stop());

it('starts from the repository when unset, and is seen live by a member through its link (BC-1, BC-11, BC-12, BC-13)', async () => {
  const preview = await livePreview(issueId);
  const starts = box.heardOf('preview.start');
  expect(starts[0]?.data).toMatchObject({ settings: null });
  // the second start carries what core read from the Vite package.json: npm, `--`, a free port
  expect(starts[1]?.data).toMatchObject({
    settings: { command: 'npm run dev -- --port {port}' },
    env: {
      FORGE_ENVIRONMENT: 'dev',
      FORGE_ENVIRONMENT_URL: 'https://dev.shop.example.test',
      FORGE_SERVICE_API_URL: 'https://api.dev.shop.example.test',
    },
  });
  expect(JSON.stringify(starts)).not.toContain('live');
  expect(preview.url).toMatch(/^http:\/\/p-[a-z2-7]{16}\.preview\.localhost:7311\/$/);

  const { entered } = await enter(preview);
  expect(entered.status).toBe(303);
  expect(entered.headers.location).toBe('/');
  const cookie = cookieOf(entered.headers['set-cookie']);
  expect(cookie).toMatch(/^forge_preview=/);
  expect(String(entered.headers['set-cookie'])).toContain('HttpOnly');

  const page = await atPreview(core, preview.url, '/', {
    cookie: `${cookie}; app_session=keep-me`,
    origin: preview.url.replace(/\/$/, ''),
  });
  expect(page.status).toBe(200);
  expect(page.text).toContain('the change being made');
  // framed by Forge's web only, as a second policy beside the app's own (both apply)
  expect(page.headers['content-security-policy']).toBe(
    "default-src 'self', frame-ancestors http://localhost:3000",
  );
  expect(page.headers['set-cookie']).toEqual(['app_session=from-the-project; Path=/']);
  const sent = dev.seen.at(-1)?.headers ?? {};
  expect(sent.host).toBe(`localhost:${dev.port}`);
  expect(sent.origin).toBe(`http://localhost:${dev.port}`);
  expect(sent.cookie).toBe('app_session=keep-me');

  const redirected = await atPreview(core, preview.url, '/redirect', { cookie });
  expect(redirected.status).toBe(302);
  expect(redirected.headers.location).toBe(`${preview.url}landed`);
});

it('lets in only a signed-in member, once per ticket (BC-4)', async () => {
  const preview = (await api(owner, 'GET', `/api/issues/${issueId}/preview`)).body.preview as {
    id: string;
    url: string;
  };
  const outsiderTicket = await api(stranger, 'POST', `/api/previews/${preview.id}/ticket`);
  expect(outsiderTicket.status).toBe(403);
  expect(outsiderTicket.body.url).toBeUndefined();
  expect((await api(null, 'POST', `/api/previews/${preview.id}/ticket`)).status).toBe(401);

  const { entered, path } = await enter(preview, member);
  expect(entered.status).toBe(303);
  const reused = await atPreview(core, preview.url, path);
  expect(reused.status).toBe(403);
  expect(reused.text).toContain('already been used');

  const bare = await atPreview(core, preview.url, '/');
  expect(bare.status).toBe(403);
  expect(bare.text).toContain('Open this preview from Forge');
  expect(dev.seen.length).toBeGreaterThan(0);
  const before = dev.seen.length;

  // a viewer cookie for someone who does not read the project is turned away at the host
  const [s] = (await db.execute(
    sql`SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM project_members WHERE project_id = ${projectId}) LIMIT 1`,
  )) as unknown as { id: string }[];
  const forged = await signViewer({ previewId: preview.id, userId: String(s?.id) });
  const outsider = await atPreview(core, preview.url, '/', { cookie: `forge_preview=${forged}` });
  expect(outsider.status).toBe(403);
  expect(outsider.text).toContain('not a member');
  // a cookie for another preview opens nothing here
  const elsewhere = await signViewer({ previewId: crypto.randomUUID(), userId: ownerId });
  expect(
    (await atPreview(core, preview.url, '/', { cookie: `forge_preview=${elsewhere}` })).status,
  ).toBe(403);
  expect(dev.seen.length).toBe(before);

  const unknownHost = await atPreview(
    core,
    'http://p-aaaaaaaaaaaaaaaa.preview.localhost:7311/',
    '/',
  );
  expect(unknownHost.status).toBe(404);
});

it('carries the dev server hot-reload socket over the tunnel (BC-2, BC-5)', async () => {
  const preview = (await api(owner, 'GET', `/api/issues/${issueId}/preview`)).body.preview as {
    id: string;
    url: string;
  };
  const cookie = cookieOf((await enter(preview)).entered.headers['set-cookie']);
  const ws = new WebSocket(`ws://127.0.0.1:${core.port}/hmr`, {
    headers: { host: new URL(preview.url).host, cookie },
  });
  const reply = await new Promise<string>((resolve, reject) => {
    ws.on('open', () => ws.send('edit-1'));
    ws.on('message', (m) => resolve(String(m)));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) =>
      reject(new Error(`upgrade answered ${res.statusCode}`)),
    );
  });
  expect(reply).toBe('update:edit-1');
  ws.close();

  const refused = new WebSocket(`ws://127.0.0.1:${core.port}/hmr`, {
    headers: { host: new URL(preview.url).host },
  });
  const status = await new Promise<number>((resolve) => {
    refused.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    refused.on('open', () => resolve(101));
  });
  expect(status).toBe(403);
});

it("takes a person's change to the run holding the preview (BC-6)", async () => {
  const preview = (await api(owner, 'GET', `/api/issues/${issueId}/preview`)).body.preview as {
    id: string;
    sessionId: string;
  };
  const sent = await api(owner, 'POST', `/api/previews/${preview.id}/messages`, {
    text: 'make the buy button green',
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  const rows = (await db.execute(sql`
    SELECT kind, body FROM session_inbox WHERE agent_session_id = ${preview.sessionId} ORDER BY seq DESC LIMIT 1
  `)) as unknown as { kind: string; body: string }[];
  expect(rows[0]?.kind).toBe('inject');
  expect(rows[0]?.body).toContain('make the buy button green');
  await settleOutbox();
  const told = await box.until('session.send');
  expect(told.data).toMatchObject({ sessionId: preview.sessionId, kind: 'inject' });
  const viewer = await createTestUser({ verified: true });
  await addProjectMember(projectId, viewer.id, 'viewer');
  const readOnly = await api(
    await userToken(viewer.id),
    'POST',
    `/api/previews/${preview.id}/messages`,
    {
      text: 'x',
    },
  );
  expect(readOnly.status).toBe(403);
  expect(
    (await api(owner, 'POST', `/api/previews/${preview.id}/messages`, { text: '' })).status,
  ).toBe(400);
});

it("refuses production, an issue with no run, a second open, and another box's report (BC-13, BC-1)", async () => {
  await seedProjectDocument(projectId, ownerId, {
    environments: PREVIEW_ENVIRONMENTS,
    extra: { preview: { command: 'pnpm dev --port {port}', environment: 'live' } },
  });
  const prod = await open(owner, await issueWithRun());
  expect(prod.status).toBe(422);
  expect(prod.body).toMatchObject({ code: 'PREVIEW_PRODUCTION_ENVIRONMENT' });
  await seedProjectDocument(projectId, ownerId, { environments: PREVIEW_ENVIRONMENTS });

  const lonely = { id: await world.issueWithoutRun() };
  const noRun = await open(owner, lonely.id);
  expect(noRun.status).toBe(422);
  expect(noRun.body).toMatchObject({ code: 'PREVIEW_NO_RUN' });

  box.onStart = (frame) =>
    frame.settings === null
      ? { kind: 'facts', facts: { cwd: '', packageJson: VITE_PACKAGE, lockfiles: [] } }
      : { kind: 'live', port: dev.port };
  const fresh = await issueWithRun();
  const first = await livePreview(fresh);
  const again = await open(owner, fresh);
  expect(again.status).toBe(409);
  expect(again.body).toMatchObject({ code: 'PREVIEW_ALREADY_OPEN' });

  const otherDevice = await createTestDevice(ownerId);
  const other = new StandInBox(core.base, await boxToken(ownerId, otherDevice), otherDevice);
  const foreign = await other.report(first.id, { kind: 'live', port: 4000 });
  expect(foreign.status).toBe(404);
  expect(foreign.body).toMatchObject({ code: 'PREVIEW_NOT_FOUND' });
  expect((await api(member, 'POST', `/api/issues/${fresh}/preview`)).status).toBe(409);
  const viewer = await createTestUser({ verified: true });
  await addProjectMember(projectId, viewer.id, 'viewer');
  expect(
    (await api(await userToken(viewer.id), 'POST', `/api/issues/${fresh}/preview`)).status,
  ).toBe(403);
});
