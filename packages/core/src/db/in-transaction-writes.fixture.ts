/**
 * Which writes in a catch change the error it caught before a guard reads it: a write to the error
 * or to any name bound to it, through `this`, through a call whose result may be the error or its
 * prototype, or through the property of an object holding it. What a function called from the catch
 * does to the error inside its own body is the catch scan's named residual.
 */

import ts from 'typescript';
import { type Scan, unwrap } from './in-transaction-guards.fixture.js';

function isAssignment(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

/** Where `this` holds the caught error: `this` is no name, so it stands for itself among them. */
const THIS = { escapedName: 'this' } as unknown as ts.Symbol;

/** The symbol a name or `this` stands for, where `node` is either. */
function bound(node: ts.Node, scan: Scan): ts.Symbol | undefined {
  if (node.kind === ts.SyntaxKind.ThisKeyword) return THIS;
  return ts.isIdentifier(node) ? scan.checker.getSymbolAtLocation(node) : undefined;
}

function mentionsAny(node: ts.Node, among: ReadonlySet<ts.Symbol>, scan: Scan): boolean {
  const symbol = bound(node, scan);
  if (symbol && among.has(symbol)) return true;
  return ts.forEachChild(node, (c) => mentionsAny(c, among, scan) || undefined) ?? false;
}

/** The names `body` binds to the caught error, and those holding it in a property. */
interface Aliases {
  /** The catch's own name, and each name bound to a value mentioning the error, as `const { cause } = err`. */
  is: Set<ts.Symbol>;
  /** Each name, or `this`, a property of which was set to such a value, as `this.last = err`. */
  holds: Set<ts.Symbol>;
}

/**
 * Every name the caught error is bound to in `body`: the catch's own, each name a declaration, a
 * parameter's or a binding's default, a `for...of` or an assignment binds to a value mentioning one
 * of them, and a function declared with a body that mentions one, whose result may be the error.
 * Storing such a value in a property of a name, of `this`, or of what a call returns makes that
 * name, `this` or the callee a holder of it, and whatever a holder's call returns may be the holder.
 */
function aliasesOf(body: ts.Node, param: ts.Symbol, scan: Scan): Aliases {
  const aliases: Aliases = { is: new Set([param]), holds: new Set() };
  let grew = true;
  const add = (into: Set<ts.Symbol>, symbol: ts.Symbol | undefined): void => {
    if (symbol && !into.has(symbol)) {
      into.add(symbol);
      grew = true;
    }
  };
  const hold = (e: ts.Expression): void => {
    const root = unwrap(e);
    if (
      ts.isPropertyAccessExpression(root) ||
      ts.isElementAccessExpression(root) ||
      ts.isCallExpression(root)
    )
      hold(root.expression);
    else add(aliases.holds, bound(root, scan));
  };
  const bind = (name: ts.Node): void => {
    const e = ts.isExpression(name) ? unwrap(name) : name;
    if (ts.isIdentifier(e)) add(aliases.is, scan.checker.getSymbolAtLocation(e));
    else if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))
      hold(e.expression);
    else if (ts.isBindingElement(e)) bind(e.name);
    else if (ts.isPropertyAssignment(e)) bind(e.initializer);
    else if (ts.isShorthandPropertyAssignment(e))
      add(aliases.is, scan.checker.getShorthandAssignmentValueSymbol(e));
    else if (ts.isSpreadElement(e) || ts.isSpreadAssignment(e)) bind(e.expression);
    else if (isAssignment(e)) bind(e.left);
    else ts.forEachChild(e, bind);
  };
  const fromAlias = (n: ts.Node) =>
    mentionsAny(n, new Set([...aliases.is, ...aliases.holds]), scan);
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer && fromAlias(n.initializer)) bind(n.name);
    if ((ts.isParameter(n) || ts.isBindingElement(n)) && n.initializer && fromAlias(n.initializer))
      bind(n.name);
    if (ts.isFunctionDeclaration(n) && n.name && n.body && fromAlias(n.body)) bind(n.name);
    if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && fromAlias(n.expression)) {
      if (ts.isVariableDeclarationList(n.initializer))
        for (const d of n.initializer.declarations) bind(d.name);
      else bind(n.initializer);
    }
    if (isAssignment(n) && fromAlias(n.right)) bind(n.left);
    ts.forEachChild(n, visit);
  };
  while (grew) {
    grew = false;
    visit(body);
  }
  return aliases;
}

