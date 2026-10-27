/** The control flow and bindings the catch scan reads a handler by. */

import ts from 'typescript';

export function within(node: ts.Node, outer: ts.Node): boolean {
  return node.pos >= outer.pos && node.end <= outer.end;
}

export function isNestedFunction(node: ts.Node): boolean {
  return ts.isFunctionLike(node) && !ts.isCallSignatureDeclaration(node);
}

export function statementsOf(node: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(node) ? node.statements : [node];
}

/** True where `stmts`' last statement throws on every path; `leaves` reads the exits before it. */
export function endsInThrow(stmts: readonly ts.Statement[]): boolean {
  const last = stmts.at(-1);
  if (!last) return false;
  if (ts.isThrowStatement(last)) return true;
  if (ts.isIfStatement(last) && last.elseStatement) {
    return (
      endsInThrow(statementsOf(last.thenStatement)) && endsInThrow(statementsOf(last.elseStatement))
    );
  }
  return false;
}

/** True where a jump in `block` lands on a statement inside it: its label's, or its loop or switch. */
function landsInside(jump: ts.BreakOrContinueStatement, block: ts.Node): boolean {
  for (let at = jump.parent; at && at !== block; at = at.parent) {
    if (jump.label) {
      if (ts.isLabeledStatement(at) && at.label.text === jump.label.text) return true;
    } else if (
      ts.isIterationStatement(at, false) ||
      (ts.isBreakStatement(jump) && ts.isSwitchStatement(at))
    ) {
      return true;
    }
  }
  return false;
}

/** Each statement of `block` that returns, or breaks or continues to a target outside it. */
export function exitsOf(block: ts.Node): ts.Node[] {
  const exits: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (isNestedFunction(n)) return;
    if (
      ts.isReturnStatement(n) ||
      ((ts.isBreakStatement(n) || ts.isContinueStatement(n)) && !landsInside(n, block))
    ) {
      exits.push(n);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(block);
  return exits;
}

export function leaves(block: ts.Node): boolean {
  return exitsOf(block).length > 0;
}

/** A branch with no way out but a throw. */
export function alwaysThrows(branch: ts.Statement): boolean {
  return endsInThrow(statementsOf(branch)) && !leaves(branch);
}

/**
 * The parts of `body` no error but a named one reaches: the branch an `if`, `?:` or `&&` takes on
 * a test that `names` one; the other branch of a test that `allBut` holds of every error but a
 * named kind, `else`, `?:`'s second or `||`'s right; and each statement after an `if` on such a
 * test whose branch has no way out but a throw. Any error can take every other path.
 */
export function namedPaths(
  body: ts.Node,
  names: (test: ts.Expression) => boolean,
  allBut: (test: ts.Expression) => boolean,
): Set<ts.Node> {
  const named = new Set<ts.Node>();
  const visit = (n: ts.Node): void => {
    if (ts.isIfStatement(n)) {
      if (names(n.expression)) named.add(n.thenStatement);
      if (allBut(n.expression)) {
        if (n.elseStatement) named.add(n.elseStatement);
        const list = n.parent;
        if (alwaysThrows(n.thenStatement) && (ts.isBlock(list) || ts.isCaseOrDefaultClause(list)))
          for (const after of list.statements.slice(list.statements.indexOf(n) + 1))
            named.add(after);
      }
    } else if (ts.isConditionalExpression(n)) {
      if (names(n.condition)) named.add(n.whenTrue);
      if (allBut(n.condition)) named.add(n.whenFalse);
    } else if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken && names(n.left)) named.add(n.right);
      if (op === ts.SyntaxKind.BarBarToken && allBut(n.left)) named.add(n.right);
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return named;
}

/** True where `node` sits inside one of `named`, below `body`. */
export function onANamedPath(node: ts.Node, body: ts.Node, named: ReadonlySet<ts.Node>): boolean {
  for (let at: ts.Node | undefined = node; at && at !== body; at = at.parent) {
    if (named.has(at)) return true;
  }
  return false;
}

export function isAssignment(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

export function isWrapper(node: ts.Node): node is ts.Expression & { expression: ts.Expression } {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

/** Whether `node` is written: an assignment's target, a destructuring one's, `++`, `delete`. */
export function assignedTo(node: ts.Node): boolean {
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

function symbolAt(node: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  const { parent } = node;
  return ts.isShorthandPropertyAssignment(parent) && parent.name === node
    ? checker.getShorthandAssignmentValueSymbol(parent)
    : checker.getSymbolAtLocation(node);
}

/** Whether `symbol` is written anywhere in its declaring file, past its declaration. */
function rebound(symbol: ts.Symbol, file: ts.SourceFile, checker: ts.TypeChecker): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && assignedTo(n) && symbolAt(n, checker) === symbol) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(file);
  return found;
}

/**
 * Whether the value `symbol` holds can come from `param`: its declaration binds it from an
 * expression reading `param`, or it is a `let`, a `var` or a parameter written past its
 * declaration, whatever it is written with.
 */
function boundFrom(
  symbol: ts.Symbol,
  param: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  const decl = symbol.valueDeclaration;
  if (!decl) return false;
  const holder = ts.isBindingElement(decl) ? ts.walkUpBindingElementsAndPatterns(decl) : decl;
  if (!ts.isVariableDeclaration(holder) && !ts.isParameter(holder)) return false;
  const from = [ts.isBindingElement(decl) ? decl.initializer : undefined, holder.initializer];
  if (from.some((e) => e !== undefined && mentions(e, param, checker, seen))) return true;
  const fixed =
    ts.isVariableDeclaration(holder) &&
    (ts.getCombinedNodeFlags(holder) & ts.NodeFlags.Const) !== 0;
  return !fixed && rebound(symbol, decl.getSourceFile(), checker);
}

/** Whether `node` reads `param`, itself or through a name whose value can come from it. */
export function mentions(
  node: ts.Node,
  param: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol> = new Set(),
): boolean {
  if (ts.isIdentifier(node)) {
    const symbol = symbolAt(node, checker);
    if (symbol === param) return true;
    if (symbol && !seen.has(symbol)) {
      seen.add(symbol);
      if (boundFrom(symbol, param, checker, seen)) return true;
    }
  }
  return ts.forEachChild(node, (c) => mentions(c, param, checker, seen) || undefined) ?? false;
}
