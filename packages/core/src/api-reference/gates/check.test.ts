import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PAT_DOOR_REFUSALS } from '../../middleware/pat-rest-surface.js';
import { describeOperation, fail, json, raw } from '../declare/describe.js';
import { zValidator } from '../declare/validator.js';
import { buildReference, type Reference } from '../document/build.js';
import { checkReference, describeFinding, inputsRead, thrownInline } from './check.js';
import { stringsWrittenOutsideDeclarations } from './written-codes.fixture.js';

const ok = describeOperation({ summary: 'ok', responses: { 200: json(z.object({})) } });
const hook = (r: { success: boolean }) => {
  if (!r.success) throw new HTTPException(400, { message: 'bad', cause: { code: 'BAD_REQUEST' } });
};

/** Every code the build adds on its own, written as a source file would write it. */
const BUILT_IN = [...PAT_DOOR_REFUSALS.map((r) => `'${r.code}'`), "'INTERNAL_ERROR'"].join(' ');

/** What the source files write, the built-in codes and the given file texts. */
const writing = (...files: string[]) =>
  stringsWrittenOutsideDeclarations([
    BUILT_IN,
    ...files.map((file) => `import { fail } from '../declare/describe.js';\n${file}`),
  ]);

async function checked(
  app: Hono,
  written = writing(`'NOT_FOUND' 'BAD_REQUEST' 'CONFLICT' 'STALE'`),
) {
  const reference = await buildReference(app, { version: 't' });
  return { reference, findings: checkReference({ reference, written }) };
}

const rules = (findings: ReadonlyArray<{ rule: string; route: string }>) =>
  findings.map((f) => `${f.rule} ${f.route}`);

describe('a clean planted app', () => {
  it('has no findings, so every rule below is red for its own plant and not for the app', async () => {
    const app = new Hono();
    app.get('/api/issues/:id', zValidator('param', z.object({ id: z.string() }), hook), ok, (c) =>
      c.json({}),
    );
    app.post(
      '/api/issues',
      zValidator('json', z.object({ a: z.string() }), hook),
      describeOperation({
        summary: 'create',
        responses: { 201: json(z.object({})), 409: fail('CONFLICT', 'twice') },
      }),
      async (c) => {
        if (c.req.valid('json').a === 'x')
          throw new HTTPException(409, { message: 'm', cause: { code: 'CONFLICT' } });
        return c.json({}, 201);
      },
    );
    const { findings } = await checked(app);
    expect(findings.map(describeFinding)).toEqual([]);
  });
});

