import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zValidator } from './zod-validator.js';

function appWith(schema: z.ZodType) {
  const app = new Hono();
  app.get('/graph', zValidator('query', schema), (c) => c.json(c.req.valid('query' as never)));
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
