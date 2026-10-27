/**
 * A handle is any expression bound outside the guarded code whose declared type, or a type
 * parameter's constraint, a drizzle transaction is assignable to and which carries any member of
 * the transaction, so `Pick<Tx, 'insert'>`, `Pick<Db, 'select'>`, `Tx` and every local executor
 * alias count while the pool's own `Db` does not. A catch passes by calling
 * `rethrowInTransaction(<the error>, <the handle>)` first, or by going on only for an error it
 * names; a `finally` that returns, breaks or continues out of a guarded try swallows whatever the
 * try threw. `EXCEPTIONS` names any allowed to fall back.
 *
 * Named residuals: a statement reached through a helper that closes over the transaction without
 * the guarded code naming any handle, a transaction cast to a type it is not, such as `typeof db`,
 * a rejection handled by anything other than `try`, `.catch(fn)` or `.then(ok, fn)`, and a guard
 * whose body the scan cannot read, judged by a predicate nothing checks at run time.
 */

import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const TX_SOURCE = join(SRC, 'db', 'client.ts');

/** A catch that may fall back inside a transaction, each with why it is allowed to. */
export const EXCEPTIONS: ReadonlyArray<{ at: string; reason: string }> = [];

export interface GuardedCatch {
  file: string;
  line: number;
  fn: string;
  handles: string[];
  handler: 'rethrows' | 'narrowed' | 'swallows';
}

function sourceFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFilesIn(path));
    else if (/\.ts$/.test(entry.name) && !/\.(test|fixture|d)\.ts$/.test(entry.name))
      out.push(path);
  }
  return out;
}

export function buildProgram(plants: ReadonlyMap<string, string> = new Map()): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    types: ['node'],
  };
  const host = ts.createCompilerHost(options, true);
  const overlay = new Map([...plants].map(([f, text]) => [join(SRC, f), text]));
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (fn) => overlay.get(fn) ?? readFile(fn);
  host.fileExists = (fn) => overlay.has(fn) || fileExists(fn);
  host.getSourceFile = (fn, version, onError, create) => {
    const text = overlay.get(fn);
    return text === undefined
      ? getSourceFile(fn, version, onError, create)
      : ts.createSourceFile(fn, text, version, true, ts.ScriptKind.TS);
  };
  return ts.createProgram([...sourceFilesIn(SRC), ...overlay.keys()], options, host);
}

/** The transaction constituent of `Tx`: the one carrying `rollback`. */
function transactionType(program: ts.Program, checker: ts.TypeChecker): ts.Type {
  const sf = program.getSourceFile(TX_SOURCE);
  const alias = sf?.statements.find(
    (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === 'Tx',
  );
  if (!alias) throw new Error(`${TX_SOURCE} no longer declares the type alias Tx`);
  const tx = checker.getTypeAtLocation(alias.name);
  const found = tx.isUnion() ? tx.types.find((t) => t.getProperty('rollback')) : undefined;
  if (!found) throw new Error('Tx no longer has a constituent carrying rollback()');
  return found;
}

function within(node: ts.Node, outer: ts.Node): boolean {
  return node.pos >= outer.pos && node.end <= outer.end;
}

function isNestedFunction(node: ts.Node): boolean {
  return ts.isFunctionLike(node) && !ts.isCallSignatureDeclaration(node);
}

/**
 * What a statement on a transaction can throw: the server's `PostgresError`, and the plain `Error`
 * the driver raises for a connection it lost, as `CONNECTION_CLOSED`.
 */
function everyDatabaseError(program: ts.Program, checker: ts.TypeChecker): ts.Type[] {
  const sf = program.getSourceFile(TX_SOURCE);
  const error = sf && checker.resolveName('Error', sf, ts.SymbolFlags.Type, false);
  if (!error) throw new Error('the default library no longer declares Error');
  const driver = sf?.statements
    .filter(ts.isImportDeclaration)
    .find((s) => ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === 'postgres')
    ?.importClause?.name;
  const imported = driver && checker.getSymbolAtLocation(driver);
  const server =
    imported && checker.getAliasedSymbol(imported).exports?.get('PostgresError' as ts.__String);
  if (!server) {
    throw new Error(`${TX_SOURCE} no longer imports postgres, whose PostgresError the scan reads`);
  }
  return [checker.getDeclaredTypeOfSymbol(error), checker.getDeclaredTypeOfSymbol(server)];
}

/** What the scan reads every catch against. */
interface Scan {
  program: ts.Program;
  checker: ts.TypeChecker;
  tx: ts.Type;
  /** Every member of the transaction, any one of which a handle carries. */
  members: ReadonlySet<string>;
  /** Every kind of error a statement on a transaction throws. */
  errors: readonly ts.Type[];
}

/** The expressions in `guarded` that name a handle bound outside it. */
function handlesIn(guarded: ts.Node, scan: Scan): string[] {
  const found = new Set<string>();
  const visit = (n: ts.Node): void => {
    const candidate =
      (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) ||
      ts.isPropertyAccessExpression(n);
    if (candidate && isHandle(n as ts.Expression, guarded, scan)) found.add(n.getText());
    ts.forEachChild(n, visit);
  };
  visit(guarded);
  return [...found];
}

function isHandle(node: ts.Expression, guarded: ts.Node, scan: Scan): boolean {
  const { checker } = scan;
  const symbol = checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(node) ? node.name : node,
  );
  if (!symbol || !(symbol.flags & ts.SymbolFlags.Value)) return false;
  const declared = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declared || within(declared, guarded)) return false;
  const seen = checker.getTypeAtLocation(node);
  const type =
    seen.flags & ts.TypeFlags.TypeParameter
      ? (checker.getBaseConstraintOfType(seen) ?? seen)
      : seen;
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter))
    return false;
  if (!type.getProperties().some((p) => scan.members.has(p.name))) return false;
  return checker.isTypeAssignableTo(scan.tx, type);
}

