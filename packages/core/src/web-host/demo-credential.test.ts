// A demo core answers a request that carries no credential as its seeded member, so a browser holds
// no cookie and a frame on another site is signed in like a tab (demo-credential.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ FORGE_DEMO_MODE: true }));
const member = vi.hoisted(() => ({
  id: 'a3c9e2f1-7b1d-4e8a-9c2f-5d6e7f8a9b0c' as string | null,
  asked: 0,
}));
vi.mock('../lib/env.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/env.js')>();
  return {
    ...real,
    env: new Proxy(real.env, {
      get: (target, key) =>
        key in settings ? settings[key as keyof typeof settings] : Reflect.get(target, key),
    }),
  };
});
vi.mock('../auth/index.js', () => ({
  demoMemberId: () => {
    member.asked += 1;
    return Promise.resolve(member.id);
  },
}));
const logged = vi.hoisted(() => ({ errors: [] as string[] }));
vi.mock('../lib/logger.js', () => ({
  logger: { error: (message: string) => logged.errors.push(message) },
}));

import { jwtVerify } from 'jose';
import { USER_JWT_TTL_SECONDS } from '../credentials/jwt.js';
import { withDemoCredential } from './demo-credential.js';

/** The app's fetch, keeping the requests it was handed. */
function app() {
  const seen: Request[] = [];
  const fetch = (request: Request) => {
    seen.push(request);
    return Promise.resolve(new Response('ok'));
  };
  return { fetch, seen };
}

const tokenOf = (request: Request | undefined) =>
  /(?:^|; )forge_auth=([^;]+)/.exec(request?.headers.get('cookie') ?? '')?.[1];

beforeEach(() => {
  settings.FORGE_DEMO_MODE = true;
  member.id = 'a3c9e2f1-7b1d-4e8a-9c2f-5d6e7f8a9b0c';
  member.asked = 0;
  logged.errors.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('a demo core', () => {
  it('signs a request with no credential in as the demo member, keeping the cookies it carried', async () => {
    const { fetch, seen } = app();
    await withDemoCredential(fetch)(
      new Request('http://core.test/api/projects', { headers: { cookie: 'theme=dark' } }),
    );
    expect(seen[0]?.headers.get('cookie')).toMatch(/^theme=dark; forge_auth=/);
    // signed with core's own secret, so core's session check takes it as the member
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    expect((await jwtVerify(tokenOf(seen[0]) ?? '', secret)).payload).toMatchObject({
      sub: member.id,
      typ: 'user',
    });
  });

  it("leaves a request that carries its own credential as it came: the browser's session wins", async () => {
    const { fetch, seen } = app();
    const signed = withDemoCredential(fetch);
    await signed(
      new Request('http://core.test/api/a', { headers: { cookie: 'forge_auth=browser-own' } }),
    );
    await signed(
      new Request('http://core.test/api/b', { headers: { authorization: 'Bearer pat_x' } }),
    );
    expect(seen.map((r) => r.headers.get('cookie'))).toEqual(['forge_auth=browser-own', null]);
    expect(member.asked).toBe(0);
  });

  it('signs once for as long as the credential lasts, and again a day before it ends', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-11T00:00:00Z'), toFake: ['Date'] });
    const signed = withDemoCredential(app().fetch);
    await signed(new Request('http://core.test/api/a'));
    await signed(new Request('http://core.test/api/b'));
    expect(member.asked).toBe(1);
    vi.setSystemTime(Date.now() + (USER_JWT_TTL_SECONDS - 24 * 60 * 60) * 1000 + 1);
    await signed(new Request('http://core.test/api/c'));
    expect(member.asked).toBe(2);
  });

  it('serves a request signed out, and says why once, when the demo member was never seeded', async () => {
    member.id = null;
    const { fetch, seen } = app();
    const signed = withDemoCredential(fetch);
    await signed(new Request('http://core.test/api/a'));
    await signed(new Request('http://core.test/api/b'));
    expect(seen.map(tokenOf)).toEqual([undefined, undefined]);
    expect(logged.errors).toHaveLength(1);
    expect(logged.errors[0]).toContain('the demo member was never seeded');
  });
});

describe('any other core', () => {
  it('passes every request on as it came, and never looks for a demo member', async () => {
    settings.FORGE_DEMO_MODE = false;
    const { fetch, seen } = app();
    const request = new Request('http://core.test/api/projects');
    await withDemoCredential(fetch)(request);
    expect(seen).toEqual([request]);
    expect(member.asked).toBe(0);
  });

  it('reads demo mode per request, so a core wrapped before its settings were read follows them', async () => {
    settings.FORGE_DEMO_MODE = false;
    const { fetch, seen } = app();
    const signed = withDemoCredential(fetch);
    settings.FORGE_DEMO_MODE = true;
    await signed(new Request('http://core.test/api/projects'));
    expect(tokenOf(seen[0])).toBeDefined();
  });
});
