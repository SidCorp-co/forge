/**
 * The demo session (REQ-39, Forge previewing itself on demo data): in a demo core,
 * `GET /api/auth/demo` signs the one seeded member in with no credential and sends the browser to
 * the app; the cookies it sets are a real session. An unseeded demo core refuses by name rather
 * than sign in nobody. The door's other half, a core that is NOT in demo mode answering
 * DEMO_MODE_OFF, is src/auth/demo.test.ts, because the mode is read once per process.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.FORGE_DEMO_MODE = '1';
});

import { DEMO_MEMBER_EMAIL } from '../../src/auth/demo.js';
import { api } from '../helpers/api.js';
import { seedDemoWorld } from '../helpers/demo-world.js';
import { truncateAll } from '../helpers/factories.js';

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
