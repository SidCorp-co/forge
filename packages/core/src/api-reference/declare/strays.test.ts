import type { zValidator as library } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { refuseQueryNotTaken } from './input-not-taken.js';
import { declaresInput, refuseInputNotTaken, zValidator } from './validator.js';

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** A Hono app answering refusals as core's error handler does: message, code and details. */
function refusing(build: (app: Hono) => void) {
  const app = new Hono();
  build(app);
  app.onError((err, c) => {
    if (!(err instanceof HTTPException)) return c.json({}, 500);
    const cause = (err.cause ?? {}) as { code?: string; details?: unknown };
    return c.json({ message: err.message, code: cause.code, details: cause.details }, err.status);
  });
  return app;
}

type Refusal = {
  message: string;
  code?: string;
  details?: { formErrors: string[]; fieldErrors: Record<string, string[]> };
};

describe('a route hook that words its own refusal (ISS-1421 r20)', () => {
  const body = z.object({ host: z.string().min(1), path: z.string().min(1) }).strict();
  const ownHook: Parameters<typeof library>[2] = (r) => {
    if (!r.success)
      throw new HTTPException(400, {
        message: 'Host and path are required.',
        cause: { code: 'GIT_ASK', details: z.flattenError(r.error as z.core.$ZodError) },
      });
  };
  const app = refusing((a) => a.post('/git', zValidator('json', body, ownHook), (c) => c.json({})));

  it('is overruled by a body field the route does not take, which is named, keeping its code', async () => {
    const res = await app.request('/git', post({ host: 'github.com', path: 'a/b', colour: 'red' }));
    const refused = (await res.json()) as Refusal;
    expect(res.status).toBe(400);
    expect(refused.code).toBe('GIT_ASK');
    expect(refused.message).toBe('The field colour is not one this call takes.');
    expect(refused.details?.formErrors).toEqual(['The field colour is not one this call takes.']);
  });

  // Consult findings at 068fc82: a stray that is no plain word, a long one, and one whose name is a
  // word the hook's sentence happens to use were each left behind "Host and path are required.".
  it.each([
    ['colour-code', 'colour-code'],
    ['a name past forty characters', 'x'.repeat(50)],
    ['a name the sentence uses as a word', 'required'],
  ])('is overruled by a stray named %s', async (_what, key) => {
    const res = await app.request('/git', post({ host: 'github.com', path: 'a/b', [key]: 1 }));
    const refused = (await res.json()) as Refusal;
    expect(refused.message).toBe(`The field ${key} is not one this call takes.`);
  });

  it('keeps its own sentence for any other refusal, with that sentence as its details', async () => {
    const res = await app.request('/git', post({ host: 'github.com', path: 7 }));
    const refused = (await res.json()) as Refusal;
    expect(refused.message).toBe('Host and path are required.');
    expect(refused.details).toEqual({
      formErrors: [],
      fieldErrors: { path: ['Host and path are required.'] },
    });
  });

  it('keeps its own sentence where it already names the stray field', async () => {
    const named = refusing((a) =>
      a.post(
        '/m',
        zValidator('json', body, (r) => {
          if (!r.success)
            throw new HTTPException(400, {
              message: 'Leave out `colour`, because a mark takes only host and path.',
              cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error as z.core.$ZodError) },
            });
        }),
        (c) => c.json({}),
      ),
    );
    const res = await named.request('/m', post({ host: 'h', path: 'p', colour: 'red' }));
    const refused = (await res.json()) as Refusal;
    expect(refused.message).toBe('Leave out `colour`, because a mark takes only host and path.');
    expect(refused.details?.formErrors).toEqual([refused.message]);
  });

  // Fifth whole-set read: a key reading as a sentence passed as named wherever the hook said "field".
  it('is overruled by a stray reading as a sentence where it only says a field is required', async () => {
    const hooked = refusing((a) =>
      a.post(
        '/f',
        zValidator('json', body, (r) => {
          if (!r.success)
            throw new HTTPException(400, {
              message: 'The field host is required.',
              cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error as z.core.$ZodError) },
            });
        }),
        (c) => c.json({}),
      ),
    );
    const res = await hooked.request('/f', post({ host: 'h', path: 'p', 'colour code': 1 }));
    expect(((await res.json()) as Refusal).message).toMatch(/colour code/);
  });

  // Second whole-set read: naming one stray of two left the other unnamed everywhere.
  it('is overruled where it names one stray of two, so both are named', async () => {
    const named = refusing((a) =>
      a.post(
        '/m',
        zValidator('json', body, (r) => {
          if (!r.success)
            throw new HTTPException(400, {
              message: 'Leave out `colour`, because a mark takes only host and path.',
              cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error as z.core.$ZodError) },
            });
        }),
        (c) => c.json({}),
      ),
    );
    const res = await named.request('/m', post({ host: 'h', path: 'p', colour: 'red', hue: 'b' }));
    const refused = (await res.json()) as Refusal;
    expect(refused.message).toMatch(/colour/);
    expect(refused.message).toMatch(/hue/);
  });
});

