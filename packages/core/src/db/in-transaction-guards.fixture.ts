/**
 * What the catch scan reads as a guard naming an error. A guard counts as one only where the scan
 * recognises it as one that no error in `lib/db-errors.ts:STATEMENT_ERRORS` passes as a kind: drizzle's
 * `DrizzleQueryError` and `TransactionRollbackError`, the driver's `PostgresError` and a plain
 * `Error`. That is `instanceof` a class
 * other than those and their bases, bound by a class declaration and carrying no `Symbol.hasInstance`
 * of its own; the error's `code`, constraint or `name` compared with a value known at compile time,
 * read off the error or by `lib/db-errors.ts`'s readers, a `name` never one of those classes', a code
 * never one of `SESSION_ENDED_CODES`; an `isX(err)` or `hasX(err)` bound by a function declaration or
 * a `const`, whose one returned expression is such a test; or those joined. A read through `cause` is
 * held to the same list, since a caller may wrap a wrapped error again. The caught error is matched
 * by its binding, never by its name, so an inner `err` shadowing it is a different value. Every guard
 * it does not so recognise is refused like a bare catch, among them one whose body it cannot read,
 * whatever its predicate says, and a comparison with a value it cannot resolve.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { SESSION_ENDED_CODES } from '../lib/db-errors.js';

const DB_ERRORS = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'db-errors.ts');

/** The readers of `lib/db-errors.ts` a guard may call, by the property of the error each reads. */
const READERS = new Map([
  ['pgErrorCode', 'code'],
  ['pgConstraintName', 'constraint_name'],
]);

const IDENTIFYING = new Set(['code', 'constraint_name', 'constraint', 'name']);

/** What the scan reads every catch against. */
export interface Scan {
  program: ts.Program;
  checker: ts.TypeChecker;
  tx: ts.Type;
  /** Every member of the transaction, any one of which a handle carries. */
  members: ReadonlySet<string>;
  /** Every class a statement on a transaction throws, and each of their bases. */
  kinds: ReadonlySet<ts.Symbol>;
  /** The `name` of each of those classes. */
  names: ReadonlySet<string>;
}

/** The classes `lib/db-errors.ts:STATEMENT_ERRORS` lists, read off the program the scan compiled. */
export function statementErrors(program: ts.Program, checker: ts.TypeChecker): ts.Type[] {
  const list = program
    .getSourceFile(DB_ERRORS)
    ?.statements.filter(ts.isVariableStatement)
    .flatMap((s) => [...s.declarationList.declarations])
    .find((d) => ts.isIdentifier(d.name) && d.name.text === 'STATEMENT_ERRORS')?.initializer;
  const items = list && ts.isAsExpression(list) ? list.expression : list;
  if (!items || !ts.isArrayLiteralExpression(items)) {
    throw new Error(`${DB_ERRORS} no longer declares STATEMENT_ERRORS as an array of classes`);
  }
  return items.elements.map((element) => {
    const made = checker.getTypeAtLocation(element).getConstructSignatures()[0];
    if (!made) throw new Error(`STATEMENT_ERRORS lists ${element.getText()}, which is no class`);
    return made.getReturnType();
  });
}

/** Each class in `errors` and every class it extends. */
export function withBases(errors: readonly ts.Type[], checker: ts.TypeChecker): Set<ts.Symbol> {
  const found = new Set<ts.Symbol>();
  const visit = (type: ts.Type): void => {
    const symbol = type.getSymbol();
    if (!symbol || found.has(symbol)) return;
    found.add(symbol);
    if (type.isClassOrInterface()) checker.getBaseTypes(type).forEach(visit);
  };
  errors.forEach(visit);
  return found;
}

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

function isParam(node: ts.Expression, param: ts.Symbol, scan: Scan): boolean {
  const e = unwrap(node);
  return ts.isIdentifier(e) && scan.checker.getSymbolAtLocation(e) === param;
}

/** The symbol an imported name stands for, or `symbol` itself. */
function resolved(symbol: ts.Symbol | undefined, scan: Scan): ts.Symbol | undefined {
  return symbol && symbol.flags & ts.SymbolFlags.Alias
    ? scan.checker.getAliasedSymbol(symbol)
    : symbol;
}

