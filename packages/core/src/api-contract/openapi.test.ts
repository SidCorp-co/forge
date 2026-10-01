import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { declareGate } from '../middleware/declared-gate.js';
import { rawBody, zValidator } from '../middleware/zod-validator.js';
import { buildApiContract, UNDECLARED_RESPONSE, UNNAMED_REFINEMENT } from './openapi.js';

type Op = {
  'x-forge-auth': string[];
  'x-forge-input'?: string;
  parameters?: { in: string; name: string; required: boolean; schema: Record<string, unknown> }[];
  requestBody?: {
    required: boolean;
    description?: string;
    content: Record<string, { schema: Record<string, unknown> }>;
  };
  responses: { default: { description: string } };
  'x-forge-validated': string[];
  'x-forge-query-closed'?: boolean;
};

function contract(app: Hono) {
  const built = buildApiContract(app.routes, { title: 't', version: '0' });
  const paths = built.document.paths as Record<string, Record<string, Op>>;
  return { ...built, paths };
}

function operation(app: Hono, path: string, method: string): Op {
  const op = contract(app).paths[path]?.[method];
  if (op === undefined) throw new Error(`the contract holds no ${method} ${path}`);
  return op;
}

function firstParameter(op: Op) {
  const param = op.parameters?.[0];
  if (param === undefined) throw new Error('the operation declares no parameter');
  return param;
}

