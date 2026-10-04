import { type Change, CriticalityLevel, diff } from '@graphql-inspector/core';
import {
  type GraphQLNamedType,
  getNamedType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isUnionType,
} from 'graphql';
import type { ChangeKind, ChangeLevel, MeasuredChange } from './diff.js';
import { operationsOf, type SdlField, type SdlSchema } from './graphql-sdl.js';

export const GRAPHQL_RULES_VERSION = 'graphql-inspector-8';

const CAP_REACHED = 1000;

const LEVEL: Record<CriticalityLevel, ChangeLevel> = {
  [CriticalityLevel.Breaking]: 'breaking',
  [CriticalityLevel.Dangerous]: 'warning',
  [CriticalityLevel.NonBreaking]: 'info',
};

function kindOf(type: string): ChangeKind {
  if (/DEPRECATION(_REASON)?_ADDED$/.test(type)) return 'deprecated';
  if (type.endsWith('_REMOVED')) return 'removed';
  if (type.endsWith('_ADDED')) return 'added';
  return 'changed';
}

/** An argument is named `Type.field(arg)`, the shape the element index and impact read; inspector paths join it with a dot. */
function elementOf(c: Change): string {
  const parts = (c.path ?? '').split('.').filter(Boolean);
  if (c.type.startsWith('FIELD_ARGUMENT_') && parts.length === 3) {
    return `${parts[0]}.${parts[1]}(${parts[2]})`;
  }
  return parts.length > 0 ? parts.join('.') : 'document';
}

/** A description edit binds no caller, and an applied `@deprecated` is already reported as the deprecation itself. */
const ignored = (c: Change) =>
  c.type.includes('_DESCRIPTION_') ||
  (c.type.startsWith('DIRECTIVE_USAGE_') && (c.path ?? '').includes('@deprecated'));

const toMeasured = (c: Change): MeasuredChange => ({
  element: elementOf(c),
  kind: kindOf(c.type),
  level: LEVEL[c.criticality.level],
  text: c.message,
  check: `graphql-${c.type.toLowerCase().replace(/_/g, '-')}`,
});

/** Where each type is reached from one operation: the shortest field path to it, and the arguments taking an input type. */
interface Reach {
  types: Map<string, string[]>;
  inputs: Map<string, string>;
}

function inputClosure(root: GraphQLNamedType): Set<string> {
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length) {
    const t = queue.shift() as GraphQLNamedType;
    if (seen.has(t.name) || !isInputObjectType(t)) continue;
    seen.add(t.name);
    for (const f of Object.values(t.getFields())) queue.push(getNamedType(f.type));
  }
  return seen;
}

const pathOf = (op: string, path: readonly string[]) => [op, ...path].join('.');

function reachOf(schema: SdlSchema, op: string, field: SdlField): Reach {
  const types = new Map<string, string[]>();
  const inputs = new Map<string, string>();
  const argsAt = (at: string, f: SdlField) => {
    for (const a of f.args) {
      for (const i of inputClosure(getNamedType(a.type))) {
        if (!inputs.has(i)) inputs.set(i, `${at}(${a.name})`);
      }
    }
  };
  argsAt(op, field);
  const queue: [GraphQLNamedType, string[]][] = [[getNamedType(field.type), []]];
  while (queue.length) {
    const [t, path] = queue.shift() as [GraphQLNamedType, string[]];
    if (types.has(t.name)) continue;
    types.set(t.name, path);
    if (isUnionType(t)) for (const m of t.getTypes()) queue.push([m, path]);
    if (isInterfaceType(t)) {
      const { objects, interfaces } = schema.getImplementations(t);
      for (const m of [...objects, ...interfaces]) queue.push([m, path]);
    }
    if (!isObjectType(t) && !isInterfaceType(t)) continue;
    for (const f of Object.values(t.getFields())) {
      argsAt(pathOf(op, [...path, f.name]), f);
      queue.push([getNamedType(f.type), [...path, f.name]]);
    }
  }
  return { types, inputs };
}

const TYPE_LEVEL =
  /^([_A-Za-z][_0-9A-Za-z]*)(?:\.([_A-Za-z][_0-9A-Za-z]*))?(?:\(([_A-Za-z][_0-9A-Za-z]*)\))?$/;

/** A consumer reads a type through the operations it calls, so each breaking type-level change is also named once per operation that reaches it, as `Query.op.field.path`; impact matches a link's fields-used against those paths. */
function reached(schema: SdlSchema, changes: readonly MeasuredChange[]): MeasuredChange[] {
  const breaking = changes.filter(
    (c) => c.level === 'breaking' && !/^(Query|Mutation|Subscription)\./.test(c.element),
  );
  if (breaking.length === 0) return [];
  const ops = operationsOf(schema).map((o) => ({
    ...o,
    reach: reachOf(schema, o.element, o.field),
  }));
  const out: MeasuredChange[] = [];
  for (const c of breaking) {
    const m = TYPE_LEVEL.exec(c.element);
    if (!m) continue;
    const [, typeName = '', member, arg] = m;
    const owner = schema.getType(typeName);
    for (const { element: op, reach } of ops) {
      if (out.length >= CAP_REACHED) return out;
      let at: string | undefined;
      if (owner && isInputObjectType(owner)) at = reach.inputs.get(typeName);
      else {
        const path = reach.types.get(typeName);
        if (!path) continue;
        const enumOrWhole = !owner || !(isObjectType(owner) || isInterfaceType(owner)) || !member;
        at = enumOrWhole
          ? pathOf(op, path)
          : `${pathOf(op, [...path, member])}${arg ? `(${arg})` : ''}`;
      }
      if (!at) continue;
      out.push({
        ...c,
        element: at,
        text: `${c.text} (${c.element}, reached through ${op})`,
        check: `${c.check ?? 'graphql'}-reached`,
      });
    }
  }
  return out;
}

export async function diffGraphql(o: SdlSchema, n: SdlSchema): Promise<MeasuredChange[]> {
  const out = (await diff(o, n)).filter((c) => !ignored(c)).map(toMeasured);
  return [...out, ...reached(o, out)];
}
