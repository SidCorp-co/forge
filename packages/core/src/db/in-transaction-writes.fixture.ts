/**
 * The write reading: on a path an error the catch does not name can take, a rethrowing one
 * included, every use of the caught error, of a name bound to it or of a holder of it is a write,
 * and the catch is refused, unless `readOnly` resolves it as a plain read; so are `arguments` and a
 * direct `eval` there, which reach the error by no name (biome refuses both too: `noArguments`,
 * `noGlobalEval`). A store to a key of the error is a plain read only where no guard the scan
 * reads looks at that key: any but `code`, `constraint_name`, `constraint`, `name`, `cause` and
 * `__proto__`, which swaps its class.
 *
 * What one file's reading still cannot see: a function the catch calls without handing it the
 * error or a holder, which reaches the error through a binding outside the catch the catch stored
 * it in (`lastErr = err; poison()` where `poison` writes `lastErr.code`); a property declared plain
 * that is a setter at run time (a `Proxy`, a subclass's accessor on `this`); and code the error
 * object itself carries, a getter, `toString`, `valueOf`, `Symbol.toPrimitive` or a `Proxy` trap,
 * which a property read, comparison, `in` or conversion runs and which no driver's error has.
 */

import ts from 'typescript';
import { IDENTIFYING, readsTheError, type Scan, unwrap } from './in-transaction-guards.fixture.js';
import { assignedTo, isAssignment, isWrapper } from './in-transaction-paths.fixture.js';

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
  is: Set<ts.Symbol>;
  holds: Set<ts.Symbol>;
}

/**
 * Every name the caught error is bound to in `body` (`is`), by a declaration, a default, a
 * `for...of`, an assignment or a function whose body mentions one, and every name, `this` or callee
 * a property of which was set to such a value (`holds`).
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

/** Every key a guard the scan reads looks at on the error, and the one that swaps its class. */
const GUARDED = new Set([...IDENTIFYING, 'cause', '__proto__']);

/** A store to a key named in the source that no guard the scan reads looks at. */
function unguarded(store: ts.AccessExpression): boolean {
  const key = ts.isPropertyAccessExpression(store)
    ? store.name.text
    : ts.isStringLiteralLike(store.argumentExpression)
      ? store.argumentExpression.text
      : undefined;
  return key !== undefined && !GUARDED.has(key);
}

function dataProperty(store: ts.AccessExpression, scan: Scan): boolean {
  const key = ts.isPropertyAccessExpression(store) ? store.name : store.argumentExpression;
  const declared = scan.checker.getSymbolAtLocation(key)?.declarations ?? [];
  return (
    declared.length > 0 &&
    declared.every(
      (d) =>
        ts.isPropertyDeclaration(d) ||
        ts.isPropertySignature(d) ||
        ts.isPropertyAssignment(d) ||
        ts.isShorthandPropertyAssignment(d),
    )
  );
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
 * Whether `mention` only reads the error, by a form that ends the reach or runs none of its code: a
 * value whose type holds no object; a comparison, `instanceof`, `in`, `!`, `typeof`, `void` or test
 * of it; a `throw`, `return` or statement of it; a binding of a name, whose own uses answer; one
 * argument to a `lib/db-errors.ts` reader or resolved `isX` helper; one store into a holder's
 * property declared plain, or into the error's own where no guard reads that key. A property read,
 * cast, `?:`, `&&`, `||`, `??`, comma, literal or assignment holding it reaches on; anything else
 * is a write.
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
      if (assignedTo(parent))
        return steps === 1 && dataProperty(parent, scan) && (holder || unguarded(parent));
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

/** `arguments`, or a direct `eval`: each reaches the error by no name the reading follows. */
function unnamedReach(node: ts.Node): boolean {
  if (!ts.isIdentifier(node)) return false;
  const { parent } = node;
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) &&
    parent.name === node
  )
    return false;
  if (node.text === 'arguments') return true;
  return node.text === 'eval' && ts.isCallExpression(parent) && parent.expression === node;
}

/**
 * The first use `readOnly` does not resolve outside the parts of `body` in `named`, `undefined`
 * where none: a call or `new` handed the error (`Object.assign(err, …)`, `[err].forEach(…)`), a
 * method of it or of a holder, an `await`, a conversion or a computed key among them; and any
 * `arguments` or direct `eval`, which biome refuses anyway (`noArguments`, `noGlobalEval`).
 */
export function unreadUse(
  body: ts.Node,
  param: ts.Symbol,
  scan: Scan,
  named: ReadonlySet<ts.Node> = new Set(),
): ts.Node | undefined {
  const aliases = aliasesOf(body, param, scan);
  const among = new Set([...aliases.is, ...aliases.holds]);
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found || named.has(n)) return;
    if (unnamedReach(n)) {
      found = n;
      return;
    }
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
