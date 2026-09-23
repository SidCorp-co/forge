/**
 * Every GitHub call this directory makes, found by what it CALLS rather than by how it is written.
 *
 * The transports are derived from the source — the functions that hand a parameterised URL to
 * something answering with a `Response` — and every call to one of them is a call site whatever its
 * arguments look like. Only the argument's VALUE can then be unreadable, which is what this reports.
 *
 * The one call shape left outside that: a transport method on a receiver the type checker cannot
 * name. `untypedTransportCall` refuses that one rather than passing over it.
 */

import ts from 'typescript';
import {
  bodyExpression,
  declarationOf,
  evaluate,
  GITHUB_DIR,
  isNetworkCall,
  lineOf,
  MAX_DEPTH,
  program,
  resolvePathOf,
  sourceFile,
  sourceFiles,
  symbolOf,
  toPattern,
  walk,
} from './app-permissions-source.fixture.js';

const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

// ---- deriving the transports, and reading the calls to them ------------------------------------

interface Position {
  index: number;
  property: string | null;
}

interface Transport {
  symbol: ts.Symbol;
  path: Position;
  method: { index: number; property: string } | null;
}

function carrierOf(node: ts.Node): ts.Node | null {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (
      ts.isMethodDeclaration(at) ||
      ts.isFunctionDeclaration(at) ||
      ts.isFunctionExpression(at) ||
      ts.isArrowFunction(at)
    )
      return at;
  }
  return null;
}

/** The symbol a caller would reach this transport by: the interface member, or the function. */
function transportSymbol(carrier: ts.Node, checker: ts.TypeChecker): ts.Symbol | null {
  if (ts.isMethodDeclaration(carrier) && ts.isObjectLiteralExpression(carrier.parent)) {
    const contextual = checker.getContextualType(carrier.parent);
    if (!contextual) return null;
    const name = carrier.name.getText();
    // An async factory contextually types its object as `T | PromiseLike<T>`, and only one side has
    // the member.
    const parts = contextual.isUnion() ? contextual.types : [contextual];
    return parts.map((t) => checker.getPropertyOfType(t, name)).find((s) => s) ?? null;
  }
  if (ts.isFunctionDeclaration(carrier) && carrier.name) return symbolOf(carrier.name, checker);
  const owner = carrier.parent;
  if (owner && ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name))
    return symbolOf(owner.name, checker);
  return null;
}

/** Where a call to this transport carries its path and its method, read off the transport's own signature. */
function positionsOf(symbol: ts.Symbol, checker: ts.TypeChecker): Omit<Transport, 'symbol'> | null {
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!decl) return null;
  const signature = checker.getTypeOfSymbolAtLocation(symbol, decl).getCallSignatures()[0];
  if (!signature) return null;
  const parameters = signature.getParameters();
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index] as ts.Symbol;
    const at = parameter.valueDeclaration ?? decl;
    const type = checker.getTypeOfSymbolAtLocation(parameter, at);
    if (
      (parameter.name === 'path' || parameter.name === 'url') &&
      checker.typeToString(type) === 'string'
    )
      return { path: { index, property: null }, method: null };
    if (checker.getPropertyOfType(type, 'path')) {
      const method = checker.getPropertyOfType(type, 'method');
      return {
        path: { index, property: 'path' },
        method: method ? { index, property: 'method' } : null,
      };
    }
  }
  return null;
}

let TRANSPORTS: Transport[] | null = null;

/**
 * Every transport in this directory: a function that hands a URL it cannot state to the network.
 *
 * One whose URL the checker CAN read is not a conduit but a call site, and is priced as one.
 */
function transports(): Transport[] {
  if (TRANSPORTS) return TRANSPORTS;
  const checker = program().getTypeChecker();
  const found = new Map<ts.Symbol, Transport>();
  for (const file of program()
    .getSourceFiles()
    .filter((sf) => sf.fileName.startsWith(GITHUB_DIR))) {
    walk(file, (node) => {
      if (!ts.isCallExpression(node) || !isNetworkCall(node, checker)) return;
      if (resolvePathOf(node.arguments[0] ?? node, checker) !== null) return;
      const carrier = carrierOf(node);
      const symbol = carrier ? transportSymbol(carrier, checker) : null;
      const where = symbol ? positionsOf(symbol, checker) : null;
      if (symbol && where && !found.has(symbol)) found.set(symbol, { symbol, ...where });
    });
  }
  TRANSPORTS = [...found.values()];
  return TRANSPORTS;
}

function objectOf(
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
    return decl && ts.isVariableDeclaration(decl)
      ? objectOf(decl.initializer, checker, depth + 1)
      : null;
  }
  if (ts.isCallExpression(node)) {
    const decl = declarationOf(node.expression, checker);
    const body = decl ? bodyExpression(decl) : null;
    return body ? objectOf(body, checker, depth + 1) : null;
  }
  return null;
}

/** The node carrying `name` in this object, following a spread the same way the runtime would. */
function propertyOf(
  object: ts.ObjectLiteralExpression,
  name: string,
  checker: ts.TypeChecker,
  depth = 0,
): ts.Node | null {
  let held: ts.Node | null = null;
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === name)
      held = property.initializer;
    else if (ts.isShorthandPropertyAssignment(property) && property.name.getText() === name)
      held = property.name;
    else if (ts.isSpreadAssignment(property) && depth < MAX_DEPTH) {
      const spread = objectOf(property.expression, checker);
      const inner = spread ? propertyOf(spread, name, checker, depth + 1) : null;
      if (inner) held = inner;
    }
  }
  return held;
}

