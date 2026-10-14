import ts from 'typescript';
import {
  bindingNames,
  type Ev,
  type FnInfo,
  isPrimitiveType,
  mergeInto,
  none,
  type ParamRef,
} from './single-door.parse.fixture.js';

/**
 * Where each name is declared and what it holds there: the source file for module level, else the
 * function. A name is looked up from where it is used outward, the innermost scope declaring it
 * deciding, and a parameter is told from a local so a table handed in is not taken for one named.
 */
export abstract class Scopes {
  readonly fnByNode = new Map<ts.Node, FnInfo>();
  protected readonly env = new Map<ts.Node, Map<string, Ev>>();

  protected envOf(scope: ts.Node): Map<string, Ev> {
    let held = this.env.get(scope);
    if (!held) {
      held = new Map();
      this.env.set(scope, held);
    }
    return held;
  }

  protected namedFn(node: ts.Node): FnInfo | null {
    const fn = this.fnByNode.get(node);
    return fn?.named ? fn : null;
  }

  protected paramIn(fn: ts.SignatureDeclaration, name: string): ParamRef | null {
    const params = fn.parameters;
    for (let i = 0; i < params.length; i++) {
      const p = params[i] as ts.ParameterDeclaration;
      if (ts.isIdentifier(p.name)) {
        if (p.name.text !== name) continue;
        const type = p.type;
        const primitive = !!type && isPrimitiveType(type);
        return {
          fn: this.namedFn(fn),
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
  protected lookup(id: ts.Identifier): { param: ParamRef | null; ev: Ev | null } {
    for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
      if (ts.isSourceFile(n)) return { param: null, ev: this.env.get(n)?.get(id.text) ?? null };
      if (!ts.isFunctionLike(n)) continue;
      const param = this.paramIn(n, id.text);
      const ev = this.env.get(n)?.get(id.text) ?? null;
      if (param || ev) return { param, ev };
    }
    return { param: null, ev: null };
  }

  protected put(map: Map<string, Ev>, key: string, ev: Ev): boolean {
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
  protected scopeDeclaring(id: ts.Identifier, sf: ts.SourceFile): ts.Node {
    for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
      if (!ts.isFunctionLike(n) && !ts.isSourceFile(n)) continue;
      if (this.env.get(n)?.has(id.text)) return n;
      if (ts.isFunctionLike(n) && this.paramIn(n, id.text)) return n;
    }
    return sf;
  }

  /** The parameter an identifier names inside the function that declares it, if it names one. */
  paramOf(id: ts.Identifier): ParamRef | null {
    return this.lookup(id).param;
  }
}
