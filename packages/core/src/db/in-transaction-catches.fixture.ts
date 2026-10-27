/**
 * A handle is any expression bound outside the guarded code whose declared type, or a type
 * parameter's constraint, a drizzle transaction is assignable to and which carries any member of
 * the transaction, so `Pick<Tx, 'insert'>`, `Pick<Db, 'select'>`, `Tx` and every local executor
 * alias count while the pool's own `Db` does not. `EXCEPTIONS` names any catch allowed to fall back.
 *
 * A catch passes by calling `rethrowInTransaction(<the error>, <the handle>)` first, or by handing
 * every error it does not name up unchanged: on each path such an error can take it leaves only
 * by throwing the error it caught, throws no replacement for it, and makes no use of it the write
 * reading refuses, since what it does there reaches the guard deciding on the error or the catch
 * the error goes up to. A path only a named error reaches is not read
 * (`in-transaction-paths.fixture.ts:namedPaths`). A `finally` that leaves its block swallows.
 *
 * Which guard counts as naming an error: `in-transaction-guards.fixture.ts`; which use of the error
 * is refused as a write, and what that reading still cannot see: `in-transaction-writes.fixture.ts`.
 *
 * Named residuals: a statement reached through a helper that closes over the transaction without
 * the guarded code naming any handle, and so a catch around such a helper that replaces or rewrites
 * what it throws, which the scan never reads; a replacement thrown by a function declared outside
 * the catch that it calls, which it does not read; a transaction cast to a type it is not, such as
 * `typeof db`; and a rejection handled by anything other than `try`, `.catch(fn)` or
 * `.then(ok, fn)` written inline, among them the same rejection taken again off the statement's
 * own promise (`p.catch((e) => …)`). The guard reader and the write reading name their own.
 */

import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  admitsAllButNamed,
  escapedClasses,
  namesAnError,
  type Scan,
  statementErrors,
  unwrap,
  withBases,
} from './in-transaction-guards.fixture.js';
import {
  exitsOf,
  isNestedFunction,
  leaves,
  namedPaths,
  onANamedPath,
  statementsOf,
  within,
} from './in-transaction-paths.fixture.js';
import { unreadUse } from './in-transaction-writes.fixture.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const TX_SOURCE = join(SRC, 'db', 'client.ts');

/** A catch that may fall back inside a transaction, each with why it is allowed to. */
export const EXCEPTIONS: ReadonlyArray<{ at: string; reason: string }> = [];

/** What refused a catch that decides only for an error it names: a use of the error, or a throw. */
export interface Refused {
  what: 'use' | 'replacement';
  line: number;
  text: string;
}

export interface GuardedCatch {
  file: string;
  line: number;
  fn: string;
  handles: string[];
  handler: 'rethrows' | 'narrowed' | 'swallows';
  refused?: Refused;
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

/** Whether running off the end of `stmts` is open only to a named error, given `allBut`. */
function endsNamed(
  stmts: readonly ts.Statement[],
  body: ts.Block,
  named: ReadonlySet<ts.Node>,
  allBut: (test: ts.Expression) => boolean,
): boolean {
  const last = stmts.at(-1);
  if (!last) return false;
  if (ts.isThrowStatement(last) || onANamedPath(last, body, named)) return true;
  if (!ts.isIfStatement(last)) return false;
  const other = last.elseStatement;
  return (
    endsNamed(statementsOf(last.thenStatement), body, named, allBut) &&
    (other ? endsNamed(statementsOf(other), body, named, allBut) : allBut(last.expression))
  );
}

/**
 * Whether every way out of `body` an error it does not name can take is a throw: each return,
 * break or continue leaving it, and its end, lie on a path only a named error reaches.
 */
function decides(
  body: ts.Block,
  named: ReadonlySet<ts.Node>,
  allBut: (test: ts.Expression) => boolean,
): boolean {
  return (
    endsNamed(body.statements, body, named, allBut) &&
    exitsOf(body).every((exit) => onANamedPath(exit, body, named))
  );
}

/** Whether `thrown` is the caught error itself, on each branch an error it does not name takes. */
function passesOn(
  thrown: ts.Expression,
  at: ts.Block,
  param: ts.Symbol,
  named: ReadonlySet<ts.Node>,
  scan: Scan,
): boolean {
  const e = unwrap(thrown);
  if (onANamedPath(e, at, named)) return true;
  if (ts.isIdentifier(e)) return scan.checker.getSymbolAtLocation(e) === param;
  return (
    ts.isConditionalExpression(e) &&
    passesOn(e.whenTrue, at, param, named, scan) &&
    passesOn(e.whenFalse, at, param, named, scan)
  );
}

/** A function `n` declares under a name, which runs only where something calls it. */
function declaredOnly(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(n) ||
    ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isVariableDeclaration(n.parent) &&
      n.parent.initializer === n)
  );
}

