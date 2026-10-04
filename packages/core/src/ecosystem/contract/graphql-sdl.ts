/** A strict reader for the GraphQL type-system subset a contract publishes; no `graphql` package is a dependency of this workspace. */

import type { RefusalError } from '../../lib/refusal.js';
import { refuseEcosystem } from '../refusals.js';

export type RootRole = 'query' | 'mutation' | 'subscription';

export const ROOT_NAME: Record<RootRole, string> = {
  query: 'Query',
  mutation: 'Mutation',
  subscription: 'Subscription',
};

export interface SdlArg {
  name: string;
  type: string;
  hasDefault: boolean;
  deprecated: boolean;
}

export interface SdlField {
  name: string;
  type: string;
  args: Map<string, SdlArg>;
  deprecated: boolean;
  /** An input field's default, which keeps a non-null input optional to send. */
  hasDefault?: boolean;
}

export type SdlKind = 'object' | 'interface' | 'input' | 'enum' | 'scalar' | 'union';

export interface SdlType {
  kind: SdlKind;
  name: string;
  fields: Map<string, SdlField>;
  members: Set<string>;
  interfaces: Set<string>;
}

export interface SdlSchema {
  roots: Partial<Record<RootRole, string>>;
  types: Map<string, SdlType>;
}

const sdlUnreadable = (why: string) =>
  refuseEcosystem('ARTIFACT_UNREADABLE', `a graphql artifact is SDL text, and ${why}`, '/artifact');

type Token = { kind: 'punct' | 'name' | 'string' | 'number' | 'eof'; value: string; at: number };

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);
const NAME = /[_A-Za-z][_0-9A-Za-z]*/y;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function lex(text: string): Token[] {
  const out: Token[] = [];
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
    } else if (c === '#') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
    } else if (PUNCT.has(c)) {
      out.push({ kind: 'punct', value: c, at: i++ });
    } else if (text.startsWith('...', i)) {
      throw unreadable(text, i, 'a spread belongs to an operation, not to a type definition');
    } else if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      if (end < 0) throw unreadable(text, i, 'a block string is never closed');
      out.push({ kind: 'string', value: text.slice(i + 3, end), at: i });
      i = end + 3;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\n' || text[j] === '\r')
          throw unreadable(text, i, 'a string runs past its line');
        j += text[j] === '\\' ? 2 : 1;
      }
      if (j >= text.length) throw unreadable(text, i, 'a string is never closed');
      out.push({ kind: 'string', value: text.slice(i + 1, j), at: i });
      i = j + 1;
    } else {
      NAME.lastIndex = i;
      NUMBER.lastIndex = i;
      const name = NAME.exec(text);
      const num = name ? null : NUMBER.exec(text);
      const hit = name ?? num;
      if (!hit) throw unreadable(text, i, `${JSON.stringify(c)} is not a GraphQL character here`);
      out.push({ kind: name ? 'name' : 'number', value: hit[0], at: i });
      i += hit[0].length;
    }
  }
  out.push({ kind: 'eof', value: '', at: text.length });
  return out;
}

function unreadable(text: string, at: number, why: string): RefusalError {
  const before = text.slice(0, at);
  const line = before.split(/\r\n|\r|\n/).length;
  const col = at - Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
  return sdlUnreadable(`the SDL does not parse at ${line}:${col}: ${why}`);
}

const DEFINITIONS = new Set([
  'schema',
  'scalar',
  'type',
  'interface',
  'union',
  'enum',
  'input',
  'directive',
]);

const KIND_OF: Record<string, SdlKind> = {
  type: 'object',
  interface: 'interface',
  input: 'input',
  enum: 'enum',
  scalar: 'scalar',
  union: 'union',
};

interface Pending {
  keyword: string;
  type: SdlType;
  extend: boolean;
  at: number;
}

class Parser {
  private i = 0;
  readonly roots: Partial<Record<RootRole, string>> = {};
  readonly defs: Pending[] = [];

