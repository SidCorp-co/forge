// ISS-768 r2: ChatGPT's connector lists /mcp's tools and then reports "action discovery failed",
// and one schema a client's importer cannot read fails the whole discovery. Every tool's input is
// listed in the plain JSON Schema subset (mcp/listed-schema.ts). Two things hold for every tool the
// registry serves: the listing passes a strict JSON Schema meta-validation and the subset's rules,
// and it accepts exactly the inputs the published schema accepts, judged sample by sample.
//
// @direct-test-of packages/core/src/mcp/listed-schema.ts

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { PAT_GRANT_EPOCH } from '../credentials/pat-permissions.js';
import type { McpContext } from '../lib/tool.js';
import type { PrincipalVars } from '../middleware/require-pat.js';
import { listedSchema } from './listed-schema.js';
import { MCP_TOOLS } from './registry.js';
import { mcpTools, toolListing } from './server.js';

type Schema = Record<string, unknown>;

const principal = {
  kind: 'pat',
  agency: 'agent',
  agentUserId: null,
  userId: '00000000-0000-4000-8000-000000000768',
  tokenId: 'tok-768',
  scopes: ['read', 'write'],
  projectIds: null,
  permissions: ['*'],
  grantEpoch: PAT_GRANT_EPOCH,
  boundProjectId: null,
  deviceId: null,
  onBehalfOf: null,
} as unknown as PrincipalVars['principal'];

const tools = mcpTools({ principal, projectSlug: null } as unknown as McpContext);
const published = new Map(tools.map((t) => [t.name, t.inputSchema as Schema]));
const listing = new Map(toolListing(tools).map((t) => [t.name, t.inputSchema as Schema]));

function ajv(strict: boolean) {
  const a = new Ajv2020({
    strict,
    strictTypes: strict,
    strictTuples: strict,
    strictRequired: strict,
    allErrors: true,
    validateSchema: true,
  });
  addFormats.default(a);
  return a;
}

const isPlain = (v: unknown): v is Schema =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every subschema of `schema`, with the path it sits at. */
function* subschemas(schema: unknown, path = ''): Generator<[string, Schema]> {
  if (!isPlain(schema)) return;
  yield [path, schema];
  for (const [k, v] of Object.entries(schema)) {
    if (['enum', 'const', 'default', 'examples', 'required'].includes(k)) continue;
    if (k === 'properties' || k === '$defs' || k === 'patternProperties') {
      for (const [name, s] of Object.entries(v as Schema))
        yield* subschemas(s, `${path}/${k}/${name}`);
    } else if (Array.isArray(v)) {
      for (const [i, s] of v.entries()) yield* subschemas(s, `${path}/${k}/${i}`);
    } else {
      yield* subschemas(v, `${path}/${k}`);
    }
  }
}

/** What the subset forbids in one subschema, by rule. */
function ruleBreaks(schema: Schema): string[] {
  const broken: string[] = [];
  for (const [path, s] of subschemas(schema)) {
    const at = path || '/';
    if ('$schema' in s) broken.push(`${at}: $schema`);
    if (Array.isArray(s.type)) broken.push(`${at}: type ${JSON.stringify(s.type)}`);
    if ('propertyNames' in s) broken.push(`${at}: propertyNames`);
    if ('const' in s) broken.push(`${at}: const`);
    if ('required' in s && !(Array.isArray(s.required) && s.required.length > 0))
      broken.push(`${at}: required ${JSON.stringify(s.required)}`);
    if (s.type === 'object' && !isPlain(s.properties))
      broken.push(`${at}: object without properties`);
    if (
      Array.isArray(s.oneOf) &&
      !s.oneOf.every((b) => isPlain(b) && b.type === 'object' && isPlain(b.properties))
    )
      broken.push(`${at}: oneOf of non-object branches`);
  }
  return broken;
}

// ── samples ────────────────────────────────────────────────────────────────────────────────────

const SCALARS: unknown[] = [
  null,
  true,
  false,
  0,
  1,
  -1,
  1.5,
  2 ** 40,
  '',
  'x',
  'fetch',
  'a'.repeat(301),
  '00000000-0000-4000-8000-000000000768',
  'ISS-768',
  '2026-10-29T00:00:00Z',
  'https://forge.test/a',
  {},
  [],
  { a: 1 },
  ['x'],
];

/** Candidate values for one subschema: the generic pool plus every value the schema names. */
function candidates(s: Schema): unknown[] {
  const named: unknown[] = [];
  if ('const' in s) named.push(s.const);
  if (Array.isArray(s.enum)) named.push(...s.enum);
  if ('default' in s) named.push(s.default);
  return [...named, ...SCALARS];
}

/**
 * Inputs to judge `schema` by, built from the published schema itself: a value it accepts for each
 * subschema where the pool holds one, then that value with each property swapped for every
 * candidate, each required one removed, and an unnamed one added — so both sides of every keyword
 * the listing rewrote are reached.
 */
