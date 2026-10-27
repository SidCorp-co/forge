/**
 * Which uses of the caught error a catch may make before its guard reads it. Every use of the error,
 * of a name bound to it, or of a name or `this` holding it in a property, is refused as a write
 * unless the reading resolves it as a plain read: a value it reaches whose type holds no object,
 * which nothing can change; a comparison, `instanceof` with the error on the left, `in` with it on
 * the right, `!`, `typeof`, `void`, a test of an `if`, a loop or a `switch`, or the left of a comma,
 * none of which runs code of the error's; a `throw`, a `return` or a statement of its own, after
 * which nothing reads it; a declaration, a binding default or an assignment binding a name to it,
 * whose own uses answer for that name; one argument handed to a reader of `lib/db-errors.ts` or an
 * `isX` helper the guard reader resolves, whose body only reads; a property read off it, which
 * reaches what it holds and is read the same way; and one store into a property of a holder, which
 * replaces what the holder held and leaves the error as it was. A `?:`, `&&`, `||`, `??`, the
 * right of a comma, a parenthesis, a cast, an array or object literal holding it, or an assignment
 * whose value it is, reaches it too, and what takes that reach is read the same way.
 *
 * Everything else is a write, among them a call or `new` handed it (`Object.assign(err, …)`,
 * `Object.getPrototypeOf(err)`, `[err].forEach(…)`), a method called on it or on a holder, an
 * `await` of it, a conversion to a string or a number, a spread into a call or an array, and a
 * key computed from it.
 *
 * Which code is read is the catch scan's: only the test of a guard the catch opens with, since
 * what follows it runs once it has decided; the whole catch where it decides at each exit, uses
 * after a decision among them; and none of a catch that throws on every path.
 *
 * What one file's static reading still cannot see: a function the catch calls without handing it
 * the error or a holder, which reaches the error through a binding outside the catch the catch
 * stored it in (`lastErr = err; poison()` where `poison` writes `lastErr.code`), or through a holder
 * stored by an earlier call. The caller's caught error is matched by its binding, so another
 * binding of the same object reached that way is no name the reading knows.
 */

import ts from 'typescript';
import { readsTheError, type Scan, unwrap } from './in-transaction-guards.fixture.js';

