/**
 * The sources the checker reads, and what one expression in them evaluates to.
 *
 * A regex over source text cannot tell "no GitHub call here" from "a GitHub call I did not
 * recognise", and answers the second as the first. This reads a TypeScript program instead.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { GITHUB_API_BASE } from './types.js';

const SRC_ROOT = join(import.meta.dirname, '..', '..');
export const GITHUB_DIR = join(SRC_ROOT, 'integrations', 'github');

/** The table itself, which calls nothing, so its rows are never read as call sites. */
export const DECLARATION_FILE = 'app-permissions.ts';

export const MAX_DEPTH = 8;

/**
 * Values the checker cannot read out of the source, declared as the path fragment they stand for.
 *
 * A wrong entry resolves a path to the wrong pattern, which the endpoint comparison reports by
 * name; it cannot make a call invisible. A hole neither declared here nor provably one segment
 * leaves the path unresolved: `:p` claims the value carries no `/`, and `/pulls/${tail}` priced as
 * `/pulls/:p` matches the pull-request row while the runtime sends `/pulls/12/reviews`.
 */
const HOLE_VALUES: Record<string, string> = {
  base: '',
  'client.fullName': ':p/:p',
  'client.owner': ':p',
  'client.repo': ':p',
  // Qualified by file where the name alone is too common to declare globally. `path` here is the
  // repository file path the contents endpoint takes, priced as one segment because what sits under
  // it buys no further permission.
  'merge-read.ts:headSha': ':p',
  'runner-release-repo.ts:path': ':p',
};

function declaredValue(node: ts.Node): string | undefined {
  const file = node.getSourceFile().fileName.split('/').pop() ?? '';
  const text = node.getText();
  return HOLE_VALUES[`${file}:${text}`] ?? HOLE_VALUES[text];
}

/**
 * Every TypeScript source under a directory, subdirectories included, relative to it: a listing of
 * the top level alone leaves a call in `helpers/extra.ts` in no scan and no sweep.
 */
export function sourceFilesIn(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return sourceFilesIn(join(dir, entry.name), `${at}/`);
    const source =
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.fixture.ts');
    return source ? [at] : [];
  });
}

export function sourceFiles(): string[] {
  return sourceFilesIn(GITHUB_DIR).filter((f) => f !== DECLARATION_FILE);
}

function programFiles(): string[] {
  return sourceFilesIn(GITHUB_DIR);
}

const PLANTS = new Map<string, string>();

/**
 * Register a source read exactly as a file of this directory is. Call it at module scope: the
 * program is built once, on the first read, and holds every source planted before then.
 */
export function plant(file: string, source: string): string {
  if (BUILT) throw new Error(`${file} was planted after the checker's program was built`);
  PLANTS.set(file, source);
  return file;
}

let BUILT: ts.Program | null = null;

export function program(): ts.Program {
  if (BUILT) return BUILT;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
  };
  const host = ts.createCompilerHost(options, true);
  const overlay = new Map([...PLANTS].map(([f, text]) => [join(GITHUB_DIR, f), text]));
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (fn) => overlay.get(fn) ?? readFile(fn);
  host.fileExists = (fn) => overlay.has(fn) || fileExists(fn);
  host.getSourceFile = (fn, langVersion, onError, shouldCreate) => {
    const text = overlay.get(fn);
    return text === undefined
      ? getSourceFile(fn, langVersion, onError, shouldCreate)
      : ts.createSourceFile(fn, text, langVersion, true, ts.ScriptKind.TS);
  };
  const roots = [...programFiles().map((f) => join(GITHUB_DIR, f)), ...overlay.keys()];
  BUILT = ts.createProgram(roots, options, host);
  return BUILT;
}

export function sourceFile(file: string): ts.SourceFile {
  const sf = program().getSourceFile(join(GITHUB_DIR, file));
  if (!sf) throw new Error(`${file} is not in the checker's program`);
  return sf;
}

export function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

export function lineOf(node: ts.Node): number {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export function symbolOf(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | null {
  const found = checker.getSymbolAtLocation(node);
  if (!found) return null;
  return found.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(found) : found;
}

/** A call whose callee answers with a `Response` — the network boundary, whatever it is named. */
export function isNetworkCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  return checker
    .getTypeAtLocation(call.expression)
    .getCallSignatures()
    .some((s) => checker.getAwaitedType(s.getReturnType())?.getSymbol()?.getName() === 'Response');
}

/** Whether every value of this type is a string, the literal unions a method parameter takes included. */
export function isStringLike(type: ts.Type): boolean {
  const string = (t: ts.Type) => (t.flags & ts.TypeFlags.StringLike) !== 0;
  return type.isUnion() ? type.types.every(string) : string(type);
}

// ---- resolving an expression to a path pattern -------------------------------------------------

export function declarationOf(node: ts.Node, checker: ts.TypeChecker): ts.Declaration | null {
  const symbol = symbolOf(node, checker);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0] ?? null;
}