describe('each rule, planted once', () => {
  it('no-response: a route that declares no answer is named', async () => {
    const app = new Hono();
    app.get('/api/issues', (c) => c.json({}));
    const { findings } = await checked(app);
    expect(rules(findings)).toEqual(['no-response GET /api/issues']);
  });

  it('no-response: a retired route that answers only a refusal is not named, and is marked deprecated', async () => {
    const app = new Hono();
    app.get(
      '/api/issues',
      describeOperation({
        summary: 's',
        retired: 'moved to knowledge',
        responses: { 410: fail('GONE_FOR_GOOD') },
      }),
      () => {
        throw new HTTPException(410, { message: 'gone', cause: { code: 'GONE_FOR_GOOD' } });
      },
    );
    const { findings, reference } = await checked(app, writing("'GONE_FOR_GOOD'"));
    expect(rules(findings)).toEqual([]);
    expect(reference.document.paths['/api/issues']?.get?.deprecated).toBe(true);
  });

  it('raw-json: a JSON body declared as a raw string is named', async () => {
    const app = new Hono();
    app.post(
      '/mcp',
      describeOperation({ summary: 's', responses: { 200: raw('application/json', 'a message') } }),
      (c) => c.json({}),
    );
    const { findings } = await checked(app);
    expect(rules(findings)).toEqual(['raw-json POST /mcp']);
    expect(findings[0]?.detail).toContain('json(schema)');
  });

  it('raw-json: a raw answer that is not JSON is left alone', async () => {
    const app = new Hono();
    app.get(
      '/health',
      describeOperation({ summary: 's', responses: { 200: raw('text/event-stream', 'events') } }),
      (c) => c.body(''),
    );
    const { findings } = await checked(app);
    expect(rules(findings)).toEqual([]);
  });

  it('no-response: a route that declares only errors is named too', async () => {
    const app = new Hono();
    app.get(
      '/api/issues',
      describeOperation({ summary: 's', responses: { 404: fail('NOT_FOUND') } }),
      (c) => c.json({}),
    );
    const { findings } = await checked(app);
    expect(rules(findings)).toEqual(['no-response GET /api/issues']);
  });

  it('undeclared-input: a path parameter with no schema is named', async () => {
    const app = new Hono();
    app.get('/api/issues/:id', ok, (c) => c.json({}));
    const { findings } = await checked(app);
    expect(rules(findings)).toContain('undeclared-input GET /api/issues/:id');
    expect(findings.find((f) => f.rule === 'undeclared-input')?.detail).toContain(':id');
  });

  it('undeclared-input: a handler that reads the body with no schema is named for the body', async () => {
    const app = new Hono();
    app.post('/api/issues', ok, async (c) => c.json(await c.req.json()));
    const { findings } = await checked(app);
    expect(findings.map((f) => `${f.rule} ${f.route}: ${f.detail}`).join('\n')).toMatch(
      /undeclared-input POST \/api\/issues: .*reads the request's json/,
    );
  });

  it('undeclared-input: a handler that reads a query with no schema is named', async () => {
    const app = new Hono();
    app.get('/api/issues', ok, (c) => c.json({ q: c.req.query('q') }));
    const { findings } = await checked(app);
    expect(findings.find((f) => f.rule === 'undeclared-input')?.detail).toContain('query');
  });

  it('undeclared-input: a declared schema silences it, so the rule reads what the handler reads', async () => {
    const app = new Hono();
    app.get(
      '/api/issues',
      zValidator('query', z.object({ q: z.string().optional() }), hook),
      ok,
      (c) => c.json({ q: c.req.query('q') }),
    );
    const { findings } = await checked(app);
    expect(findings).toEqual([]);
  });

  it('unrepresentable: a schema JSON Schema cannot hold is named with its route and target', async () => {
    const app = new Hono();
    app.post(
      '/api/issues',
      zValidator('json', z.object({ x: z.custom<string>(() => true) }), hook),
      ok,
      (c) => c.json({}),
    );
    const { findings } = await checked(app);
    expect(rules(findings)).toEqual(['unrepresentable POST /api/issues']);
    expect(findings[0]?.detail).toContain('json schema');
  });

  it('unreadable-hook: a hook that cannot be run to read its refusal is named, never taken as silent', async () => {
    const app = new Hono();
    app.get(
      '/api/issues',
      zValidator('query', z.object({}), () => {
        throw new TypeError('needs the real context');
      }),
      ok,
      (c) => c.json({}),
    );
    const { findings } = await checked(app);
    expect(rules(findings)).toEqual(['unreadable-hook GET /api/issues']);
  });

  it('param-not-in-path: a param schema that names a segment the path lacks is named', async () => {
    const app = new Hono();
    app.get('/api/issues', zValidator('param', z.object({ id: z.string() }), hook), ok, (c) =>
      c.json({}),
    );
    const { findings } = await checked(app);
    expect(rules(findings)).toEqual(['param-not-in-path GET /api/issues']);
  });
});