/** The expression a name stands for, so a refusal names what was written AND what it led to. */
function shown(node: ts.Node, checker: ts.TypeChecker): string {
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

export interface FoundCall {
  file: string;
  line: number;
  raw: string;
  path: string;
  method: string;
  /** `fetch` is the shape a transport also wears; `path` is always a call site. */
  kind: 'path' | 'fetch';
  /** Why this call could not be read, or null. */
  unresolved: string | null;
}

function literalMethod(node: ts.Node | null, checker: ts.TypeChecker): string | null {
  const value = node ? evaluate(node, checker) : null;
  return value && HTTP_METHODS.includes(value) ? value : null;
}

function record(args: {
  file: string;
  at: ts.Node;
  raw: string;
  path: string | null;
  method: string | null;
  kind: 'path' | 'fetch';
  why: string | null;
}): FoundCall {
  const unresolved =
    args.why ??
    (args.path === null
      ? `the path expression does not resolve to a GitHub path: ${args.raw}`
      : args.method === null
        ? `the call names no HTTP method: ${args.raw}`
        : null);
  return {
    file: args.file,
    line: lineOf(args.at),
    raw: args.raw,
    path: args.path ?? '',
    method: args.method ?? '?',
    kind: args.kind,
    unresolved,
  };
}

function transportCall(
  call: ts.CallExpression,
  transport: Transport,
  file: string,
  checker: ts.TypeChecker,
): FoundCall {
  const argument = call.arguments[transport.path.index];
  const object = transport.path.property === null ? null : objectOf(argument, checker);
  const pathNode =
    transport.path.property === null
      ? (argument ?? null)
      : object
        ? propertyOf(object, transport.path.property, checker)
        : null;
  const why =
    pathNode === null
      ? object === null
        ? `the call's arguments cannot be read: ${argument?.getText() ?? call.getText()}`
        : `the call names no path: ${argument?.getText() ?? call.getText()}`
      : null;
  const method =
    transport.method === null
      ? 'GET'
      : object
        ? literalMethod(propertyOf(object, transport.method.property, checker), checker)
        : null;
  return record({
    file,
    at: pathNode ?? argument ?? call,
    raw: pathNode ? shown(pathNode, checker) : (argument?.getText() ?? ''),
    path: pathNode ? resolvePathOf(pathNode, checker) : null,
    method,
    kind: 'path',
    why,
  });
}

function networkCall(call: ts.CallExpression, file: string, checker: ts.TypeChecker): FoundCall {
  const argument = call.arguments[0];
  const options = objectOf(call.arguments[1], checker);
  const named = options ? literalMethod(propertyOf(options, 'method', checker), checker) : null;
  return record({
    file,
    at: argument ?? call,
    raw: argument?.getText() ?? '',
    path: argument ? resolvePathOf(argument, checker) : null,
    method: named ?? 'GET',
    kind: 'fetch',
    why: null,
  });
}

/**
 * Nothing in this directory writes one, and the day something does it is refused by name rather
 * than passed over.
 */
function untypedTransportCall(call: ts.CallExpression, file: string): FoundCall[] {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return [];
  const named = transports().some((t) => t.symbol.getName() === callee.name.text);
  if (!named) return [];
  return [
    record({
      file,
      at: call,
      raw: callee.getText(),
      path: null,
      method: null,
      kind: 'path',
      why: `${callee.name.text} is a transport and the type of ${callee.expression.getText()} cannot be read, so this call cannot be priced`,
    }),
  ];
}

/** Every GitHub call one source makes, as `METHOD /path`, or the reason one could not be read. */
export function collectGitHubCalls(file: string): FoundCall[] {
  const checker = program().getTypeChecker();
  const known = new Map(transports().map((t) => [t.symbol, t]));
  const out: FoundCall[] = [];
  walk(sourceFile(file), (node) => {
    if (!ts.isCallExpression(node)) return;
    const symbol = symbolOf(node.expression, checker);
    const transport = symbol ? known.get(symbol) : undefined;
    // A transport that answers with the `Response` itself wears both shapes; its callers carry the
    // path, so the transport reading is the one that prices the call.
    if (transport) out.push(transportCall(node, transport, file, checker));
    else if (isNetworkCall(node, checker)) out.push(networkCall(node, file, checker));
    else if (!symbol) out.push(...untypedTransportCall(node, file));
  });
  return out.sort((a, b) => a.line - b.line);
}

export function callsInTree(): FoundCall[] {
  return sourceFiles().flatMap((file) => collectGitHubCalls(file));
}

/** Every request whose URL `collectGitHubCalls` could not read, with the line it sits on. */
export function unreadableRequests(file: string): Array<{ line: number; raw: string }> {
  return collectGitHubCalls(file)
    .filter((c) => c.kind === 'fetch' && c.unresolved)
    .map((c) => ({ line: c.line, raw: c.raw }));
}

export function hasRequestHelper(file: string): boolean {
  return unreadableRequests(file).length > 0;
}

/** Every GitHub-shaped path written in a source, whatever expression carries it to the network. */
export function pathLiterals(file: string): Array<{ line: number; path: string; text: string }> {
  const checker = program().getTypeChecker();
  const out: Array<{ line: number; path: string; text: string }> = [];
  walk(sourceFile(file), (node) => {
    if (
      !ts.isStringLiteral(node) &&
      !ts.isNoSubstitutionTemplateLiteral(node) &&
      !ts.isTemplateExpression(node)
    )
      return;
    const path = toPattern(evaluate(node, checker));
    if (path !== null) out.push({ line: lineOf(node), path, text: node.getText() });
  });
  return out;
}