/** The symbol `node` names, where it is a name or a property access and nothing computed or cast. */
function named(node: ts.Expression, scan: Scan): ts.Symbol | undefined {
  const name = ts.isIdentifier(node)
    ? node
    : ts.isPropertyAccessExpression(node)
      ? node.name
      : undefined;
  return name && resolved(scan.checker.getSymbolAtLocation(name), scan);
}

/**
 * The function `call` runs, where its callee is bound for good: a function declaration, or a
 * `const` holding a function. A `let`, a property or anything else may hold another by the time it
 * runs, so the body the scan would read is not the one that answers.
 */
function fixedCallee(call: ts.CallExpression, scan: Scan): ts.FunctionLikeDeclaration | undefined {
  const decl = named(call.expression, scan)?.valueDeclaration;
  let fn: ts.FunctionLikeDeclaration | undefined;
  if (decl && ts.isFunctionDeclaration(decl)) fn = decl;
  else if (
    decl &&
    ts.isVariableDeclaration(decl) &&
    ts.isVariableDeclarationList(decl.parent) &&
    decl.parent.flags & ts.NodeFlags.Const &&
    decl.initializer &&
    (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
  )
    fn = decl.initializer;
  return fn && scan.checker.getResolvedSignature(call)?.getDeclaration() === fn ? fn : undefined;
}

/**
 * The property of the caught error `node` reads: `err.code`, `err['code']`, the same down its
 * `cause` chain, or a reader of `lib/db-errors.ts` given the error.
 */
function propertyRead(node: ts.Expression, param: ts.Symbol, scan: Scan): string | undefined {
  const e = unwrap(node);
  if (ts.isCallExpression(e)) return readerOf(e, param, scan);
  let key: string;
  if (ts.isPropertyAccessExpression(e)) key = e.name.text;
  else if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))
    key = e.argumentExpression.text;
  else return undefined;
  if (isParam(e.expression, param, scan)) return key;
  return propertyRead(e.expression, param, scan) === 'cause' ? key : undefined;
}

function readerOf(call: ts.CallExpression, param: ts.Symbol, scan: Scan): string | undefined {
  const [arg, ...more] = call.arguments;
  if (!arg || more.length > 0 || !isParam(arg, param, scan)) return undefined;
  const decl = fixedCallee(call, scan);
  if (!decl || !ts.isFunctionDeclaration(decl) || !decl.name) return undefined;
  return decl.getSourceFile().fileName === DB_ERRORS ? READERS.get(decl.name.text) : undefined;
}

/** The value `node` holds whatever runs, where its type says: a string or number literal type. */
function knownValue(node: ts.Expression, scan: Scan): string | number | undefined {
  const type = scan.checker.getTypeAtLocation(unwrap(node));
  return type.isStringLiteral() || type.isNumberLiteral() ? type.value : undefined;
}

function mentions(node: ts.Node, param: ts.Symbol, scan: Scan): boolean {
  if (ts.isIdentifier(node) && scan.checker.getSymbolAtLocation(node) === param) return true;
  return ts.forEachChild(node, (c) => mentions(c, param, scan) || undefined) ?? false;
}

/**
 * `err.code === '23505'`: the other side reads nothing of the error, a `name` is no statement
 * error's, and a code is not one the error carries when the session ended.
 */
function comparesError(node: ts.BinaryExpression, param: ts.Symbol, scan: Scan): boolean {
  const sides = [
    [node.left, node.right],
    [node.right, node.left],
  ] as const;
  for (const [error, other] of sides) {
    const key = propertyRead(error, param, scan);
    if (key === undefined || !IDENTIFYING.has(key)) continue;
    const value = mentions(other, param, scan) ? undefined : knownValue(other, scan);
    if (value === undefined) return false;
    if (key === 'name') return !scan.names.has(String(value));
    return key !== 'code' || !SESSION_ENDED_CODES.has(String(value));
  }
  return false;
}

/**
 * Whether `right` names a class no statement error is: bound by a class declaration, or a default
 * library's, not one of those errors or their bases, and with no `Symbol.hasInstance` beside the
 * one every function has, which would answer `instanceof` with whatever it likes.
 */
