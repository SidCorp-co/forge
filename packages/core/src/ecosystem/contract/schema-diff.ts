import { isDeepStrictEqual } from 'node:util';
import type { ChangeKind, ChangeLevel, MeasuredChange } from './diff.js';

export const SCHEMA_RULES_VERSION = 'forge-narrow-1';

type Schema = Record<string, unknown> | boolean;

const ANNOTATIONS = new Set([
  'description',
  'title',
  '$comment',
  'examples',
  '$schema',
  '$id',
  'readOnly',
  'writeOnly',
]);
const LOWER_BOUNDS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'];
const UPPER_BOUNDS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'];
const MODELLED = new Set([
  ...ANNOTATIONS,
  ...LOWER_BOUNDS,
  ...UPPER_BOUNDS,
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'pattern',
  'format',
  'default',
  'deprecated',
  'uniqueItems',
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');

function typesOf(s: Record<string, unknown>): Set<string> | null {
  const t = s.type;
  if (typeof t === 'string') return new Set([t]);
  if (Array.isArray(t)) return new Set(t.map(String));
  return null;
}

const accepts = (types: Set<string>, t: string) =>
  types.has(t) || (t === 'integer' && types.has('number'));

interface Out {
  element: string;
  push(level: ChangeLevel, kind: ChangeKind, at: string, text: string, check: string): void;
}

function sink(element: string, into: MeasuredChange[]): Out {
  return {
    element,
    push: (level, kind, at, text, check) =>
      into.push({ element, kind, level, text: `${at || '/'}: ${text} (BACKWARD)`, check }),
  };
}

function typeRule(o: Record<string, unknown>, n: Record<string, unknown>, at: string, out: Out) {
  const [ot, nt] = [typesOf(o), typesOf(n)];
  if (ot && nt) {
    for (const t of ot) {
      if (!accepts(nt, t))
        out.push('breaking', 'changed', at, `type ${t} is no longer accepted`, 'type-narrowed');
    }
    for (const t of nt)
      if (!accepts(ot, t))
        out.push('info', 'changed', at, `type ${t} is now accepted`, 'type-widened');
  } else if (!ot && nt) {
    out.push(
      'breaking',
      'changed',
      at,
      `a value of any type was accepted and now only ${[...nt].join(' | ')} is`,
      'type-narrowed',
    );
  } else if (ot && !nt) {
    out.push('info', 'changed', at, 'a value of any type is now accepted', 'type-widened');
  }
}

function valueRules(o: Record<string, unknown>, n: Record<string, unknown>, at: string, out: Out) {
  const [oe, ne] = [o.enum, n.enum];
  if (Array.isArray(oe) && Array.isArray(ne)) {
    for (const v of oe)
      if (!ne.some((x) => isDeepStrictEqual(x, v)))
        out.push(
          'breaking',
          'changed',
          at,
          `enum value ${JSON.stringify(v)} was removed`,
          'enum-value-removed',
        );
    for (const v of ne)
      if (!oe.some((x) => isDeepStrictEqual(x, v)))
        out.push(
          'info',
          'changed',
          at,
          `enum value ${JSON.stringify(v)} was added`,
          'enum-value-added',
        );
  } else if (!Array.isArray(oe) && Array.isArray(ne)) {
    out.push('breaking', 'changed', at, 'the value is now restricted to an enum', 'enum-added');
  } else if (Array.isArray(oe) && !Array.isArray(ne)) {
    out.push('info', 'changed', at, 'the enum was lifted', 'enum-removed');
  }
  if (!isDeepStrictEqual(o.const, n.const)) {
    if (n.const === undefined)
      out.push('info', 'changed', at, 'the const was lifted', 'const-removed');
    else
      out.push(
        'breaking',
        'changed',
        at,
        `the value must now be ${JSON.stringify(n.const)}`,
        'const-changed',
      );
  }
  for (const k of LOWER_BOUNDS) boundRule(k, o[k], n[k], (a, b) => b > a, at, out);
  for (const k of UPPER_BOUNDS) boundRule(k, o[k], n[k], (a, b) => b < a, at, out);
  if (o.uniqueItems !== true && n.uniqueItems === true)
    out.push('breaking', 'changed', at, 'items must now be unique', 'unique-items-added');
  for (const k of ['pattern', 'format'] as const) {
    if (isDeepStrictEqual(o[k], n[k])) continue;
    if (n[k] === undefined) out.push('info', 'changed', at, `the ${k} was lifted`, `${k}-removed`);
    else
      out.push(
        'warning',
        'changed',
        at,
        `the ${k} is now ${JSON.stringify(n[k])}; whether it accepts every value the old one did is not decidable here`,
        `${k}-changed`,
      );
  }
  if (!isDeepStrictEqual(o.default, n.default))
    out.push('info', 'changed', at, 'the default changed', 'default-changed');
  if (o.deprecated !== true && n.deprecated === true)
    out.push('info', 'deprecated', at, 'deprecated', 'deprecated');
}

function boundRule(
  k: string,
  a: unknown,
  b: unknown,
  tighter: (a: number, b: number) => boolean,
  at: string,
  out: Out,
) {
  if (a === b) return;
  if (typeof b !== 'number') {
    if (typeof a === 'number')
      out.push('info', 'changed', at, `${k} ${a} was lifted`, `${k}-removed`);
    return;
  }
  if (typeof a !== 'number' || tighter(a, b))
    out.push(
      'breaking',
      'changed',
      at,
      `${k} is now ${b}${typeof a === 'number' ? `, was ${a}` : ''}`,
      `${k}-narrowed`,
    );
  else out.push('info', 'changed', at, `${k} is now ${b}, was ${a}`, `${k}-widened`);
}

function objectRules(o: Record<string, unknown>, n: Record<string, unknown>, at: string, out: Out) {
  const op = isObject(o.properties) ? o.properties : {};
  const np = isObject(n.properties) ? n.properties : {};
  const oreq = new Set(Array.isArray(o.required) ? o.required.map(String) : []);
  const nreq = new Set(Array.isArray(n.required) ? n.required.map(String) : []);
  const [oClosed, nClosed] = [o.additionalProperties === false, n.additionalProperties === false];
  for (const k of new Set([...Object.keys(op), ...Object.keys(np)])) {
    const p = `${at}/properties/${esc(k)}`;
    if (!(k in np)) {
      if (nClosed)
        out.push(
          'breaking',
          'removed',
          p,
          `property ${k} was removed from a closed object, which now refuses it`,
          'property-removed',
        );
      else
        out.push(
          'warning',
          'removed',
          p,
          `property ${k} was removed; the open object still accepts it, and what it now means is not measured`,
          'property-removed-open',
        );
    } else if (!(k in op)) {
      if (nreq.has(k))
        out.push(
          'breaking',
          'added',
          p,
          `required property ${k} was added`,
          'required-property-added',
        );
      else if (oClosed)
        out.push('info', 'added', p, `optional property ${k} was added`, 'optional-property-added');
      else
        out.push(
          'warning',
          'added',
          p,
          `optional property ${k} was added to an open object, which may have carried it as anything`,
          'optional-property-added-open',
        );
    } else {
      compareSchemas(op[k] as Schema, np[k] as Schema, p, out);
      if (!oreq.has(k) && nreq.has(k))
        out.push(
          'breaking',
          'changed',
          p,
          `property ${k} is now required`,
          'property-became-required',
        );
      if (oreq.has(k) && !nreq.has(k))
        out.push(
          'info',
          'changed',
          p,
          `property ${k} is no longer required`,
          'property-became-optional',
        );
    }
  }
  for (const k of nreq) {
    if (!(k in np) && !oreq.has(k))
      out.push('breaking', 'changed', at, `${k} is now required`, 'property-became-required');
  }
  const [oa, na] = [o.additionalProperties, n.additionalProperties];
  if (!oClosed && nClosed)
    out.push(
      'breaking',
      'changed',
      at,
      'the object is now closed to properties it does not name',
      'object-closed',
    );
  else if (oClosed && !nClosed && na !== undefined && na !== true && !isObject(na)) return;
  else if (oClosed && !nClosed)
    out.push(
      'info',
      'changed',
      at,
      'the object now accepts properties it does not name',
      'object-opened',
    );
  else if (isObject(oa) || isObject(na))
    compareSchemas(
      (oa ?? true) as Schema,
      (na ?? true) as Schema,
      `${at}/additionalProperties`,
      out,
    );
}

export function compareSchemas(o: Schema, n: Schema, at: string, out: Out): void {
  if (isDeepStrictEqual(o, n)) return;
  if (typeof o === 'boolean' || typeof n === 'boolean') {
    if (n === true || o === false)
      out.push('info', 'changed', at, 'the schema now accepts more', 'schema-widened');
    else if (n === false)
      out.push('breaking', 'changed', at, 'the schema now accepts nothing', 'schema-false');
    else
      out.push(
        'warning',
        'changed',
        at,
        'a schema now constrains a value any schema accepted',
        'schema-constrained',
      );
    return;
  }
  const unmodelled = new Set(
    [...Object.keys(o), ...Object.keys(n)].filter((k) => !MODELLED.has(k)),
  );
  const undecided = [...unmodelled].filter((k) => !isDeepStrictEqual(o[k], n[k])).sort();
  if (undecided.length > 0) {
    out.push(
      'warning',
      'changed',
      at,
      `${undecided.join(', ')} changed, which the narrow rules do not decide`,
      'undecidable-keyword',
    );
    return;
  }
  typeRule(o, n, at, out);
  valueRules(o, n, at, out);
  objectRules(o, n, at, out);
  if (o.items !== undefined || n.items !== undefined) {
    compareSchemas((o.items ?? true) as Schema, (n.items ?? true) as Schema, `${at}/items`, out);
  }
}

export function diffSchema(element: string, o: unknown, n: unknown): MeasuredChange[] {
  const into: MeasuredChange[] = [];
  compareSchemas(o as Schema, n as Schema, '', sink(element, into));
  return into;
}

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export function toolsOf(doc: unknown): Map<string, ListedTool> | null {
  if (!isObject(doc) || !Array.isArray(doc.tools)) return null;
  const tools = new Map<string, ListedTool>();
  for (const t of doc.tools) {
    if (!isObject(t) || typeof t.name !== 'string' || !isObject(t.inputSchema)) return null;
    tools.set(t.name, t as unknown as ListedTool);
  }
  return tools;
}

export function diffMcpTools(
  o: Map<string, ListedTool>,
  n: Map<string, ListedTool>,
): MeasuredChange[] {
  const out: MeasuredChange[] = [];
  for (const [name, tool] of o) {
    const next = n.get(name);
    if (!next) {
      out.push({
        element: name,
        kind: 'removed',
        level: 'breaking',
        text: `tool ${name} was removed`,
        check: 'tool-removed',
      });
      continue;
    }
    if (tool.description !== next.description)
      out.push({
        element: name,
        kind: 'changed',
        level: 'info',
        text: 'the description changed',
        check: 'tool-description-changed',
      });
    out.push(...diffSchema(name, tool.inputSchema, next.inputSchema));
  }
  for (const name of n.keys()) {
    if (!o.has(name))
      out.push({
        element: name,
        kind: 'added',
        level: 'info',
        text: `tool ${name} was added`,
        check: 'tool-added',
      });
  }
  return out;
}

export function jsonSchemaElements(doc: unknown): string[] {
  const defs = isObject(doc) && isObject(doc.$defs) ? Object.keys(doc.$defs) : [];
  return ['#', ...defs.map((k) => `#/$defs/${esc(k)}`)];
}

const withoutDefs = (s: unknown): unknown => {
  if (!isObject(s)) return s;
  const { $defs: _defs, ...rest } = s;
  return rest;
};

export function diffJsonSchema(o: unknown, n: unknown): MeasuredChange[] {
  const out = diffSchema('#', withoutDefs(o), withoutDefs(n));
  const [od, nd] = [o, n].map((s) => (isObject(s) && isObject(s.$defs) ? s.$defs : {})) as [
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  for (const k of new Set([...Object.keys(od), ...Object.keys(nd)])) {
    const element = `#/$defs/${esc(k)}`;
    if (!(k in nd)) {
      out.push({
        element,
        kind: 'removed',
        level: 'breaking',
        text: `definition ${k} was removed`,
        check: 'definition-removed',
      });
    } else if (!(k in od)) {
      out.push({
        element,
        kind: 'added',
        level: 'info',
        text: `definition ${k} was added`,
        check: 'definition-added',
      });
    } else {
      out.push(...diffSchema(element, od[k], nd[k]));
    }
  }
  return out;
}
