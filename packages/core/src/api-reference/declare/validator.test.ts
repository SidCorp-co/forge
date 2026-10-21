import { zValidator as library } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { issueRelationInputSchema } from '../../issues/relations-service.js';
import {
  declaresInput,
  refuseQueryNotTaken,
  validatorDeclarations,
  zValidator,
} from './validator.js';

const schema = z.object({ n: z.coerce.number().int().min(1) });

type Library = typeof library;
type Valid = { valid: (target: string) => unknown };

function appWith(build: Library, hook?: Parameters<Library>[2]) {
  const app = new Hono();
  app.post('/j', build('json', schema, hook), (c) =>
    c.json({ got: (c.req as unknown as Valid).valid('json') }),
  );
  app.get('/q', build('query', schema, hook), (c) =>
    c.json({ got: (c.req as unknown as Valid).valid('query') }),
  );
  app.onError((err, c) =>
    err instanceof HTTPException
      ? c.json({ refused: err.status, code: (err.cause as { code?: string })?.code }, err.status)
      : c.json({}, 500),
  );
  return app;
}

async function answer(app: Hono, path: string, init?: RequestInit) {
  const res = await app.request(path, init);
  return { status: res.status, body: await res.text() };
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('zValidator answers as @hono/zod-validator does, but for a failed parse with no hook', () => {
  const hook: Parameters<typeof library>[2] = (r) => {
    if (!r.success) throw new HTTPException(400, { message: 'bad', cause: { code: 'BAD_N' } });
  };
  const cases: Array<[string, string, RequestInit | undefined]> = [
    ['a valid body', '/j', post({ n: '3' })],
    ['an invalid body', '/j', post({ n: 0 })],
    [
      'a body that is not JSON',
      '/j',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' },
    ],
    ['a valid query', '/q?n=2', undefined],
    ['an invalid query', '/q?n=x', undefined],
  ];

  for (const [name, path, init] of cases) {
    it(`with a hook, for ${name}`, async () => {
      expect(await answer(appWith(zValidator, hook), path, init)).toEqual(
        await answer(appWith(library, hook), path, init),
      );
    });
    it(`with no hook, for ${name}`, async () => {
      const ours = await answer(appWith(zValidator), path, init);
      if (name.startsWith('an invalid'))
        // ISS-1421 r14: the library's raw `{ success: false, error }` is no refusal a reader reads.
        expect(ours).toEqual({
          status: 400,
          body: JSON.stringify({ refused: 400, code: 'BAD_REQUEST' }),
        });
      else expect(ours).toEqual(await answer(appWith(library), path, init));
    });
  }

  it('is a refusal and not a pass for an invalid input, so the parity above is not between two 200s', async () => {
    const refused = await answer(appWith(zValidator, hook), '/q?n=x');
    expect(refused).toEqual({ status: 400, body: JSON.stringify({ refused: 400, code: 'BAD_N' }) });
    const unhooked = await answer(appWith(library), '/q?n=x');
    expect(unhooked.status).toBe(400);
    expect(unhooked.body).toContain('"success":false');
  });
});

describe('a failed parse is refused in sentences (ISS-1421 r14)', () => {
  async function refusal(hook?: Parameters<typeof library>[2]) {
    const app = new Hono();
    app.post('/j', zValidator('json', schema, hook), (c) => c.json({}));
    let thrown: unknown;
    app.onError((err, c) => {
      thrown = err;
      return c.json({}, 400);
    });
    await app.request('/j', post({ n: 0 }));
    return thrown as HTTPException;
  }

  it('re-words a hook that refused with "Invalid input", keeping its status, code and details', async () => {
    const err = await refusal((r) => {
      if (!r.success)
        throw new HTTPException(422, {
          message: 'Invalid input',
          cause: { code: 'BAD_N', details: { kept: true } },
        });
    });
    expect(err.status).toBe(422);
    expect(err.message).toBe('The field n takes at least 1.');
    expect(err.cause).toEqual({ code: 'BAD_N', details: { kept: true } });
  });

  it('gives a hook that threw no details the sentences by field, and the accepted values', async () => {
    const app = new Hono();
    const status = z.object({ status: z.enum(['open', 'closed']) });
    app.post(
      '/s',
      zValidator('json', status, (r) => {
        if (!r.success)
          throw new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_STATUS' } });
      }),
      (c) => c.json({}),
    );
    let thrown: HTTPException | undefined;
    app.onError((err, c) => {
      thrown = err as HTTPException;
      return c.json({}, 400);
    });
    await app.request('/s', post({ status: 'shipped' }));
    expect(thrown?.message).toBe(
      'The field status takes one of the values listed in details.accepted.',
    );
    expect(thrown?.cause).toEqual({
      code: 'BAD_STATUS',
      details: {
        formErrors: [],
        fieldErrors: {
          status: ['The field status takes one of the values listed in details.accepted.'],
        },
        accepted: { status: ['open', 'closed'] },
      },
    });
  });

  it("keeps a hook's own refusal where it is already a sentence", async () => {
    const err = await refusal((r) => {
      if (!r.success) throw new HTTPException(400, { message: 'Name a count of one or more.' });
    });
    expect(err.message).toBe('Name a count of one or more.');
  });

  it('refuses in sentences where there is no hook', async () => {
    const err = await refusal();
    expect(err.message).toBe('The field n takes at least 1.');
    expect((err.cause as { code: string }).code).toBe('BAD_REQUEST');
  });
});

describe('what a validator records for the reference', () => {
  it('records its target, its schema and the hook it runs, which wraps the one given', () => {
    const hook = () => undefined;
    const mw = zValidator('query', schema, hook);
    expect(validatorDeclarations.get(mw)).toMatchObject({ target: 'query', schema });
    expect(validatorDeclarations.get(mw)?.hook).toBeTypeOf('function');
  });

  it('records a refusing hook where none was given, as the route refuses with one', () => {
    expect(validatorDeclarations.get(zValidator('json', schema))?.hook).toBeTypeOf('function');
  });

  it('records nothing for a handler that is not a validator', () => {
    expect(validatorDeclarations.get(async () => undefined)).toBeUndefined();
  });
});

describe('declaresInput', () => {
  function declaredApp() {
    const app = new Hono();
    app.post('/d', declaresInput('json', schema), async (c) => c.json({ got: await c.req.json() }));
    app.onError((err, c) =>
      err instanceof HTTPException
        ? c.json({ refused: err.status, message: err.message }, err.status)
        : c.json({}, 500),
    );
    return app;
  }
  const post = (body: string) =>
    declaredApp().request('/d', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

  it('records the schema as declared and not enforced', () => {
    const mw = declaresInput('json', schema);
    expect(validatorDeclarations.get(mw)).toMatchObject({
      target: 'json',
      schema,
      enforced: false,
    });
  });

  it('lets a body through to the handler, which parses it itself, values and all', async () => {
    const res = await post('{"n":"zero"}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: { n: 'zero' } });
  });

  it('lets a body that is not JSON through to the handler, which owns that refusal', async () => {
    const res = await post('not json');
    expect(res.status).toBe(500);
  });

  it('refuses by name a field the schema does not take, before the handler runs (ISS-1421 r15)', async () => {
    const res = await post('{"n":1,"colour":"red"}');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      refused: 400,
      message: 'The field colour is not one this call takes.',
    });
  });
});

describe('zValidator on a JSON body', () => {
  it('refuses by name a field the schema does not take, with the rest of what is wrong', async () => {
    const app = new Hono();
    app.post('/j', zValidator('json', schema), (c) => c.json({ ok: true }));
    app.onError((err, c) =>
      err instanceof HTTPException
        ? c.json({ refused: err.status, message: err.message }, err.status)
        : c.json({}, 500),
    );
    const sent = (body: string) =>
      app.request('/j', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(await (await sent('{"n":1,"colour":"red"}')).json()).toEqual({
      refused: 400,
      message: 'The field colour is not one this call takes.',
    });
    expect(await (await sent('{"colour":"red"}')).json()).toEqual({
      refused: 400,
      message: 'The field colour is not one this call takes. The field n is required.',
    });
    expect((await sent('{"n":1}')).status).toBe(200);
  });

  it('takes any field where the schema says it does', async () => {
    const app = new Hono();
    app.post('/j', zValidator('json', schema.loose()), (c) => c.json({ ok: true }));
    const res = await app.request('/j', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"n":1,"colour":"red"}',
    });
    expect(res.status).toBe(200);
  });
});