function mentions(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node) && node.text === name) return true;
  return ts.forEachChild(node, (c) => mentions(c, name) || undefined) ?? false;
}

function statementsOf(node: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(node) ? node.statements : [node];
}

/** True where control cannot leave `stmts` normally: its last statement throws on every path. */
function endsInThrow(stmts: readonly ts.Statement[]): boolean {
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

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
}

const EQUAL = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken];
const UNEQUAL = [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken];

/** `null`, `undefined` or `void x`: a value every error differs from, so naming none. */
function isNothing(node: ts.Expression): boolean {
  const e = unwrap(node);
  return (
    e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(e) && e.text === 'undefined') ||
    ts.isVoidExpression(e)
  );
}

/** `err.name` against `'Error'`, or `err.constructor` against `Error`. */
function isEveryErrorsOwn(error: ts.Expression, other: ts.Expression, scan: Scan): boolean {
  const e = unwrap(error);
  const o = unwrap(other);
  const prop = ts.isPropertyAccessExpression(e) ? e.name.text : undefined;
  if (prop === 'name' && ts.isStringLiteralLike(o)) {
    return ['Error', 'Object'].includes(o.text);
  }
  if (prop === 'constructor') {
    const made = scan.checker.getTypeAtLocation(o).getConstructSignatures()[0];
    return made !== undefined && isEveryErrorClass(made.getReturnType(), scan);
  }
  return false;
}

/**
 * One side names the caught error and the other is a value, as in `err.code === '23505'`; never
 * `typeof err`, which every error of a type shares, a comparison with nothing, or one with the name
 * or constructor every error shares.
 */
function comparesError(node: ts.BinaryExpression, param: string, scan: Scan): boolean {
  const [error, other] = mentions(node.left, param)
    ? [node.left, node.right]
    : [node.right, node.left];
  if (!mentions(error, param) || mentions(other, param)) return false;
  return (
    !ts.isTypeOfExpression(unwrap(error)) &&
    !isNothing(other) &&
    !isEveryErrorsOwn(error, other, scan)
  );
}

/** Read by name and not by shape, as `instanceof` reads the prototype chain. */
function isEveryErrorClass(type: ts.Type, scan: Scan): boolean {
  const symbol = type.getSymbol();
  const decl = symbol?.declarations?.[0];
  if (decl === undefined) return false;
  if (scan.errors.some((e) => e.getSymbol() === symbol)) return true;
  return (
    scan.program.isSourceFileDefaultLibrary(decl.getSourceFile()) &&
    ['Error', 'Object'].includes(symbol?.name ?? '')
  );
}

/**
 * Whether a type predicate's type holds of every database error, read by shape since a predicate
 * is checked by nothing at run time: some kind the scan knows is assignable to it, or it requires
 * no property at all, as `Record<string, unknown>` and `{ code?: string }` do.
 */
function holdsOfEveryError(type: ts.Type, scan: Scan): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive))
    return true;
  if (type.isUnion()) return type.types.some((t) => holdsOfEveryError(t, scan));
  if (type.isIntersection()) return type.types.every((t) => holdsOfEveryError(t, scan));
  if (scan.errors.some((e) => scan.checker.isTypeAssignableTo(e, type))) return true;
  return (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    type.getCallSignatures().length === 0 &&
    type.getProperties().every((p) => (p.flags & ts.SymbolFlags.Optional) !== 0)
  );
}

