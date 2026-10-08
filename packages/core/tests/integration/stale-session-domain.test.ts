/**
 * On an instance that scopes its session cookies to a domain, a sign-in and a session-ended
 * refusal also clear the host-only variant — the one left from before the domain was configured,
 * which the browser would otherwise keep sending first.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.AUTH_COOKIE_DOMAIN = '.forge.test';
});

import { hashPassword } from '../../src/auth/password.js';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { createTestUser, truncateAll } from '../helpers/factories.js';

const PASSWORD = 'correct horse battery staple';
const STALE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdGFsZSIsInR5cCI6InVzZXIifQ.c3RhbGU';

function cookiesSet(headers: Headers): string[] {
  return headers.getSetCookie().map((line) => {
    const [pair = '', ...attrs] = line.split(';').map((p) => p.trim());
    const name = pair.split('=')[0];
    const attr = (k: string) =>
      attrs.find((a) => a.toLowerCase().startsWith(`${k}=`))?.split('=')[1];
    const domain = attr('domain');
    return `${name}@${attr('path')}${domain ? `;${domain}` : ''}=${attr('max-age') === '0' ? 'cleared' : 'set'}`;
  });
}

let email: string;

beforeEach(async () => {
  await truncateAll();
  const user = await createTestUser({ verified: true });
  email = user.email;
  await db.execute(
    sql`UPDATE users SET password_hash = ${await hashPassword(PASSWORD)} WHERE id = ${user.id}`,
  );
});

describe('session cookies scoped to a configured domain', () => {
  it('a sign-in clears the host-only variant before setting the domain one', async () => {
    const r = await api(
      null,
      'POST',
      '/api/auth/local',
      { email, password: PASSWORD },
      { cookie: `forge_auth=${STALE}` },
    );
    expect(r.status).toBe(200);
    expect(cookiesSet(r.headers)).toEqual([
      'forge_auth@/=cleared',
      'forge_auth@/;.forge.test=set',
      'forge_refresh@/api/auth=cleared',
      'forge_refresh@/api/auth;.forge.test=set',
    ]);
  });

  it('a session-ended refusal clears both variants of both cookies', async () => {
    const r = await api(null, 'GET', '/api/auth/me', undefined, { cookie: `forge_auth=${STALE}` });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('SESSION_EXPIRED');
    expect(cookiesSet(r.headers)).toEqual([
      'forge_auth@/=cleared',
      'forge_auth@/;.forge.test=cleared',
      'forge_refresh@/api/auth=cleared',
      'forge_refresh@/api/auth;.forge.test=cleared',
    ]);
  });
});
