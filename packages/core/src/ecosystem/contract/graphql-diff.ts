import type { ChangeKind, ChangeLevel, MeasuredChange } from './diff.js';
import {
  isRootType,
  namedType,
  operationsOf,
  type SdlField,
  type SdlSchema,
  type SdlType,
} from './graphql-sdl.js';

export const GRAPHQL_RULES_VERSION = 'forge-graphql-1';

const CAP_REACHED = 1000;

type Push = (
  level: ChangeLevel,
  kind: ChangeKind,
  element: string,
  text: string,
  check: string,
) => void;

const unwrap = (t: string) => (t.endsWith('!') ? t.slice(0, -1) : t);
const isList = (t: string) => t.startsWith('[') && t.endsWith(']');

// cm:why an output may grow stricter (a nullable field becoming non-null keeps every reader working) and an input may grow looser; every other type change can break a caller, so it is breaking
function atLeastAsStrict(o: string, n: string): boolean {
  if (n.endsWith('!')) return atLeastAsStrict(unwrap(o), unwrap(n));
  if (o.endsWith('!')) return false;
  if (isList(o) && isList(n)) return atLeastAsStrict(o.slice(1, -1), n.slice(1, -1));
  return o === n;
}

const required = (a: { type: string; hasDefault?: boolean }) =>
  a.type.endsWith('!') && !a.hasDefault;

function compareArgs(el: string, o: SdlField, n: SdlField, push: Push): void {
  for (const [name, a] of o.args) {
    const b = n.args.get(name);
    const at = `${el}(${name})`;
    if (!b) push('breaking', 'removed', at, `argument ${name} was removed`, 'graphql-arg-removed');
    else if (a.type !== b.type) {
      const safe = atLeastAsStrict(b.type, a.type);
      push(
        safe ? 'info' : 'breaking',
        'changed',
        at,
        `argument ${name} is now ${b.type}, was ${a.type}`,
        'graphql-arg-type-changed',
      );
    }
  }
  for (const [name, b] of n.args) {
    if (o.args.has(name)) continue;
    const req = required(b);
    push(
      req ? 'breaking' : 'info',
      'added',
      `${el}(${name})`,
      `${req ? 'required ' : ''}argument ${name}: ${b.type} was added`,
      req ? 'graphql-arg-required-added' : 'graphql-arg-added',
    );
  }
}

function compareField(el: string, o: SdlField, n: SdlField, push: Push): void {
  if (o.type !== n.type) {
    push(
      atLeastAsStrict(o.type, n.type) ? 'info' : 'breaking',
      'changed',
      el,
      `the field is now ${n.type}, was ${o.type}`,
      'graphql-field-type-changed',
    );
  }
  if (!o.deprecated && n.deprecated) {
    push('info', 'deprecated', el, `${el} is deprecated`, 'graphql-deprecated');
  }
  compareArgs(el, o, n, push);
}

function compareInput(t: string, o: SdlType, n: SdlType, push: Push): void {
  for (const [name, f] of o.fields) {
    const g = n.fields.get(name);
    const el = `${t}.${name}`;
    if (!g)
      push(
        'breaking',
        'removed',
        el,
        `input field ${name} was removed`,
        'graphql-input-field-removed',
      );
    else if (f.type !== g.type) {
      push(
        atLeastAsStrict(g.type, f.type) ? 'info' : 'breaking',
        'changed',
        el,
        `input field ${name} is now ${g.type}, was ${f.type}`,
        'graphql-input-field-type-changed',
      );
    }
  }
  for (const [name, g] of n.fields) {
    if (o.fields.has(name)) continue;
    const req = required(g);
    push(
      req ? 'breaking' : 'info',
      'added',
      `${t}.${name}`,
      `${req ? 'required ' : ''}input field ${name}: ${g.type} was added`,
      req ? 'graphql-input-field-required-added' : 'graphql-input-field-added',
    );
  }
}

function compareType(o: SdlType, n: SdlType, push: Push): void {
  const t = o.name;
  if (o.kind !== n.kind) {
    push(
      'breaking',
      'changed',
      t,
      `${t} is now a ${n.kind}, was a ${o.kind}`,
      'graphql-type-kind-changed',
    );
    return;
  }
  if (o.kind === 'input') {
    compareInput(t, o, n, push);
    return;
  }
  if (o.kind === 'union') {
    for (const m of o.members) {
      if (!n.members.has(m))
        push(
          'breaking',
          'removed',
          t,
          `${m} is no longer a member of ${t}`,
          'graphql-union-member-removed',
        );
    }
    for (const m of n.members) {
      if (!o.members.has(m))
        push(
          'warning',
          'added',
          t,
          `${m} became a member of ${t}; a reader that switches on the member may not expect it`,
          'graphql-union-member-added',
        );
    }
    return;
  }
  for (const [name, f] of o.fields) {
    const g = n.fields.get(name);
    const el = `${t}.${name}`;
    if (!g) {
      const what = o.kind === 'enum' ? 'enum value' : 'field';
      push(
        'breaking',
        'removed',
        el,
        `${what} ${name} was removed`,
        o.kind === 'enum' ? 'graphql-enum-value-removed' : 'graphql-field-removed',
      );
    } else if (o.kind === 'enum') {
      if (!f.deprecated && g.deprecated)
        push('info', 'deprecated', el, `${el} is deprecated`, 'graphql-deprecated');
    } else compareField(el, f, g, push);
  }
  for (const name of n.fields.keys()) {
    if (o.fields.has(name)) continue;
    if (o.kind === 'enum') {
      push(
        'warning',
        'added',
        `${t}.${name}`,
        `enum value ${name} was added; a reader that switches on ${t} may not expect it`,
        'graphql-enum-value-added',
      );
    } else push('info', 'added', `${t}.${name}`, `field ${name} was added`, 'graphql-field-added');
  }
}

