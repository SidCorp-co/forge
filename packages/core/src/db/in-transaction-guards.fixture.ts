/**
 * What the catch scan reads as a guard naming an error. A guard counts as one only where the scan
 * recognises it as one that neither a plain `Error` nor the driver's `PostgresError` passes:
 * `instanceof` a class other than those two and their bases; the error's `code`, constraint or
 * `name` compared with a value known at compile time, read off the error or by `lib/db-errors.ts`'s
 * readers, a `name` never one of those two classes'; an `isX(err)` or `hasX(err)` whose one
 * returned expression is such a test; or those joined. Every guard it does not so recognise is
 * refused like a bare catch, among them one whose body it cannot read, whatever its predicate says,
 * and a comparison with a value it cannot resolve.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const DB_ERRORS = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'db-errors.ts');

/** The readers of `lib/db-errors.ts` a guard may call, by the property of the error each reads. */
const READERS = new Map([
  ['pgErrorCode', 'code'],
  ['pgConstraintName', 'constraint_name'],
]);

/** The properties that tell one error from another. */
const IDENTIFYING = new Set(['code', 'constraint_name', 'constraint', 'name']);

/** What the scan reads every catch against. */
export interface Scan {
  program: ts.Program;
  checker: ts.TypeChecker;
  tx: ts.Type;
  /** Every member of the transaction, any one of which a handle carries. */
  members: ReadonlySet<string>;
  /** Every kind of error a statement on a transaction throws. */
  errors: readonly ts.Type[];
  /** The `name` of each of those kinds, which every error of it carries. */
  names: ReadonlySet<string>;
}

/** The expression under its parentheses, type assertions and non-null marks. */
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;
}

const EQUAL = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken];
const UNEQUAL = [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken];

function isParam(node: ts.Expression, param: string): boolean {
  const e = unwrap(node);
  return ts.isIdentifier(e) && e.text === param;
}

/**
 * The property of the caught error `node` reads: `err.code`, `err['code']`, the same down its
 * `cause` chain, or a reader of `lib/db-errors.ts` given the error.
 */
function propertyRead(node: ts.Expression, param: string, scan: Scan): string | undefined {
  const e = unwrap(node);
  if (ts.isCallExpression(e)) return readerOf(e, param, scan);
  let key: string;
  if (ts.isPropertyAccessExpression(e)) key = e.name.text;
  else if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))
    key = e.argumentExpression.text;
  else return undefined;
  if (isParam(e.expression, param)) return key;
  return propertyRead(e.expression, param, scan) === 'cause' ? key : undefined;
}

function readerOf(call: ts.CallExpression, param: string, scan: Scan): string | undefined {
  const [arg, ...more] = call.arguments;
  if (!arg || more.length > 0 || !isParam(arg, param)) return undefined;
  const decl = scan.checker.getResolvedSignature(call)?.getDeclaration();
  if (!decl || !ts.isFunctionDeclaration(decl) || !decl.name) return undefined;
  return decl.getSourceFile().fileName === DB_ERRORS ? READERS.get(decl.name.text) : undefined;
}

/** The value `node` holds whatever runs, where its type says: a string or number literal type. */
function knownValue(node: ts.Expression, scan: Scan): string | number | undefined {
  const type = scan.checker.getTypeAtLocation(unwrap(node));
  return type.isStringLiteral() || type.isNumberLiteral() ? type.value : undefined;
}

/**
 * One side reads a property that tells errors apart and the other is a value known at compile
 * time, as in `err.code === '23505'`; a `name` is never one every error of a kind carries.
 */
function comparesError(node: ts.BinaryExpression, param: string, scan: Scan): boolean {
  const sides = [
    [node.left, node.right],
    [node.right, node.left],
  ] as const;
  for (const [error, other] of sides) {
    const key = propertyRead(error, param, scan);
    if (key === undefined || !IDENTIFYING.has(key)) continue;
    const value = knownValue(other, scan);
    if (value === undefined) return false;
    return key !== 'name' || !scan.names.has(String(value));
  }
  return false;
}

/** Whether the class an `instanceof` names is declared, and no database error's kind or base. */
function isOwnClass(type: ts.Type, scan: Scan): boolean {
  const symbol = type.getSymbol();
  const decl = symbol?.declarations?.[0];
  if (symbol === undefined || decl === undefined) return false;
  if (scan.errors.some((e) => e.getSymbol() === symbol)) return false;
  return !(
    scan.program.isSourceFileDefaultLibrary(decl.getSourceFile()) &&
    ['Error', 'Object'].includes(symbol.name)
  );
}

/** Whether `isX(err)` names an error, read off its body's one returned expression, which runs. */
function helperNamesAnError(call: ts.CallExpression, param: string, scan: Scan, depth: number) {
  const index = call.arguments.findIndex((a) => isParam(a, param));
  const decl = scan.checker.getResolvedSignature(call)?.getDeclaration();
  if (index === -1 || depth > 3 || !decl || !ts.isFunctionLike(decl)) return false;
  if (decl.getSourceFile().isDeclarationFile) return false;
  const own = decl.parameters[index];
  const body = (decl as ts.FunctionLikeDeclaration).body;
  const returned =
    body && ts.isBlock(body)
      ? body.statements.length === 1 && ts.isReturnStatement(body.statements[0] as ts.Statement)
        ? (body.statements[0] as ts.ReturnStatement).expression
        : undefined
      : body;
  return (
    own !== undefined &&
    ts.isIdentifier(own.name) &&
    returned !== undefined &&
    namesAnError(returned, own.name.text, scan, depth + 1)
  );
}

/**
 * True only for a test the scan recognises as holding of a named kind of error: `err instanceof X`
 * for a class of its own, an `isX(err)` or `hasX(err)` whose body is one, a comparison of what
 * tells errors apart with a known value, or a conjunction or disjunction of those.
 */
export function namesAnError(node: ts.Expression, param: string, scan: Scan, depth = 0): boolean {
  const e = unwrap(node);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.InstanceOfKeyword) {
      if (!isParam(e.left, param) && propertyRead(e.left, param, scan) !== 'cause') return false;
      const made = scan.checker.getTypeAtLocation(e.right).getConstructSignatures()[0];
      return made !== undefined && isOwnClass(made.getReturnType(), scan);
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return namesAnError(e.left, param, scan, depth) || namesAnError(e.right, param, scan, depth);
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      return namesAnError(e.left, param, scan, depth) && namesAnError(e.right, param, scan, depth);
    }
    return EQUAL.includes(op) && comparesError(e, param, scan);
  }
  if (ts.isCallExpression(e)) {
    const callee = ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression;
    return (
      ts.isIdentifier(callee) &&
      /^(is|has)[A-Z]/.test(callee.text) &&
      helperNamesAnError(e, param, scan, depth)
    );
  }
  return false;
}

export function admitsAllButNamed(node: ts.Expression, param: string, scan: Scan): boolean {
  const e = unwrap(node);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    return namesAnError(e.operand, param, scan);
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken) {
      return admitsAllButNamed(e.left, param, scan) && admitsAllButNamed(e.right, param, scan);
    }
    return UNEQUAL.includes(op) && comparesError(e, param, scan);
  }
  return false;
}