function isAssignment(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

/** Where `this` holds the caught error: `this` is no name, so it stands for itself among them. */
const THIS = { escapedName: 'this' } as unknown as ts.Symbol;

function bound(node: ts.Node, scan: Scan): ts.Symbol | undefined {
  if (node.kind === ts.SyntaxKind.ThisKeyword) return THIS;
  if (!ts.isIdentifier(node)) return undefined;
  const { parent } = node;
  return ts.isShorthandPropertyAssignment(parent) && parent.name === node
    ? scan.checker.getShorthandAssignmentValueSymbol(parent)
    : scan.checker.getSymbolAtLocation(node);
}

function mentionsAny(node: ts.Node, among: ReadonlySet<ts.Symbol>, scan: Scan): boolean {
  const symbol = bound(node, scan);
  if (symbol && among.has(symbol)) return true;
  return ts.forEachChild(node, (c) => mentionsAny(c, among, scan) || undefined) ?? false;
}

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
 * name, `this` or the callee a holder of it.
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

function isWrapper(node: ts.Node): node is ts.Expression & { expression: ts.Expression } {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

/** Whether `node` is assigned, incremented, deleted, or destructured into, through any pattern around it. */
function assignedTo(node: ts.Node): boolean {
  const { parent } = node;
  if (isWrapper(parent)) return assignedTo(parent);
  if (isAssignment(parent)) return parent.left === node;
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
    return [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator);
  if (ts.isDeleteExpression(parent)) return true;
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent))
    return parent.initializer === node;
  if (ts.isPropertyAssignment(parent)) return parent.initializer === node && assignedTo(parent);
  if (
    ts.isArrayLiteralExpression(parent) ||
    ts.isObjectLiteralExpression(parent) ||
    ts.isShorthandPropertyAssignment(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isSpreadAssignment(parent)
  )
    return assignedTo(parent);
  return false;
}

const COMPARED = [
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
];
const PASSED_ON = [
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
];
const BINDING = [
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
];

/** Where a value standing as this statement's test, or as a statement, is only read. */
function testedOrDone(parent: ts.Node, at: ts.Node): boolean {
  if (ts.isExpressionStatement(parent) || ts.isThrowStatement(parent)) return true;
  if (ts.isReturnStatement(parent)) return true;
  if (
    ts.isIfStatement(parent) ||
    ts.isWhileStatement(parent) ||
    ts.isDoStatement(parent) ||
    ts.isSwitchStatement(parent) ||
    ts.isCaseClause(parent)
  )
    return parent.expression === at;
  if (ts.isForStatement(parent)) return parent.condition === at;
  if (ts.isVariableDeclaration(parent))
    return parent.initializer === at && !ts.isArrayBindingPattern(parent.name);
  if (ts.isParameter(parent) || ts.isBindingElement(parent))
    return parent.initializer === at && !ts.isArrayBindingPattern(parent.name);
  return ts.isArrowFunction(parent) && parent.body === at;
}

/**
 * Whether `mention`, a use of `symbol`, only reads the error by the forms the header lists: walk
 * up from it while what it reaches may still be the error, and answer at the first form that
 * either ends the reach or runs code of the error's.
 */
function readOnly(mention: ts.Node, symbol: ts.Symbol, aliases: Aliases, scan: Scan): boolean {
  const holder = !aliases.is.has(symbol);
  const [param] = aliases.is;
  if (assignedTo(mention)) return symbol !== param;
  let at = (ts.isShorthandPropertyAssignment(mention.parent) ? mention.parent : mention) as ts.Node;
  let steps = 0;
  for (;;) {
    if (ts.isExpression(at) && !ts.isShorthandPropertyAssignment(at) && primitive(at, scan))
      return true;
    const { parent } = at;
    if (isWrapper(parent)) {
      at = parent;
    } else if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === at
    ) {
      steps += 1;
      if (assignedTo(parent)) return holder && steps === 1;
      at = parent;
    } else if (ts.isCallExpression(parent)) {
      return parent.expression !== at && readsTheError(parent, symbol, scan);
    } else if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (COMPARED.includes(op)) return true;
      if (op === ts.SyntaxKind.InstanceOfKeyword) return parent.left === at;
      if (op === ts.SyntaxKind.InKeyword) return parent.right === at;
      if (op === ts.SyntaxKind.CommaToken && parent.left === at) return true;
      const reaches =
        op === ts.SyntaxKind.CommaToken ||
        PASSED_ON.includes(op) ||
        (BINDING.includes(op) && parent.right === at);
      if (!reaches) return false;
      at = parent;
    } else if (ts.isConditionalExpression(parent)) {
      if (parent.condition === at) return true;
      at = parent;
    } else if (ts.isPrefixUnaryExpression(parent)) {
      return parent.operator === ts.SyntaxKind.ExclamationToken;
    } else if (ts.isTypeOfExpression(parent) || ts.isVoidExpression(parent)) {
      return true;
    } else if (ts.isArrayLiteralExpression(parent) || ts.isSpreadAssignment(parent)) {
      at = ts.isSpreadAssignment(parent) ? parent.parent : parent;
    } else if (ts.isPropertyAssignment(parent) && parent.initializer === at) {
      at = parent.parent;
    } else if (ts.isObjectLiteralExpression(parent)) {
      at = parent;
    } else {
      return testedOrDone(parent, at);
    }
  }
}

/** Whether `node` names a binding rather than using one: a declaration's own name. */
function declares(node: ts.Identifier): boolean {
  const { parent } = node;
  return (
    ((ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node)
  );
}

/**
 * The first use in `body` of the caught error `param`, of a name bound to it or of a holder of it,
 * that the reading does not resolve as a plain read; `undefined` where every use is one.
 */
export function unreadUse(body: ts.Node, param: ts.Symbol, scan: Scan): ts.Node | undefined {
  const aliases = aliasesOf(body, param, scan);
  const among = new Set([...aliases.is, ...aliases.holds]);
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    const use =
      (n.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(n) && !declares(n))) &&
      !ts.isPartOfTypeNode(n);
    const symbol = use ? bound(n, scan) : undefined;
    if (symbol && among.has(symbol) && !readOnly(n, symbol, aliases, scan)) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}
