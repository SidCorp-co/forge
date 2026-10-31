import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { invalid, noQuery, readElsewhere, zValidator } from './zod-validator.js';

function appWith(schema: z.ZodType, hook?: ReturnType<typeof readElsewhere>) {
  const app = new Hono();
  app.get('/graph', zValidator('query', schema, hook), (c) =>
    c.json(c.req.valid('query' as never)),
  );
  app.onError((err, c) => {
    if (!(err instanceof HTTPException)) throw err;
    const cause = err.cause as { code: string; details: { code: string; path: string }[] };
    return c.json({ message: err.message, code: cause.code, details: cause.details }, err.status);
  });
  return app;
}

describe('zValidator query', () => {
  const lax = z.object({ rootIssueId: z.string().optional() });

  it('refuses a key a plain z.object query does not take, by name', async () => {
    const res = await appWith(lax).request('/graph?issueId=abc');
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      message: string;
      details: { path: string }[];
    };
    expect(body.code).toBe('UNKNOWN_QUERY_PARAMETER');
    expect(body.message).toContain('`issueId`');
    expect(body.message).toContain('This route takes: rootIssueId.');
    expect(body.details[0]?.path).toBe('/issueId');
  });

  it('says a route that takes no query takes none, never an empty list', async () => {
    const res = await appWith(z.strictObject({})).request('/graph?bogus=1');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('UNKNOWN_QUERY_PARAMETER');
    expect(body.message).toBe(
      'Unknown query parameter: `bogus`. This route takes no query parameters.',
    );
  });

  it('names where a key read by another route is read, and refuses the rest as unknown', async () => {
    const hook = readElsewhere({ revision: 'A past revision is read at /history?revision=<n>.' });
    const res = await appWith(z.strictObject({}), hook).request('/graph?revision=2&bogus=1');
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      message: string;
      details: { code: string; path: string; detail: string }[];
    };
    expect(body.code).toBe('UNKNOWN_QUERY_PARAMETER');
    expect(body.message).toContain('/history?revision=<n>');
    const byPath = new Map(body.details.map((d) => [d.path, d.detail]));
    expect(byPath.get('/revision')).toContain('A past revision is read at /history?revision=<n>.');
    expect(byPath.get('/bogus')).toBe(
      '`bogus` is not a query parameter of this route. This route takes no query parameters.',
    );
    expect((await appWith(z.strictObject({}), hook).request('/graph')).status).toBe(200);
  });

  it('still answers the keys it declares', async () => {
    const res = await appWith(lax).request('/graph?rootIssueId=abc');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rootIssueId: 'abc' });
  });

  it('keeps refinements on the strict copy', async () => {
    const refined = z
      .object({ a: z.string().optional(), b: z.string().optional() })
      .refine((q) => !(q.a && q.b), 'a and b are exclusive');
    expect((await appWith(refined).request('/graph?a=1&b=2')).status).toBe(400);
    expect((await appWith(refined).request('/graph?a=1&c=2')).status).toBe(400);
  });

  it('lets a declared loose query, called by a third party, carry keys it does not read', async () => {
    const loose = z.looseObject({ code: z.string().optional() });
    const res = await appWith(loose).request('/graph?code=x&scope=email');
    expect(res.status).toBe(200);
  });
});

// A JSON-typed request with no body is the body `{}`, as hono reads one with no content type: the
// route's schema decides it, never hono's bare "Malformed JSON in request body" (a DELETE of a
// binding sent with no body, forge-dev 2026-10-16).
describe('zValidator json, a request with no body', () => {
  function bodyApp(schema: z.ZodType, hint?: string) {
    const app = new Hono();
    app.delete('/thing', zValidator('json', schema, hint ? invalid(hint) : undefined), (c) =>
      c.json({ read: c.req.valid('json' as never) }),
    );
    app.onError((err, c) => {
      if (!(err instanceof HTTPException)) throw err;
      return c.json(
        { message: err.message, code: (err.cause as { code?: string })?.code },
        err.status,
      );
    });
    return app;
  }
  const send = (app: Hono, body?: string, type = 'application/json') =>
    app.request('/thing', {
      method: 'DELETE',
      headers: { 'content-type': type },
      ...(body === undefined ? {} : { body }),
    });

  it('is taken by a route whose schema takes an empty object', async () => {
    for (const body of [undefined, '', '  \n']) {
      const res = await send(bodyApp(z.strictObject({})), body);
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(await res.json()).toEqual({ read: {} });
    }
  });

  it('is refused by a route needing a field, naming the shape it takes', async () => {
    const res = await send(
      bodyApp(z.strictObject({ baseRevision: z.number() }), 'send { "baseRevision": <n> }'),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe(
      'send { "baseRevision": <n> }. Accepted body (? marks an optional field): { baseRevision: number }',
    );
    expect(body.message).not.toContain('Malformed');
  });

  it('refuses a body that is not JSON naming the route, without echoing the body', async () => {
    const res = await send(bodyApp(z.strictObject({})), '{"token":"sk-secret"');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe(
      'DELETE /thing takes a JSON body, and this one does not parse as JSON.',
    );
    expect(body.message).not.toContain('sk-secret');
  });

  it('still refuses a body sent under another content type, by name', async () => {
    const res = await send(bodyApp(z.strictObject({})), 'baseRevision=1', 'text/plain');
    expect(res.status).toBe(415);
    expect(((await res.json()) as { code: string }).code).toBe('BODY_NOT_JSON');
  });

  it('reads a real body as sent', async () => {
    const res = await send(
      bodyApp(z.strictObject({ baseRevision: z.number() })),
      '{"baseRevision":3}',
    );
    expect(await res.json()).toEqual({ read: { baseRevision: 3 } });
  });
});

// ISS-753: the one validator every read that takes no query holds
describe('noQuery', () => {
  const app = new Hono().get('/read', noQuery, (c) => c.json({ ok: true }));

  it('answers a read sent no query', async () => {
    expect((await app.request('/read')).status).toBe(200);
  });

  it('refuses every key, by name, saying the route takes none', async () => {
    const res = await app.request('/read?revision=3&verbose');
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      'Unknown query parameters: `revision`, `verbose`. This route takes no query parameters.',
    );
  });
});
