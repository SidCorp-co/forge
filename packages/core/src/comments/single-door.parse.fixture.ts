import ts from 'typescript';

/** A function a call can be traced into: its returns, and which of its parameters reach a write. */
export interface FnInfo {
  kind: 'fn';
  file: string;
  name: string;
  node: ts.Node;
  /** Where the name that binds it is declared: the nearest function, or the file. */
  scope: ts.Node;
  returns: ts.Expression[];
  /** Whether a name in its scope holds it, so a call is traced into it by that name. */
  bound: boolean;
  /** Whether a call can reach it at all, by its name, as a property of an object or at once. */
  named: boolean;
}

export interface NsValue {
  kind: 'ns';
  file: string;
}

/** An object or array literal, whose members the scan reads where they are named. */
export interface LiteralValue {
  kind: 'literal';
  file: string;
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression;
}

export const TABLE = { kind: 'table' } as const;

export type Value = typeof TABLE | NsValue | FnInfo | LiteralValue;

/** What an expression can be: the values the scan follows, and why it could not follow it further. */
export interface Ev {
  values: Set<Value>;
  unknown: string | null;
}

export interface ParamRef {
  fn: FnInfo | null;
  index: number;
  primitive: boolean;
  type: ts.TypeNode | undefined;
}

interface ImportFact {
  spec: string;
  named: Array<[string, string]>;
  namespace: string | null;
}

interface ExportFact {
  spec: string | null;
  kind: 'all' | 'namespace' | 'names';
  as: string;
  pairs: Array<[string, string]>;
}

export interface FileFacts {
  file: string;
  sf: ts.SourceFile;
  imports: ImportFact[];
  exports: ExportFact[];
  defaultExpr: ts.Expression | null;
  exportedLocals: Array<[string, string]>;
  declarations: ts.VariableDeclaration[];
  assignments: ts.BinaryExpression[];
  fns: FnInfo[];
  paramDefaults: ts.ParameterDeclaration[];
  calls: ts.CallExpression[];
  refs: ts.Node[];
  strings: ts.LiteralLikeNode[];
  /** Names this file declares or imports from a sibling module, as opposed to a package or a global. */
  ownNames: Set<string>;
  /** The interfaces and type aliases this file declares, by name. */
  types: Map<string, ts.TypeNode | ts.InterfaceDeclaration>;
}

export const WRITING_CALLS = new Set(['insert', 'update', 'delete']);

const PRIMITIVE_TYPES = new Set([
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.SymbolKeyword,
  ts.SyntaxKind.LiteralType,
  ts.SyntaxKind.TemplateLiteralType,
]);

export function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    } else return current;
  }
}

export function isPrimitiveType(type: ts.TypeNode): boolean {
  if (PRIMITIVE_TYPES.has(type.kind)) return true;
  if (ts.isUnionTypeNode(type)) return type.types.every(isPrimitiveType);
  return ts.isParenthesizedTypeNode(type) && isPrimitiveType(type.type);
}

export function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  return out;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false)
  );
}

export function isFunctionExpression(
  node: ts.Expression,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function collectReturns(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const body = fn.body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

function importOf(statement: ts.ImportDeclaration): ImportFact | null {
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) return null;
  const named: Array<[string, string]> = [];
  let namespace: string | null = null;
  if (clause.name) named.push(['default', clause.name.text]);
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) namespace = bindings.name.text;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const el of bindings.elements) {
      if (!el.isTypeOnly) named.push([(el.propertyName ?? el.name).text, el.name.text]);
    }
  }
  return { spec: statement.moduleSpecifier.text, named, namespace };
}

function exportOf(statement: ts.ExportDeclaration): ExportFact | null {
  if (statement.isTypeOnly) return null;
  const spec =
    statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : null;
  const clause = statement.exportClause;
  if (!clause) return spec ? { spec, kind: 'all', as: '', pairs: [] } : null;
  if (ts.isNamespaceExport(clause)) {
    return spec ? { spec, kind: 'namespace', as: clause.name.text, pairs: [] } : null;
  }
  const pairs: Array<[string, string]> = clause.elements
    .filter((el) => !el.isTypeOnly)
    .map((el) => [(el.propertyName ?? el.name).text, el.name.text]);
  return { spec, kind: 'names', as: '', pairs };
}

