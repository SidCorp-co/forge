import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler } from './error.js';
import type { RequestIdVars } from './request-id.js';
import { zValidator } from './zod-validator.js';

const app = new Hono<{ Variables: RequestIdVars }>();
app.onError(errorHandler);
app.post('/note', zValidator('json', z.object({ text: z.string().optional() })), (c) =>
  c.json({ read: c.req.valid('json') }),
);

const post = (headers: Record<string, string>, body?: string) =>
  app.request(
    '/note',
    body === undefined ? { method: 'POST', headers } : { method: 'POST', headers, body },
  );

describe('a JSON route refuses a body it would otherwise read as nothing', () => {
  it('reads a JSON body', async () => {
    const res = await post({ 'content-type': 'application/json' }, '{"text":"hi"}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ read: { text: 'hi' } });
  });

  it('reads a JSON body with a charset and a vendor +json type', async () => {
    expect((await post({ 'content-type': 'application/json; charset=utf-8' }, '{}')).status).toBe(
      200,
    );
    expect((await post({ 'content-type': 'application/merge-patch+json' }, '{}')).status).toBe(200);
  });

  it('refuses by name a body sent with no content type', async () => {
    const res = await post({}, '{"text":"hi"}');
    expect(res.status).toBe(415);
    expect(JSON.stringify(await res.json())).toContain('BODY_NOT_JSON');
  });

  it('refuses by name a body sent as text', async () => {
    const res = await post({ 'content-type': 'text/plain' }, '{"text":"hi"}');
    expect(res.status).toBe(415);
    expect(JSON.stringify(await res.json())).toMatch(
      /BODY_NOT_JSON[\s\S]*text\/plain|text\/plain[\s\S]*BODY_NOT_JSON/,
    );
  });

  it('lets a request with no body through to the schema', async () => {
    expect((await post({})).status).toBe(200);
  });
});