describe('each rule, planted once, continued', () => {
  it('no-access: a path in neither the grant menu nor the exclusions is named', async () => {
    const app = new Hono();
    app.get('/not-a-listed-path', ok, (c) => c.json({}));
    const { findings } = await checked(app);
    expect(rules(findings)).toEqual(['no-access GET /not-a-listed-path']);
  });

  it('more-than-one-descriptor: two descriptors on one route are named', async () => {
    const app = new Hono();
    app.get('/api/issues', ok, ok, (c) => c.json({}));
    const { findings } = await checked(app);
    expect(rules(findings)).toEqual(['more-than-one-descriptor GET /api/issues']);
  });

  it('undeclared-error: a handler that throws a status and code its descriptor lacks is named with both', async () => {
    const app = new Hono();
    app.get('/api/issues', ok, () => {
      throw new HTTPException(409, { message: 'm', cause: { code: 'STALE' } });
    });
    const { findings } = await checked(app);
    expect(rules(findings)).toEqual(['undeclared-error GET /api/issues']);
    expect(findings[0]?.detail).toContain('409 STALE');
  });

  it('undeclared-error: the right status with a different code is still named', async () => {
    const app = new Hono();
    app.get(
      '/api/issues',
      describeOperation({
        summary: 's',
        responses: { 200: json(z.object({})), 409: fail('CONFLICT') },
      }),
      () => {
        throw new HTTPException(409, { message: 'm', cause: { code: 'STALE' } });
      },
    );
    const { findings } = await checked(app);
    expect(findings[0]?.detail).toContain('409 STALE');
  });

  it('undeclared-error: a status thrown with no code takes the code the error handler derives', async () => {
    const app = new Hono();
    app.get(
      '/api/issues',
      describeOperation({ summary: 's', responses: { 200: json(z.object({})), 404: fail() } }),
      () => {
        throw new HTTPException(404, { message: 'gone' });
      },
    );
    const { findings } = await checked(app);
    expect(findings).toEqual([]);
  });

  it('omitted: a route the document does not carry is named', async () => {
    const app = new Hono();
    app.get('/api/issues', ok, (c) => c.json({}));
    const reference = await buildReference(app, { version: 't' });
    const trimmed: Reference = { ...reference, document: { ...reference.document, paths: {} } };
    expect(rules(checkReference({ reference: trimmed, written: writing() }))).toEqual([
      'omitted GET /api/issues',
    ]);
  });

  it('path-collision: two routes that are one OpenAPI operation are named', async () => {
    const app = new Hono();
    app.get('/api/issues/:a', zValidator('param', z.object({ a: z.string() }), hook), ok, (c) =>
      c.json({}),
    );
    app.get('/api/issues/:b', zValidator('param', z.object({ b: z.string() }), hook), ok, (c) =>
      c.json({}),
    );
    const { findings } = await checked(app);
    expect(findings.map((f) => f.rule)).toContain('path-collision');
  });

  it('dangling-ref: a $ref that names no schema is named', async () => {
    const app = new Hono();
    app.get('/api/issues', ok, (c) => c.json({}));
    const reference = await buildReference(app, { version: 't' });
    const op = reference.document.paths['/api/issues']?.get;
    if (op)
      op.responses = {
        200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Gone' } } } },
      };
    expect(rules(checkReference({ reference, written: writing() }))).toContain(
      'dangling-ref document',
    );
  });

  it('schema-name-clash: two different schemas under one name are named', async () => {
    const app = new Hono();
    app.get(
      '/api/a',
      describeOperation({
        summary: 'a',
        responses: { 200: json(z.object({ x: z.string() }).meta({ id: 'Thing' })) },
      }),
      (c) => c.json({}),
    );
    app.get(
      '/api/b',
      describeOperation({
        summary: 'b',
        responses: { 200: json(z.object({ y: z.number() }).meta({ id: 'Thing' })) },
      }),
      (c) => c.json({}),
    );
    const { findings } = await checked(app);
    expect(findings.find((f) => f.rule === 'schema-name-clash')?.detail).toContain('"Thing"');
  });
});

describe('what the check reads out of handler text', () => {
  it('finds each input a handler reads, by target', () => {
    expect(
      inputsRead(
        'async (c) => { await c.req.json(); c.req.query("a"); c.req.param("id"); c.req.parseBody(); c.req.arrayBuffer() }',
      ).sort(),
    ).toEqual(['form', 'json', 'param', 'query', 'raw'].sort());
  });

  it('finds none in a handler that reads only what a validator gave it', () => {
    expect(inputsRead("async (c) => c.json(c.req.valid('json'))")).toEqual([]);
  });

  it('reads an exception thrown through a bundler import wrapper as the same exception', () => {
    expect(
      thrownInline("throw new __vite_ssr_import_1__.HTTPException(409, { cause: { code: 'X' } })"),
    ).toEqual([{ status: 409, code: 'X' }]);
  });

  it('reads the project lookup as a 404 the handler can answer, as written or through an import wrapper', () => {
    expect(thrownInline('const a = await loadProjectAccess(id, user);')).toEqual([
      { status: 404, code: 'NOT_FOUND' },
    ]);
    expect(
      thrownInline('await (0, __vite_ssr_import_1__.loadProjectAccess)(id, f(user));'),
    ).toEqual([{ status: 404, code: 'NOT_FOUND' }]);
  });

  it('reads no 404 from a project lookup whose refusal is caught on the spot', () => {
    expect(
      thrownInline('const a = await loadProjectAccess(id, f(user)).catch(() => null);'),
    ).toEqual([]);
  });

  it('reads the status and code of each exception thrown inline, through nested braces and strings', () => {
    const text = `async (c) => {
      throw new HTTPException(422, { message: "a (b)", cause: { code: 'ONE', details: { x: 1 } } });
      if (x) throw new HTTPException(404, { message: 'gone' });
    }`;
    expect(thrownInline(text)).toEqual([
      { status: 422, code: 'ONE' },
      { status: 404, code: 'NOT_FOUND' },
    ]);
  });
});