  constructor(
    private readonly text: string,
    private readonly tokens: Token[],
  ) {}

  private get t(): Token {
    return this.tokens[this.i] as Token;
  }

  private fail(why: string, at = this.t.at): never {
    throw unreadable(this.text, at, why);
  }

  private peek(value: string): boolean {
    return this.t.kind === 'punct' && this.t.value === value;
  }

  private skip(value: string): boolean {
    if (!this.peek(value)) return false;
    this.i++;
    return true;
  }

  private expect(value: string): void {
    if (!this.skip(value)) this.fail(`expected "${value}", found ${this.shown()}`);
  }

  private shown(): string {
    return this.t.kind === 'eof' ? 'the end of the text' : JSON.stringify(this.t.value);
  }

  private name(what: string): string {
    if (this.t.kind !== 'name') this.fail(`expected ${what}, found ${this.shown()}`);
    return (this.tokens[this.i++] as Token).value;
  }

  private description(): void {
    if (this.t.kind === 'string') this.i++;
  }

  parse(): void {
    while (this.t.kind !== 'eof') this.definition();
  }

  private definition(): void {
    this.description();
    const at = this.t.at;
    const extend = this.t.kind === 'name' && this.t.value === 'extend';
    if (extend) this.i++;
    const keyword = this.t.kind === 'name' ? this.t.value : '';
    if (!DEFINITIONS.has(keyword) || (extend && keyword === 'directive')) {
      this.fail(
        `an SDL holds type-system definitions (schema, type, interface, input, enum, union, scalar, directive); ${this.shown()} is not one, and an operation document is not a contract`,
      );
    }
    this.i++;
    if (keyword === 'schema' || keyword === 'directive') {
      if (keyword === 'schema') this.schema();
      else this.directiveDefinition();
      return;
    }
    const type: SdlType = {
      kind: KIND_OF[keyword] as SdlKind,
      name: this.name(`a ${keyword} name`),
      fields: new Map(),
      members: new Set(),
      interfaces: new Set(),
    };
    if (keyword === 'type' || keyword === 'interface') this.implementsList(type);
    this.directives();
    if (keyword === 'type' || keyword === 'interface') this.fieldsBlock(type);
    else if (keyword === 'input') this.inputBlock(type);
    else if (keyword === 'enum') this.enumBlock(type);
    else if (keyword === 'union' && this.skip('=')) {
      this.skip('|');
      do type.members.add(this.name('a union member'));
      while (this.skip('|'));
    }
    this.defs.push({ keyword, type, extend, at });
  }

  private schema(): void {
    this.directives();
    if (!this.skip('{')) return;
    while (!this.skip('}')) {
      const at = this.t.at;
      const role = this.name('query, mutation or subscription');
      if (role !== 'query' && role !== 'mutation' && role !== 'subscription') {
        this.fail(
          `a schema names query, mutation or subscription, not ${JSON.stringify(role)}`,
          at,
        );
      }
      this.expect(':');
      if (this.roots[role]) this.fail(`the schema names its ${role} root twice`, at);
      this.roots[role] = this.name(`the ${role} root type`);
    }
  }

  private directiveDefinition(): void {
    this.expect('@');
    this.name('a directive name');
    if (this.peek('(')) this.argsDefinition(new Map());
    if (this.t.kind === 'name' && this.t.value === 'repeatable') this.i++;
    if (this.name('"on"') !== 'on')
      this.fail('a directive definition names where it applies with "on"');
    this.skip('|');
    do this.name('a directive location');
    while (this.skip('|'));
  }

  private implementsList(type: SdlType): void {
    if (!(this.t.kind === 'name' && this.t.value === 'implements')) return;
    this.i++;
    this.skip('&');
    do type.interfaces.add(this.name('an interface name'));
    while (this.skip('&'));
  }

