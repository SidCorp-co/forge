// ISS-1374 — `restCredential` names the credential a REST write came through, from what the gate
// recorded, and refuses a request the gate recorded nothing on. A hand-built context is the point
// of the file: the integration test proves the real doors, this one proves the refusals no door can
// be made to reach.

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { restCredential } = await import('./auth.js');

type Vars = import('./auth.js').AuthVars;

const TOKEN_ID = '66666666-6666-4666-8666-666666666666';
const DEVICE_ID = '77777777-7777-4777-8777-777777777777';

/** What `restCredential` answers for a request whose gate recorded `vars`, or the refusal's text. */
async function answerFor(vars: Partial<Record<keyof Vars, string>>) {
  const app = new Hono<{ Variables: Vars }>();
  app.get('/', (c) => {
    for (const [k, v] of Object.entries(vars)) c.set(k as keyof Vars, v as never);
    try {
      return c.json({ credential: restCredential(c as never) });
    } catch (err) {
      return c.json({ refused: (err as Error).message });
    }
  });
  return (await app.request('/')).json() as Promise<{
    credential?: { via: string; tokenId: string | null };
    refused?: string;
  }>;
}

describe('restCredential', () => {
  it('reads a session as web, with no token', async () => {
    expect((await answerFor({ principal: 'user' })).credential).toEqual({
      via: 'web',
      tokenId: null,
    });
  });

  it('reads a token as pat and names the token', async () => {
    expect((await answerFor({ principal: 'pat', patTokenId: TOKEN_ID })).credential).toEqual({
      via: 'pat',
      tokenId: TOKEN_ID,
    });
  });

  it("reads a token bound to a paired device as that device's credential, still naming the token", async () => {
    const got = await answerFor({ principal: 'pat', patTokenId: TOKEN_ID, patDeviceId: DEVICE_ID });
    expect(got.credential).toEqual({ via: 'device', tokenId: TOKEN_ID });
  });

  it('reads the device gate as device', async () => {
    expect((await answerFor({ principal: 'device' })).credential).toEqual({
      via: 'device',
      tokenId: null,
    });
  });

  it('refuses a request no gate set a principal on, naming the missing gate rather than answering web', async () => {
    const got = await answerFor({});
    expect(got.credential).toBeUndefined();
    expect(got.refused).toMatch(/^restCredential: no principal on this request/);
    expect(got.refused).toMatch(/requireAuth\(\)/);
  });

  it('refuses a token request that carries no token id rather than claiming pat without its evidence', async () => {
    const got = await answerFor({ principal: 'pat' });
    expect(got.credential).toBeUndefined();
    expect(got.refused).toMatch(/^restCredential: a token request carries no token id/);
  });
});
