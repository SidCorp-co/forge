/**
 * What the catch scan reads as a guard naming an error: one no class in
 * `lib/db-errors.ts:STATEMENT_ERRORS` passes as a kind, on the error or down its `cause`, by
 * `instanceof`, a `code`, constraint or `name` compared with a value known at compile time, or an
 * `isX(err)` whose one returned expression is such a test; or those joined. The caught error is
 * matched by its binding, never its name. Every guard it does not so recognise is refused like a
 * bare catch, among them one whose body it cannot read and a comparison it cannot resolve.
 *
 * Named residuals: a comparand whose type claims a literal its value does not hold, a class changed
 * by code outside `src`, and a code a TLS layer raises (`ERR_SSL_*`), which no list here holds.
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
  /** Every class `escapedClasses` found used other than by `instanceof`, `new` or `extends`. */
  escaped: ReadonlySet<ts.Symbol>;
}

/** `lib/db-errors.ts:STATEMENT_ERRORS`'s declaration and the array of classes it holds. */
function statementList(program: ts.Program) {
  const decl = program
    .getSourceFile(DB_ERRORS)
    ?.statements.filter(ts.isVariableStatement)
    .flatMap((s) => [...s.declarationList.declarations])
    .find((d) => ts.isIdentifier(d.name) && d.name.text === 'STATEMENT_ERRORS');
  const list = decl?.initializer;
  const items = list && ts.isAsExpression(list) ? list.expression : list;
  if (!decl || !items || !ts.isArrayLiteralExpression(items)) {
    throw new Error(`${DB_ERRORS} no longer declares STATEMENT_ERRORS as an array of classes`);
  }
  return { decl, items };
}

/** The classes `lib/db-errors.ts:STATEMENT_ERRORS` lists, read off the program the scan compiled. */
export function statementErrors(program: ts.Program, checker: ts.TypeChecker): ts.Type[] {
  return statementList(program).items.elements.map((element) => {
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

const EQUAL = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken];
const UNEQUAL = [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken];

/** Whether `node` is the target of an assignment, an increment or a `delete`. */
function isWritten(node: ts.Node): boolean {
  const { parent } = node;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === node &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator)) ||
    ts.isDeleteExpression(parent) ||
    (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) ? isWritten(parent) : false)
  );
}

/**
 * Every name a class in `files` can go by, read off the text so that only those are resolved: each
 * declared, extended or tested by `instanceof`, `Error`, `STATEMENT_ERRORS`, and each name an import
 * or export gives one of them, a default import being any class.
 */
function classNames(files: readonly ts.SourceFile[]): Set<string> {
  const names = new Set(['Error', 'STATEMENT_ERRORS']);
  const renames: Array<[string, string]> = [];
  const add = (e: ts.Expression) => {
    const at = unwrap(e);
    if (ts.isIdentifier(at)) names.add(at.text);
    else if (ts.isPropertyAccessExpression(at)) names.add(at.name.text);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isClassDeclaration(n) && n.name) names.add(n.name.text);
    if (ts.isHeritageClause(n)) for (const t of n.types) add(t.expression);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)
      add(n.right);
    if (ts.isImportClause(n) && n.name) names.add(n.name.text);
    if ((ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) && n.propertyName)
      renames.push([n.propertyName.text, n.name.text]);
    ts.forEachChild(n, visit);
  };
  files.forEach(visit);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [from, to] of renames)
      if (names.has(from) && !names.has(to)) {
        names.add(to);
        grew = true;
      }
  }
  return names;
}

/**
 * Each class some use in `files` could change: its value handed to a call (`Object.defineProperty`
 * among them, `Error.captureStackTrace` excepted), bound to another name, indexed, or written. Its
 * `instanceof` then answers what the change says, and so does a subclass's. `STATEMENT_ERRORS`
 * holding a class is no such use until something reads that list.
 */
export function escapedClasses(
  program: ts.Program,
  files: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
): Set<ts.Symbol> {
  const escaped = new Set<ts.Symbol>();
  const { decl, items } = statementList(program);
  const list = checker.getSymbolAtLocation(decl.name);
  const names = classNames(files);
  const visit = (n: ts.Node): void => {
    ts.forEachChild(n, visit);
    if (!ts.isIdentifier(n) || !names.has(n.text) || ts.isPartOfTypeNode(n)) return;
    if (n.getSourceFile() === items.getSourceFile() && n.pos >= items.pos && n.end <= items.end)
      return;
    const symbol = checker.getSymbolAtLocation(n);
    const own =
      symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    if (own === list && n !== decl.name) {
      for (const kind of statementErrors(program, checker)) {
        const named = kind.getSymbol();
        if (named) escaped.add(named);
      }
    }
    if (!own || !(own.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Variable))) return;
    if (!own.declarations?.some(ts.isClassDeclaration) && !(own.flags & ts.SymbolFlags.Interface))
      return;
    const ref = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n ? n.parent : n;
    let at: ts.Node = ref;
    while (ts.isExpression(at.parent) && unwrap(at.parent) === ref) at = at.parent;
    const { parent } = at;
    const compared =
      ts.isBinaryExpression(parent) &&
      [...EQUAL, ...UNEQUAL, ts.SyntaxKind.InstanceOfKeyword].includes(parent.operatorToken.kind) &&
      (parent.right === at || parent.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword);
    const safe =
      compared ||
      ts.isTypeOfExpression(parent) ||
      ts.isTypeQueryNode(parent) ||
      ts.isExpressionWithTypeArguments(parent) ||
      ts.isQualifiedName(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      (ts.isClassDeclaration(parent) && parent.name === n) ||
      (ts.isNewExpression(parent) && parent.expression === at) ||
      (ts.isPropertyAccessExpression(parent) && parent.expression === at && !isWritten(parent)) ||
      (ts.isCallExpression(parent) &&
        parent.expression.getText() === 'Error.captureStackTrace' &&
        parent.arguments[1] === at);
    if (!safe) escaped.add(own);
  };
  files.forEach(visit);
  return escaped;
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
 * one every function has, which would answer `instanceof` with whatever it likes, nor any class in
 * its chain `escapedClasses` found.
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
  const made = statics.getConstructSignatures()[0]?.getReturnType();
  const kind = made?.getSymbol();
  if (answers || !made || kind === undefined || scan.kinds.has(kind)) return false;
  if ([...withBases([made], scan.checker)].some((k) => scan.escaped.has(k))) return false;
  return !(kind.declarations?.some(lib) && ['Error', 'Object'].includes(kind.name));
}