  private fieldsBlock(type: SdlType): void {
    if (!this.skip('{')) return;
    while (!this.skip('}')) {
      this.description();
      const at = this.t.at;
      const name = this.name('a field name');
      const args = new Map<string, SdlArg>();
      if (this.peek('(')) this.argsDefinition(args);
      this.expect(':');
      const fieldType = this.typeRef();
      const deprecated = this.directives();
      if (type.fields.has(name)) this.fail(`${type.name}.${name} is defined twice`, at);
      type.fields.set(name, { name, type: fieldType, args, deprecated });
    }
  }

  private inputBlock(type: SdlType): void {
    if (!this.skip('{')) return;
    while (!this.skip('}')) {
      const at = this.t.at;
      const value = this.inputValue();
      if (type.fields.has(value.name)) this.fail(`${type.name}.${value.name} is defined twice`, at);
      type.fields.set(value.name, { ...value, args: new Map() });
    }
  }

  private enumBlock(type: SdlType): void {
    if (!this.skip('{')) return;
    while (!this.skip('}')) {
      this.description();
      const at = this.t.at;
      const value = this.name('an enum value');
      if (value === 'true' || value === 'false' || value === 'null') {
        this.fail(`${value} cannot be an enum value`, at);
      }
      const deprecated = this.directives();
      if (type.fields.has(value)) this.fail(`${type.name}.${value} is defined twice`, at);
      type.fields.set(value, { name: value, type: type.name, args: new Map(), deprecated });
    }
  }

  private argsDefinition(into: Map<string, SdlArg>): void {
    this.expect('(');
    if (this.peek(')')) this.fail('an argument list holds at least one argument');
    while (!this.skip(')')) {
      const at = this.t.at;
      const arg = this.inputValue();
      if (into.has(arg.name)) this.fail(`argument ${arg.name} is defined twice`, at);
      into.set(arg.name, arg);
    }
  }

  private inputValue(): SdlArg {
    this.description();
    const name = this.name('an argument name');
    this.expect(':');
    const type = this.typeRef();
    const hasDefault = this.skip('=');
    if (hasDefault) this.value();
    return { name, type, hasDefault, deprecated: this.directives() };
  }

  private typeRef(): string {
    let out: string;
    if (this.skip('[')) {
      out = `[${this.typeRef()}]`;
      this.expect(']');
    } else out = this.name('a type');
    return this.skip('!') ? `${out}!` : out;
  }

  private value(): void {
    if (this.peek('$')) this.fail('a variable belongs to an operation, not to a default value');
    if (this.skip('[')) {
      while (!this.skip(']')) this.value();
      return;
    }
    if (this.skip('{')) {
      while (!this.skip('}')) {
        this.name('an object field');
        this.expect(':');
        this.value();
      }
      return;
    }
    if (this.t.kind === 'eof' || this.t.kind === 'punct')
      this.fail(`expected a value, found ${this.shown()}`);
    this.i++;
  }

  /** Reads the directives on a definition, and answers whether one of them is @deprecated. */
  private directives(): boolean {
    let deprecated = false;
    while (this.skip('@')) {
      if (this.name('a directive name') === 'deprecated') deprecated = true;
      if (this.skip('(')) {
        while (!this.skip(')')) {
          this.name('a directive argument');
          this.expect(':');
          this.value();
        }
      }
    }
    return deprecated;
  }
}

