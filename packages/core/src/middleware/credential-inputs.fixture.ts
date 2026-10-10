// Every read of a request input in a module of core, for credential-doors.test.ts: a header, a
// query key, the whole header set. Each read names what it reads, or null where the name is computed.

import ts from 'typescript';

/** What the scan reads of a parsed module: its key, its source, and its top-level declarations. */
export interface ScannedModule {
  readonly key: string;
  readonly file: ts.SourceFile;
  readonly decls: Map<string, { node: ts.Node; exported: boolean }>;
}

/** One read of a request input: what it names (null when computed or whole), and where. */
export interface InputRead {
  kind: 'header' | 'query';
  name: string | null;
  text: string;
  node: ts.Node;
}

/** A name written as a string, or as a module constant holding one; null when computed. */
function literal(mod: ScannedModule, node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text.toLowerCase();
  if (!ts.isIdentifier(node)) return null;
  const decl = mod.decls.get(node.text)?.node;
  const init = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
  const constant =
    decl && ts.isVariableDeclarationList(decl.parent) && decl.parent.flags & ts.NodeFlags.Const;
  return constant && init && ts.isStringLiteralLike(init) ? init.text.toLowerCase() : null;
}

const isWritten = (node: ts.Node) =>
  ts.isBinaryExpression(node.parent) &&
  node.parent.left === node &&
  node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;

/** The header-set methods that read one header, the ones that read every header, and writes. */
const ONE_HEADER = new Set(['get', 'has', 'getSetCookie']);
const HEADER_WRITES = new Set(['set', 'append', 'delete']);

/**
 * Every read of a request input in a module: a header by `.header(x)`, `.headers.get/has(x)`,
 * `.headers[x]`, `.headers.<name>` or a destructure of `.headers`, the whole header set handed on,
 * and a query key by the request's `query` or `queries` method, or `searchParams.get/getAll/has(x)`.
 */
export function inputReads(mod: ScannedModule): InputRead[] {
  const reads: InputRead[] = [];
  const text = (n: ts.Node) => n.getText(mod.file);
  const add = (kind: InputRead['kind'], name: string | null, node: ts.Node) =>
    reads.push({ kind, name, text: text(node), node });

  const headersAccess = (node: ts.PropertyAccessExpression) => {
    const parent = node.parent;
    if (isWritten(node)) return;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      const method = parent.name.text;
      const call = parent.parent;
      const called = ts.isCallExpression(call) && call.expression === parent;
      if (called && HEADER_WRITES.has(method)) return;
      if (called && ONE_HEADER.has(method)) {
        const name = literal(mod, call.arguments[0]);
        add('header', name, name === null ? call : parent);
        return;
      }
      if (called) return add('header', null, call);
      if (!isWritten(parent)) add('header', method.toLowerCase(), parent);
      return;
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === node) {
      if (isWritten(parent)) return;
      const name = literal(mod, parent.argumentExpression);
      return add('header', name, parent);
    }
    if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
      for (const el of parent.name.elements) {
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) {
          add('header', key.text.toLowerCase(), el);
        } else add('header', null, el);
      }
      return;
    }
    add('header', null, node);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const method = callee.name.text;
      const onReq = ts.isPropertyAccessExpression(callee.expression)
        ? callee.expression.name.text === 'req'
        : ts.isIdentifier(callee.expression) && callee.expression.text === 'req';
      if (method === 'header' && node.arguments.length <= 1) {
        add('header', node.arguments.length ? literal(mod, node.arguments[0]) : null, node);
      } else if ((method === 'query' || method === 'queries') && onReq) {
        add('query', node.arguments.length ? literal(mod, node.arguments[0]) : null, node);
      } else if (
        ['get', 'getAll', 'has'].includes(method) &&
        ((ts.isPropertyAccessExpression(callee.expression) &&
          callee.expression.name.text === 'searchParams') ||
          (ts.isIdentifier(callee.expression) && callee.expression.text === 'searchParams'))
      ) {
        add('query', literal(mod, node.arguments[0]), node);
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'headers') headersAccess(node);
    if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      (node.propertyName ?? node.name).getText(mod.file) === 'headers'
    ) {
      add('header', null, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(mod.file);
  return reads;
}

export const inputKey = (read: InputRead) => `${read.kind}:${read.name}`;
export const computedKey = (mod: ScannedModule, read: InputRead) => `${mod.key} ${read.text}`;
