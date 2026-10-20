import { zValidator as library } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { declaresInput, validatorDeclarations, zValidator } from './validator.js';

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

  it('gives the accepted values a details of their own where the hook threw none', async () => {
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
      details: { accepted: { status: ['open', 'closed'] } },
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
  it('records the schema as declared and not enforced, and lets every request through', async () => {
    const mw = declaresInput('json', schema);
    expect(validatorDeclarations.get(mw)).toMatchObject({
      target: 'json',
      schema,
      enforced: false,
    });
    let reached = false;
    await mw({} as never, async () => {
      reached = true;
    });
    expect(reached).toBe(true);
  });
});