// ISS-1421 r17 — judge-73: a slip of letter case alone named no near field, and `?limit=abc` was
// answered "takes a number, not NaN", a word the caller never typed.
describe('a REST refusal says what the caller sent', () => {
  const body = z.object({
    documentId: z.string().optional(),
    relations: z.array(issueRelationInputSchema).optional(),
  });
  const app = new Hono();
  app.post('/j', zValidator('json', body), (c) => c.json({ ok: true }));
  app.get('/q', zValidator('query', schema), (c) => c.json({ ok: true }));
  app.onError((err, c) =>
    err instanceof HTTPException
      ? c.json({ refused: err.status, message: err.message }, err.status)
      : c.json({}, 500),
  );
  const said = async (path: string, init?: RequestInit) =>
    ((await (await app.request(path, init)).json()) as { message?: string }).message;

  it('names the field a stray one differs from in letter case alone, arrays included', async () => {
    expect(await said('/j', post({ documentid: 'x' }))).toBe(
      'The field documentid is not one this call takes. This call takes documentId, which may be what documentid meant.',
    );
    expect(await said('/j', post({ documentID: 'x' }))).toContain(
      'This call takes documentId, which may be what documentID meant.',
    );
    const relation = { dependsOnID: '7c9e6679-7425-40de-944b-e07fc1f90ae7' };
    expect(await said('/j', post({ relations: [relation] }))).toContain(
      'This call takes relations.0.dependsOnId, which may be what relations.0.dependsOnID meant.',
    );
    expect(await said('/j', post({ colour: 'red' }))).toBe(
      'The field colour is not one this call takes.',
    );
  });

  it('quotes a value a number could not be read from, never NaN', async () => {
    expect(await said('/q?n=abc')).toBe('The field n takes a number, not "abc".');
    expect(await said('/q')).toBe('The field n is required.');
  });
});

