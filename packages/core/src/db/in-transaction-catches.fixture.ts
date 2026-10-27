/**
 * A handle is any expression bound outside the guarded code whose declared type, or a type
 * parameter's constraint, a drizzle transaction is assignable to and which carries any member of
 * the transaction, so `Pick<Tx, 'insert'>`, `Pick<Db, 'select'>`, `Tx` and every local executor
 * alias count while the pool's own `Db` does not. A catch passes by calling
 * `rethrowInTransaction(<the error>, <the handle>)` first, or by going on only for an error it
 * names, on every path out of the branch that rethrows, without assigning the caught error first; a
 * `finally` that returns, breaks or continues out of a guarded try swallows whatever the try threw.
 * `EXCEPTIONS` names any allowed to fall back.
 *
 * Which guard counts as naming an error: `in-transaction-guards.fixture.ts`.
 *
 * Named residuals: a statement reached through a helper that closes over the transaction without
 * the guarded code naming any handle, a transaction cast to a type it is not, such as `typeof db`,
 * a call handed the caught error or an alias of it that changes it before the guard reads it, as
 * `Object.assign(err, …)` does, and a rejection handled by anything other than `try`, `.catch(fn)`
 * or `.then(ok, fn)`. The guard reader names its own.
 */

import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  admitsAllButNamed,
  escapedClasses,
  namesAnError,
  reassigns,
  type Scan,
  statementErrors,
  withBases,
} from './in-transaction-guards.fixture.js';

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

function statementsOf(node: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(node) ? node.statements : [node];
}

/** True where `stmts`' last statement throws on every path; `leaves` reads the exits before it. */
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

/**
 * The handler goes on only for errors it named: it opens by throwing every error but a named kind,
 * on every path out of that branch, or every exit from it short of a throw sits under a test naming
 * one.
 */
function exitsOnlyWhenNarrowed(block: ts.Block, param: ts.Symbol | null, scan: Scan): boolean {
  if (param === null) return false;
  const first = block.statements[0];
  if (first && ts.isIfStatement(first) && !first.elseStatement) {
    if (
      admitsAllButNamed(first.expression, param, scan) &&
      endsInThrow(statementsOf(first.thenStatement)) &&
      !leaves(first.thenStatement)
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

function narrowedBy(exit: ts.Node, block: ts.Block, param: ts.Symbol, scan: Scan): boolean {
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

function rethrowsFirst(
  block: ts.Block,
  param: ts.Symbol | null,
  handles: string[],
  scan: Scan,
): boolean {
  const first = block.statements[0];
  if (!first || param === null || !ts.isExpressionStatement(first)) return false;
  const call = first.expression;
  if (!ts.isCallExpression(call) || call.expression.getText() !== 'rethrowInTransaction')
    return false;
  const [err, handle] = call.arguments;
  return (
    err !== undefined &&
    ts.isIdentifier(err) &&
    scan.checker.getSymbolAtLocation(err) === param &&
    handle !== undefined &&
    handles.includes(handle.getText())
  );
}

function paramOf(
  decl: ts.ParameterDeclaration | ts.VariableDeclaration | undefined,
  scan: Scan,
): ts.Symbol | null {
  return (
    (decl && ts.isIdentifier(decl.name) && scan.checker.getSymbolAtLocation(decl.name)) || null
  );
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

/** True where a statement of `block` returns, or breaks or continues to a target outside it. */
function leaves(block: ts.Node): boolean {
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
  let param: ts.Symbol | null;
  if (ts.isBlock(handler) && ts.isTryStatement(handler.parent)) {
    return 'swallows';
  }
  if (ts.isCatchClause(handler)) {
    body = handler.block;
    param = paramOf(handler.variableDeclaration, scan);
  } else if (
    (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
    ts.isBlock(handler.body)
  ) {
    body = handler.body;
    param = paramOf(handler.parameters[0], scan);
  } else {
    return 'swallows';
  }
  if (rethrowsFirst(body, param, handles, scan)) return 'rethrows';
  if (param !== null && reassigns(body, param, scan)) return 'swallows';
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
    if (ts.isTryStatement(n) && n.finallyBlock && leaves(n.finallyBlock)) {
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
  const kinds = withBases(statementErrors(program, checker), checker);
  const files = program
    .getSourceFiles()
    .filter((sf) => sf.fileName.startsWith(`${SRC}/`) && !sf.fileName.includes('/node_modules/'));
  const scan: Scan = {
    program,
    checker,
    tx,
    members,
    kinds,
    names: new Set([...kinds].map((k) => k.name)),
    escaped: escapedClasses(program, files, checker),
  };
  const found: GuardedCatch[] = [];
  for (const sf of files) {
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
