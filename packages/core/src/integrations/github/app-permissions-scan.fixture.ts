/**
 * Every GitHub call this directory makes, found by what it CALLS rather than by how it is written.
 *
 * The transports are derived from the source — the functions that hand a parameterised URL to
 * something answering with a `Response` — and every call to one of them is a call site whatever its
 * arguments look like. Only the argument's VALUE can then be unreadable, which is what this reports.
 *
 * What it is NOT: a sound analysis of every request this directory can send. It is a bounded
 * syntactic audit whose guarantee covers the transport references and value constructions its
 * resolver recognises, and a reader must not take a green run as proof that no other call exists.
 * Named residuals: a transport on a receiver no type names, refused by `untypedTransportCall`
 * rather than passed over; a value mutated through a path `isWrittenTo` does not reach, such as one
 * an escaping call writes; and an invocation reaching a transport by some route other than a name,
 * a bind or `.call`. Seven reviews closed twenty-four such shapes (ISS-1153); the class of
 * spellings is open and the mechanisms are the ones above.
 */

import ts from 'typescript';
import {
  evaluate,
  GITHUB_DIR,
  isNetworkCall,
  isStringLike,
  lineOf,
  objectOf,
  program,
  propertyOf,
  resolvePathOf,
  shown,
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
  method: Position | null;
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

/** The member of the object's own declared type, whichever side of an async factory's union holds it. */
function contextualMember(
  object: ts.ObjectLiteralExpression,
  name: string,
  checker: ts.TypeChecker,
): ts.Symbol | null {
  const contextual = checker.getContextualType(object);
  if (!contextual) return null;
  const parts = contextual.isUnion() ? contextual.types : [contextual];
  return parts.map((t) => checker.getPropertyOfType(t, name)).find((s) => s) ?? null;
}

/** The symbol a caller would reach this transport by: the interface member, or the function. */
function transportSymbol(carrier: ts.Node, checker: ts.TypeChecker): ts.Symbol | null {
  if (ts.isMethodDeclaration(carrier) && ts.isObjectLiteralExpression(carrier.parent))
    return contextualMember(carrier.parent, carrier.name.getText(), checker);
  if (ts.isFunctionDeclaration(carrier) && carrier.name) return symbolOf(carrier.name, checker);
  const owner = carrier.parent;
  if (owner && ts.isPropertyAssignment(owner) && ts.isObjectLiteralExpression(owner.parent))
    return contextualMember(owner.parent, owner.name.getText(), checker);
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
  let path: Position | null = null;
  let method: Position | null = null;
  const parameters = signature.getParameters();
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index] as ts.Symbol;
    const type = checker.getTypeOfSymbolAtLocation(parameter, parameter.valueDeclaration ?? decl);
    const scalar = isStringLike(type);
    if (!path && scalar && (parameter.name === 'path' || parameter.name === 'url'))
      path = { index, property: null };
    else if (!method && scalar && parameter.name === 'method') method = { index, property: null };
    else if (!path && checker.getPropertyOfType(type, 'path')) {
      path = { index, property: 'path' };
      if (checker.getPropertyOfType(type, 'method')) method = { index, property: 'method' };
    }
  }
  return path ? { path, method } : null;
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

/** What this call names as its method: the argument, the property, or GET where the transport sends one. */
function methodOf(
  call: ts.CallExpression,
  transport: Transport,
  object: ts.ObjectLiteralExpression | null,
  checker: ts.TypeChecker,
): string | null {
  const where = transport.method;
  if (where === null) return 'GET';
  if (where.property === null) return literalMethod(call.arguments[where.index] ?? null, checker);
  return object ? literalMethod(propertyOf(object, where.property, checker).value, checker) : null;
}

function transportCall(
  call: ts.CallExpression,
  transport: Transport,
  file: string,
  checker: ts.TypeChecker,
): FoundCall {
  const argument = call.arguments[transport.path.index];
  const object = transport.path.property === null ? null : objectOf(argument, checker);
  const found =
    transport.path.property === null || !object
      ? { value: argument ?? null, blockedBy: null }
      : propertyOf(object, transport.path.property, checker);
  const pathNode = transport.path.property !== null && !object ? null : found.value;
  const why =
    pathNode !== null
      ? null
      : found.blockedBy
        ? `a spread this checker cannot read may overwrite the path: ${found.blockedBy.getText()}`
        : object === null
          ? `the call's arguments cannot be read: ${argument?.getText() ?? call.getText()}`
          : `the call names no path: ${argument?.getText() ?? call.getText()}`;
  const method = methodOf(call, transport, object, checker);
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

function methodRefusal(
  method: string | null,
  named: { value: ts.Node | null; blockedBy: ts.Node | null } | null,
  second: ts.Expression | undefined,
): string | null {
  if (method !== null) return null;
  if (named?.blockedBy)
    return `a spread this checker cannot read may set the method: ${named.blockedBy.getText()}`;
  if (named?.value)
    return `the call names a method this checker cannot read: ${named.value.getText()}`;
  return `the call's options cannot be read, so its method is unknown: ${second?.getText() ?? ''}`;
}

/** A transport reached through `.call` or `.apply`, whose arguments are not the transport's own. */
function reflectedTransport(
  call: ts.CallExpression,
  known: ReadonlyMap<ts.Symbol, Transport>,
  checker: ts.TypeChecker,
): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== 'call' && callee.name.text !== 'apply') return false;
  return transportFor(symbolOf(callee.expression, checker), known, checker) !== undefined;
}