/**
 * Whether `isX(err)` names an error, read off its body's one returned expression, which runs. No
 * other argument, and no parameter's default, may read the error, which would hand the body a
 * comparand of the error's own.
 */
function helperNamesAnError(call: ts.CallExpression, param: ts.Symbol, scan: Scan, depth: number) {
  const index = call.arguments.findIndex((a) => isParam(a, param, scan));
  const decl = fixedCallee(call, scan);
  if (index === -1 || depth > 3 || !decl || decl.getSourceFile().isDeclarationFile) return false;
  if (call.arguments.some((a, at) => at !== index && mentions(a, param, scan))) return false;
  const params = decl.parameters.flatMap((p) => {
    const s = ts.isIdentifier(p.name) && scan.checker.getSymbolAtLocation(p.name);
    return s ? [s] : [];
  });
  if (
    decl.parameters.some(
      (p) => p.initializer && params.some((s) => mentions(p.initializer as ts.Node, s, scan)),
    )
  )
    return false;
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

function isAssignment(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

/**
 * Every name the caught error is bound to in `body`: the catch's own, and each name a declaration,
 * a `for...of` or an assignment binds to a value mentioning one of them, as `const { cause } = err`.
 */
function aliasesOf(body: ts.Node, param: ts.Symbol, scan: Scan): Set<ts.Symbol> {
  const aliases = new Set([param]);
  let grew = true;
  const bind = (name: ts.Node): void => {
    const e = ts.isExpression(name) ? unwrap(name) : name;
    if (ts.isIdentifier(e)) {
      const symbol = scan.checker.getSymbolAtLocation(e);
      if (symbol && !aliases.has(symbol)) {
        aliases.add(symbol);
        grew = true;
      }
    } else if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))
      bind(e.expression);
    else if (ts.isBindingElement(e)) bind(e.name);
    else if (ts.isPropertyAssignment(e)) bind(e.initializer);
    else if (ts.isShorthandPropertyAssignment(e)) {
      const symbol = scan.checker.getShorthandAssignmentValueSymbol(e);
      if (symbol && !aliases.has(symbol)) {
        aliases.add(symbol);
        grew = true;
      }
    } else if (ts.isSpreadElement(e) || ts.isSpreadAssignment(e)) bind(e.expression);
    else if (isAssignment(e)) bind(e.left);
    else ts.forEachChild(e, bind);
  };
  const fromAlias = (n: ts.Node) => [...aliases].some((a) => mentions(n, a, scan));
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer && fromAlias(n.initializer)) bind(n.name);
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

/**
 * Whether the assignment target `node` changes the caught error: binds `err` itself, or writes a
 * property reached through it or any of its `aliases`, also inside a destructuring pattern. A key
 * that only reads the error, as in `seen[err.message]`, writes something else, and binding an
 * alias anew leaves the error as it was.
 */
function writesTo(node: ts.Node, aliases: ReadonlySet<ts.Symbol>, scan: Scan, through = false) {
  const e: ts.Node = ts.isExpression(node) ? unwrap(node) : node;
  const again = (n: ts.Node, deeper = through): boolean => writesTo(n, aliases, scan, deeper);
  const [param] = aliases;
  if (ts.isIdentifier(e)) {
    const symbol = scan.checker.getSymbolAtLocation(e);
    return symbol === param || (through && symbol !== undefined && aliases.has(symbol));
  }
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))
    return again(e.expression, true);
  if (isAssignment(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) return again(e.left);
  if (ts.isArrayLiteralExpression(e)) return e.elements.some((x) => again(x));
  if (ts.isSpreadElement(e) || ts.isSpreadAssignment(e)) return again(e.expression);
  if (ts.isObjectLiteralExpression(e)) return e.properties.some((x) => again(x));
  if (ts.isPropertyAssignment(e)) return again(e.initializer);
  if (ts.isShorthandPropertyAssignment(e))
    return scan.checker.getShorthandAssignmentValueSymbol(e) === param;
  return false;
}

/** True where `node` holds a write `writesTo` counts; a call handed the error goes unseen. */
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
