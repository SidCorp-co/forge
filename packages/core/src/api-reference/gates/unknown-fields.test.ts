import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fieldsPolicy, refusesItself, unknownFields } from '../../lib/unknown-fields.js';
import { refusingUnknownFields, type ValidatorDeclaration } from '../declare/validator.js';
import { type RouteEntry, type RouteSource, readRoutes } from '../document/registry.js';

/**
 * ISS-1421 r15 — a JSON body field no schema names is refused by name, never dropped. judge-65 sent
 * `POST /api/projects` a `colour` and got 201 with the colour gone. The shared validator refuses
 * such a field on every route it guards; a route that parses its own body, or a schema that says it
 * takes any field, is held here to a named reason, which is the price of letting a field through.
 */
const TAKES_ANY_FIELD: Readonly<Record<string, string>> = {
  'POST /api/devices/me/questions':
    'a box sends the question it was asked as it read it, and the extra keys are kept with the question',
  'POST /api/projects/:projectId/release-batches/:runId/attempts':
    "the release agent writes this body by hand from its skill, and a release in flight is not stopped over a field Forge does not read; ends when the release skill's attempt is sent by a verb that builds the body",
  'POST /api/projects/:projectId/release-batches/:runId/attempts/:key/account':
    "the release agent writes this body by hand from its skill, and a release in flight is not stopped over a field Forge does not read; ends when the release skill's account is sent by a verb that builds the body",
  'PUT /api/projects/:id/master-charter':
    'parseMasterCharterWrite reads the body itself and refuses every field but goal and rules by name',
};

let routes: RouteEntry[];

beforeAll(async () => {
  const { app } = (await import('../../index.js')) as unknown as { app: RouteSource };
  routes = readRoutes(app);
}, 120_000);

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
      if (key in TAKES_ANY_FIELD) continue;
      const policy = fieldsPolicy(declaration.schema);
      if (policy !== 'closed') silent.push(`${key}: the schema's fields are ${policy}`);
    }
    // The walk is not vacuous: the app takes a JSON body on well over a hundred routes.
    expect(bodies().length).toBeGreaterThan(150);
    expect(silent, 'each line is a route that drops a field it does not name').toEqual([]);
  });

  it('names no exception for a route the app no longer serves', () => {
    const served = new Set(bodies().map((b) => b.key));
    expect(Object.keys(TAKES_ANY_FIELD).filter((k) => !served.has(k))).toEqual([]);
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
