import { posix } from 'node:path';
import ts from 'typescript';
import {
  type Ev,
  type FileFacts,
  type FnInfo,
  identifiersIn,
  isNamedPath,
  type LiteralValue,
  merged,
  mergeInto,
  type NsValue,
  none,
  parse,
  primitiveMember,
  scopeAbove,
  TABLE,
  unknownBecause,
  unwrap,
  type Value,
} from './single-door.parse.fixture.js';
import { Scopes } from './single-door.scope.fixture.js';

/** Drizzle's wrappers that hand back the table they were given, under another name. */
const ALIASING = new Set(['alias', 'aliasedTable']);

/**
 * What the sources name the comments table, followed to a fixed point: the export declared as
 * `pgTable('comments', ...)`, through imports, re-exports under any name, namespaces (including a
 * namespace re-exported or bound to another name), destructuring, local aliases, dynamic imports,
 * and the functions that return it. What it cannot follow it reports as `unknown`, with the reason,
 * so the caller refuses it by name and never reads it as "not the table".
 */
export class Model extends Scopes {
  readonly facts = new Map<string, FileFacts>();
  private readonly exp = new Map<string, Map<string, Ev>>();
  private readonly namespaces = new Map<string, NsValue>();
  private readonly visiting = new Set<FnInfo>();
  private readonly literals = new Map<ts.Node, LiteralValue>();
  private readonly reading = new Set<ts.Node>();
  /** What is stored into an object or array after it is written: by key, and `*` for any key. */
  private readonly assigned = new Map<LiteralValue, Map<string, Ev>>();

  constructor(sources: ReadonlyMap<string, string>) {
    super();
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
    const order = this.dependencyOrder();
    for (let round = 0; ; round++) {
      let changed = false;
      for (const f of order) changed = this.step(f) || changed;
      if (!changed) return;
      if (round > 200) throw new Error('single-door scan: module resolution did not settle');
    }
  }

  /** Files with what they import first, so most names are known the first time a file is read. */
  private dependencyOrder(): FileFacts[] {
    const order: FileFacts[] = [];
    const seen = new Set<string>();
    const visit = (f: FileFacts): void => {
      if (seen.has(f.file)) return;
      seen.add(f.file);
      for (const spec of [
        ...f.imports.map((i) => i.spec),
        ...f.exports.flatMap((e) => e.spec ?? []),
      ]) {
        const target = this.resolve(f.file, spec);
        const dep = target ? this.facts.get(target) : undefined;
        if (dep) visit(dep);
      }
      order.push(f);
    };
    for (const f of this.facts.values()) visit(f);
    return order;
  }

  fnsOf(ev: Ev): FnInfo[] {
    return [...ev.values].filter((v): v is FnInfo => v.kind === 'fn');
  }