describe('a field inside a body object that the object does not take (ISS-1421 r20)', () => {
  const body = z.object({
    story: z.string(),
    provenance: z.object({ commit: z.string().optional() }).optional(),
    items: z.array(z.object({ id: z.string() })).optional(),
  });
  const app = refusing((a) => a.post('/p', zValidator('json', body), (c) => c.json({ ok: true })));

  it('is refused naming its whole path, and the handler never runs', async () => {
    const res = await app.request('/p', post({ story: 's', provenance: { colour: 'red' } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Refusal).message).toBe(
      'The field provenance.colour is not one this call takes.',
    );
  });

  it('is refused inside an array entry', async () => {
    const res = await app.request(
      '/p',
      post({ story: 's', items: [{ id: 'a' }, { id: 'b', hue: 1 }] }),
    );
    expect(((await res.json()) as Refusal).message).toBe(
      'The field items.1.hue is not one this call takes.',
    );
  });

  it('lets a body whose objects hold only fields they take through', async () => {
    const res = await app.request('/p', post({ story: 's', provenance: { commit: 'abc' } }));
    expect(res.status).toBe(200);
  });

  // Consult finding at 068fc82: two union branches both declaring `metadata` left it unread.
  describe('under a union whose branches both declare it', () => {
    const shared = z.union([
      z.object({ kind: z.string(), metadata: z.object({ name: z.string() }) }),
      z.object({ size: z.number(), metadata: z.object({ name: z.string() }) }),
    ]);
    const widening = z.union([
      z.object({ kind: z.string(), metadata: z.object({ name: z.string() }) }),
      z.object({ size: z.number(), metadata: z.object({ name: z.string(), colour: z.string() }) }),
    ]);
    const on = (schema: z.ZodType) =>
      refusing((a) => a.post('/u', zValidator('json', schema), (c) => c.json({ ok: true })));

    it('is refused where no branch takes it', async () => {
      const res = await on(shared).request(
        '/u',
        post({ kind: 'k', metadata: { name: 'n', colour: 'red' } }),
      );
      expect(((await res.json()) as Refusal).message).toBe(
        'The field metadata.colour is not one this call takes.',
      );
    });

    it('is let through where a branch takes it', async () => {
      const res = await on(widening).request(
        '/u',
        post({ size: 1, metadata: { name: 'n', colour: 'red' } }),
      );
      expect(res.status).toBe(200);
    });
  });

  // Fifth whole-set read: a list a union takes was not walked, so its entries' strays were dropped.
  it('is refused inside a list that a union takes', async () => {
    const listed = z.object({
      items: z.union([z.array(z.object({ id: z.string() })), z.string()]),
    });
    const res = await refusing((a) =>
      a.post('/i', zValidator('json', listed), (c) => c.json({ ok: true })),
    ).request('/i', post({ items: [{ id: 'a', colour: 'red' }] }));
    expect(((await res.json()) as Refusal).message).toBe(
      'The field items.0.colour is not one this call takes.',
    );
  });

  // Seventh whole-set read: a union whose other option takes anything was refused for a stray.
  it('lets a list through where another option of its union takes anything', async () => {
    const either = z.object({
      items: z.union([z.array(z.object({ id: z.string() })), z.unknown()]),
    });
    const res = await refusing((a) =>
      a.post('/e', zValidator('json', either), (c) => c.json({ ok: true })),
    ).request('/e', post({ items: [{ id: 'a', colour: 'red' }] }));
    expect(res.status).toBe(200);
  });

  // A field one branch reads closed and another takes whatever it holds is not refused, and a
  // catchall's values are read by the catchall.
  it.each([
    [
      'a record branch',
      z.union([z.object({ meta: z.object({ a: z.string() }) }), z.record(z.string(), z.unknown())]),
    ],
    [
      'a loose branch',
      z.union([z.object({ meta: z.object({ a: z.string() }) }), z.looseObject({})]),
    ],
    [
      'an intersection with a loose side',
      z.intersection(z.object({ meta: z.object({ a: z.string() }) }), z.looseObject({})),
    ],
  ])('lets a nested field through where %s takes it', async (_what, schema) => {
    const res = await refusing((a) =>
      a.post('/b', zValidator('json', schema as z.ZodType), (c) => c.json({ ok: true })),
    ).request('/b', post({ meta: { a: 'x', colour: 'red' } }));
    expect(res.status).toBe(200);
  });

  it('is refused inside a value a catchall reads', async () => {
    const caught = z.object({ id: z.string() }).catchall(z.object({ n: z.number() }));
    const res = await refusing((a) =>
      a.post('/c', zValidator('json', caught), (c) => c.json({ ok: true })),
    ).request('/c', post({ id: 'a', extra: { n: 1, colour: 'red' } }));
    expect(((await res.json()) as Refusal).message).toBe(
      'The field extra.colour is not one this call takes.',
    );
  });

  // The shapes a list or a map takes beside an array: a tuple's entries and a record's values.
  it.each([
    [
      'a tuple entry',
      z.object({ pair: z.tuple([z.string(), z.object({ id: z.string() })]) }),
      { pair: ['a', { id: 'b', colour: 1 }] },
      'pair.1.colour',
    ],
    [
      'a record value',
      z.object({ byName: z.record(z.string(), z.object({ id: z.string() })) }),
      { byName: { k: { id: 'b', colour: 1 } } },
      'byName.k.colour',
    ],
  ])('is refused inside %s', async (_what, schema, sent, path) => {
    const res = await refusing((a) =>
      a.post('/s', zValidator('json', schema as z.ZodType), (c) => c.json({ ok: true })),
    ).request('/s', post(sent));
    expect(((await res.json()) as Refusal).message).toBe(
      `The field ${path} is not one this call takes.`,
    );
  });

  // Fourth whole-set read: an object taking any field, below the root, hid the closed one in it.
  it('is refused inside a closed object held by an open one', async () => {
    const deep = z.object({ outer: z.looseObject({ inner: z.object({ name: z.string() }) }) });
    const res = await refusing((a) =>
      a.post('/d', zValidator('json', deep), (c) => c.json({ ok: true })),
    ).request('/d', post({ outer: { extra: 1, inner: { name: 'n', colour: 'red' } } }));
    expect(((await res.json()) as Refusal).message).toBe(
      'The field outer.inner.colour is not one this call takes.',
    );
  });

  // Second whole-set read: a root taking any field skipped the closed objects inside it.
  describe('under a root that takes any field', () => {
    const loose = z.looseObject({ metadata: z.object({ name: z.string() }) });
    const sent = { extra: 1, metadata: { name: 'n', colour: 'red' } };

    it.each([
      [
        'zValidator',
        (a: Hono) => a.post('/l', zValidator('json', loose), (c) => c.json({ ok: true })),
      ],
      [
        'declaresInput',
        (a: Hono) => a.post('/l', declaresInput('json', loose), (c) => c.json({ ok: true })),
      ],
    ])('is refused through %s, the extra root field let through', async (_door, mount) => {
      const res = await refusing((a) => void mount(a)).request('/l', post(sent));
      expect(((await res.json()) as Refusal).message).toBe(
        'The field metadata.colour is not one this call takes.',
      );
    });
  });

  it('is refused by a route that parses its own body too', async () => {
    const own = refusing((a) =>
      a.post('/o', declaresInput('json', body), (c) => c.json({ ok: true })),
    );
    const res = await own.request('/o', post({ story: 's', provenance: { colour: 'red' } }));
    expect(((await res.json()) as Refusal).message).toBe(
      'The field provenance.colour is not one this call takes.',
    );
  });
});

describe('a query key on a GET route that declares no query (ISS-1421 r20)', () => {
  const app = refusing((a) => {
    a.use('*', refuseQueryNotTaken());
    a.get('/none', (c) => c.json({ listed: 'everything' }));
    a.get('/some', zValidator('query', z.object({ orgId: z.string().optional() })), (c) =>
      c.json({ ok: true }),
    );
  });

  it('is refused naming the key, and nothing is answered', async () => {
    const res = await app.request('/none?orgId=x');
    const refused = (await res.json()) as Refusal & { listed?: string };
    expect(res.status).toBe(400);
    expect(refused.code).toBe('UNKNOWN_QUERY_PARAMETER');
    expect(refused.message).toBe(
      'The field orgId is not one this call takes. It takes no query parameter.',
    );
    expect(refused.listed).toBeUndefined();
  });

  it('leaves a GET with no query, and a route that declares its query, to the route', async () => {
    expect((await app.request('/none')).status).toBe(200);
    expect((await app.request('/some?orgId=x')).status).toBe(200);
  });

  // Consult finding at 068fc82: the reference stated the 400 on every path, the app only under /api.
  it('is refused under /api alone, where the reference states it, as the app mounts it', async () => {
    const { inputGateCodes } = await import('../document/input-gates.js');
    const mounted = refusing((a) => {
      a.use('*', refuseInputNotTaken());
      for (const at of ['/example', '/api/example']) a.get(at, (c) => c.json({ ok: true }));
    });
    const stated = (path: string) =>
      inputGateCodes({ method: 'GET', path, validators: [], bodyAsSent: null } as never).some(
        (g) => g.code === 'UNKNOWN_QUERY_PARAMETER',
      );
    expect((await mounted.request('/api/example?x=1')).status).toBe(400);
    expect(stated('/api/example')).toBe(true);
    expect((await mounted.request('/example?x=1')).status).toBe(200);
    expect(stated('/example')).toBe(false);
  });
});