function shiftedCall(call: ts.CallExpression, file: string): FoundCall {
  const callee = call.expression.getText();
  return record({
    file,
    at: call,
    raw: callee,
    path: null,
    method: null,
    kind: 'path',
    why: `this transport is reached in a way that does not put its arguments where its signature does: ${callee}`,
  });
}

function networkCall(call: ts.CallExpression, file: string, checker: ts.TypeChecker): FoundCall {
  const argument = call.arguments[0];
  const second = call.arguments[1];
  const options = second ? objectOf(second, checker) : null;
  const named = options ? propertyOf(options, 'method', checker) : null;
  // GET only where the call is READ to send no method. An options object the checker cannot open,
  // a spread that may carry one, or a method expression it cannot evaluate, is a call whose row
  // nobody knows.
  const method = named?.value
    ? literalMethod(named.value, checker)
    : named?.blockedBy || (second && !options)
      ? null
      : 'GET';
  return record({
    file,
    at: argument ?? call,
    raw: argument?.getText() ?? '',
    path: argument ? resolvePathOf(argument, checker) : null,
    method,
    kind: 'fetch',
    why: methodRefusal(method, named, second),
  });
}

/**
 * Nothing in this directory writes one, and the day something does it is refused by name rather
 * than passed over.
 *
 * Matching on the member name alone will refuse an unrelated untyped `.publish(` too. That is the
 * side to be wrong on: the refusal names the receiver and is cleared by typing it, while requiring
 * a resolved receiver here would put the silence back that this whole checker exists to remove.
 */
function untypedTransportCall(call: ts.CallExpression, file: string): FoundCall[] {
  const callee = call.expression;
  const member = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
      ? callee.argumentExpression.text
      : null;
  if (member === null || !transports().some((t) => t.symbol.getName() === member)) return [];
  const receiver = (callee as ts.PropertyAccessExpression).expression.getText();
  return [
    record({
      file,
      at: call,
      raw: callee.getText(),
      path: null,
      method: null,
      kind: 'path',
      why: `${member} is a transport and the type of ${receiver} cannot be read, so this call cannot be priced`,
    }),
  ];
}

/**
 * The transport this callee reaches, through a name it was bound to first where it was.
 *
 * `const publish = client.publish` and `const { publish } = client` each put a local symbol between
 * the call and the transport, and a lookup stopping at that symbol loses the call altogether.
 */
/**
 * The method behind `x.publish.bind(x)`, or `shifted` where the bind fixes an argument as well.
 *
 * Binding a receiver leaves every argument where the transport's signature puts it; binding an
 * argument moves them, and a path read at the old index is a path from another call.
 */
function boundReceiver(node: ts.Expression): ts.Expression | 'shifted' | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  if (node.expression.name.text !== 'bind') return null;
  return node.arguments.length > 1 ? 'shifted' : node.expression.expression;
}

function transportFor(
  symbol: ts.Symbol | null,
  known: ReadonlyMap<ts.Symbol, Transport>,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol> = new Set(),
): Transport | 'shifted' | undefined {
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const direct = known.get(symbol);
  if (direct) return direct;
  const decl = symbol.valueDeclaration;
  if (
    decl &&
    (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) &&
    decl.initializer
  ) {
    const bound = boundReceiver(decl.initializer);
    if (bound === 'shifted') return 'shifted';
    return transportFor(symbolOf(bound ?? decl.initializer, checker), known, checker, seen);
  }
  if (decl && ts.isShorthandPropertyAssignment(decl)) {
    const value = checker.getShorthandAssignmentValueSymbol(decl) ?? null;
    return transportFor(value, known, checker, seen);
  }
  if (decl && ts.isBindingElement(decl) && ts.isIdentifier(decl.name)) {
    const owner = decl.parent.parent;
    const from = ts.isVariableDeclaration(owner) ? owner.initializer : undefined;
    if (!from) return undefined;
    const name = (decl.propertyName ?? decl.name).getText();
    const member = checker.getPropertyOfType(checker.getTypeAtLocation(from), name);
    return transportFor(member ?? null, known, checker, seen);
  }
  return undefined;
}

/** Every GitHub call one source makes, as `METHOD /path`, or the reason one could not be read. */
export function collectGitHubCalls(file: string): FoundCall[] {
  const checker = program().getTypeChecker();
  const known = new Map(transports().map((t) => [t.symbol, t]));
  const out: FoundCall[] = [];
  walk(sourceFile(file), (node) => {
    if (!ts.isCallExpression(node)) return;
    const symbol = symbolOf(node.expression, checker);
    const transport = transportFor(symbol, known, checker);
    // A transport that answers with the `Response` itself wears both shapes; its callers carry the
    // path, so the transport reading is the one that prices the call.
    const reflected = reflectedTransport(node, known, checker);
    if (transport === 'shifted' || reflected) out.push(shiftedCall(node, file));
    else if (transport) out.push(transportCall(node, transport, file, checker));
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
