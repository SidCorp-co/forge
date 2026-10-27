/**
 * Which paths through a catch an error reaches: where a block throws on every path, where it leaves,
 * and which of its parts only an error the catch names can reach.
 */

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

/** True where `branch` throws on every path and leaves by no other way. */
export function alwaysThrows(branch: ts.Statement): boolean {
  return endsInThrow(statementsOf(branch)) && !leaves(branch);
}

/**
 * The parts of `body` only an error the catch names can reach: the branch an `if`, `?:` or `&&`
 * takes on a test that `names` one; the other branch of a test that `allBut` holds of every error
 * but a named kind, `else`, `?:`'s second or `||`'s right; and each statement after an `if` on such
 * a test whose branch throws on every path. Everything else is a path any error can take.
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
