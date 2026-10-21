import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { declaresInput, zValidator } from './validator.js';

type Valid = { valid: (target: string) => unknown };

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ISS-1421 r19 — judge-79: `?limit=%20` was read as 0 and refused "takes at least 1".
describe('a number query parameter sent as spaces alone', () => {
  const app = new Hono();
  app.get(
    '/q',
    zValidator('query', z.object({ limit: z.coerce.number().int().min(1).default(20) })),
    (c) => c.json({ got: (c.req as unknown as Valid).valid('query') }),
  );
  app.get('/own', declaresInput('query', z.object({ limit: z.coerce.number().optional() })), (c) =>
    c.json({ ok: true }),
  );
  app.onError((err, c) =>
    err instanceof HTTPException ? c.json({ message: err.message }, err.status) : c.json({}, 500),
  );
  const said = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, message: ((await res.json()) as { message?: string }).message };
  };

  it('is refused as empty, quoting what was sent, on both kinds of route', async () => {
    const refused = {
      status: 400,
      message:
        'The field limit is empty: " " holds no number. Send a number, or leave the field out.',
    };
    expect(await said('/q?limit=%20')).toEqual(refused);
    expect(await said('/own?limit=%20')).toEqual(refused);
    expect((await said('/q?limit=%09%20')).message).toContain('is empty: "\t " holds no number.');
  });

  it('still takes a number with spaces around it', async () => {
    expect(await (await app.request('/q?limit=%203')).json()).toEqual({ got: { limit: 3 } });
  });
});

// ISS-1421 r19 — judge-79: `GET /api/projects/:id/knowledge?colour=red` answered 200, the stray
// key dropped. A query key no schema names is refused by name, as a body field is (criterion 162).
describe('a query key the schema does not take', () => {
  const list = z.object({
    kind: z.string().optional(),
    rootIssueId: z.string().optional(),
    limit: z.coerce.number().optional(),
  });
  const app = new Hono();
  app.get(
    '/hooked',
    zValidator('query', list, (r) => {
      if (!r.success) throw new HTTPException(400, { message: 'invalid query params' });
    }),
    (c) => c.json({ ok: true }),
  );
  app.get('/own', declaresInput('query', list), (c) => c.json({ ok: true }));
  app.get('/open', zValidator('query', z.looseObject({ code: z.string().optional() })), (c) =>
    c.json({ ok: true }),
  );
  app.onError((err, c) =>
    err instanceof HTTPException
      ? c.json(
          {
            code: (err.cause as { code?: string })?.code,
            message: err.message,
            details: (err.cause as { details?: unknown })?.details,
          },
          err.status,
        )
      : c.json({}, 500),
  );
  const answer = async (path: string) => {
    const res = await app.request(path);
    const body = (await res.json()) as { code?: string; message?: string; details?: unknown };
    return { status: res.status, ...body };
  };

  it('is refused 400 by name under UNKNOWN_QUERY_PARAMETER, whatever the route hook says', async () => {
    for (const path of ['/hooked?colour=red', '/own?colour=red']) {
      expect(await answer(path)).toMatchObject({
        status: 400,
        code: 'UNKNOWN_QUERY_PARAMETER',
        message:
          'The field colour is not one this call takes. It takes kind, limit and rootIssueId.',
        details: { unknownParameters: ['colour'], takes: ['kind', 'limit', 'rootIssueId'] },
      });
    }
  });

  it('names the known key near a stray one', async () => {
    const { message } = await answer('/hooked?issueId=x&kind=a');
    expect(message).toBe(
      'The field issueId is not one this call takes. This call takes rootIssueId, which may be what issueId meant. It takes kind, limit and rootIssueId.',
    );
  });

  it('says every refusal of the query at once, in sentences, details included', async () => {
    const got = await answer('/hooked?colour=red&limit=abc');
    expect(got.message).toBe(
      'The field colour is not one this call takes. The field limit takes a number, not "abc". It takes kind, limit and rootIssueId.',
    );
    expect(JSON.stringify(got.details)).not.toMatch(/NaN|Invalid input|Unrecognized/);
  });

  it('names a stray key beside a blank number, on a strict schema too (review F1)', async () => {
    const strict = new Hono();
    strict.get('/s', zValidator('query', list.strict()), (c) => c.json({ ok: true }));
    strict.onError((err, c) =>
      err instanceof HTTPException
        ? c.json({ code: (err.cause as { code?: string })?.code, message: err.message }, err.status)
        : c.json({}, 500),
    );
    for (const [at, path] of [
      [app, '/hooked?colour=red&limit=%20'],
      [strict, '/s?colour=red&limit=%20'],
      [strict, '/s?colour=red&limit=abc'],
    ] as const) {
      const res = await at.request(path);
      const got = (await res.json()) as { code?: string; message?: string };
      expect(got.code, path).toBe('UNKNOWN_QUERY_PARAMETER');
      expect(got.message, path).toContain('The field colour is not one this call takes.');
      expect(got.message, path).toMatch(/The field limit (is empty|takes a number)/);
      expect(got.message?.match(/The field colour is not/g), path).toHaveLength(1);
    }
  });

  it('is taken where the schema says it takes any key, and a known key alone is taken', async () => {
    expect((await answer('/open?code=1&setup_action=install')).status).toBe(200);
    expect((await answer('/hooked?kind=a&limit=2')).status).toBe(200);
    expect((await answer('/own?kind=a')).status).toBe(200);
  });
});

// ISS-1421 r19 — a connection create sent no `config.baseUrl` said so in its message, while its
// details, flattened to the top-level key, said "The field config is required."
describe("a hook's flattened details", () => {
  it('are said again from the parse, each sentence naming the nested field', async () => {
    const nested = z.object({
      config: z.object({ baseUrl: z.string(), targets: z.array(z.string()) }),
    });
    const app = new Hono();
    app.post(
      '/j',
      zValidator('json', nested, (r) => {
        if (!r.success)
          throw new HTTPException(400, {
            message: 'invalid body',
            cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
          });
      }),
      (c) => c.json({ ok: true }),
    );
    app.onError((err, c) =>
      err instanceof HTTPException
        ? c.json(
            { message: err.message, details: (err.cause as { details?: unknown }).details },
            400,
          )
        : c.json({}, 500),
    );
    const body = (await (await app.request('/j', post({ config: {} }))).json()) as {
      message: string;
      details: unknown;
    };
    expect(body.message).toBe(
      'The field config.baseUrl is required. The field config.targets is required.',
    );
    expect(body.details).toEqual({
      formErrors: [],
      fieldErrors: {
        config: ['The field config.baseUrl is required.', 'The field config.targets is required.'],
      },
    });
  });
});
