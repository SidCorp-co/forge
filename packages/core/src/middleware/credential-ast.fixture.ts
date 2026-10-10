// The vocabulary credential-access.fixture.ts reads core's source in, and the syntax it walks:
// which types a request arrives as, what a member of one can do, and where in the tree a node sits.

import ts from 'typescript';

/** The types a request arrives as, by the package that declares each. */
export const CARRIERS = {
  Context: 'hono',
  HonoRequest: 'hono',
  Request: 'web',
  Headers: 'web',
  URL: 'web',
  URLSearchParams: 'web',
  IncomingMessage: 'node',
  IncomingHttpHeaders: 'node',
  WebSocket: 'ws',
} as const;
export type Carrier = keyof typeof CARRIERS;

/** Where each package declares its types, so a type of core's own of the same name is not one. */
export const PACKAGE_DIRS: Readonly<Record<string, readonly string[]>> = {
  hono: ['/node_modules/hono/'],
  web: [
    '/node_modules/@types/node/',
    '/node_modules/undici-types/',
    '/node_modules/typescript/lib/',
  ],
  node: ['/node_modules/@types/node/'],
  ws: ['/node_modules/@types/ws/'],
};

/**
 * What a carrier's member does: `carrier` yields another carrier, read in turn; `header`, `query`,
 * `param` and `var` read one input named by the first argument (the whole set with none); `fields`
 * reads each field of a validated target; `whole` reads unnamed content; `event` subscribes, and
 * reads content on a `message` or `data` event; `none` carries no request input.
 */
export type Role =
  | 'carrier'
  | 'header'
  | 'query'
  | 'param'
  | 'var'
  | 'fields'
  | 'whole'
  | 'event'
  | 'none';
export type Surface = Readonly<Record<Carrier, ReadonlyMap<string, Role>>>;

/**
 * One access: a named input (`header:authorization`, `field:query:pairing_code`), a whole read
 * keyed `<module> <what> in <owner>`, or a refusal saying what the scan could not read.
 */
export interface Access {
  kind: 'input' | 'whole' | 'refused';
  key: string;
  node: ts.Node;
}

/** A value import of a hono-family package, by `<specifier>:<name>` (`*` for the namespace). */
export interface FrameworkImport {
  key: string;
  node: ts.Node;
}

const FRAMEWORK = /^(hono$|hono\/|@hono\/)/;

/** The hono-family value bindings an import, a re-export or a dynamic import takes. */
export function frameworkImports(node: ts.Node): FrameworkImport[] {
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const spec = node.arguments[0];
    const framework = spec && ts.isStringLiteralLike(spec) && FRAMEWORK.test(spec.text);
    return framework ? [{ key: `${spec.text}:*`, node }] : [];
  }
  if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return [];
  const spec = node.moduleSpecifier;
  if (!spec || !ts.isStringLiteral(spec) || !FRAMEWORK.test(spec.text)) return [];
  if (ts.isExportDeclaration(node)) {
    return node.isTypeOnly ? [] : [{ key: `${spec.text}:*`, node }];
  }
  const clause = node.importClause;
  if (!clause || clause.isTypeOnly) return [];
  const found: FrameworkImport[] = [];
  if (clause.name) found.push({ key: `${spec.text}:default`, node });
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) found.push({ key: `${spec.text}:*`, node });
  else if (named) {
    for (const el of named.elements) {
      if (el.isTypeOnly) continue;
      found.push({ key: `${spec.text}:${(el.propertyName ?? el.name).text}`, node: el });
    }
  }
  return found;
}

/** The instance side of a class or interface type; a constructor's static side is not one. */
export function instanceShape(type: ts.Type): ts.InterfaceType | null {
  if (type.isClassOrInterface()) return type;
  const ref = type as ts.TypeReference;
  const isReference = ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;
  return isReference && ref.target?.isClassOrInterface() ? ref.target : null;
}

export const passesThrough = (n: ts.Node) =>
  ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n);

/** A node without the casts and parentheses around its value. */
export function unwrapped(node: ts.Node | undefined): ts.Node | undefined {
  let at = node;
  while (at && (ts.isAsExpression(at) || ts.isParenthesizedExpression(at))) at = at.expression;
  return at;
}

/** The call a member access is the callee of, through parentheses; null when it is not called. */
export function callOf(access: ts.Node): ts.CallExpression | null {
  let at = access;
  while (passesThrough(at.parent)) at = at.parent;
  const p = at.parent;
  return ts.isCallExpression(p) && p.expression === at ? p : null;
}

const NOT_A_VALUE: readonly ((n: ts.Node) => boolean)[] = [
  ts.isQualifiedName,
  ts.isImportSpecifier,
  ts.isImportClause,
  ts.isNamespaceImport,
  ts.isExportSpecifier,
  ts.isParameter,
  ts.isVariableDeclaration,
  ts.isFunctionDeclaration,
  ts.isClassDeclaration,
  ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration,
  ts.isPropertySignature,
  ts.isMethodSignature,
  ts.isLabeledStatement,
  ts.isBreakOrContinueStatement,
  ts.isEnumMember,
  ts.isEnumDeclaration,
  ts.isBindingElement,
];

const inTypePosition = (node: ts.Node) =>
  ts.findAncestor(node.parent, (n) => ts.isTypeNode(n) || ts.isTypeParameterDeclaration(n)) !==
  undefined;

/** Expressions whose type is worth asking: names in value position, member reads and calls. */
export function isValueExpression(node: ts.Node): node is ts.Expression {
  if (ts.isIdentifier(node)) {
    const p = node.parent;
    const isName =
      (ts.isPropertyAccessExpression(p) ||
        ts.isPropertyAssignment(p) ||
        ts.isPropertyDeclaration(p) ||
        ts.isMethodDeclaration(p)) &&
      p.name === node;
    return !isName && !NOT_A_VALUE.some((is) => is(p)) && !inTypePosition(node);
  }
  const valued =
    node.kind === ts.SyntaxKind.ThisKeyword ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isConditionalExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isAsExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind !== ts.SyntaxKind.EqualsToken);
  return valued && !inTypePosition(node);
}

/** The callee's last name: `f` in `f(…)`, `b` in `a.b(…)`. */
export function calleeName(call: ts.CallExpression | ts.NewExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return e.getText().replace(/\s+/g, ' ');
}

/** The package a declaration file belongs to, `lib` for the language's own. */
export function packageOf(file: string | undefined): string {
  if (!file) return 'unresolved';
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return 'lib';
  const first = parts[at + 1] ?? '';
  if (first === 'typescript') return 'lib';
  return first.startsWith('@') ? `${first}/${parts[at + 2] ?? ''}` : first;
}

/** The outermost named declaration a node sits in: its function, class or top-level binding. */
export function ownerName(node: ts.Node): string {
  let name = 'module code';
  for (let at: ts.Node | undefined = node; at && !ts.isSourceFile(at); at = at.parent) {
    const declared =
      ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isClassDeclaration(at)
        ? at.name
        : undefined;
    if (declared && ts.isIdentifier(declared)) name = declared.text;
    else if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) {
      if (ts.isSourceFile(at.parent.parent.parent)) name = at.name.text;
    }
  }
  return name;
}