describe('the API contract read off a mounted app', () => {
  it('describes path, query and body inputs from the validators each route holds', () => {
    const sub = new Hono();
    sub.post(
      '/:id/items',
      zValidator('param', z.object({ id: z.uuid() })),
      zValidator('query', z.strictObject({ dryRun: z.enum(['0', '1']).optional() })),
      zValidator('json', z.object({ name: z.string().max(64) })),
      (c) => c.json({}),
    );
    const app = new Hono();
    app.route('/api/things', sub);

    const { operations, refusals } = contract(app);
    const op = operation(app, '/api/things/{id}/items', 'post');

    expect(refusals).toEqual([]);
    expect(operations).toBe(1);
    expect(op['x-forge-validated']).toEqual(['json', 'param', 'query']);
    expect(op.parameters?.map((p) => [p.in, p.name, p.required, p.schema.format])).toEqual([
      ['path', 'id', true, 'uuid'],
      ['query', 'dryRun', false, undefined],
    ]);
    expect(op['x-forge-query-closed']).toBe(true);
    expect(op.requestBody?.content['application/json']?.schema.properties).toEqual({
      name: { type: 'string', maxLength: 64 },
    });
  });

  it('says a response is undeclared rather than inventing one, and a path param with no validator is a string', () => {
    const app = new Hono();
    app.get('/api/x/:slug', (c) => c.json({ ok: true }));

    const op = operation(app, '/api/x/{slug}', 'get');

    expect(op.responses).toEqual({ default: { description: UNDECLARED_RESPONSE } });
    expect(op['x-forge-validated']).toEqual([]);
    expect(op.parameters).toEqual([
      { in: 'path', name: 'slug', required: true, schema: { type: 'string' } },
    ]);
    expect(op.requestBody).toBeUndefined();
  });

  it('reads validators through a sub-app whose own error handler wraps every handler', () => {
    const sub = new Hono();
    sub.onError((_err, c) => c.text('no', 500));
    sub.put('/:n', zValidator('json', z.object({ a: z.number() })), (c) => c.json({}));
    const app = new Hono();
    app.route('/api/wrapped', sub);

    const op = operation(app, '/api/wrapped/{n}', 'put');

    expect(op['x-forge-validated']).toEqual(['json']);
  });

  it('applies a validator mounted with use() to every route under its pattern, and to no other', () => {
    const app = new Hono();
    app.use('/api/p/:pid/*', zValidator('param', z.object({ pid: z.uuid() })));
    app.get('/api/p/:pid/a', (c) => c.json({}));
    app.get('/api/q/:pid/a', (c) => c.json({}));

    expect(operation(app, '/api/p/{pid}/a', 'get')['x-forge-validated']).toEqual(['param']);
    expect(operation(app, '/api/q/{pid}/a', 'get')['x-forge-validated']).toEqual([]);
  });

  it('describes a coerced date as the date-time string a URL can carry', () => {
    const app = new Hono();
    app.get('/api/d', zValidator('query', z.object({ from: z.coerce.date() })), (c) => c.json({}));

    const param = firstParameter(operation(app, '/api/d', 'get'));

    expect(param.schema).toEqual({ type: 'string', format: 'date-time' });
    expect(param.required).toBe(true);
  });

  it('carries a regex path constraint into the parameter pattern', () => {
    const app = new Hono();
    app.get('/api/n/:num{[0-9]+}', (c) => c.json({}));

    const param = firstParameter(operation(app, '/api/n/{num}', 'get'));

    expect(param.schema).toEqual({ type: 'string', pattern: '^[0-9]+$' });
  });

  it('orders paths and methods the same way whatever order the routes were mounted in', () => {
    const one = new Hono();
    one.post('/b', (c) => c.json({}));
    one.get('/b', (c) => c.json({}));
    one.get('/a', (c) => c.json({}));
    const two = new Hono();
    two.get('/a', (c) => c.json({}));
    two.get('/b', (c) => c.json({}));
    two.post('/b', (c) => c.json({}));

    const first = contract(one).paths;
    const second = contract(two).paths;

    expect(Object.keys(first)).toEqual(['/a', '/b']);
    expect(Object.keys(first['/b'] ?? {})).toEqual(['get', 'post']);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('a mounted route the generator cannot describe is refused by name, never left out', () => {
  it.each([
    [
      'a wildcard route',
      (app: Hono) => app.get('/api/files/*', (c) => c.text('')),
      'GET /api/files/*: a wildcard segment',
    ],
    [
      'an optional path parameter',
      (app: Hono) => app.get('/api/o/:id?', (c) => c.text('')),
      'GET /api/o/:id?: the optional parameter',
    ],
    [
      'an all() handler covering no other route',
      (app: Hono) => app.all('/api/anything', (c) => c.text('')),
      'ALL /api/anything: registered for every method and covering no route',
    ],
    [
      'a schema holding a plain date',
      (app: Hono) =>
        app.post('/api/j', zValidator('json', z.object({ at: z.date() })), (c) => c.text('')),
      'POST /api/j: a `json` validator with a schema holding z.date()',
    ],
    [
      'a query validator that is not an object',
      (app: Hono) =>
        app.get(
          '/api/u',
          zValidator('query', z.union([z.object({ a: z.string() }), z.object({ b: z.string() })])),
          (c) => c.text(''),
        ),
      'GET /api/u: a query validator whose schema is not an object',
    ],
    [
      'a param validator naming a param the path does not carry',
      (app: Hono) =>
        app.get(
          '/api/r/:id',
          zValidator('param', z.object({ id: z.string(), other: z.string() })),
          (c) => c.text(''),
        ),
      'GET /api/r/:id: a param validator for `other`',
    ],
    [
      'two routes reaching one OpenAPI path',
      (app: Hono) => {
        app.get('/api/t', (c) => c.text(''));
        app.get('/api/t/', (c) => c.text(''));
      },
      'GET /api/t/: a second route reaching `GET /api/t`',
    ],
  ])('%s', (_name, mount, refusal) => {
    const app = new Hono();
    mount(app);

    const { refusals } = contract(app);

    expect(refusals.some((r) => r.startsWith(refusal))).toBe(true);
  });

  it('keeps describing every other route while it refuses one', () => {
    const app = new Hono();
    app.get('/api/files/*', (c) => c.text(''));
    app.get('/api/fine', (c) => c.text(''));

    const { paths, refusals, operations } = contract(app);

    expect(refusals).toHaveLength(1);
    expect(operations).toBe(1);
    expect(Object.keys(paths)).toEqual(['/api/fine']);
  });
});

describe('a route that reads input no validator declares is refused by name', () => {
  it.each([
    [
      'a body read with c.req.json()',
      (app: Hono) => app.post('/api/b', async (c) => c.json(await c.req.json())),
      'POST /api/b: reads the request body with `c.req.json()` and declares no body',
    ],
    [
      'a validated body read with no json validator mounted',
      (app: Hono) => app.post('/api/v', (c) => c.json(c.req.valid('json' as never))),
      "POST /api/v: reads `c.req.valid('json')` and holds no `json` validator",
    ],
    [
      'a query read with c.req.query()',
      (app: Hono) => app.get('/api/q', (c) => c.text(c.req.query('since') ?? '')),
      'GET /api/q: reads the query with `c.req.query()` and holds no query validator',
    ],
    [
      'a query read off the URL',
      (app: Hono) =>
        app.get('/api/u', (c) => c.text(new URL(c.req.url).searchParams.get('org') ?? '')),
      'GET /api/u: reads the query with `new URL(c.req.url).searchParams`',
    ],
    [
      'a multipart body with no rawBody() declaration',
      (app: Hono) => app.post('/api/m', async (c) => c.json(await c.req.parseBody())),
      'POST /api/m: reads the request body with `c.req.parseBody()` and declares no body',
    ],
    [
      'a body read in middleware covering the route',
      (app: Hono) => {
        app.use('/api/w', async (c, next) => {
          await c.req.json();
          await next();
        });
        app.post('/api/w', (c) => c.text(''));
      },
      'POST /api/w: reads the request body with `c.req.json()` and declares no body',
    ],
  ])('%s', (_name, mount, refusal) => {
    const app = new Hono();
    mount(app);

    const { refusals } = contract(app);

    expect(refusals.some((r) => r.startsWith(refusal))).toBe(true);
  });

  it('admits the same reads once a validator or rawBody() declares them', () => {
    const app = new Hono();
    app.post(
      '/api/b',
      zValidator('json', z.object({ a: z.string() })),
      zValidator('query', z.object({ since: z.string().optional() })),
      (c) => c.json({ ...c.req.valid('json'), since: c.req.valid('query').since }),
    );
    app.post('/api/m', rawBody('multipart/form-data', 'one file under `file`'), async (c) =>
      c.json(await c.req.parseBody()),
    );

    const { refusals, paths } = contract(app);

    expect(refusals).toEqual([]);
    expect(paths['/api/m']?.post?.requestBody).toEqual({
      required: true,
      description: 'one file under `file`',
      content: { 'multipart/form-data': { schema: {} } },
    });
    expect(paths['/api/m']?.post?.['x-forge-validated']).toEqual([]);
  });

  it('lets a handler read a path parameter with no validator, the path being its declaration', () => {
    const app = new Hono();
    app.get('/api/x/:id', (c) => c.text(c.req.param('id')));

    expect(contract(app).refusals).toEqual([]);
  });

  it('marks an operation that reads no input at all', () => {
    const app = new Hono();
    app.get('/api/none', (c) => c.json({}));
    app.get('/api/one/:id', (c) => c.json({}));

    expect(operation(app, '/api/none', 'get')['x-forge-input']).toBe('none');
    expect(operation(app, '/api/one/{id}', 'get')['x-forge-input']).toBeUndefined();
  });
});

describe('what the contract says beyond the shape', () => {
  it('names each refinement by the message it refuses with', () => {
    const app = new Hono();
    app.post(
      '/api/r',
      zValidator(
        'json',
        z
          .object({ a: z.string().refine((v) => v.length > 1, { message: 'a is too short' }) })
          .superRefine(() => {}),
      ),
      (c) => c.json({}),
    );

    const schema = operation(app, '/api/r', 'post').requestBody?.content['application/json']
      ?.schema as { properties: { a: Record<string, unknown> }; [k: string]: unknown };

    expect(schema.properties.a['x-forge-refinements']).toEqual(['a is too short']);
    expect(schema['x-forge-refinements']).toEqual([UNNAMED_REFINEMENT]);
  });

  it('lists the auth gates that run before the route answers, in order, and none registered after', () => {
    const user = declareGate('requireAuth', async (_c: unknown, next: () => Promise<void>) => {
      await next();
    });
    const verified = declareGate(
      'assertEmailVerified',
      async (_c: unknown, next: () => Promise<void>) => {
        await next();
      },
    );
    const sub = new Hono();
    sub.use('*', user as never);
    sub.get('/guarded', verified as never, (c) => c.json({}));
    sub.get('/early', (c) => c.json({}));
    const app = new Hono();
    app.get('/api/s/open', (c) => c.json({}));
    app.route('/api/s', sub);
    app.use('/api/s/*', user as never);

    const { document } = contract(app);

    expect(operation(app, '/api/s/guarded', 'get')['x-forge-auth']).toEqual([
      'requireAuth',
      'assertEmailVerified',
    ]);
    expect(operation(app, '/api/s/early', 'get')['x-forge-auth']).toEqual(['requireAuth']);
    expect(operation(app, '/api/s/open', 'get')['x-forge-auth']).toEqual([]);
    expect(Object.keys(document['x-forge-auth-gates'] as object)).toContain('requireAuth');
  });
});