  primitiveMember(type: ts.TypeNode | undefined, path: readonly string[], file: string): boolean {
    const facts = this.facts.get(file);
    return !!facts && primitiveMember(facts, type, path);
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
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const fn = this.fnByNode.get(node);
      return fn ? { values: new Set<Value>([fn]), unknown: null } : none();
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      return this.facts.get(file)?.ownNames.has(node.expression.text)
        ? unknownBecause(`an instance of \`${node.expression.text}\``)
        : none();
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) return unknownBecause('`this`');
    return none();
  }

  private identifier(node: ts.Identifier): Ev {
    const { param, ev } = this.lookup(node);
    if (!param) return ev ?? none();
    const out: Ev = ev ? { values: new Set(ev.values), unknown: ev.unknown } : none();
    out.unknown ??= `the parameter \`${node.text}\``;
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
      } else if (v.kind === 'literal') {
        if (ts.isObjectLiteralExpression(v.node)) {
          mergeInto(out, this.property(v.node, v.file, name));
        } else if (/^\d+$/.test(name)) mergeInto(out, this.members(v));
        const added = this.assigned.get(v);
        for (const key of [name, '*']) {
          const held = added?.get(key);
          if (held) mergeInto(out, held);
        }
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
      else if (v.kind === 'literal') {
        mergeInto(out, this.members(v));
        for (const held of this.assigned.get(v)?.values() ?? []) mergeInto(out, held);
      }
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
      else if (ts.isMethodDeclaration(item)) mergeInto(out, this.method(item));
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
      } else if (ts.isMethodDeclaration(item)) {
        if (item.name.getText() === name) mergeInto(out, this.method(item));
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

  private method(node: ts.MethodDeclaration): Ev {
    const fn = this.fnByNode.get(node);
    return fn ? { values: new Set<Value>([fn]), unknown: null } : none();
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
      return this.entersNothing(callee, held, file)
        ? unknownBecause(
            `the result of \`${callee.getText().slice(0, 40)}(...)\`, a call the scan cannot enter`,
          )
        : none();
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

  /**
   * Whether the result of a call the scan cannot enter may still be a table: the call is on a name
   * or an object the sources declare. A method of a parameter is the caller's object, and a table it
   * holds arrives as the parameter.
   */
  private entersNothing(callee: ts.Expression, held: Ev, file: string): boolean {
    if (ts.isIdentifier(callee)) return !!this.facts.get(file)?.ownNames.has(callee.text);
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
      return false;
    }
    const base = this.eval(callee.expression, file);
    const built = [...base.values].some((v) => v.kind === 'literal' || v.kind === 'ns');
    return built || (!!held.unknown && !held.unknown.startsWith('the parameter'));
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
      if (fn.bound) {
        put(this.envOf(fn.scope), fn.name, { values: new Set<Value>([fn]), unknown: null });
      }
    }

    for (const p of f.paramDefaults) {
      const given = this.eval(p.initializer as ts.Expression, f.file);
      changed = this.bind(this.envOf(p.parent), p.name, given, f.file) || changed;
    }

    for (const d of f.declarations) {
      const init = d.initializer && unwrap(d.initializer);
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
      } else if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
        const key = ts.isPropertyAccessExpression(left)
          ? left.name.text
          : ts.isStringLiteralLike(left.argumentExpression)
            ? left.argumentExpression.text
            : '*';
        const stored = this.store(
          this.eval(left.expression, f.file),
          key,
          this.eval(a.right, f.file),
        );
        changed = stored || changed;
      }
    }

    for (const call of f.calls) {
      changed = this.mutation(call, f.file) || changed;
      changed = this.handOver(call, f.file) || changed;
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

  /** What a call hands each function it enters for its parameters, read where the function is read. */
  private handOver(call: ts.CallExpression, file: string): boolean {
    let changed = false;
    const callee = unwrap(call.expression);
    if (!isNamedPath(callee)) return false;
    for (const fn of this.fnsOf(this.eval(callee, file))) {
      const params = (fn.node as ts.FunctionLikeDeclaration).parameters;
      for (const [i, p] of params.entries()) {
        const arg = call.arguments[i];
        if (!arg || ts.isSpreadElement(arg) || p.dotDotDotToken) continue;
        changed =
          this.bind(this.incomingOf(fn.node), p.name, this.eval(arg, file), file) || changed;
      }
    }
    return changed;
  }

  /** What an expression holds by what is written in the function it is in, leaving out its callers. */
  evalOwn(expr: ts.Expression, file: string): Ev {
    this.useIncoming = false;
    try {
      return this.eval(expr, file);
    } finally {
      this.useIncoming = true;
    }
  }

  /** Records what is written into every object or array `base` can be. */
  private store(base: Ev, key: string, ev: Ev): boolean {
    let changed = false;
    for (const v of base.values) {
      if (v.kind !== 'literal') continue;
      let held = this.assigned.get(v);
      if (!held) {
        held = new Map();
        this.assigned.set(v, held);
      }
      changed = this.put(held, key, ev) || changed;
    }
    return changed;
  }

  /** `list.push(t)`, `Object.assign(box, { t })`: a call that stores into an object it is given. */
  private mutation(call: ts.CallExpression, file: string): boolean {
    const callee = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const [target, ...rest] = call.arguments;
    const assign =
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Object' &&
      callee.name.text === 'assign';
    let changed = false;
    if (assign && target) {
      for (const source of rest) {
        const given = this.anyMember(this.eval(source, file));
        changed = this.store(this.eval(target, file), '*', given) || changed;
      }
    } else if (['push', 'unshift', 'splice', 'fill', 'set'].includes(callee.name.text)) {
      const into = this.eval(callee.expression, file);
      for (const arg of call.arguments)
        changed = this.store(into, '*', this.eval(arg, file)) || changed;
    }
    return changed;
  }

  private bind(map: Map<string, Ev>, name: ts.BindingName, ev: Ev, file: string): boolean {
    if (ts.isIdentifier(name)) return this.put(map, name.text, ev);
    let changed = false;
    if (ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isOmittedExpression(el)) continue;
        let sub = el.dotDotDotToken ? ev : this.anyMember(ev);
        if (el.initializer) sub = merged(sub, this.eval(el.initializer, file));
        changed = this.bind(map, el.name, sub, file) || changed;
      }
      return changed;
    }
    for (const el of name.elements) {
      const keyNode = el.propertyName ?? el.name;
      let sub: Ev;
      if (el.dotDotDotToken) sub = ev;
      else if (ts.isIdentifier(keyNode) || ts.isStringLiteralLike(keyNode)) {
        sub = this.prop(ev, keyNode.text);
      } else sub = this.anyMember(ev);
      if (el.initializer) sub = merged(sub, this.eval(el.initializer, file));
      changed = this.bind(map, el.name, sub, file) || changed;
    }
    return changed;
  }
}
