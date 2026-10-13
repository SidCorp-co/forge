import type { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { env } from './config/env.js';

/** `GET /pair` sends a person to the web UI's pairing page, carrying the device code when one was sent. */
let app: Hono;

beforeAll(async () => {
  ({ app } = (await import('./index.js')) as unknown as { app: Hono });
}, 120_000);

async function pair(query: string) {
  const res = await app.request(`/pair${query}`);
  return { status: res.status, location: res.headers.get('location') };
}

describe('GET /pair', () => {
  const base = () => env.APP_BASE_URL.replace(/\/+$/, '');

  it('redirects with no code to the bare pairing page', async () => {
    expect(await pair('')).toEqual({ status: 302, location: `${base()}/pair` });
  });

  it('treats an empty code as no code', async () => {
    expect(await pair('?code=')).toEqual({ status: 302, location: `${base()}/pair` });
  });

  it('carries a code through, encoded', async () => {
    expect(await pair('?code=AB%20C%26D')).toEqual({
      status: 302,
      location: `${base()}/pair?code=AB%20C%26D`,
    });
  });

  it('reads the first of a repeated code, as it always did', async () => {
    expect(await pair('?code=ONE&code=TWO')).toEqual({
      status: 302,
      location: `${base()}/pair?code=ONE`,
    });
  });
});
