import { posix } from 'node:path';
import ts from 'typescript';
import {
  bindingNames,
  type Ev,
  type FileFacts,
  type FnInfo,
  isFunctionExpression,
  isPrimitiveType,
  type LiteralValue,
  type NsValue,
  type ParamRef,
  parse,
  scopeAbove,
  TABLE,
  unwrap,
  type Value,
} from './single-door.parse.fixture.js';

/** Drizzle's wrappers that hand back the table they were given, under another name. */
const ALIASING = new Set(['alias', 'aliasedTable']);

const none = (): Ev => ({ values: new Set(), unknown: null });
const unknownBecause = (why: string): Ev => ({ values: new Set(), unknown: why });

/**
 * What the sources name the comments table, followed to a fixed point: the export declared as
 * `pgTable('comments', ...)`, through imports, re-exports under any name, namespaces (including a
 * namespace re-exported or bound to another name), destructuring, local aliases, dynamic imports,
 * and the functions that return it. What it cannot follow it reports as `unknown`, with the reason,
 * so the caller refuses it by name and never reads it as "not the table".
 */
export class Model {
  readonly facts = new Map<string, FileFacts>();
  readonly fnByNode = new Map<ts.Node, FnInfo>();
  /** What each name holds, per scope: the source file for module level, else the function. */
  private readonly env = new Map<ts.Node, Map<string, Ev>>();
  private readonly exp = new Map<string, Map<string, Ev>>();
  private readonly namespaces = new Map<string, NsValue>();
  private readonly visiting = new Set<FnInfo>();
  private readonly literals = new Map<ts.Node, LiteralValue>();
  private readonly reading = new Set<ts.Node>();

  constructor(sources: ReadonlyMap<string, string>) {
    for (const [file, text] of sources) {
      const facts = parse(file, text);
      this.facts.set(file, facts);
      for (const fn of facts.fns) this.fnByNode.set(fn.node, fn);
      this.exp.set(file, new Map());
    }
    this.settle();
  }

  /** Reads every file again until none holds anything new: a name can reach a file only after another has settled. */
  private settle(): void {
    for (let round = 0; ; round++) {
      let changed = false;
      for (const f of this.facts.values()) changed = this.step(f) || changed;
      if (!changed) return;
      if (round > 200) throw new Error('single-door scan: module resolution did not settle');
    }
  }

  fnsOf(ev: Ev): FnInfo[] {
    return [...ev.values].filter((v): v is FnInfo => v.kind === 'fn');
  }

  private envOf(scope: ts.Node): Map<string, Ev> {
    let held = this.env.get(scope);
    if (!held) {
      held = new Map();
      this.env.set(scope, held);
    }
    return held;
  }

  private paramIn(fn: ts.SignatureDeclaration, name: string): ParamRef | null {
    const params = fn.parameters;
    for (let i = 0; i < params.length; i++) {
      const p = params[i] as ts.ParameterDeclaration;
      if (ts.isIdentifier(p.name)) {
        if (p.name.text !== name) continue;
        const type = p.type;
        const primitive = !!type && isPrimitiveType(type);
        return {
          fn: this.fnByNode.get(fn) ?? null,
          index: p.dotDotDotToken ? -1 : i,
          primitive,
          type,
        };
      }
      if (bindingNames(p.name).includes(name)) {
        return { fn: null, index: -1, primitive: false, type: undefined };
      }
    }
    return null;
  }