/**
 * Whether `isX(err)` holds of a named kind of error, read off its own body where that is one
 * returned expression, since that is what runs; else off its predicate, which must leave out some
 * database error. A helper with neither names none.
 */
function helperNamesAnError(call: ts.CallExpression, param: string, scan: Scan, depth: number) {
  const signature = scan.checker.getResolvedSignature(call);
  const decl = signature?.getDeclaration();
  const index = call.arguments.findIndex((a) => mentions(a, param));
  const own = decl?.parameters[index];
  const body =
    decl && !decl.getSourceFile().isDeclarationFile && ts.isFunctionLike(decl)
      ? (decl as ts.FunctionLikeDeclaration).body
      : undefined;
  const returned =
    body && ts.isBlock(body)
      ? body.statements.length === 1 && ts.isReturnStatement(body.statements[0] as ts.Statement)
        ? (body.statements[0] as ts.ReturnStatement).expression
        : undefined
      : body;
  if (own && ts.isIdentifier(own.name) && returned && depth <= 3) {
    return namesAnError(returned, own.name.text, scan, depth + 1);
  }
  const predicate = signature && scan.checker.getTypePredicateOfSignature(signature);
  return predicate?.type !== undefined && !holdsOfEveryError(predicate.type, scan);
}

/**
 * True only for a test that holds of a named kind of error: `err instanceof X` for an `X` that is
 * not `Error` or `Object`, an `isX(err)` or `hasX(err)` whose predicate or body names one, a
 * comparison of the error with a value, or a conjunction of those.
 */
function namesAnError(node: ts.Expression, param: string, scan: Scan, depth = 0): boolean {
  const e = unwrap(node);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.InstanceOfKeyword) {
      if (!mentions(e.left, param)) return false;
      const made = scan.checker.getTypeAtLocation(e.right).getConstructSignatures()[0];
      return made === undefined || !isEveryErrorClass(made.getReturnType(), scan);
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return namesAnError(e.left, param, scan, depth) || namesAnError(e.right, param, scan, depth);
    }
    return EQUAL.includes(op) && comparesError(e, param, scan);
  }
  if (ts.isCallExpression(e)) {
    const callee = ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression;
    return (
      ts.isIdentifier(callee) &&
      /^(is|has)[A-Z]/.test(callee.text) &&
      e.arguments.some((a) => mentions(a, param)) &&
      helperNamesAnError(e, param, scan, depth)
    );
  }
  return false;
}