function namesOwnClass(right: ts.Expression, scan: Scan): boolean {
  const symbol = named(right, scan);
  const decl = symbol?.valueDeclaration;
  const lib = (n: ts.Node) => scan.program.isSourceFileDefaultLibrary(n.getSourceFile());
  if (
    !symbol ||
    !decl ||
    !(ts.isClassDeclaration(decl) || (ts.isVariableDeclaration(decl) && lib(decl)))
  )
    return false;
  const statics = scan.checker.getTypeOfSymbolAtLocation(symbol, right);
  const answers = statics
    .getProperties()
    .some(
      (p) => p.escapedName.toString().startsWith('__@hasInstance') && !p.declarations?.every(lib),
    );
  const kind = statics.getConstructSignatures()[0]?.getReturnType().getSymbol();
  if (answers || kind === undefined || scan.kinds.has(kind)) return false;
  return !(kind.declarations?.some(lib) && ['Error', 'Object'].includes(kind.name));
}

/**
 * Whether `isX(err)` names an error, read off its body's one returned expression, which runs. No
 * other argument may read the error, which would hand the body a comparand of the error's own.
 */
function helperNamesAnError(call: ts.CallExpression, param: ts.Symbol, scan: Scan, depth: number) {
  const index = call.arguments.findIndex((a) => isParam(a, param, scan));
  const decl = fixedCallee(call, scan);
  if (index === -1 || depth > 3 || !decl || decl.getSourceFile().isDeclarationFile) return false;
  if (call.arguments.some((a, at) => at !== index && mentions(a, param, scan))) return false;
  const own = decl.parameters[index];
  const body = decl.body;
  const returned =
    body && ts.isBlock(body)
      ? body.statements.length === 1 && ts.isReturnStatement(body.statements[0] as ts.Statement)
        ? (body.statements[0] as ts.ReturnStatement).expression
        : undefined
      : body;
  const ownSymbol = own && ts.isIdentifier(own.name) && scan.checker.getSymbolAtLocation(own.name);
  return (
    !!ownSymbol && returned !== undefined && namesAnError(returned, ownSymbol, scan, depth + 1)
  );
}

export function namesAnError(
  node: ts.Expression,
  param: ts.Symbol,
  scan: Scan,
  depth = 0,
): boolean {
  const e = unwrap(node);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.InstanceOfKeyword) {
      if (!isParam(e.left, param, scan) && propertyRead(e.left, param, scan) !== 'cause')
        return false;
      return namesOwnClass(e.right, scan);
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

export function admitsAllButNamed(node: ts.Expression, param: ts.Symbol, scan: Scan): boolean {
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

/**
 * Whether the assignment target `node` writes the caught error or something reached through it:
 * `err`, `err.code`, `err['cause'].code`, or `err` inside a destructuring pattern. A key that only
 * reads the error, as in `seen[err.message]`, writes something else.
 */
function writesTo(node: ts.Node, param: ts.Symbol, scan: Scan): boolean {
  const e = ts.isExpression(node) ? unwrap(node) : node;
  if (ts.isIdentifier(e)) return scan.checker.getSymbolAtLocation(e) === param;
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))
    return writesTo(e.expression, param, scan);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    return writesTo(e.left, param, scan);
  if (ts.isArrayLiteralExpression(e)) return e.elements.some((x) => writesTo(x, param, scan));
  if (ts.isSpreadElement(e) || ts.isSpreadAssignment(e)) return writesTo(e.expression, param, scan);
  if (ts.isObjectLiteralExpression(e)) return e.properties.some((x) => writesTo(x, param, scan));
  if (ts.isPropertyAssignment(e)) return writesTo(e.initializer, param, scan);
  if (ts.isShorthandPropertyAssignment(e))
    return scan.checker.getShorthandAssignmentValueSymbol(e) === param;
  return false;
}

/**
 * Whether anything in `node` assigns the caught error or a property reached through it, so a later
 * read may not be what was thrown. A call handed the error may change it too, which this does not
 * see.
 */
export function reassigns(node: ts.Node, param: ts.Symbol, scan: Scan): boolean {
  const target = (n: ts.Node) => writesTo(n, param, scan);
  if (
    (ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      target(node.left)) ||
    ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
      target(node.operand)) ||
    ((ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      target(node.initializer))
  )
    return true;
  return ts.forEachChild(node, (c) => reassigns(c, param, scan) || undefined) ?? false;
}