/**
 * Whether the function `fn` declares is only ever called by its name in `body`, so that it runs
 * where those calls stand; one bound to another name, handed on, stored or reassigned can run
 * anywhere, and is read where it is declared.
 */
function onlyCalled(fn: ts.FunctionLikeDeclaration, body: ts.Block, scan: Scan): boolean {
  const name = ts.isFunctionDeclaration(fn) ? fn.name : (fn.parent as ts.VariableDeclaration).name;
  const symbol = name && ts.isIdentifier(name) && scan.checker.getSymbolAtLocation(name);
  if (!symbol) return false;
  let called = true;
  const visit = (n: ts.Node): void => {
    if (!called) return;
    if (
      ts.isIdentifier(n) &&
      n !== name &&
      scan.checker.getSymbolAtLocation(n) === symbol &&
      !(ts.isCallExpression(n.parent) && n.parent.expression === n)
    )
      called = false;
    else ts.forEachChild(n, visit);
  };
  visit(body);
  return called;
}

/** The function declared under a name inside `body` that `call` runs, if it runs one. */
function calledHere(call: ts.CallExpression, body: ts.Block, scan: Scan) {
  const decl = ts.isIdentifier(call.expression)
    ? scan.checker.getSymbolAtLocation(call.expression)?.valueDeclaration
    : undefined;
  const fn = decl && ts.isVariableDeclaration(decl) ? decl.initializer : decl;
  return fn && declaredOnly(fn) && within(fn, body) ? fn : undefined;
}

/**
 * The first throw of anything but the caught error on a path an error it does not name can take,
 * reading a function the catch declares under a name where a call on such a path runs it, or where
 * it is declared if anything but a call by that name reaches it.
 */
