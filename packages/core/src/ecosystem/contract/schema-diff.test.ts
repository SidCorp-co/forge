import { describe, expect, it } from 'vitest';
import { classify, measured } from './diff.js';
import { diffJsonSchema, diffMcpTools, diffSchema, toolsOf } from './schema-diff.js';

const closed = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const BASE = closed(
  {
    id: { type: 'string', format: 'uuid' },
    state: { type: 'string', enum: ['open', 'closed'] },
    note: { type: 'string', minLength: 1, maxLength: 100 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
  },
  ['id'],
);

// biome-ignore lint/suspicious/noExplicitAny: a schema is edited at arbitrary depth
type S = any;

const edit = (fn: (s: S) => void) => {
  const s = structuredClone(BASE) as S;
  fn(s);
  return s;
};

const checks = (o: unknown, n: unknown) =>
  diffSchema('forge_x', o, n).map((c) => `${c.level}:${c.check}`);

describe('the narrow JSON Schema rules, read BACKWARD: does the new schema accept every value the old one did', () => {
  it.each([
    [
      'a required field added',
      (s: S) => {
        s.properties.policy = { type: 'string' };
        s.required.push('policy');
      },
      'breaking:required-property-added',
    ],
    [
      'a field removed from a closed object',
      (s: S) => delete s.properties.note,
      'breaking:property-removed',
    ],
    ['a type narrowed', (s: S) => (s.properties.note.type = 'integer'), 'breaking:type-narrowed'],
    [
      'an enum narrowed',
      (s: S) => (s.properties.state.enum = ['open']),
      'breaking:enum-value-removed',
    ],
    [
      'an optional field made required',
      (s: S) => s.required.push('note'),
      'breaking:property-became-required',
    ],
    [
      'a maximum lowered',
      (s: S) => (s.properties.note.maxLength = 50),
      'breaking:maxLength-narrowed',
    ],
    ['a minimum added', (s: S) => (s.properties.tags.minItems = 1), 'breaking:minItems-narrowed'],
    [
      'an item type narrowed',
      (s: S) => (s.properties.tags.items = { type: 'integer' }),
      'breaking:type-narrowed',
    ],
  ])('%s is breaking', (_name, mutate, check) => {
    const n = edit(mutate as (s: S) => void);
    expect(checks(BASE, n)).toContain(check);
    expect(classify(diffSchema('t', BASE, n))).toBe('breaking');
  });

  it('closing an open object is breaking and opening a closed one is not', () => {
    const open = { ...structuredClone(BASE), additionalProperties: true };
    expect(checks(open, BASE)).toContain('breaking:object-closed');
    expect(checks(BASE, open)).toContain('info:object-opened');
    expect(classify(diffSchema('t', BASE, open))).toBe('non-breaking');
  });

  it.each([
    [
      'an optional field added to a closed object',
      (s: S) => (s.properties.extra = { type: 'string' }),
      'info:optional-property-added',
    ],
    ['an enum widened', (s: S) => s.properties.state.enum.push('merged'), 'info:enum-value-added'],
    ['a maximum raised', (s: S) => (s.properties.note.maxLength = 500), 'info:maxLength-widened'],
    [
      'a required field made optional',
      (s: S) => (s.required = []),
      'info:property-became-optional',
    ],
    [
      'a type widened',
      (s: S) => (s.properties.note.type = ['string', 'null']),
      'info:type-widened',
    ],
    ['a description edited', (s: S) => (s.properties.note.description = 'words'), null],
  ])('%s is non-breaking', (_name, mutate, check) => {
    const n = edit(mutate as (s: S) => void);
    if (check) expect(checks(BASE, n)).toContain(check);
    expect(classify(diffSchema('t', BASE, n))).toBe('non-breaking');
  });

  it.each([
    [
      'a pattern changed',
      (s: S) => (s.properties.note.pattern = '^[a-z]+$'),
      'warning:pattern-changed',
    ],
    ['a format changed', (s: S) => (s.properties.id.format = 'email'), 'warning:format-changed'],
    [
      'a union rewritten',
      (s: S) => (s.properties.note = { anyOf: [{ type: 'string' }, { type: 'null' }] }),
      'warning:undecidable-keyword',
    ],
    [
      'a field removed from an open object',
      (s: S) => {
        s.additionalProperties = undefined;
        delete s.additionalProperties;
        delete s.properties.note;
      },
      'warning:property-removed-open',
    ],
    [
      'a keyword the rules do not model',
      (s: S) => (s.properties.note.contentMediaType = 'text/html'),
      'warning:undecidable-keyword',
    ],
  ])('%s is undecidable, so unknown and never non-breaking', (_name, mutate, check) => {
    const n = edit(mutate as (s: S) => void);
    expect(checks(BASE, n)).toContain(check);
    expect(classify(diffSchema('t', BASE, n))).toBe('unknown');
  });

  it('an identical schema measures no change', () => {
    expect(diffSchema('t', BASE, structuredClone(BASE))).toEqual([]);
  });

  it('a schema that now accepts nothing is breaking, and true where an object stood is wider', () => {
    expect(checks(BASE, false)).toEqual(['breaking:schema-false']);
    expect(checks(BASE, true)).toEqual(['info:schema-widened']);
  });

  it('names the pointer of each change, so the reader finds the field', () => {
    const n = edit((s: S) => (s.properties.tags.items = { type: 'integer' }));
    expect(diffSchema('forge_x', BASE, n)[0]?.text).toMatch(
      /^\/properties\/tags\/items: type string/,
    );
  });
});

describe('the tools contract: each tool is an element and its input schema is diffed', () => {
  const tools = (list: object[]) => {
    const t = toolsOf({ tools: list });
    if (!t) throw new Error('fixture is not a tools list');
    return t;
  };
  const tool = (name: string, inputSchema: object = BASE) => ({
    name,
    description: 'd',
    inputSchema,
  });

  it('a removed tool is breaking and an added one is info', () => {
    const out = diffMcpTools(
      tools([tool('forge_a'), tool('forge_b')]),
      tools([tool('forge_a'), tool('forge_c')]),
    );
    expect(out.map((c) => `${c.element}:${c.level}:${c.kind}`).sort()).toEqual([
      'forge_b:breaking:removed',
      'forge_c:info:added',
    ]);
  });

  it('a change inside one tool is reported against that tool', () => {
    const narrowed = edit((s: S) => (s.properties.state.enum = ['open']));
    const out = diffMcpTools(tools([tool('forge_a')]), tools([tool('forge_a', narrowed)]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      element: 'forge_a',
      level: 'breaking',
      check: 'enum-value-removed',
    });
  });

  it('refuses to read a tools list whose entry has no object input schema', () => {
    expect(toolsOf({ tools: [{ name: 'x', inputSchema: 'any' }] })).toBeNull();
    expect(toolsOf({ notTools: [] })).toBeNull();
  });
});

describe('a json-schema contract names a change by the definition it is in', () => {
  it('reports a change under $defs against that definition', () => {
    const o = { $defs: { step: closed({ name: { type: 'string' } }) } };
    const n = { $defs: { step: closed({ name: { type: 'integer' } }) } };
    const out = diffJsonSchema(o, n);
    expect(new Set(out.map((c) => c.element))).toEqual(new Set(['#/$defs/step']));
    expect(classify(out)).toBe('breaking');
    const gone = diffJsonSchema(o, { $defs: {} });
    expect(gone).toMatchObject([{ element: '#/$defs/step', level: 'breaking', kind: 'removed' }]);
  });
});

describe('a diff is classified over every change and keeps at most 500', () => {
  it('cuts info first and says how many it dropped, keeping the classification of the whole', () => {
    const many = Array.from({ length: 600 }, (_, i) => ({
      element: `t${i}`,
      kind: 'added' as const,
      level: 'info' as const,
      text: 'added',
    }));
    const d = measured('json-schema-diff', 'x', [
      ...many,
      { element: 'gone', kind: 'removed', level: 'breaking', text: 'removed' },
    ]);
    expect(d.classification).toBe('breaking');
    expect(d.changes).toHaveLength(500);
    expect(d.changes[0]?.element).toBe('gone');
    expect(d.changes.at(-1)?.text).toMatch(/^102 further change/);
  });
});