export function bodyExpression(decl: ts.Declaration): ts.Expression | null {
  const fn = ts.isVariableDeclaration(decl) ? decl.initializer : decl;
  if (
    !fn ||
    !(ts.isArrowFunction(fn) || ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn))
  )
    return null;
  const body = fn.body;
  if (!body) return null;
  if (!ts.isBlock(body)) return body;
  const only = body.statements.length === 1 ? body.statements[0] : null;
  return only && ts.isReturnStatement(only) ? (only.expression ?? null) : null;
}

/** The string this expression evaluates to, interpolations kept as `:p`, or null where it cannot be read. */
export function evaluate(node: ts.Node, checker: ts.TypeChecker, depth = 0): string | null {
  const read = readValue(node, checker, depth);
  // The declared value is what the source does not carry, so it answers only where reading failed:
  // a spelling that DOES have a value in the tree resolves to that value and is judged on it.
  return read ?? declaredValue(node) ?? null;
}

function readValue(node: ts.Node, checker: ts.TypeChecker, depth: number): string | null {
  if (depth > MAX_DEPTH) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node))
    return evaluate(node.expression, checker, depth + 1);
  if (ts.isNonNullExpression(node)) return evaluate(node.expression, checker, depth + 1);
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      // Past the `?` the text is the query string, which `toPattern` drops: a hole there adds no
      // path segment, so it is not held to proving it carries none.
      const query = out.includes('?');
      const filled =
        evaluate(span.expression, checker, depth + 1) ??
        (query ? ':p' : oneSegment(span.expression, checker));
      if (filled === null) return null;
      out += filled + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluate(node.left, checker, depth + 1);
    const right = evaluate(node.right, checker, depth + 1);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    const decl = declarationOf(node, checker);
    if (!decl) return null;
    if (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) {
      if (ts.isVariableDeclaration(decl) && !isConstBinding(decl)) return null;
      if (ts.isPropertyAccessExpression(node) && isWrittenTo(node.expression, checker)) return null;
      return decl.initializer ? evaluate(decl.initializer, checker, depth + 1) : null;
    }
    if (ts.isShorthandPropertyAssignment(decl)) {
      const value = checker.getShorthandAssignmentValueSymbol(decl);
      const from = value?.valueDeclaration ?? value?.declarations?.[0];
      if (from && ts.isVariableDeclaration(from) && from.initializer)
        return evaluate(from.initializer, checker, depth + 1);
    }
    return null;
  }
  if (ts.isCallExpression(node)) {
    const decl = declarationOf(node.expression, checker);
    const body = decl ? bodyExpression(decl) : null;
    return body ? evaluate(body, checker, depth + 1) : null;
  }
  return null;
}

/**
 * `:p` where this expression cannot carry a `/`, else null: a number has no separator to carry and
 * `encodeURIComponent` escapes the one that would make a value two segments.
 */
/**
 * Whether anything in this file assigns to a property of the name, which `const` does not stop.
 *
 * `const args = { path: repoPath(client) }` then `args.path += '/branches/…'` sends a path the
 * initializer does not name, and pricing the initializer prices the wrong permission.
 */
export function isWrittenTo(name: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(name)) return false;
  const target = symbolOf(name, checker);
  if (!target) return true;
  let written = false;
  const isTarget = (node: ts.Node) => ts.isIdentifier(node) && symbolOf(node, checker) === target;
  walk(name.getSourceFile(), (node) => {
    if (written) return;
    // A second name for the same object is a second way to write to it, and the write is spelled
    // against the alias.
    if (ts.isVariableDeclaration(node) && node.initializer && isTarget(node.initializer))
      written = true;
    if (!ts.isBinaryExpression(node)) return;
    const op = node.operatorToken.kind;
    if (op < ts.SyntaxKind.FirstAssignment || op > ts.SyntaxKind.LastAssignment) return;
    const left = node.left;
    const root =
      ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)
        ? left.expression
        : left;
    if (isTarget(root)) written = true;
  });
  return written;
}

/** A binding nothing rebinds: a `let p = …` followed by `p += '/branches/…'` sends another path. */
export function isConstBinding(decl: ts.VariableDeclaration): boolean {
  return (decl.parent.flags & ts.NodeFlags.Const) !== 0;
}