function admitsAllButNamed(node: ts.Expression, param: string, scan: Scan): boolean {
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
 * The handler goes on only for errors it named: it opens by throwing every error but a named kind,
 * or every exit from it short of a throw sits under a test naming one.
 */
function exitsOnlyWhenNarrowed(block: ts.Block, param: string | null, scan: Scan): boolean {
  if (param === null) return false;
  const first = block.statements[0];
  if (first && ts.isIfStatement(first) && !first.elseStatement) {
    if (
      admitsAllButNamed(first.expression, param, scan) &&
      endsInThrow(statementsOf(first.thenStatement))
    )
      return true;
  }
  if (!endsInThrow(block.statements)) return false;
  let ok = true;
  const visit = (n: ts.Node): void => {
    if (!ok || isNestedFunction(n)) return;
    if (ts.isReturnStatement(n) || ts.isBreakStatement(n) || ts.isContinueStatement(n)) {
      ok = narrowedBy(n, block, param, scan);
      return;
    }
    ts.forEachChild(n, visit);
  };
  block.statements.forEach(visit);
  return ok;
}

function narrowedBy(exit: ts.Node, block: ts.Block, param: string, scan: Scan): boolean {
  for (let at = exit.parent; at && at !== block; at = at.parent) {
    if (
      ts.isIfStatement(at) &&
      within(exit, at.thenStatement) &&
      namesAnError(at.expression, param, scan)
    ) {
      return true;
    }
  }
  return false;
}

function rethrowsFirst(block: ts.Block, param: string | null, handles: string[]): boolean {
  const first = block.statements[0];
  if (!first || param === null || !ts.isExpressionStatement(first)) return false;
  const call = first.expression;
  if (!ts.isCallExpression(call) || call.expression.getText() !== 'rethrowInTransaction')
    return false;
  const [err, handle] = call.arguments;
  return err?.getText() === param && handle !== undefined && handles.includes(handle.getText());
}

function paramOf(
  decl: ts.ParameterDeclaration | ts.VariableDeclaration | undefined,
): string | null {
  return decl && ts.isIdentifier(decl.name) ? decl.name.text : null;
}

/** True where a jump in `block` lands on a statement inside it: its label's, or its loop or switch. */
function landsInside(jump: ts.BreakOrContinueStatement, block: ts.Block): boolean {
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

/** True where a statement of `block` returns, or breaks or continues to a target outside it. */
function leavesBlock(block: ts.Block): boolean {
  let leaves = false;
  const visit = (n: ts.Node): void => {
    if (leaves || isNestedFunction(n)) return;
    if (
      ts.isReturnStatement(n) ||
      ((ts.isBreakStatement(n) || ts.isContinueStatement(n)) && !landsInside(n, block))
    ) {
      leaves = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(block);
  return leaves;
}

function handlerKind(handler: ts.Node, handles: string[], scan: Scan): GuardedCatch['handler'] {
  let body: ts.Block;
  let param: string | null;
  if (ts.isBlock(handler) && ts.isTryStatement(handler.parent)) {
    return 'swallows';
  }
  if (ts.isCatchClause(handler)) {
    body = handler.block;
    param = paramOf(handler.variableDeclaration);
  } else if (
    (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
    ts.isBlock(handler.body)
  ) {
    body = handler.body;
    param = paramOf(handler.parameters[0]);
  } else {
    return 'swallows';
  }
  if (rethrowsFirst(body, param, handles)) return 'rethrows';
  return exitsOnlyWhenNarrowed(body, param, scan) ? 'narrowed' : 'swallows';
}

function enclosingName(node: ts.Node): string {
  for (let at = node.parent; at; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name) {
      return at.name.getText();
    }
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
  }
  return '<module>';
}

/**
 * Each guarded statement and its handler: `try`, `.catch(fn)`, `.then(ok, fn)`, and a `finally`
 * that leaves its block, which ends whatever the try threw.
 */
function catchSites(sf: ts.SourceFile): Array<{ at: ts.Node; guarded: ts.Node; handler: ts.Node }> {
  const sites: Array<{ at: ts.Node; guarded: ts.Node; handler: ts.Node }> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isTryStatement(n) && n.catchClause) {
      sites.push({ at: n.catchClause, guarded: n.tryBlock, handler: n.catchClause });
    }
    if (ts.isTryStatement(n) && n.finallyBlock && leavesBlock(n.finallyBlock)) {
      sites.push({ at: n.finallyBlock, guarded: n.tryBlock, handler: n.finallyBlock });
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      const handler =
        method === 'catch' ? n.arguments[0] : method === 'then' ? n.arguments[1] : undefined;
      if (handler) sites.push({ at: n.expression.name, guarded: n.expression.expression, handler });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

/** Every catch guarding a statement on a handle that can be a transaction, with its handler's kind. */
export function guardedCatches(program: ts.Program): GuardedCatch[] {
  const checker = program.getTypeChecker();
  const tx = transactionType(program, checker);
  const members = new Set(tx.getProperties().map((p) => p.name));
  const scan: Scan = {
    program,
    checker,
    tx,
    members,
    errors: everyDatabaseError(program, checker),
  };
  const found: GuardedCatch[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(`${SRC}/`) || sf.fileName.includes('/node_modules/')) continue;
    for (const site of catchSites(sf)) {
      const handles = handlesIn(site.guarded, scan);
      if (handles.length === 0) continue;
      found.push({
        file: relative(SRC, sf.fileName),
        line: sf.getLineAndCharacterOfPosition(site.at.getStart(sf)).line + 1,
        fn: enclosingName(site.at),
        handles,
        handler: handlerKind(site.handler, handles, scan),
      });
    }
  }
  return found;
}

/**
 * The catches that fall back inside a transaction and that `EXCEPTIONS` does not name, each as
 * `file:line fn`, plus every exception that names no such catch any more.
 */
export function refusals(
  catches: GuardedCatch[],
  exceptions: ReadonlyArray<{ at: string; reason: string }> = EXCEPTIONS,
): string[] {
  const swallows = catches.filter((c) => c.handler === 'swallows');
  const at = (c: GuardedCatch) => `${c.file}:${c.fn}`;
  const named = new Set(exceptions.map((e) => e.at));
  return [
    ...swallows
      .filter((c) => !named.has(at(c)))
      .map(
        (c) =>
          `${c.file}:${c.line} ${c.fn} catches a statement on ${c.handles.join(', ')}, which can be a transaction, and can fall back without rethrowInTransaction(<the error>, <the handle>) as its first statement`,
      ),
    ...[...named]
      .filter((n) => !swallows.some((c) => at(c) === n))
      .map((n) => `EXCEPTIONS names ${n}, where no catch falls back any more`),
  ];
}
