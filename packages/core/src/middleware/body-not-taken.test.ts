import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { takesBodyAsSent, zValidator } from '../api-reference/declare/validator.js';
import { refuseBodyNotTaken } from './body-not-taken.js';
import { errorHandler } from './error.js';

// ISS-1421 r16 — judge-69 asked for a pairing code with `expiresInMinutes: 1` and was minted a
// ten-minute one: the route declares no body, so the field was dropped unread and nothing said so.
function app() {
  let minted = 0;
  const a = new Hono();
  a.onError(errorHandler as never);
  a.use('*', refuseBodyNotTaken());
  a.post('/pairing-codes', (c) => {
    minted += 1;
    return c.json({ ok: true }, 201);
  });
  a.get('/pairing-codes', (c) => c.json({ ok: true }));
  a.post('/projects', zValidator('json', z.object({ slug: z.string() })), (c) =>
    c.json({ ok: true }, 201),
  );
  a.post('/webhook', takesBodyAsSent('a provider signs the bytes it sends'), async (c) =>
    c.json({ read: await c.req.text() }),
  );
  return { a, minted: () => minted };
}

const send = (a: Hono, path: string, body?: string, method = 'POST') =>
  a.request(path, {
    method,
    ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
  });

describe('a write route that declares no body', () => {
  it('refuses a body naming each field it carries, and runs nothing', async () => {
    const { a, minted } = app();
    const res = await send(a, '/pairing-codes', JSON.stringify({ expiresInMinutes: 1, note: 'x' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string; details: unknown };
    expect(body.code).toBe('BAD_REQUEST');
    expect(body.message).toBe('The fields expiresInMinutes and note are not ones this call takes.');
    expect(body.details).toEqual({ unknownFields: ['expiresInMinutes', 'note'] });
    expect(minted()).toBe(0);
  });

  it('refuses a body that is not a JSON object in a sentence', async () => {
    const { a, minted } = app();
    for (const sent of ['[1]', '"x"', 'not json']) {
      const res = await send(a, '/pairing-codes', sent);
      expect(res.status, sent).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe('This call takes no body.');
    }
    expect(minted()).toBe(0);
  });

  it('runs on no body, an empty one, {} and null', async () => {
    const { a, minted } = app();
    for (const sent of [undefined, '', '{}', 'null', '  ']) {
      expect((await send(a, '/pairing-codes', sent)).status, String(sent)).toBe(201);
    }
    expect(minted()).toBe(5);
  });

  it('leaves a read alone, and a route that declares its body to its schema', async () => {
    const { a } = app();
    expect((await a.request('/pairing-codes')).status).toBe(200);
    expect((await send(a, '/projects', JSON.stringify({ slug: 's' }))).status).toBe(201);
  });

  it('lets a route that takes its body as sent read it whole', async () => {
    const { a } = app();
    const res = await send(a, '/webhook', '{"any":"thing"}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ read: '{"any":"thing"}' });
  });
});