function oneSegment(node: ts.Expression, checker: ts.TypeChecker, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  const type = checker.getTypeAtLocation(node);
  const numeric = (t: ts.Type) => (t.flags & ts.TypeFlags.NumberLike) !== 0;
  if (type.isUnion() ? type.types.every(numeric) : numeric(type)) return ':p';
  if (isComponentEncoder(node, checker)) return ':p';
  if (ts.isIdentifier(node)) {
    const decl = declarationOf(node, checker);
    const held =
      decl && ts.isVariableDeclaration(decl) && isConstBinding(decl) ? decl.initializer : undefined;
    if (held) return oneSegment(held, checker, depth + 1);
  }
  return null;
}

/** The global `encodeURIComponent` alone: `encodeURI` leaves `/`, and a local one escapes its own. */
function isComponentEncoder(node: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isCallExpression(node)) return false;
  const symbol = symbolOf(node.expression, checker);
  if (symbol?.getName() !== 'encodeURIComponent') return false;
  return (symbol.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile);
}

/** The pattern a resolved value names, or null where it is no GitHub path. */
export function toPattern(value: string | null): string | null {
  if (value === null) return null;
  const stripped = value.startsWith(GITHUB_API_BASE) ? value.slice(GITHUB_API_BASE.length) : value;
  const path = stripped.split('?')[0] ?? '';
  return path.startsWith('/') ? path : null;
}

export function resolvePathOf(node: ts.Node, checker: ts.TypeChecker): string | null {
  return toPattern(evaluate(node, checker));
}

export function objectOf(
  node: ts.Node | undefined,
  checker: ts.TypeChecker,
  depth = 0,
): ts.ObjectLiteralExpression | null {
  if (!node || depth > MAX_DEPTH) return null;
  if (ts.isObjectLiteralExpression(node)) return node;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return objectOf(node.expression, checker, depth + 1);
  if (ts.isIdentifier(node)) {
    const decl = declarationOf(node, checker);
    if (!decl || !ts.isVariableDeclaration(decl) || !isConstBinding(decl)) return null;
    return isWrittenTo(node, checker) ? null : objectOf(decl.initializer, checker, depth + 1);
  }
  if (ts.isCallExpression(node)) {
    const decl = declarationOf(node.expression, checker);
    const body = decl ? bodyExpression(decl) : null;
    return body ? objectOf(body, checker, depth + 1) : null;
  }
  return null;
}

/**
 * The node carrying `name` in this object, following a spread the same way the runtime would.
 *
 * A spread whose object cannot be read, and whose TYPE says it may carry `name`, takes the value
 * back: the runtime would overwrite whatever an earlier property established, and keeping the
 * earlier one prices a path the call does not send.
 */
/** What this property NAMES, or null where the key is computed out of something unreadable. */
function keyOf(property: ts.ObjectLiteralElementLike): string | null {
  const name = property.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression))
    return name.expression.text;
  return null;
}

export function propertyOf(
  object: ts.ObjectLiteralExpression,
  name: string,
  checker: ts.TypeChecker,
  depth = 0,
): { value: ts.Node | null; blockedBy: ts.Node | null } {
  let held: ts.Node | null = null;
  let blockedBy: ts.Node | null = null;
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && keyOf(property) === name) {
      held = property.initializer;
      blockedBy = null;
    } else if (ts.isShorthandPropertyAssignment(property) && keyOf(property) === name) {
      held = property.name;
      blockedBy = null;
    } else if (
      (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
      keyOf(property) === null
    ) {
      blockedBy = property.name;
    } else if (ts.isSpreadAssignment(property)) {
      const spread = depth < MAX_DEPTH ? objectOf(property.expression, checker) : null;
      const inner = spread ? propertyOf(spread, name, checker, depth + 1) : null;
      if (inner?.value) {
        held = inner.value;
        blockedBy = null;
      } else if (inner?.blockedBy) blockedBy = inner.blockedBy;
      else if (
        !spread &&
        checker.getPropertyOfType(checker.getTypeAtLocation(property.expression), name)
      )
        blockedBy = property.expression;
    }
  }
  return blockedBy ? { value: null, blockedBy } : { value: held, blockedBy: null };
}

/** The expression a name stands for, so a refusal names what was written AND what it led to. */
export function shown(node: ts.Node, checker: ts.TypeChecker): string {
  const text = node.getText();
  if (!ts.isIdentifier(node)) return text;
  const decl = declarationOf(node, checker);
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer)
    return `${text} → ${decl.initializer.getText()}`;
  if (decl && ts.isShorthandPropertyAssignment(decl)) {
    const value = checker.getShorthandAssignmentValueSymbol(decl);
    const from = value?.valueDeclaration;
    if (from && ts.isVariableDeclaration(from) && from.initializer)
      return `${text} → ${from.initializer.getText()}`;
  }
  return text;
}
