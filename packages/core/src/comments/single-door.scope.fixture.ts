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
  /** What the calls the sources make hand each function for its parameters, by function. */
  protected readonly incoming = new Map<ts.Node, Map<string, Ev>>();
  /** Whether a parameter holds what its callers hand it, which a write inside the function leaves out. */
  protected useIncoming = true;

  protected envOf(scope: ts.Node): Map<string, Ev> {
    let held = this.env.get(scope);
    if (!held) {
      held = new Map();
      this.env.set(scope, held);
    }
    return held;
  }

  protected incomingOf(fn: ts.Node): Map<string, Ev> {
    let held = this.incoming.get(fn);
    if (!held) {
      held = new Map();
      this.incoming.set(fn, held);
    }
    return held;
  }

  protected namedFn(node: ts.Node): FnInfo | null {
    const fn = this.fnByNode.get(node);
    return fn?.named ? fn : null;
  }

  private readonly params = new Map<ts.Node, Map<string, ParamRef>>();

  protected paramIn(fn: ts.SignatureDeclaration, name: string): ParamRef | null {
    let held = this.params.get(fn);
    if (!held) {
      held = new Map();
      for (const [i, p] of fn.parameters.entries()) {
        if (ts.isIdentifier(p.name)) {
          const type = p.type;
          held.set(p.name.text, {
            fn: this.namedFn(fn),
            index: p.dotDotDotToken ? -1 : i,
            primitive: !!type && isPrimitiveType(type),
            type,
          });
        } else {
          for (const n of bindingNames(p.name)) {
            held.set(n, { fn: null, index: -1, primitive: false, type: undefined });
          }
        }
      }
      this.params.set(fn, held);
    }
    return held.get(name) ?? null;
  }

  /** What a name means where it is used: the innermost scope declaring it decides. */
  protected lookup(id: ts.Identifier): { param: ParamRef | null; ev: Ev | null } {
    for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
      if (ts.isSourceFile(n)) return { param: null, ev: this.env.get(n)?.get(id.text) ?? null };
      if (!ts.isFunctionLike(n)) continue;
      const param = this.paramIn(n, id.text);
      const own = this.env.get(n)?.get(id.text);
      const given = this.useIncoming ? this.incoming.get(n)?.get(id.text) : undefined;
      let ev: Ev | null = own ?? given ?? null;
      if (own && given) {
        ev = none();
        mergeInto(ev, own);
        mergeInto(ev, given);
      }
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
