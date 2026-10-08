/**
 * A stale session cookie never blocks a sign-in. A browser can hold two `forge_auth` at once — this
 * host's own and a sibling instance's scoped to the parent domain — and sends the older first; a
 * session that no longer verifies is answered SESSION_EXPIRED with both cookies cleared, while a
 * bad header token keeps INVALID_TOKEN. Through the app, against real Postgres.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { hashPassword } from '../../src/auth/password.js';
import { openRefreshToken } from '../../src/auth/service.js';
import { db } from '../../src/db/client.js';
import { attachWs, closeWs } from '../../src/ws/server.js';
import { api, userToken } from '../helpers/api.js';
import { createTestUser, truncateAll } from '../helpers/factories.js';

const STALE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdGFsZSIsInR5cCI6InVzZXIifQ.c3RhbGU';
const PASSWORD = 'correct horse battery staple';

let userId: string;
let email: string;

beforeEach(async () => {
  await truncateAll();
  const user = await createTestUser({ verified: true });
  userId = user.id;
  email = user.email;
});

const cookie = (...pairs: string[]) => ({ cookie: pairs.join('; ') });

/** The `Set-Cookie` lines of a response, each reduced to `name@path[;domain]=value|cleared`. */
function cookiesSet(headers: Headers): string[] {
  return headers.getSetCookie().map((line) => {
    const [pair = '', ...attrs] = line.split(';').map((p) => p.trim());
    const [name, value] = pair.split('=');
    const attr = (k: string) =>
      attrs.find((a) => a.toLowerCase().startsWith(`${k}=`))?.split('=')[1];
    const cleared = attr('max-age') === '0';
    const domain = attr('domain');
    return `${name}@${attr('path')}${domain ? `;${domain}` : ''}=${cleared ? 'cleared' : value ? 'set' : 'empty'}`;
  });
}

const CLEARED_BOTH = ['forge_auth@/=cleared', 'forge_refresh@/api/auth=cleared'];

describe('a session cookie that no longer opens a session', () => {
  it('is refused SESSION_EXPIRED on /me, with both session cookies cleared', async () => {
    const r = await api(null, 'GET', '/api/auth/me', undefined, cookie(`forge_auth=${STALE}`));
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('SESSION_EXPIRED');
    expect(r.body.message).toBe('your session has ended; sign in again');
    expect(cookiesSet(r.headers)).toEqual(CLEARED_BOTH);
  });

  it('is refused the same way by the session middleware on any route', async () => {
    const r = await api(null, 'GET', '/api/projects', undefined, cookie(`forge_auth=${STALE}`));
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('SESSION_EXPIRED');
    expect(cookiesSet(r.headers)).toEqual(CLEARED_BOTH);
  });

  it('is refused the same way where a device may also enter (requireUserOrDevice)', async () => {
    const r = await api(
      null,
      'GET',
      '/api/agent-sessions',
      undefined,
      cookie(`forge_auth=${STALE}`),
    );
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('SESSION_EXPIRED');
    expect(cookiesSet(r.headers)).toEqual(CLEARED_BOTH);
  });

  it('is refused SESSION_EXPIRED when the account it names is gone', async () => {
    const token = await userToken(userId);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    const r = await api(null, 'GET', '/api/auth/me', undefined, cookie(`forge_auth=${token}`));
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('SESSION_EXPIRED');
    expect(cookiesSet(r.headers)).toEqual(CLEARED_BOTH);
  });

  it('keeps INVALID_TOKEN for a bad header token, and clears no cookie for it', async () => {
    const r = await api(STALE, 'GET', '/api/auth/me');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('INVALID_TOKEN');
    expect(cookiesSet(r.headers)).toEqual([]);
  });

  it('answers no credential at all UNAUTHENTICATED, clearing nothing', async () => {
    const r = await api(null, 'GET', '/api/auth/me');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHENTICATED');
    expect(cookiesSet(r.headers)).toEqual([]);
  });
});

describe('a stale cookie sent beside a live one', () => {
  it('does not shadow the live session, whichever the browser sends first', async () => {
    const live = await userToken(userId);
    for (const order of [
      [`forge_auth=${STALE}`, `forge_auth=${live}`],
      [`forge_auth=${live}`, `forge_auth=${STALE}`],
    ]) {
      const r = await api(null, 'GET', '/api/auth/me', undefined, cookie(...order));
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(userId);
      expect(cookiesSet(r.headers)).toEqual([]);
    }
  });

  it('does not refuse the realtime socket either', async () => {
    const server: Server = createServer();
    attachWs(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    const opens = (header: string) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(url, { headers: { cookie: header } });
        ws.on('open', () => {
          ws.close();
          resolve(true);
        });
        ws.on('error', () => resolve(false));
        ws.on('unexpected-response', () => resolve(false));
      });
    try {
      const live = await userToken(userId);
      expect(await opens(`forge_auth=${STALE}; forge_auth=${live}`)).toBe(true);
      expect(await opens(`forge_auth=${STALE}`)).toBe(false);
    } finally {
      await closeWs();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('a sign-in over a stale cookie', () => {
  beforeEach(async () => {
    const hash = await hashPassword(PASSWORD);
    await db.execute(sql`UPDATE users SET password_hash = ${hash} WHERE id = ${userId}`);
  });

  it('wins: the login sets a fresh session and /me answers with it beside the stale one', async () => {
    const login = await api(
      null,
      'POST',
      '/api/auth/local',
      { email, password: PASSWORD },
      cookie(`forge_auth=${STALE}`, 'forge_refresh=rt_stale'),
    );
    expect(login.status).toBe(200);
    expect(cookiesSet(login.headers)).toEqual(['forge_auth@/=set', 'forge_refresh@/api/auth=set']);
    const fresh = login.body.token as string;

    const me = await api(
      null,
      'GET',
      '/api/auth/me',
      undefined,
      cookie(`forge_auth=${STALE}`, `forge_auth=${fresh}`),
    );
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(userId);
  });
});

describe('a refresh over a stale cookie', () => {
  it('refuses a junk refresh token and clears both session cookies', async () => {
    const r = await api(
      null,
      'POST',
      '/api/auth/refresh',
      undefined,
      cookie('forge_refresh=rt_stale_value'),
    );
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('INVALID_REFRESH_TOKEN');
    expect(cookiesSet(r.headers)).toEqual(CLEARED_BOTH);
  });

  it('rotates the live refresh token when a stale one is sent first', async () => {
    const { raw } = await openRefreshToken(userId);
    const r = await api(
      null,
      'POST',
      '/api/auth/refresh',
      undefined,
      cookie('forge_refresh=rt_stale_value', `forge_refresh=${raw}`),
    );
    expect(r.status).toBe(200);
    expect(cookiesSet(r.headers)).toEqual(['forge_auth@/=set', 'forge_refresh@/api/auth=set']);
  });
});

afterAll(async () => {
  await truncateAll();
});