function merged(text: string, defs: readonly Pending[]): Map<string, SdlType> {
  const types = new Map<string, SdlType>();
  for (const d of defs.filter((p) => !p.extend)) {
    if (types.has(d.type.name))
      throw unreadable(text, d.at, `type ${d.type.name} is defined twice`);
    types.set(d.type.name, d.type);
  }
  for (const d of defs.filter((p) => p.extend)) {
    const base = types.get(d.type.name);
    if (!base)
      throw unreadable(
        text,
        d.at,
        `extend ${d.keyword} ${d.type.name} extends a type the SDL never defines`,
      );
    if (base.kind !== d.type.kind) {
      throw unreadable(
        text,
        d.at,
        `${d.type.name} is a ${base.kind}, and is extended as a ${d.type.kind}`,
      );
    }
    for (const [name, field] of d.type.fields) {
      if (base.fields.has(name))
        throw unreadable(text, d.at, `${d.type.name}.${name} is defined twice`);
      base.fields.set(name, field);
    }
    for (const m of d.type.members) base.members.add(m);
    for (const i of d.type.interfaces) base.interfaces.add(i);
  }
  return types;
}

export const namedType = (ref: string): string => ref.replace(/[[\]!]/g, '');

// cm:why a contract measured against types it never defines would report breaks nobody can read, so a field naming an unknown type is refused rather than indexed; the five built-in scalars are the only names an SDL may use without defining
const BUILT_IN = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

export function parseSdl(text: string): SdlSchema {
  const parser = new Parser(text, lex(text));
  parser.parse();
  const types = merged(text, parser.defs);
  const roots: Partial<Record<RootRole, string>> = { ...parser.roots };
  if (Object.keys(roots).length === 0) {
    for (const role of ['query', 'mutation', 'subscription'] as const) {
      if (types.get(ROOT_NAME[role])?.kind === 'object') roots[role] = ROOT_NAME[role];
    }
  }
  for (const [role, name] of Object.entries(roots)) {
    if (types.get(name)?.kind !== 'object') {
      throw sdlUnreadable(
        `the SDL names ${name} as its ${role} root, and defines no object type ${name}`,
      );
    }
  }
  if (!roots.query)
    throw sdlUnreadable('the SDL defines no query root (a type Query, or schema { query: … })');
  const known = (n: string) => BUILT_IN.has(n) || types.has(n);
  for (const t of types.values()) {
    for (const i of t.interfaces) {
      if (types.get(i)?.kind !== 'interface') {
        throw sdlUnreadable(`${t.name} implements ${i}, which is no interface the SDL defines`);
      }
    }
    for (const m of t.members) {
      if (types.get(m)?.kind !== 'object') {
        throw sdlUnreadable(`union ${t.name} names ${m}, which is no object type the SDL defines`);
      }
    }
    if (t.kind === 'enum') continue;
    for (const f of t.fields.values()) {
      for (const ref of [f.type, ...[...f.args.values()].map((a) => a.type)]) {
        if (!known(namedType(ref))) {
          throw sdlUnreadable(
            `${t.name}.${f.name} names type ${namedType(ref)}, which the SDL never defines`,
          );
        }
      }
    }
  }
  return { roots, types };
}

/** Each root field under its role's canonical name, so `QueryRoot.products` and `Query.products` are one operation. */
export function operationsOf(schema: SdlSchema): { element: string; field: SdlField }[] {
  return (Object.entries(schema.roots) as [RootRole, string][]).flatMap(([role, name]) =>
    [...(schema.types.get(name)?.fields.values() ?? [])].map((field) => ({
      element: `${ROOT_NAME[role]}.${field.name}`,
      field,
    })),
  );
}

export const isRootType = (schema: SdlSchema, name: string): boolean =>
  Object.values(schema.roots).includes(name);

export function sdlElements(schema: SdlSchema): string[] {
  const out = new Set<string>();
  for (const { element, field } of operationsOf(schema)) {
    out.add(element);
    for (const a of field.args.keys()) out.add(`${element}(${a})`);
  }
  for (const t of schema.types.values()) {
    if (isRootType(schema, t.name) || t.kind === 'scalar' || t.kind === 'union') continue;
    for (const f of t.fields.values()) {
      out.add(`${t.name}.${f.name}`);
      for (const a of f.args.keys()) out.add(`${t.name}.${f.name}(${a})`);
    }
  }
  return [...out];
}
