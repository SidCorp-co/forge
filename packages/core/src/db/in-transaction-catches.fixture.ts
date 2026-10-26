/**
 * A handle is any expression bound outside the guarded code whose declared type a drizzle
 * transaction is assignable to and which carries `select` or `execute`, so `Pick<Db, 'select'>`,
 * `Tx` and every local executor alias count while the pool's own `Db` does not. A catch passes by
 * calling `rethrowInTransaction(<the error>, <the handle>)` first, or by `EXCEPTIONS` naming it.
 *
 * Named residuals: a statement reached through a helper that closes over the transaction without
 * the guarded code naming any handle, and a rejection handled by anything other than `try`,
 * `.catch(fn)` or `.then(ok, fn)`.
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

/** The expressions in `guarded` that name a handle bound outside it. */
function handlesIn(guarded: ts.Node, checker: ts.TypeChecker, tx: ts.Type): string[] {
  const found = new Set<string>();
  const visit = (n: ts.Node): void => {
    const candidate =
      (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) ||
      ts.isPropertyAccessExpression(n);
    if (candidate && isHandle(n as ts.Expression, guarded, checker, tx)) found.add(n.getText());
    ts.forEachChild(n, visit);
  };
  visit(guarded);
  return [...found];
}

function isHandle(
  node: ts.Expression,
  guarded: ts.Node,
  checker: ts.TypeChecker,
  tx: ts.Type,
): boolean {
  const symbol = checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(node) ? node.name : node,
  );
  if (!symbol || !(symbol.flags & ts.SymbolFlags.Value)) return false;
  const declared = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declared || within(declared, guarded)) return false;
  const type = checker.getTypeAtLocation(node);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  if (!type.getProperty('select') && !type.getProperty('execute')) return false;
  return checker.isTypeAssignableTo(tx, type);
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

/**
 * The handler goes on only for errors it named: it opens by throwing whatever a condition on the
 * caught error does not admit, or every exit from it short of a throw sits under such a condition.
 */
function exitsOnlyWhenNarrowed(block: ts.Block, param: string | null): boolean {
  const first = block.statements[0];
  if (param !== null && first && ts.isIfStatement(first) && !first.elseStatement) {
    if (mentions(first.expression, param) && endsInThrow(statementsOf(first.thenStatement)))
      return true;
  }
  if (!endsInThrow(block.statements)) return false;
  let ok = true;
  const visit = (n: ts.Node): void => {
    if (!ok || isNestedFunction(n)) return;
    if (ts.isReturnStatement(n) || ts.isBreakStatement(n) || ts.isContinueStatement(n)) {
      ok = param !== null && narrowedBy(n, block, param);
      return;
    }
    ts.forEachChild(n, visit);
  };
  block.statements.forEach(visit);
  return ok;
}

function narrowedBy(exit: ts.Node, block: ts.Block, param: string): boolean {
  for (let at = exit.parent; at && at !== block; at = at.parent) {
    if (ts.isIfStatement(at) && within(exit, at.thenStatement) && mentions(at.expression, param)) {
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

function handlerKind(handler: ts.Node, handles: string[]): GuardedCatch['handler'] {
  let body: ts.Block;
  let param: string | null;
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
  return exitsOnlyWhenNarrowed(body, param) ? 'narrowed' : 'swallows';
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

/** Each guarded statement and its handler: `try`, `.catch(fn)` and `.then(ok, fn)`. */
function catchSites(sf: ts.SourceFile): Array<{ at: ts.Node; guarded: ts.Node; handler: ts.Node }> {
  const sites: Array<{ at: ts.Node; guarded: ts.Node; handler: ts.Node }> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isTryStatement(n) && n.catchClause) {
      sites.push({ at: n.catchClause, guarded: n.tryBlock, handler: n.catchClause });
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
  const found: GuardedCatch[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(`${SRC}/`) || sf.fileName.includes('/node_modules/')) continue;
    for (const site of catchSites(sf)) {
      const handles = handlesIn(site.guarded, checker, tx);
      if (handles.length === 0) continue;
      found.push({
        file: relative(SRC, sf.fileName),
        line: sf.getLineAndCharacterOfPosition(site.at.getStart(sf)).line + 1,
        fn: enclosingName(site.at),
        handles,
        handler: handlerKind(site.handler, handles),
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