// ISS-1421 r18 — judge-75: `?limit=` read as 0 and was answered "takes at least 1", or taken as 0.
describe('a number query parameter sent empty', () => {
  const app = new Hono();
  app.get(
    '/q',
    zValidator('query', z.object({ limit: z.coerce.number().int().min(0).default(20) })),
    (c) => c.json({ got: (c.req as unknown as Valid).valid('query') }),
  );
  app.get(
    '/own',
    declaresInput(
      'query',
      z.object({ limit: z.coerce.number().optional(), q: z.string().optional() }),
    ),
    (c) => c.json({ ok: true }),
  );
  app.onError((err, c) =>
    err instanceof HTTPException ? c.json({ message: err.message }, err.status) : c.json({}, 500),
  );

  it('is refused by name, never read as 0', async () => {
    const res = await app.request('/q?limit=');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe(
      'The field limit is empty. Send a number, or leave the field out.',
    );
  });

  it('is refused the same way on a route that parses its own query', async () => {
    const res = await app.request('/own?limit=&q=');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe(
      'The field limit is empty. Send a number, or leave the field out.',
    );
  });

  it('leaves an empty text parameter, a number sent and a number left out alone', async () => {
    expect((await app.request('/own?q=')).status).toBe(200);
    expect(await (await app.request('/q?limit=0')).json()).toEqual({ got: { limit: 0 } });
    expect(await (await app.request('/q')).json()).toEqual({ got: { limit: 20 } });
  });
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
});