  /** What a name means where it is used: the innermost scope declaring it decides. */
  private lookup(id: ts.Identifier): { param: ParamRef | null; ev: Ev | null } {
    for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
      if (ts.isSourceFile(n)) return { param: null, ev: this.env.get(n)?.get(id.text) ?? null };
      if (!ts.isFunctionLike(n)) continue;
      const param = this.paramIn(n, id.text);
      const ev = this.env.get(n)?.get(id.text) ?? null;
      if (param || ev) return { param, ev };
    }
    return { param: null, ev: null };
  }

  /**
   * Whether `type`, read in `file`, gives the member reached by `path` a primitive type, so a
   * property of a parameter is a string or a number and cannot be a table.
   */
  primitiveMember(type: ts.TypeNode | undefined, path: readonly string[], file: string): boolean {
    let current: ts.TypeNode | ts.InterfaceDeclaration | undefined = type;
    for (const name of path) {
      let members: readonly ts.TypeElement[] | undefined;
      for (let depth = 0; current && depth < 8 && !members; depth++) {
        if (ts.isTypeLiteralNode(current) || ts.isInterfaceDeclaration(current))
          members = current.members;
        else if (ts.isTypeReferenceNode(current) && ts.isIdentifier(current.typeName)) {
          current = this.facts.get(file)?.types.get(current.typeName.text);
        } else if (ts.isParenthesizedTypeNode(current)) current = current.type;
        else return false;
      }
      const member = members?.find(
        (m): m is ts.PropertySignature =>
          ts.isPropertySignature(m) &&
          !!m.name &&
          (ts.isIdentifier(m.name) || ts.isStringLiteralLike(m.name)) &&
          m.name.text === name,
      );
      current = member?.type;
    }
    return !!current && isPrimitiveType(current);
  }

  /** The parameter an identifier names inside the function that declares it, if it names one. */
  paramOf(id: ts.Identifier): ParamRef | null {
    return this.lookup(id).param;
  }

  eval(expr: ts.Expression, file: string): Ev {
    const node = unwrap(expr);
    if (ts.isIdentifier(node)) return this.identifier(node);
    if (ts.isPropertyAccessExpression(node)) {
      return this.prop(this.eval(node.expression, file), node.name.text);
    }
    if (ts.isElementAccessExpression(node)) {
      const base = this.eval(node.expression, file);
      const key = node.argumentExpression;
      return ts.isStringLiteralLike(key) ? this.prop(base, key.text) : this.anyMember(base);
    }
    if (ts.isConditionalExpression(node)) {
      return merged(this.eval(node.whenTrue, file), this.eval(node.whenFalse, file));
    }
    if (ts.isBinaryExpression(node)) return this.binary(node, file);
    if (ts.isCallExpression(node)) return this.call(node, file);
    if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
      return { values: new Set<Value>([this.literal(node, file)]), unknown: null };
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) return unknownBecause('`this`');
    return none();
  }

  private identifier(node: ts.Identifier): Ev {
    const { param, ev } = this.lookup(node);
    const out: Ev = ev ? { values: new Set(ev.values), unknown: ev.unknown } : none();
    if (param) out.unknown ??= `the parameter \`${node.text}\``;
    return out;
  }

  private binary(node: ts.BinaryExpression, file: string): Ev {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return merged(this.eval(node.left, file), this.eval(node.right, file));
    }
    if (op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.EqualsToken) {
      return this.eval(node.right, file);
    }
    return none();
  }

  private literal(
    node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    file: string,
  ): Value {
    let held = this.literals.get(node);
    if (!held) {
      held = { kind: 'literal', file, node };
      this.literals.set(node, held);
    }
    return held;
  }

  /** The member `name` of whatever `base` can be: a namespace's export, an object's property. */
  private prop(base: Ev, name: string): Ev {
    const out: Ev = { values: new Set(), unknown: base.unknown };
    for (const v of base.values) {
      if (v.kind === 'ns') {
        const held = this.exp.get(v.file)?.get(name);
        if (held) mergeInto(out, held);
      } else if (v.kind === 'literal' && ts.isObjectLiteralExpression(v.node)) {
        mergeInto(out, this.property(v.node, v.file, name));
      }
    }
    return out;
  }

  /** Every member of `base`, for a key only known when the code runs. */
  private anyMember(base: Ev): Ev {
    const out: Ev = { values: new Set(), unknown: base.unknown };
    for (const v of base.values) {
      if (v.kind === 'ns')
        for (const held of this.exp.get(v.file)?.values() ?? []) mergeInto(out, held);
      else if (v.kind === 'literal') mergeInto(out, this.members(v));
    }
    return out;
  }

  /** What the elements of an array, or the property values of an object, can be. */
  private members(v: LiteralValue): Ev {
    const out = none();
    if (this.reading.has(v.node)) return out;
    this.reading.add(v.node);
    const items = ts.isArrayLiteralExpression(v.node) ? v.node.elements : v.node.properties;
    for (const item of items) {
      if (ts.isSpreadElement(item) || ts.isSpreadAssignment(item)) {
        mergeInto(out, this.anyMember(this.eval(item.expression, v.file)));
      } else if (ts.isPropertyAssignment(item)) mergeInto(out, this.eval(item.initializer, v.file));
      else if (ts.isShorthandPropertyAssignment(item)) mergeInto(out, this.eval(item.name, v.file));
      else if (ts.isExpression(item) && !ts.isOmittedExpression(item))
        mergeInto(out, this.eval(item, v.file));
    }
    this.reading.delete(v.node);
    return out;
  }

  private property(node: ts.ObjectLiteralExpression, file: string, name: string): Ev {
    const out = none();
    if (this.reading.has(node)) return out;
    this.reading.add(node);
    for (const item of node.properties) {
      if (ts.isSpreadAssignment(item)) {
        mergeInto(out, this.prop(this.eval(item.expression, file), name));
      } else if (ts.isShorthandPropertyAssignment(item)) {
        if (item.name.text === name) mergeInto(out, this.eval(item.name, file));
      } else if (ts.isPropertyAssignment(item)) {
        if (ts.isComputedPropertyName(item.name)) {
          mergeInto(out, unknownBecause('an object with a computed key'));
        } else if (
          item.name.getText() === name ||
          (ts.isStringLiteralLike(item.name) && item.name.text === name)
        ) {
          mergeInto(out, this.eval(item.initializer, file));
        }
      }
    }
    this.reading.delete(node);
    return out;
  }

  /** Whether a call enters a function the scan holds the source of. */
  resolvesCall(node: ts.CallExpression, file: string): boolean {
    return this.fnsOf(this.eval(unwrap(node.expression), file)).length > 0;
  }

  private call(node: ts.CallExpression, file: string): Ev {
    const callee = unwrap(node.expression);
    const [first] = node.arguments;
    const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
    if (isImport || isRequire) {
      if (!first || !ts.isStringLiteralLike(first))
        return unknownBecause('an import of a computed path');
      const target = this.resolve(file, first.text);
      return target ? { values: new Set<Value>([this.ns(target)]), unknown: null } : none();
    }
    if (ts.isIdentifier(callee) && callee.text === 'pgTable') {
      return first && ts.isStringLiteralLike(first) && first.text === 'comments'
        ? { values: new Set<Value>([TABLE]), unknown: null }
        : none();
    }
    if (ts.isIdentifier(callee) && ALIASING.has(callee.text) && first)
      return this.eval(first, file);
    const held = this.eval(callee, file);
    const fns = this.fnsOf(held);
    if (fns.length === 0) {
      const own = ts.isIdentifier(callee) && this.facts.get(file)?.ownNames.has(callee.text);
      if (own || held.unknown?.startsWith('`this`')) {
        return unknownBecause(
          `the result of \`${callee.getText().slice(0, 40)}(...)\`, a call the scan cannot enter`,
        );
      }
      return none();
    }
    const out = none();
    for (const fn of fns) {
      if (this.visiting.has(fn)) continue;
      this.visiting.add(fn);
      for (const ret of fn.returns) mergeInto(out, this.eval(ret, fn.file));
      this.visiting.delete(fn);
    }
    return out;
  }

  private ns(file: string): NsValue {
    let held = this.namespaces.get(file);
    if (!held) {
      held = { kind: 'ns', file };
      this.namespaces.set(file, held);
    }
    return held;
  }

  /** The file a relative module specifier names, among the files given. */
  private resolve(from: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    const bare = base.replace(/\.(?:js|ts)$/, '');
    for (const candidate of [`${bare}.ts`, `${base}.ts`, `${bare}/index.ts`]) {
      if (this.facts.has(candidate)) return candidate;
    }
    return null;
  }

  private put(map: Map<string, Ev>, key: string, ev: Ev): boolean {
    let held = map.get(key);
    if (!held) {
      held = none();
      map.set(key, held);
    }
    const before = held.values.size + (held.unknown ? 1 : 0);
    mergeInto(held, ev);
    return held.values.size + (held.unknown ? 1 : 0) !== before;
  }

  /** The scope an assigned name belongs to: the one declaring it, else the nearest function. */
  private scopeDeclaring(id: ts.Identifier, sf: ts.SourceFile): ts.Node {
    for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
      if (!ts.isFunctionLike(n) && !ts.isSourceFile(n)) continue;
      if (this.env.get(n)?.has(id.text)) return n;
      if (ts.isFunctionLike(n) && this.paramIn(n, id.text)) return n;
    }
    return sf;
  }

  private step(f: FileFacts): boolean {
    const env = this.envOf(f.sf);
    const exp = this.exp.get(f.file) as Map<string, Ev>;
    let changed = false;
    const put = (map: Map<string, Ev>, key: string, ev: Ev): void => {
      changed = this.put(map, key, ev) || changed;
    };

    for (const imp of f.imports) {
      const target = this.resolve(f.file, imp.spec);
      if (!target) continue;
      for (const [imported, local] of imp.named) {
        const held = this.exp.get(target)?.get(imported);
        if (held) put(env, local, held);
      }
      if (imp.namespace)
        put(env, imp.namespace, { values: new Set<Value>([this.ns(target)]), unknown: null });
    }

    for (const fn of f.fns) {
      put(this.envOf(fn.scope), fn.name, { values: new Set<Value>([fn]), unknown: null });
    }

    for (const d of f.declarations) {
      const init = d.initializer && unwrap(d.initializer);
      if (init && ts.isIdentifier(d.name) && isFunctionExpression(init)) continue;
      const loop = d.parent.parent;
      const iterated = ts.isForOfStatement(loop)
        ? this.anyMember(this.eval(loop.expression, f.file))
        : none();
      const ev = init ? this.eval(init, f.file) : iterated;
      changed = this.bind(this.envOf(scopeAbove(d)), d.name, ev, f.file) || changed;
    }

    for (const a of f.assignments) {
      const left = unwrap(a.left);
      if (ts.isIdentifier(left)) {
        put(this.envOf(this.scopeDeclaring(left, f.sf)), left.text, this.eval(a.right, f.file));
      } else if (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left)) {
        for (const id of identifiersIn(left)) {
          put(this.envOf(scopeAbove(a)), id, unknownBecause('a destructuring assignment'));
        }
      }
    }

    if (f.defaultExpr) put(exp, 'default', this.eval(f.defaultExpr, f.file));
    for (const [local, as] of f.exportedLocals) {
      const held = env.get(local);
      if (held) put(exp, as, held);
    }
    for (const e of f.exports) {
      const target = e.spec ? this.resolve(f.file, e.spec) : null;
      if (!target) continue;
      const theirs = this.exp.get(target) as Map<string, Ev>;
      if (e.kind === 'namespace') {
        put(exp, e.as, { values: new Set<Value>([this.ns(target)]), unknown: null });
      } else if (e.kind === 'all') {
        for (const [name, ev] of theirs) if (name !== 'default') put(exp, name, ev);
      } else {
        for (const [imported, as] of e.pairs) {
          const held = theirs.get(imported);
          if (held) put(exp, as, held);
        }
      }
    }
    return changed;
  }

  private bind(map: Map<string, Ev>, name: ts.BindingName, ev: Ev, file: string): boolean {
    if (ts.isIdentifier(name)) return this.put(map, name.text, ev);
    let changed = false;
    if (ts.isArrayBindingPattern(name)) {
      const element = this.anyMember(ev);
      for (const id of bindingNames(name)) changed = this.put(map, id, element) || changed;
      return changed;
    }
    for (const el of name.elements) {
      const keyNode = el.propertyName ?? el.name;
      let sub: Ev;
      if (el.dotDotDotToken) sub = this.anyMember(ev);
      else if (ts.isIdentifier(keyNode) || ts.isStringLiteralLike(keyNode)) {
        sub = this.prop(ev, keyNode.text);
      } else sub = this.anyMember(ev);
      if (el.initializer) sub = merged(sub, this.eval(el.initializer, file));
      changed = this.bind(map, el.name, sub, file) || changed;
    }
    return changed;
  }
}

function identifiersIn(node: ts.Node, out: string[] = []): string[] {
  if (ts.isIdentifier(node)) out.push(node.text);
  else ts.forEachChild(node, (child) => void identifiersIn(child, out));
  return out;
}

function mergeInto(into: Ev, from: Ev): void {
  for (const v of from.values) into.values.add(v);
  into.unknown ??= from.unknown;
}

function merged(a: Ev, b: Ev): Ev {
  const out = { values: new Set(a.values), unknown: a.unknown };
  mergeInto(out, b);
  return out;
}
