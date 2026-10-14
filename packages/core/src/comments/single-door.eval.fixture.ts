import { posix } from 'node:path';
import ts from 'typescript';
import {
  type Ev,
  type FileFacts,
  type FnInfo,
  type LiteralValue,
  merged,
  mergeInto,
  type NsValue,
  none,
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
export abstract class Evaluator extends Scopes {
  readonly facts = new Map<string, FileFacts>();
  protected readonly exp = new Map<string, Map<string, Ev>>();
  protected readonly namespaces = new Map<string, NsValue>();
  protected readonly visiting = new Set<FnInfo>();
  protected readonly literals = new Map<ts.Node, LiteralValue>();
  protected readonly reading = new Set<ts.Node>();
  /** What is stored into an object or array after it is written: by key, and `*` for any key. */
  protected readonly assigned = new Map<LiteralValue, Map<string, Ev>>();

  fnsOf(ev: Ev): FnInfo[] {
    return [...ev.values].filter((v): v is FnInfo => v.kind === 'fn');
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
    if (ts.isClassExpression(node)) return unknownBecause('a class expression');
    return none();
  }

  protected identifier(node: ts.Identifier): Ev {
    const { param, ev } = this.lookup(node);
    if (!param) return ev ?? none();
    const out: Ev = ev ? { values: new Set(ev.values), unknown: ev.unknown } : none();
    out.unknown ??= `the parameter \`${node.text}\``;
    return out;
  }

  protected binary(node: ts.BinaryExpression, file: string): Ev {
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

  protected assignedTo(v: LiteralValue): Map<string, Ev> {
    let held = this.assigned.get(v);
    if (!held) {
      held = new Map();
      this.assigned.set(v, held);
    }
    return held;
  }

  protected literal(node: ts.Node, file: string): LiteralValue {
    let held = this.literals.get(node);
    if (!held) {
      held = { kind: 'literal', file, node };
      this.literals.set(node, held);
    }
    return held;
  }

  /** The member `name` of whatever `base` can be: a namespace's export, an object's property. */
  protected prop(base: Ev, name: string): Ev {
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
  protected anyMember(base: Ev): Ev {
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
  protected members(v: LiteralValue): Ev {
    const out = none();
    if (this.reading.has(v.node)) return out;
    this.reading.add(v.node);
    const items = ts.isArrayLiteralExpression(v.node)
      ? v.node.elements
      : ts.isObjectLiteralExpression(v.node)
        ? v.node.properties
        : [];
    for (const item of items) {
      if (ts.isSpreadElement(item) || ts.isSpreadAssignment(item)) {
        mergeInto(out, this.anyMember(this.eval(item.expression, v.file)));
      } else if (ts.isPropertyAssignment(item)) mergeInto(out, this.eval(item.initializer, v.file));
      else if (ts.isShorthandPropertyAssignment(item)) mergeInto(out, this.eval(item.name, v.file));
      else if (ts.isMethodDeclaration(item)) mergeInto(out, this.method(item));
      else if (ts.isGetAccessorDeclaration(item)) mergeInto(out, this.getter(item));
      else if (ts.isExpression(item) && !ts.isOmittedExpression(item))
        mergeInto(out, this.eval(item, v.file));
    }
    this.reading.delete(v.node);
    return out;
  }

  protected property(node: ts.ObjectLiteralExpression, file: string, name: string): Ev {
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
      } else if (ts.isGetAccessorDeclaration(item)) {
        if (item.name.getText() === name) mergeInto(out, this.getter(item));
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

  /** What reading a property that is a getter gives: what the getter returns. */
  protected getter(node: ts.GetAccessorDeclaration): Ev {
    const fn = this.fnByNode.get(node);
    return fn ? this.returned([fn]) : none();
  }

  /** What calling the functions gives: what they return, read where they are written. */
  protected returned(fns: readonly FnInfo[]): Ev {
    const out = none();
    for (const fn of fns) {
      if (this.visiting.has(fn)) continue;
      this.visiting.add(fn);
      for (const ret of fn.returns) mergeInto(out, this.eval(ret, fn.file));
      this.visiting.delete(fn);
    }
    return out;
  }

  protected method(node: ts.MethodDeclaration): Ev {
    const fn = this.fnByNode.get(node);
    return fn ? { values: new Set<Value>([fn]), unknown: null } : none();
  }

  /** Whether a call enters a function the scan holds the source of. */
  resolvesCall(node: ts.CallExpression, file: string): boolean {
    return this.fnsOf(this.eval(unwrap(node.expression), file)).length > 0;
  }

  protected call(node: ts.CallExpression, file: string): Ev {
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
    if (isContainerBuiltin(callee)) return this.contents(node, file);
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
    return this.returned(fns);
  }

  /**
   * Whether the result of a call the scan cannot enter may still be a table: the call is on a name
   * or an object the sources declare. A method of a parameter is the caller's object, and a table it
   * holds arrives as the parameter.
   */
  protected entersNothing(callee: ts.Expression, held: Ev, file: string): boolean {
    if (ts.isIdentifier(callee)) return !!this.facts.get(file)?.ownNames.has(callee.text);
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
      return false;
    }
    const base = this.eval(callee.expression, file);
    const built = [...base.values].some((v) => v.kind === 'literal' || v.kind === 'ns');
    return built || (!!held.unknown && !held.unknown.startsWith('the parameter'));
  }

  protected ns(file: string): NsValue {
    let held = this.namespaces.get(file);
    if (!held) {
      held = { kind: 'ns', file };
      this.namespaces.set(file, held);
    }
    return held;
  }

  /** The file a relative module specifier names, among the files given. */
  protected resolve(from: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    const bare = base.replace(/\.(?:js|ts)$/, '');
    for (const candidate of [`${bare}.ts`, `${base}.ts`, `${bare}/index.ts`]) {
      if (this.facts.has(candidate)) return candidate;
    }
    return null;
  }

  /** What `Object.values(x)`, `Array.from(x)` and kin hold: an object of what they are given, two levels in. */
  protected contents(call: ts.CallExpression, file: string): Ev {
    const held = none();
    for (const arg of call.arguments) {
      const given = this.eval(ts.isSpreadElement(arg) ? arg.expression : arg, file);
      const inner = this.anyMember(given);
      mergeInto(held, given);
      mergeInto(held, inner);
      mergeInto(held, this.anyMember(inner));
    }
    const result: LiteralValue = this.literal(call, file);
    this.put(this.assignedTo(result), '*', held);
    return { values: new Set<Value>([result]), unknown: held.unknown };
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
}

/** `Object.values(x)`, `Array.from(x)`: a built-in that hands back what it is given, rearranged. */
function isContainerBuiltin(callee: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
  const [owner, method] = [callee.expression.text, callee.name.text];
  if (owner === 'Object') {
    return ['values', 'entries', 'fromEntries', 'freeze', 'seal', 'create'].includes(method);
  }
  return owner === 'Array' && ['from', 'of'].includes(method);
}
