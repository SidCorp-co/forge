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

describe('zValidator answers exactly as @hono/zod-validator does', () => {
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
      expect(await answer(appWith(zValidator), path, init)).toEqual(
        await answer(appWith(library), path, init),
      );
    });
  }

  it('is a refusal and not a pass for an invalid input, so the parity above is not between two 200s', async () => {
    const refused = await answer(appWith(zValidator, hook), '/q?n=x');
    expect(refused).toEqual({ status: 400, body: JSON.stringify({ refused: 400, code: 'BAD_N' }) });
    const unhooked = await answer(appWith(zValidator), '/q?n=x');
    expect(unhooked.status).toBe(400);
    expect(unhooked.body).toContain('"success":false');
  });
});

describe('what a validator records for the reference', () => {
  it('records its target, its schema and its hook', () => {
    const hook = () => undefined;
    const mw = zValidator('query', schema, hook);
    expect(validatorDeclarations.get(mw)).toEqual({ target: 'query', schema, hook });
  });

  it('records no hook as null', () => {
    expect(validatorDeclarations.get(zValidator('json', schema))?.hook).toBeNull();
  });

  it('records nothing for a handler that is not a validator', () => {
    expect(validatorDeclarations.get(async () => undefined)).toBeUndefined();
  });
});

describe('declaresInput', () => {
  it('records the schema as declared and not enforced, and lets every request through', async () => {
    const mw = declaresInput('json', schema);
    expect(validatorDeclarations.get(mw)).toMatchObject({ target: 'json', schema, enforced: false });
    let reached = false;
    await mw({} as never, async () => {
      reached = true;
    });
    expect(reached).toBe(true);
  });
});