function parseFresh(file: string, text: string): FileFacts {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const facts: FileFacts = {
    file,
    sf,
    imports: [],
    exports: [],
    defaultExpr: null,
    exportedLocals: [],
    declarations: [],
    assignments: [],
    fns: [],
    paramDefaults: [],
    calls: [],
    refs: [],
    strings: [],
    ownNames: new Set(),
    types: new Map(),
  };

  const addFn = (
    name: string,
    node: ts.FunctionLikeDeclaration,
    declared: ts.Node,
    how: { bound: boolean; named: boolean },
  ): void => {
    facts.fns.push({
      kind: 'fn',
      file,
      name,
      node,
      scope: scopeAbove(declared),
      returns: collectReturns(node),
      ...how,
    });
  };

  const addFunctionLike = (node: ts.FunctionLikeDeclaration): void => {
    if (ts.isFunctionDeclaration(node)) {
      addFn(node.name?.text ?? 'default', node, node, { bound: true, named: true });
      if (node.name) facts.ownNames.add(node.name.text);
      return;
    }
    const parent = outerParent(node);
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      addFn(parent.name.text, node, parent, { bound: true, named: true });
    } else if (ts.isPropertyAssignment(parent) || ts.isObjectLiteralExpression(node.parent)) {
      const name = ts.isPropertyAssignment(parent) ? parent.name : node.name;
      addFn(name?.getText() ?? 'member', node, node, { bound: false, named: true });
    } else if (ts.isCallExpression(parent) && unwrap(parent.expression) === node) {
      addFn('(anonymous)', node, node, { bound: false, named: true });
    } else addFn('(anonymous)', node, node, { bound: false, named: false });
  };

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      const imported = importOf(statement);
      if (imported) facts.imports.push(imported);
      if (imported?.spec.startsWith('.')) {
        for (const [, local] of imported.named) facts.ownNames.add(local);
        if (imported.namespace) facts.ownNames.add(imported.namespace);
      }
    } else if (ts.isExportDeclaration(statement)) {
      const exported = exportOf(statement);
      if (!exported) continue;
      if (exported.spec === null) facts.exportedLocals.push(...exported.pairs);
      else facts.exports.push(exported);
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      facts.defaultExpr = statement.expression;
    } else if (
      ts.isVariableStatement(statement) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      for (const d of statement.declarationList.declarations) {
        for (const n of bindingNames(d.name)) facts.exportedLocals.push([n, n]);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
      const local = statement.name?.text ?? 'default';
      facts.exportedLocals.push([local, isDefault ? 'default' : local]);
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) facts.types.set(node.name.text, node);
    if (ts.isTypeAliasDeclaration(node)) facts.types.set(node.name.text, node.type);
    if (ts.isTypeNode(node)) return;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      addFunctionLike(node);
    } else if (ts.isClassDeclaration(node) && node.name) {
      facts.ownNames.add(node.name.text);
    } else if (ts.isParameter(node) && node.initializer) {
      facts.paramDefaults.push(node);
    } else if (ts.isVariableDeclaration(node)) {
      facts.declarations.push(node);
      for (const n of bindingNames(node.name)) facts.ownNames.add(n);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      facts.assignments.push(node);
    } else if (ts.isCallExpression(node)) {
      facts.calls.push(node);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      facts.strings.push(node);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      facts.strings.push(node);
    }
    if (
      ts.isIdentifier(node) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      facts.refs.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

/** What a file says, read once per text: a plant changes one file and the other 1,300 are as they were. */
const PARSED = new Map<string, { text: string; facts: FileFacts }>();

export function parse(file: string, text: string): FileFacts {
  const held = PARSED.get(file);
  if (held?.text === text) return held.facts;
  const facts = parseFresh(file, text);
  PARSED.set(file, { text, facts });
  return facts;
}

/** The node that holds this one once parentheses and type assertions are looked through. */
function outerParent(node: ts.Node): ts.Node {
  let parent = node.parent;
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isSatisfiesExpression(parent)
  ) {
    parent = parent.parent;
  }
  return parent;
}

/** The nearest function, or the file, that holds a node. */
export function scopeAbove(node: ts.Node): ts.Node {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) || ts.isSourceFile(n)) return n;
  }
  return node;
}

/**
 * Whether `type`, read in the file `facts` describes, gives the member reached by `path` a primitive
 * type, so a property of a parameter is a string or a number and cannot be a table.
 */
export function primitiveMember(
  facts: FileFacts,
  type: ts.TypeNode | undefined,
  path: readonly string[],
): boolean {
  let current: ts.TypeNode | ts.InterfaceDeclaration | undefined = type;
  for (const name of path) {
    let members: readonly ts.TypeElement[] | undefined;
    for (let depth = 0; current && depth < 8 && !members; depth++) {
      if (ts.isTypeLiteralNode(current) || ts.isInterfaceDeclaration(current)) {
        members = current.members;
      } else if (ts.isTypeReferenceNode(current) && ts.isIdentifier(current.typeName)) {
        current = facts.types.get(current.typeName.text);
      } else if (ts.isParenthesizedTypeNode(current)) current = current.type;
      else return false;
    }
    const member = members?.find(
      (m): m is ts.PropertySignature =>
        ts.isPropertySignature(m) &&
        !!m.name &&
        (ts.isIdentifier(m.name) || ts.isStringLiteralLike(m.name)) &&
        m.name.text === name,
    );
    current = member?.type;
  }
  return !!current && isPrimitiveType(current);
}

export const none = (): Ev => ({ values: new Set(), unknown: null });
export const unknownBecause = (why: string): Ev => ({ values: new Set(), unknown: why });

export function identifiersIn(node: ts.Node, out: string[] = []): string[] {
  if (ts.isIdentifier(node)) out.push(node.text);
  else ts.forEachChild(node, (child) => void identifiersIn(child, out));
  return out;
}

export function mergeInto(into: Ev, from: Ev): void {
  for (const v of from.values) into.values.add(v);
  into.unknown ??= from.unknown;
}

export function merged(a: Ev, b: Ev): Ev {
  const out = { values: new Set(a.values), unknown: a.unknown };
  mergeInto(out, b);
  return out;
}
