import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HTTPException } from 'hono/http-exception';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ZodType, z } from 'zod';
import {
  fieldsNamedAt,
  fieldsPolicy,
  nestedStrays,
  refusesItself,
  unknownFields,
} from '../../lib/unknown-fields.js';
import { QUERY_GATE_KEYS } from '../declare/input-not-taken.js';
import {
  queryIssues,
  refusingUnknownFields,
  type ValidatorDeclaration,
} from '../declare/validator.js';
import { type RouteEntry, type RouteSource, readRoutes } from '../document/registry.js';

/**
 * ISS-1421 r15 — a JSON body field no schema names is refused by name, never dropped. judge-65 sent
 * `POST /api/projects` a `colour` and got 201 with the colour gone. r16 — judge-69 sent a pairing
 * code request `expiresInMinutes: 1` and got a ten-minute code: a route that declares no body took
 * one and dropped it. A route that lets a field through, or reads its own body, says why on its own
 * declaration (`takesBodyAsSent`), which the API reference shows; this is the price of the exception.
 */
let routes: RouteEntry[];

beforeAll(async () => {
  const { app } = (await import('../../index.js')) as unknown as { app: RouteSource };
  routes = readRoutes(app);
}, 120_000);

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const READS_A_BODY = /req\.(?:json|text|parseBody|formData|arrayBuffer|blob)\(|req\.raw\b/;

const bodyAsSent = (key: string): boolean =>
  routes.some((r) => r.key === key && r.bodyAsSent !== null);

const bodies = (): { key: string; declaration: ValidatorDeclaration }[] =>
  routes.flatMap((entry) =>
    entry.validators
      .filter((d) => d.target === 'json')
      .map((declaration) => ({ key: entry.key, declaration })),
  );

describe('a JSON body field no schema names', () => {
  it('is refused on every route, or the route names why it takes it', () => {
    const silent: string[] = [];
    for (const { key, declaration } of bodies()) {
      if (bodyAsSent(key)) continue;
      const policy = fieldsPolicy(declaration.schema);
      if (policy !== 'closed') silent.push(`${key}: the schema's fields are ${policy}`);
    }
    // The walk is not vacuous: the app takes a JSON body on well over a hundred routes.
    expect(bodies().length).toBeGreaterThan(150);
    expect(silent, 'each line is a route that drops a field it does not name').toEqual([]);
  });

  it('is refused on every write route that declares no body, unless the route says why', () => {
    const silent = routes
      .filter((r) => WRITES.has(r.method) && !r.bodyAsSent)
      .filter((r) => !r.validators.some((v) => v.target === 'json' || v.target === 'form'))
      .filter((r) => READS_A_BODY.test(String(r.handler)))
      .map((r) => r.key);
    expect(silent, 'each route reads a body it neither declares nor names a reason for').toEqual(
      [],
    );
    // Not vacuous: dozens of write routes take no body, judge-69's pairing code among them.
    const bodiless = routes.filter((r) => WRITES.has(r.method) && !r.bodyAsSent);
    expect(bodiless.map((r) => r.key)).toContain('POST /api/projects/:id/devices/pairing-codes');
  });

  it('names its reason in words on every route that takes a body as sent', () => {
    const named = routes.filter((r) => r.bodyAsSent !== null);
    expect(named.length).toBeGreaterThanOrEqual(10);
    for (const r of named) expect(r.bodyAsSent, r.key).toMatch(/^[a-z].{20,}[^.]$/);
  });

  it('is refused by name on the route judge-65 sent a colour to', async () => {
    const project = bodies().find((b) => b.key === 'POST /api/projects');
    if (!project) throw new Error('POST /api/projects takes no JSON body any more');
    const parsed = await refusingUnknownFields(project.declaration.schema).safeParseAsync({
      slug: 'a-slug',
      name: 'A name',
      colour: 'red',
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toContainEqual(
      expect.objectContaining({ code: 'unrecognized_keys', keys: ['colour'] }),
    );
  });
});

/** Queries that take any key: redirects a third party shapes, each with why (ISS-1421 r19). */
const QUERY_TAKES_ANY: Record<string, string> = {
  'GET /api/auth/oauth/:provider/callback':
    "the identity provider's redirect adds keys of its own, such as Google's scope and authuser",
  'GET /api/integrations/github/installed': "GitHub's install redirect adds setup_action",
  'GET /api/integrations/github/manifest-callback':
    "GitHub's manifest redirect is GitHub's to shape",
};

describe('a query key no schema names', () => {
  const queries = () =>
    routes.flatMap((r) =>
      r.validators
        .filter((v) => v.target === 'query')
        .map((v) => ({ key: r.key, schema: v.schema })),
    );

  it('is refused on every route that declares a query, but the redirects named here', () => {
    // Not vacuous: over a hundred routes declare a query, judge-79's knowledge list among them.
    expect(queries().length).toBeGreaterThan(100);
    expect(queries().map((q) => q.key)).toContain('GET /api/projects/:id/knowledge');
    const open = queries().filter((q) => fieldsPolicy(q.schema) !== 'closed');
    expect(open.map((q) => q.key).sort()).toEqual(Object.keys(QUERY_TAKES_ANY).sort());
    const silent = queries()
      .filter((q) => !(q.key in QUERY_TAKES_ANY))
      .filter((q) => {
        // A strict schema names the stray key itself; any other has the gate name it.
        const own = q.schema.safeParse({ colour: 'red' }).error?.issues ?? [];
        const issues = [...queryIssues(q.schema, { colour: 'red' }), ...own];
        return !issues.some(
          (i) => i.code === 'unrecognized_keys' && (i.keys as string[]).includes('colour'),
        );
      })
      .map((q) => q.key);
    expect(silent, 'each route takes a query key it does not name').toEqual([]);
  });

  it('names its reason in words for every query that takes any key', () => {
    for (const [key, why] of Object.entries(QUERY_TAKES_ANY))
      expect(why, key).toMatch(/^(?:GitHub's|the identity provider's) .{20,}[^.]$/);
  });
});

/** What a route's validator answers a body carrying `colour`, read off the hook it mounted. */
async function answerTo(declaration: ValidatorDeclaration, body: unknown): Promise<string | null> {
  const parsed = await refusingUnknownFields(declaration.schema).safeParseAsync(body);
  if (parsed.success) return null;
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const c = { json, req: { header: () => undefined, param: () => ({}), query: () => ({}) } };
  try {
    const answered = await (declaration.hook as (r: unknown, c: unknown) => unknown)(
      { success: false, error: parsed.error, data: body },
      c,
    );
    if (answered instanceof Response)
      return ((await answered.json()) as { message: string }).message;
    return null;
  } catch (thrown) {
    return thrown instanceof HTTPException ? thrown.message : String(thrown);
  }
}

/**
 * Routes whose body names its shape before its fields: a body choosing no option, or not the
 * `{ base, patch }` envelope, is refused for that first, so the colour rides on a body of that shape.
 */
const SHAPE_FIRST: Record<string, Record<string, unknown>> = {
  'POST /api/orgs/:orgId/ssh-keys': { mode: 'generate' },
  'PATCH /api/projects/:id/environments': { base: {}, patch: {} },
  'PATCH /api/projects/:id/pipeline-config': { base: {}, patch: {} },
};

/**
 * ISS-1421 r20 — judge-82 sent the git credential helper {host, path, colour} and was told "host and
 * path are required": a route whose hook words its own refusal swallowed the stray field. Every
 * route's validator, hook and all, is sent a colour and must name it.
 */
describe('a JSON body field no schema names, past a route hook', () => {
  it('is named whatever the route hook says, on every route', async () => {
    const hooked = bodies().filter(
      ({ key, declaration }) => !bodyAsSent(key) && declaration.enforced !== false,
    );
    expect(hooked.length).toBeGreaterThan(150);
    expect(hooked.map((h) => h.key)).toContain('POST /api/devices/me/git-credential');
    const silent: string[] = [];
    for (const { key, declaration } of hooked) {
      const said = await answerTo(declaration, { ...(SHAPE_FIRST[key] ?? {}), colour: 'red' });
      if (said === null || !/\bcolour\b/.test(said)) silent.push(`${key}: ${said}`);
    }
    expect(silent, 'each route answered a colour without naming it').toEqual([]);
  });

  it('is named inside a body object on every route whose object takes named fields', () => {
    const silent: string[] = [];
    let walked = 0;
    for (const { key, declaration } of bodies()) {
      if (bodyAsSent(key)) continue;
      const shape = (declaration.schema as unknown as { shape?: Record<string, unknown> }).shape;
      for (const field of Object.keys(shape ?? {})) {
        const body = {
          [field]: { ...chosenOption(fieldOf(declaration.schema, field)), colour: 'red' },
        };
        const strays = nestedStrays(declaration.schema, body);
        const own = (declaration.schema as never as z.ZodType).safeParse(body).error?.issues ?? [];
        const named =
          strays.some((s) => s.keys.includes('colour')) ||
          own.some(
            (i) =>
              i.code === 'unrecognized_keys' && i.path[0] === field && i.keys.includes('colour'),
          );
        const isObject = fieldsNamedAt(declaration.schema, [field]).length > 0;
        if (!isObject) continue;
        walked++;
        if (!named && fieldsPolicy(fieldOf(declaration.schema, field)) === 'closed')
          silent.push(`${key}: ${field}`);
      }
    }
    expect(walked, 'the walk reaches nested objects').toBeGreaterThan(10);
    expect(silent, 'each line is a nested object that drops a field it does not name').toEqual([]);
  });
});

/**
 * ISS-1421 r20 — `GET /api/integration-connections?orgId=` listed every org's connections: a GET
 * route that declares no query dropped the key. The gate refuses every key there, so a handler
 * that reads one must declare it, or it would be refused the key it reads.
 */
describe('a query key on a GET route that declares no query', () => {
  const READS_A_QUERY = /req\.(?:query|queries)\(|searchParams/;

  it('is never read by the route, which would be refused it', () => {
    const undeclared = routes
      .filter((r) => r.method === 'GET' && r.path.startsWith('/api/'))
      .filter((r) => !r.validators.some((v) => v.target === 'query'))
      .filter((r) => READS_A_QUERY.test(String(r.handler)))
      .map((r) => r.key);
    expect(undeclared, 'each route reads a query it does not declare').toEqual([]);
  });

  it('is read undeclared nowhere in the source: every file reading a raw query declares one', () => {
    // The walk above reads a handler's own text; a helper it calls (`handleCallback`) is not in
    // it. So any file that reads a query raw must also declare one, or say here who declares it.
    const DECLARED_ELSEWHERE: Record<string, string> = {
      'auth/oauth/handler.ts': 'read by the OAuth routes in auth/oauth/routes.ts, which declare it',
      'middleware/error.ts': 'reads back what a refused request sent, to quote it',
      'api-reference/declare/validator.ts': 'the gate itself',
      'api-reference/declare/input-not-taken.ts': 'the gate refusing a query no route declares',
    };
    const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const unread: string[] = [];
    for (const file of sourceFiles(root)) {
      const text = readFileSync(join(root, file), 'utf8');
      if (!/req\.(?:query|queries)\(/.test(text) || file in DECLARED_ELSEWHERE) continue;
      // A route file's declarations may sit in its `-reference.ts` beside it.
      const reference = join(root, file.replace(/\.ts$/, '-reference.ts'));
      const declared = [text, existsSync(reference) ? readFileSync(reference, 'utf8') : ''];
      if (!declared.some((t) => /(?:declaresInput|zValidator)\(\s*'query'/.test(t)))
        unread.push(file);
    }
    expect(unread, 'each file reads a query raw and declares none').toEqual([]);
  });

  it('names no gate key without a reason', () => {
    for (const [key, why] of Object.entries(QUERY_GATE_KEYS))
      expect(why, key).toMatch(/^[a-z].{20,}[^.]$/);
  });
});

describe('unknownFields', () => {
  const choice = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('generate'), name: z.string() }),
    z.object({ mode: z.literal('provide'), key: z.string() }),
  ]);

  it('names a field the chosen option of a discriminated union does not take', () => {
    expect(unknownFields(choice, { mode: 'generate', name: 'n', key: 'k' })).toEqual(['key']);
    expect(unknownFields(choice, { mode: 'provide', key: 'k' })).toEqual([]);
  });

  it('leaves a body choosing no option to the schema, which refuses its discriminator', () => {
    expect(unknownFields(choice, { mode: 'nope', extra: 1 })).toEqual([]);
  });

  it('reads through a preprocess to the schema it hands on to', () => {
    const schema = z.preprocess((v) => v, z.object({ a: z.string() }));
    expect(fieldsPolicy(schema)).toBe('closed');
    expect(unknownFields(schema, { a: 'x', b: 1 })).toEqual(['b']);
  });

  it('takes any field where the schema says so, and none where it is strict', () => {
    expect(fieldsPolicy(z.looseObject({ a: z.string() }))).toBe('open');
    expect(unknownFields(z.looseObject({ a: z.string() }), { b: 1 })).toEqual([]);
    expect(fieldsPolicy(z.strictObject({ a: z.string() }))).toBe('closed');
    expect(unknownFields(z.object({ a: z.string() }).optional(), { a: 'x', b: 1 })).toEqual(['b']);
  });

  it('names a field once where the schema is strict itself', async () => {
    const strict = z.strictObject({ a: z.string() });
    const parsed = await refusingUnknownFields(strict).safeParseAsync({ a: 'x', b: 1 });
    expect(parsed.error?.issues.filter((i) => i.code === 'unrecognized_keys')).toHaveLength(1);
    expect(refusesItself(strict, { b: 1 })).toBe(true);
    expect(refusesItself(z.object({ a: z.string() }), { b: 1 })).toBe(false);
    const strictChoice = z.discriminatedUnion('mode', [
      z.strictObject({ mode: z.literal('a'), x: z.string() }),
      z.object({ mode: z.literal('b') }),
    ]);
    expect(refusesItself(strictChoice, { mode: 'a', y: 1 })).toBe(true);
    expect(refusesItself(strictChoice, { mode: 'b', y: 1 })).toBe(false);
    const viaChoice = await refusingUnknownFields(strictChoice).safeParseAsync({
      mode: 'a',
      x: 'x',
      y: 1,
    });
    expect(viaChoice.error?.issues.filter((i) => i.code === 'unrecognized_keys')).toHaveLength(1);
  });

  it('is red for a schema that drops a field, planted', async () => {
    const parsed = await refusingUnknownFields(z.object({ a: z.string() })).safeParseAsync({
      a: 'x',
      b: 1,
    });
    expect(parsed.success).toBe(false);
    const loose = await refusingUnknownFields(z.looseObject({ a: z.string() })).safeParseAsync({
      a: 'x',
      b: 1,
    });
    expect(loose.success).toBe(true);
  });
});

/** The schema a top-level field is read by, its wrappers off. */
function fieldOf(schema: ZodType, field: string): ZodType {
  let at = schema as unknown as { _zod: { def: Record<string, unknown> } };
  for (;;) {
    const def = at._zod.def as {
      type: string;
      innerType?: unknown;
      shape?: Record<string, unknown>;
    };
    if (def.type === 'object') return (def.shape?.[field] ?? z.never()) as ZodType;
    if (!def.innerType) return z.never();
    at = def.innerType as typeof at;
  }
}

/** For a discriminated union, a body choosing its first option; for anything else, nothing. */
function chosenOption(schema: ZodType): Record<string, unknown> {
  let at = schema as unknown as { _zod: { def: Record<string, unknown> } };
  for (;;) {
    const def = at._zod.def as {
      type: string;
      innerType?: unknown;
      discriminator?: string;
      options?: { _zod: { propValues?: Record<string, Set<unknown>> } }[];
    };
    if (def.type === 'union' && def.discriminator && def.options?.[0]) {
      const [value] = def.options[0]._zod.propValues?.[def.discriminator] ?? [];
      return { [def.discriminator]: value };
    }
    if (!def.innerType) return {};
    at = def.innerType as typeof at;
  }
}

/** Every non-test `.ts` file under `root`, relative to it. */
function sourceFiles(root: string, at = root): string[] {
  return readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
    const path = join(at, entry.name);
    if (entry.isDirectory()) return sourceFiles(root, path);
    return entry.name.endsWith('.ts') && !/\.test\.ts$/.test(entry.name)
      ? [relative(root, path)]
      : [];
  });
}