function replacement(body: ts.Block, param: ts.Symbol, named: ReadonlySet<ts.Node>, scan: Scan) {
  let found: ts.ThrowStatement | undefined;
  const ran = new Set<ts.Node>();
  const visit = (n: ts.Node): void => {
    if (found || named.has(n) || (declaredOnly(n) && onlyCalled(n, body, scan))) return;
    if (ts.isThrowStatement(n) && !passesOn(n.expression, body, param, named, scan)) {
      found = n;
      return;
    }
    const fn = ts.isCallExpression(n) ? calledHere(n, body, scan) : undefined;
    if (fn?.body && !ran.has(fn)) {
      ran.add(fn);
      ts.forEachChild(fn.body, visit);
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

/** The handler's kind by the rule the header states, and the use or throw that refused it. */
function handlerKind(
  handler: ts.Node,
  handles: string[],
  scan: Scan,
): { handler: GuardedCatch['handler']; refused?: { what: Refused['what']; node: ts.Node } } {
  let body: ts.Block;
  let param: ts.Symbol | null;
  if (ts.isBlock(handler) && ts.isTryStatement(handler.parent)) {
    return { handler: 'swallows' };
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
    return { handler: 'swallows' };
  }
  if (rethrowsFirst(body, param, handles, scan)) return { handler: 'rethrows' };
  if (param === null) return { handler: 'swallows' };
  const caught = param;
  const allBut = (test: ts.Expression) => admitsAllButNamed(test, caught, scan);
  const named = namedPaths(body, (test) => namesAnError(test, caught, scan), allBut);
  if (!decides(body, named, allBut)) return { handler: 'swallows' };
  const thrown = replacement(body, caught, named, scan);
  if (thrown) return { handler: 'swallows', refused: { what: 'replacement', node: thrown } };
  const use = unreadUse(body, caught, scan, named);
  return use
    ? { handler: 'swallows', refused: { what: 'use', node: use } }
    : { handler: 'narrowed' };
}

/** The statement `node` stands in, or the test it is part of, on one line. */
function shown(node: ts.Node): string {
  let at = node;
  for (let up = at.parent; up && !ts.isBlock(up) && !ts.isCaseOrDefaultClause(up); up = up.parent) {
    if (
      isNestedFunction(up) ||
      ((ts.isIfStatement(up) || ts.isIterationStatement(up, false)) && !ts.isStatement(at))
    )
      break;
    at = up;
  }
  const text = at.getText().replace(/\s+/g, ' ').replace(/;$/, '');
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
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
    ...escapedClasses(program, files, checker),
  };
  const found: GuardedCatch[] = [];
  for (const sf of files) {
    for (const site of catchSites(sf)) {
      const handles = handlesIn(site.guarded, scan);
      if (handles.length === 0) continue;
      const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      const kind = handlerKind(site.handler, handles, scan);
      found.push({
        file: relative(SRC, sf.fileName),
        line: lineOf(site.at),
        fn: enclosingName(site.at),
        handles,
        handler: kind.handler,
        ...(kind.refused && {
          refused: {
            what: kind.refused.what,
            line: lineOf(kind.refused.node),
            text: shown(kind.refused.node),
          },
        }),
      });
    }
  }
  return found;
}

const OPEN_WITH_THE_GUARD =
  'open the catch with if (!<names the one error>) throw <the error>; and do it after that, where only that error reaches';

/** Why `c` is refused, and the way past it. */
function refusedFor(c: GuardedCatch): string {
  const { refused } = c;
  if (refused?.what === 'use') {
    return `uses the error at line ${refused.line} in \`${refused.text}\`, which the scan cannot read as a plain read, on a path an error it does not name can take, where the error goes on to its guard or up to the catch around it: there use it only by a comparison, instanceof, typeof, a property read down to a primitive, a lib/db-errors.ts reader or isX helper, a store to a key no guard reads, or a throw of it unchanged; or ${OPEN_WITH_THE_GUARD}`;
  }
  if (refused?.what === 'replacement') {
    return `throws at line ${refused.line} \`${refused.text}\` in place of an error it does not name, which a catch around it can mistake for the one it names: throw the error it caught unchanged there, start the catch with rethrowInTransaction(<the error>, <the handle>) where a replacement must not reach a transaction, or ${OPEN_WITH_THE_GUARD}`;
  }
  return 'can fall back for an error it does not name: guard on the one error it means, move what is not a statement out of the try and catch that apart, start the catch with rethrowInTransaction(<the error>, <the handle>) where it must not fall back';
}

/**
 * The catches that fall back inside a transaction, or hand on an error they do not name changed or
 * replaced, and that `EXCEPTIONS` does not name, each as `file:line fn` with why and the way past
 * it, plus every exception that names no such catch any more.
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
          `${c.file}:${c.line} ${c.fn} catches a statement on ${c.handles.join(', ')}, which can be a transaction, and ${refusedFor(c)}, or give it an EXCEPTIONS entry with its reason`,
      ),
    ...[...named]
      .filter((n) => !swallows.some((c) => at(c) === n))
      .map((n) => `EXCEPTIONS names ${n}, where no catch falls back any more`),
  ];
}