/** Whether `node`'s type says it holds a string, number, boolean or nothing, which no error is. */
function primitive(node: ts.Expression, scan: Scan): boolean {
  const type = scan.checker.getTypeAtLocation(node);
  const flat = (t: ts.Type) =>
    (t.flags &
      (ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.ESSymbolLike |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Void)) !==
    0;
  return type.isUnion() ? type.types.every(flat) : flat(type);
}

/**
 * Whether the access chain `node` writes into the caught error: its root is the error or an alias,
 * or holds one and the chain reaches past the property holding it, or a call along it is one an
 * alias names or is handed an alias, as `get().code` and `Object.getPrototypeOf(err).code`, whose
 * result may be the error or its prototype. A key, or an argument whose type holds no object, only
 * reads the error.
 */
function writesThrough(node: ts.Expression, aliases: Aliases, scan: Scan): boolean {
  let depth = 0;
  let at = unwrap(node);
  for (;;) {
    if (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at)) depth += 1;
    else if (ts.isCallExpression(at)) {
      const handed = at.arguments.some(
        (a) => !primitive(a, scan) && mentionsAny(a, aliases.is, scan),
      );
      if (handed) return true;
    } else break;
    at = unwrap(at.expression);
  }
  const root = bound(at, scan);
  return root !== undefined && (aliases.is.has(root) || (aliases.holds.has(root) && depth > 1));
}

/**
 * Whether the assignment target `node` changes the caught error: binds `err` itself, or writes a
 * property `writesThrough` reaches it by, also inside a destructuring pattern. Binding an alias
 * anew, or setting the property of a holder that held it, leaves the error as it was.
 */
function writesTo(node: ts.Node, aliases: Aliases, scan: Scan): boolean {
  const e: ts.Node = ts.isExpression(node) ? unwrap(node) : node;
  const again = (n: ts.Node): boolean => writesTo(n, aliases, scan);
  const [param] = aliases.is;
  if (ts.isIdentifier(e)) return scan.checker.getSymbolAtLocation(e) === param;
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))
    return writesThrough(e, aliases, scan);
  if (isAssignment(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) return again(e.left);
  if (ts.isArrayLiteralExpression(e)) return e.elements.some((x) => again(x));
  if (ts.isSpreadElement(e) || ts.isSpreadAssignment(e)) return again(e.expression);
  if (ts.isObjectLiteralExpression(e)) return e.properties.some((x) => again(x));
  if (ts.isPropertyAssignment(e)) return again(e.initializer);
  if (ts.isShorthandPropertyAssignment(e))
    return scan.checker.getShorthandAssignmentValueSymbol(e) === param;
  return false;
}

/** True where `node` holds a write `writesTo` counts; what a call handed the error does inside it goes unseen. */
export function reassigns(node: ts.Node, param: ts.Symbol, scan: Scan): boolean {
  const aliases = aliasesOf(node, param, scan);
  const target = (n: ts.Node) => writesTo(n, aliases, scan);
  const visit = (n: ts.Node): boolean =>
    (isAssignment(n) && target(n.left)) ||
    ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator) &&
      target(n.operand)) ||
    ((ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
      !ts.isVariableDeclarationList(n.initializer) &&
      target(n.initializer)) ||
    (ts.forEachChild(n, (c) => visit(c) || undefined) ?? false);
  return visit(node);
}