function samples(schema: Schema, judge: (s: Schema, v: unknown) => boolean, depth = 0): unknown[] {
  const out: unknown[] = [...candidates(schema)];
  const branches = [schema, ...((schema.oneOf ?? schema.anyOf ?? []) as Schema[])];
  for (const branch of branches) {
    const props = isPlain(branch.properties) ? (branch.properties as Record<string, Schema>) : null;
    if (props && depth < 4) {
      const pick: Record<string, unknown[]> = {};
      for (const [name, p] of Object.entries(props)) {
        const pool = samples(p, judge, depth + 1);
        pick[name] = pool;
      }
      const base: Schema = {};
      for (const [name, pool] of Object.entries(pick)) {
        const fits = pool.find((v) => judge(props[name] as Schema, v));
        if (fits !== undefined) base[name] = fits;
      }
      out.push(base);
      for (const [name, pool] of Object.entries(pick)) {
        for (const v of pool.slice(0, 40)) out.push({ ...base, [name]: v });
        const { [name]: _, ...without } = base;
        out.push(without);
      }
      out.push({ ...base, unnamed: 'x' }, { ...base, unnamed: { a: 1 } }, { ...base, '': true });
    }
    if (isPlain(branch.additionalProperties) && depth < 4) {
      for (const v of samples(branch.additionalProperties, judge, depth + 1).slice(0, 30))
        out.push({ k: v });
    }
    if (isPlain(branch.items) && depth < 4) {
      const pool = samples(branch.items, judge, depth + 1);
      out.push(pool.slice(0, 1), pool.slice(0, 3), pool.slice(0, 7));
    }
  }
  return out;
}

const strict = ajv(true);
const loose = ajv(false);

const compiled = new WeakMap<Schema, (v: unknown) => boolean>();
/** A published subschema's own validator, compiled once. */
function judgeBy(s: Schema): (v: unknown) => boolean {
  let check = compiled.get(s);
  if (!check) {
    const { $schema: _, ...bare } = s;
    const v = loose.compile(bare);
    check = (x) => v(x) === true;
    compiled.set(s, check);
  }
  return check;
}

describe('every tool tools/list serves', () => {
  it('lists the whole registry', () => {
    expect([...listing.keys()].sort()).toEqual(Object.keys(MCP_TOOLS).sort());
  });

  it.each([...listing.keys()])(
    '%s: its listing passes strict JSON Schema meta-validation and the subset rules',
    (name) => {
      const schema = listing.get(name) as Schema;
      expect(strict.validateSchema(schema), JSON.stringify(strict.errors)).toBe(true);
      expect(() => strict.compile(schema)).not.toThrow();
      expect(ruleBreaks(schema)).toEqual([]);
    },
  );

  it.each([...listing.keys()])(
    '%s: its listing accepts exactly the samples its published schema accepts',
    (name) => {
      const before = published.get(name) as Schema;
      const after = listing.get(name) as Schema;
      const oldCheck = loose.compile(before);
      const newCheck = loose.compile(after);
      const inputs = samples(before, (s, v) => judgeBy(s)(v));
      const differ = inputs.filter((v) => oldCheck(v) !== newCheck(v));
      expect(differ.map((v) => JSON.stringify(v)).slice(0, 5)).toEqual([]);
      // the samples reach both verdicts, or the comparison judged nothing
      expect(inputs.some((v) => oldCheck(v))).toBe(true);
      expect(inputs.some((v) => !oldCheck(v))).toBe(true);
    },
  );
});

describe('listedSchema, construct by construct', () => {
  const same = (before: Schema, inputs: unknown[]) => {
    const after = listedSchema('t', before);
    const a = loose.compile(before);
    const b = loose.compile(after);
    for (const v of inputs) expect(b(v), JSON.stringify(v)).toBe(a(v));
    expect(ruleBreaks(after)).toEqual([]);
    return after;
  };

  it('splits a type list into single-type branches, the object one given properties', () => {
    const after = same(
      {
        type: 'object',
        properties: {
          source: { type: ['string', 'object'], description: 'd', maxLength: 3 },
          rev: { type: ['integer', 'null'], minimum: 1 },
        },
        additionalProperties: false,
      },
      [
        { source: 'abc' },
        { source: 'abcd' },
        { source: {} },
        { source: 1 },
        { rev: null },
        { rev: 0 },
        { rev: 2 },
        { rev: 'x' },
      ],
    );
    expect((after.properties as Schema).source).toEqual({
      description: 'd',
      anyOf: [
        { type: 'string', maxLength: 3 },
        { type: 'object', properties: {} },
      ],
    });
  });

  it('turns const into a one-value enum and keeps the default beside it', () => {
    const after = same(
      {
        type: 'object',
        properties: { action: { type: 'string', const: 'fetch', default: 'fetch' } },
      },
      [{ action: 'fetch' }, { action: 'other' }, {}],
    );
    expect((after.properties as Schema).action).toEqual({
      type: 'string',
      enum: ['fetch'],
      default: 'fetch',
    });
  });

  it('drops a propertyNames that only says names are strings, and refuses one that says more', () => {
    same(
      {
        type: 'object',
        propertyNames: { type: 'string' },
        additionalProperties: { type: 'number' },
      },
      [{ a: 1 }, { a: 'x' }],
    );
    expect(() =>
      listedSchema('forge_x', { type: 'object', propertyNames: { pattern: '^a' } }),
    ).toThrow(/forge_x's input at \/propertyNames constrains property names beyond being strings/);
  });

  it('keeps a oneOf of objects, makes one of disjoint types an anyOf, and refuses one that overlaps', () => {
    const objects = {
      oneOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }],
    };
    expect(listedSchema('t', objects).oneOf).toBeDefined();
    const after = same(
      { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      ['x', ['x'], [1], 1],
    );
    expect(after.anyOf).toBeDefined();
    expect(() =>
      listedSchema('forge_y', { oneOf: [{ type: 'integer' }, { type: 'number' }] }),
    ).toThrow(
      /forge_y's input at \/oneOf holds branches that are not objects and could match one value together/,
    );
  });

  it('drops $schema and an empty required, and refuses a required that is not a list', () => {
    const after = same(
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {},
        required: [],
      },
      [{}, { a: 1 }, 1],
    );
    expect(after).toEqual({ type: 'object', properties: {} });
    expect(() => listedSchema('forge_z', { type: 'object', required: true })).toThrow(
      /forge_z's input at \/required is not a list of property names/,
    );
  });
});