describe('typo-code, planted once', () => {
  it('typo-code: a declared code that no source file writes is named', async () => {
    const app = new Hono();
    app.get(
      '/api/issues',
      describeOperation({
        summary: 's',
        responses: { 200: json(z.object({})), 409: fail('CONFLCIT') },
      }),
      (c) => c.json({}),
    );
    const { findings } = await checked(app);
    expect(rules(findings)).toEqual(['typo-code document']);
    expect(findings[0]?.detail).toContain('CONFLCIT');
  });

  it('typo-code: a code is not written by the descriptor that declares it, in either form of fail', async () => {
    const app = new Hono();
    app.get(
      '/api/issues',
      describeOperation({
        summary: 's',
        responses: {
          200: json(z.object({})),
          409: fail('CONFLCIT', 'two writers'),
          410: fail({ GONEE: 'was here' }),
        },
      }),
      (c) => c.json({}),
    );
    const reference = await buildReference(app, { version: 't' });
    const declaring = `export const x = describeOperation({ responses: { 409: fail('CONFLCIT', 'two writers'), 410: fail({ GONEE: 'was here' }) } });`;
    const findings = checkReference({ reference, written: writing(declaring) });
    expect(rules(findings)).toEqual(['typo-code document', 'typo-code document']);
    expect(findings.map((f) => f.detail).join(' ')).toContain('CONFLCIT');
  });

  it('typo-code: a comment, a regular expression or a string before the declaration changes nothing', () => {
    const written = writing(
      [
        'const note = "fail(";',
        '// fail( is how a descriptor starts',
        "const apostrophe = /'/;",
        "const slashes = '//';",
        "fail(/* ) */ 'CONFLCIT', 'two writers');",
        "throw new HTTPException(409, { cause: { code: 'CONFLICT' } });",
      ].join('\n'),
    );
    expect(written.has('CONFLICT')).toBe(true);
    expect(written.has('CONFLCIT')).toBe(false);
  });

  it('typo-code: a fail that is not the descriptor one, a template string and a quote are all writing', () => {
    const written = stringsWrittenOutsideDeclarations([
      "const fail = (code: string) => code; fail('LOCAL');",
      'const code = `TEMPLATED`;',
    ]);
    expect(written.has('LOCAL')).toBe(true);
    expect(written.has('TEMPLATED')).toBe(true);
  });

  it('typo-code: a call one file leaves open does not reach the next file', () => {
    const written = writing(
      "fail('A', 'never closed'",
      "throw new HTTPException(409, { cause: { code: 'CONFLICT' } });",
    );
    expect(written.has('CONFLICT')).toBe(true);
  });

  it('typo-code: a code a handler throws is written, so it is not named', async () => {
    const app = new Hono();
    app.get(
      '/api/issues',
      describeOperation({
        summary: 's',
        responses: { 200: json(z.object({})), 409: fail('CONFLICT', 'two writers') },
      }),
      () => {
        throw new HTTPException(409, { message: 'x', cause: { code: 'CONFLICT' } });
      },
    );
    const reference = await buildReference(app, { version: 't' });
    const written = writing(
      "fail('CONFLICT', 'two writers'); throw new HTTPException(409, { cause: { code: 'CONFLICT' } });",
    );
    expect(checkReference({ reference, written })).toEqual([]);
  });
});
