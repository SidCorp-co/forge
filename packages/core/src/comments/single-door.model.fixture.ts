import ts from 'typescript';
import { Evaluator } from './single-door.eval.fixture.js';
import {
  type Ev,
  type FileFacts,
  identifiersIn,
  isNamedPath,
  merged,
  none,
  parse,
  primitiveMember,
  scopeAbove,
  unknownBecause,
  unwrap,
  type Value,
} from './single-door.parse.fixture.js';

/** Drizzle's wrappers that hand back the table they were given, under another name. */
const _ALIASING = new Set(['alias', 'aliasedTable']);

/** Reads every file's names, and what the calls the sources make hand each function, to a fixed point. */
export class Model extends Evaluator {
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
    for (let round = 0; ; round++) {
      let changed = false;
      for (const f of this.facts.values()) changed = this.step(f) || changed;
      if (!changed) return;
      if (round > 200) throw new Error('single-door scan: module resolution did not settle');
    }
  }

  primitiveMember(type: ts.TypeNode | undefined, path: readonly string[], file: string): boolean {
    const facts = this.facts.get(file);
    return !!facts && primitiveMember(facts, type, path);
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

    for (const c of f.classes) {
      const held = unknownBecause(
        `the class \`${c.name?.text}\`, whose members the scan does not read`,
      );
      put(this.envOf(scopeAbove(c)), c.name?.text ?? 'default', held);
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

  /** Records what is written into every object or array `base` can be. */
  private store(base: Ev, key: string, ev: Ev): boolean {
    let changed = false;
    for (const v of base.values) {
      if (v.kind !== 'literal') continue;
      changed = this.put(this.assignedTo(v), key, ev) || changed;
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