/** Where each type is reached from one operation: the shortest field path to it, and the arguments taking an input type. */
interface Reach {
  types: Map<string, string[]>;
  inputs: Map<string, string>;
}

function inputClosure(schema: SdlSchema, root: string): Set<string> {
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length) {
    const name = queue.shift() as string;
    const t = schema.types.get(name);
    if (seen.has(name) || t?.kind !== 'input') continue;
    seen.add(name);
    for (const f of t.fields.values()) queue.push(namedType(f.type));
  }
  return seen;
}

const pathOf = (op: string, path: readonly string[]) => [op, ...path].join('.');

function reachOf(schema: SdlSchema, op: string, field: SdlField): Reach {
  const types = new Map<string, string[]>();
  const inputs = new Map<string, string>();
  const closures = new Map<string, Set<string>>();
  const argsAt = (at: string, f: SdlField) => {
    for (const a of f.args.values()) {
      const named = namedType(a.type);
      const closure = closures.get(named) ?? inputClosure(schema, named);
      closures.set(named, closure);
      for (const i of closure) if (!inputs.has(i)) inputs.set(i, `${at}(${a.name})`);
    }
  };
  argsAt(op, field);
  const implementors = (i: string) =>
    [...schema.types.values()].filter((t) => t.interfaces.has(i)).map((t) => t.name);
  const queue: [string, string[]][] = [[namedType(field.type), []]];
  while (queue.length) {
    const [name, path] = queue.shift() as [string, string[]];
    if (types.has(name)) continue;
    types.set(name, path);
    const t = schema.types.get(name);
    if (!t) continue;
    if (t.kind === 'union') for (const m of t.members) queue.push([m, path]);
    if (t.kind === 'interface') for (const m of implementors(name)) queue.push([m, path]);
    if (t.kind !== 'object' && t.kind !== 'interface') continue;
    for (const f of t.fields.values()) {
      argsAt(pathOf(op, [...path, f.name]), f);
      queue.push([namedType(f.type), [...path, f.name]]);
    }
  }
  return { types, inputs };
}

const TYPE_LEVEL =
  /^([_A-Za-z][_0-9A-Za-z]*)(?:\.([_A-Za-z][_0-9A-Za-z]*))?(?:\(([_A-Za-z][_0-9A-Za-z]*)\))?$/;

// cm:why a change to a type is read by a consumer through the operations it calls, so each breaking type-level change is also named once per operation that reaches it, as `Query.op.field.path`; impact matches a link's fields-used against those paths
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
    const owner = schema.types.get(typeName);
    for (const { element: op, reach } of ops) {
      if (out.length >= CAP_REACHED) return out;
      let at: string | undefined;
      if (owner?.kind === 'input') at = reach.inputs.get(typeName);
      else {
        const path = reach.types.get(typeName);
        if (!path) continue;
        const enumOrWhole = owner?.kind === 'enum' || owner?.kind === 'union' || !member;
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

export function diffGraphql(o: SdlSchema, n: SdlSchema): MeasuredChange[] {
  const out: MeasuredChange[] = [];
  const push: Push = (level, kind, element, text, check) =>
    out.push({ element, kind, level, text, check });
  const oldOps = new Map(operationsOf(o).map((x) => [x.element, x.field]));
  const newOps = new Map(operationsOf(n).map((x) => [x.element, x.field]));
  for (const [el, f] of oldOps) {
    const g = newOps.get(el);
    if (!g)
      push('breaking', 'removed', el, `operation ${el} was removed`, 'graphql-operation-removed');
    else compareField(el, f, g, push);
  }
  for (const el of newOps.keys()) {
    if (!oldOps.has(el))
      push('info', 'added', el, `operation ${el} was added`, 'graphql-operation-added');
  }
  for (const [name, t] of o.types) {
    if (isRootType(o, name)) continue;
    const next = n.types.get(name);
    if (!next)
      push('breaking', 'removed', name, `type ${name} was removed`, 'graphql-type-removed');
    else if (!isRootType(n, name)) compareType(t, next, push);
  }
  for (const name of n.types.keys()) {
    if (!o.types.has(name) && !isRootType(n, name)) {
      push('info', 'added', name, `type ${name} was added`, 'graphql-type-added');
    }
  }
  return [...out, ...reached(o, out)];
}
