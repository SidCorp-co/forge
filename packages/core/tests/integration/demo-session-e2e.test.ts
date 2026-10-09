/**
 * The demo session (REQ-39, Forge previewing itself on demo data): in a demo core,
 * `GET /api/auth/demo` signs the one seeded member in with no credential and sends the browser to
 * the app; the cookies it sets are a real session. An unseeded demo core refuses by name rather
 * than sign in nobody. The door's other half, a core that is NOT in demo mode answering
 * DEMO_MODE_OFF, is src/auth/demo.test.ts, because the mode is read once per process.
 */

import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

vi.hoisted(() => {
  process.env.FORGE_DEMO_MODE = '1';
});

import { DEMO_MEMBER_EMAIL, demoMemberId } from '../../src/auth/demo-member.js';
import { app } from '../../src/index.js';
import { attachWs } from '../../src/ws/index.js';
import { api } from '../helpers/api.js';
import { seedDemoWorld } from '../helpers/demo-world.js';
import { truncateAll } from '../helpers/factories.js';
import { type Served, stopCore } from '../helpers/preview-world.js';

function cookieOf(headers: Headers, name: string): string | undefined {
  return headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

beforeEach(truncateAll);

describe('GET /api/auth/demo in a demo core', () => {
  it('refuses by name while the demo member was never seeded, and sets no cookie', async () => {
    const res = await api(null, 'GET', '/api/auth/demo');
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('DEMO_MEMBER_MISSING');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('signs the seeded member in and redirects home, and the cookie it sets is a real session', async () => {
    const world = await seedDemoWorld();
    const res = await api(null, 'GET', '/api/auth/demo');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const session = cookieOf(res.headers, 'forge_auth');
    expect(session).toBeTruthy();
    expect(cookieOf(res.headers, 'forge_refresh')).toBeTruthy();

    const me = await api(null, 'GET', '/api/auth/me', undefined, {
      cookie: `forge_auth=${session}`,
    });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(DEMO_MEMBER_EMAIL);
    expect(me.body.id).toBe(world.member.id);

    const projects = await api(null, 'GET', '/api/projects', undefined, {
      cookie: `forge_auth=${session}`,
    });
    expect(projects.status).toBe(200);
    expect(JSON.stringify(projects.body)).toContain('Demo Project');
  });

  it('seeds the world it promises: people, requirements, feedback and issues', async () => {
    const world = await seedDemoWorld();
    const res = await api(null, 'GET', '/api/auth/demo');
    const cookie = `forge_auth=${cookieOf(res.headers, 'forge_auth')}`;
    const issues = await api(null, 'GET', `/api/projects/${world.project.id}/issues`, undefined, {
      cookie,
    });
    expect(issues.status).toBe(200);
    expect(JSON.stringify(issues.body)).toContain('Preview opens the issue page in a frame');
  });

  it('refuses to seed a database that already holds a user, so it can never write over a real one', async () => {
    await seedDemoWorld();
    await expect(seedDemoWorld()).rejects.toThrow(/refuses a database that already holds \d+ user/);
  });
});

// The demo web signs HTTP in on its server (web-v2 lib/demo-signin.ts), but a browser holds no cookie
// and cannot set a header on a WebSocket: a demo core takes the credential-less socket for its member.
describe('the socket a demo core opens with no credential', () => {
  let core: Served | null = null;
  afterEach(async () => {
    if (core) await stopCore(core);
    core = null;
  });

  /** Core as the entry serves its socket: `credentialless` names the demo member (src/index.ts). */
  async function serve(entry: boolean): Promise<Served> {
    const server = createHttpServer(getRequestListener(app.fetch));
    attachWs(server, entry ? { credentialless: demoMemberId } : {});
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    return { server, base: `http://127.0.0.1:${port}`, port };
  }

  const frames = (ws: WebSocket, until: (f: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no frame arrived')), 5000);
      ws.on('message', (raw) => {
        const f = JSON.parse(String(raw)) as Record<string, unknown>;
        if (until(f)) {
          clearTimeout(timer);
          resolve(f);
        }
      });
    });

  it('is the demo member: it reads the demo project, and nobody else', async () => {
    const world = await seedDemoWorld();
    core = await serve(true);
    const ws = new WebSocket(`${core.base.replace('http', 'ws')}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    const read = frames(ws, (f) => f.event === 'replay.done' || f.event === 'subscribe.denied');
    ws.send(
      JSON.stringify({ type: 'subscribe', room: `project:${world.project.id}`, replayMs: 0 }),
    );
    expect((await read).event).toBe('replay.done');

    const denied = frames(ws, (f) => f.event === 'subscribe.denied');
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        room: `user:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
      }),
    );
    expect((await denied).event).toBe('subscribe.denied');
    ws.close();
  });

  it('is refused while the demo member was never seeded: no principal is guessed', async () => {
    core = await serve(true);
    const ws = new WebSocket(`${core.base.replace('http', 'ws')}/ws`);
    const err = await new Promise<Error>((resolve) => ws.on('error', resolve));
    expect(err.message).toContain('401');
  });

  it('is refused where the entry names nobody for it: only a demo core takes a socket for its member', async () => {
    await seedDemoWorld();
    core = await serve(false);
    const ws = new WebSocket(`${core.base.replace('http', 'ws')}/ws`);
    const err = await new Promise<Error>((resolve) => ws.on('error', resolve));
    expect(err.message).toContain('401');
  });
});
