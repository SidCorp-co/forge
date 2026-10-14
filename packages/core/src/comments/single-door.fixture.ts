import { posix } from 'node:path';
import ts from 'typescript';

/** One place a source writes the comments table, with the line it does so on. */
export interface CommentWrite {
  file: string;
  line: number;
  how: string;
}

const WRITING_CALLS = new Set(['insert', 'update', 'delete']);

const RAW_WRITES = [
  /\binsert\s+into\s+(?:only\s+)?(?:"?public"?\.)?"?comments"?\b/i,
  /\bupdate\s+(?:only\s+)?(?:"?public"?\.)?"?comments"?\s+set\b/i,
  /\bdelete\s+from\s+(?:only\s+)?(?:"?public"?\.)?"?comments"?\b/i,
];

/** What a file calls the comments table, and what it calls a module that exports it. */
interface Bindings {
  tables: Set<string>;
  namespaces: Map<string, ReadonlySet<string>>;
}

interface Parsed {
  sf: ts.SourceFile;
  imports: Array<{ spec: string; named: Array<[string, string]>; namespace: string | null }>;
  declarations: ts.VariableDeclaration[];
  exportsFrom: Array<{ spec: string; pairs: Array<[string, string]> | 'all' }>;
  localExports: Array<[string, string]>;
  exportedVariables: string[];
  calls: ts.CallExpression[];
  strings: ts.LiteralLikeNode[];
  declaredTable: string[];
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isAwaitExpression(current)
    ) {
      current = current.expression;
    } else return current;
  }
}

function isExported(node: ts.VariableStatement): boolean {
  return ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** `pgTable('comments', ...)`, however the call is laid out. */
function declaresCommentsTable(init: ts.Expression | undefined): boolean {
  if (!init) return false;
  const call = unwrap(init);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return false;
  if (call.expression.text !== 'pgTable') return false;
  const [name] = call.arguments;
  return !!name && ts.isStringLiteralLike(name) && name.text === 'comments';
}

function importOf(statement: ts.ImportDeclaration): Parsed['imports'][number] | null {
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) return null;
  const bindings = clause.namedBindings;
  const named: Array<[string, string]> = [];
  let namespace: string | null = null;
  if (bindings && ts.isNamespaceImport(bindings)) namespace = bindings.name.text;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const el of bindings.elements) {
      if (!el.isTypeOnly) named.push([(el.propertyName ?? el.name).text, el.name.text]);
    }
  }
  return { spec: statement.moduleSpecifier.text, named, namespace };
}

function parse(file: string, text: string): Parsed {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const parsed: Parsed = {
    sf,
    imports: [],
    declarations: [],
    exportsFrom: [],
    localExports: [],
    exportedVariables: [],
    calls: [],
    strings: [],
    declaredTable: [],
  };

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      const imported = importOf(statement);
      if (imported) parsed.imports.push(imported);
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const spec =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
      const clause = statement.exportClause;
      if (!clause && spec) parsed.exportsFrom.push({ spec, pairs: 'all' });
      if (clause && ts.isNamedExports(clause)) {
        const pairs: Array<[string, string]> = clause.elements
          .filter((el) => !el.isTypeOnly)
          .map((el) => [(el.propertyName ?? el.name).text, el.name.text]);
        if (spec) parsed.exportsFrom.push({ spec, pairs });
        else parsed.localExports.push(...pairs);
      }
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        if (declaresCommentsTable(decl.initializer)) parsed.declaredTable.push(decl.name.text);
        else parsed.exportedVariables.push(decl.name.text);
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) parsed.declarations.push(node);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WRITING_CALLS.has(node.expression.name.text) &&
      node.arguments.length > 0
    ) {
      parsed.calls.push(node);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      parsed.strings.push(node);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      parsed.strings.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return parsed;
}

/** The file a relative module specifier names, among the files given. */
function resolveModule(
  from: string,
  spec: string,
  known: ReadonlyMap<string, Parsed>,
): string | null {
  if (!spec.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const bare = base.replace(/\.(?:js|ts)$/, '');
  for (const candidate of [`${bare}.ts`, `${base}.ts`, `${bare}/index.ts`]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/** Whether `expr` is the comments table under the names this file gives it. */
function isTable(expr: ts.Expression, b: Bindings): boolean {
  const node = unwrap(expr);
  if (ts.isIdentifier(node)) return b.tables.has(node.text);
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    return b.namespaces.get(node.expression.text)?.has(node.name.text) ?? false;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return b.namespaces.get(node.expression.text)?.has(node.argumentExpression.text) ?? false;
  }
  return false;
}

/** The module an `import('...')` expression names, if `expr` is one. */
function dynamicImportOf(expr: ts.Expression): string | null {
  const node = unwrap(expr);
  const [first] = ts.isCallExpression(node) ? node.arguments : [];
  const isImport =
    ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
  return isImport && first && ts.isStringLiteralLike(first) ? first.text : null;
}

/** Every name the comments table goes by in one file, followed through imports and local aliases. */
function bindingsOf(
  file: string,
  parsed: Parsed,
  known: ReadonlyMap<string, Parsed>,
  exportedAs: ReadonlyMap<string, ReadonlySet<string>>,
): Bindings {
  const b: Bindings = { tables: new Set(), namespaces: new Map() };
  const namesOf = (spec: string): ReadonlySet<string> | null => {
    const target = resolveModule(file, spec, known);
    const names = target ? exportedAs.get(target) : undefined;
    return names && names.size > 0 ? names : null;
  };

  for (const imp of parsed.imports) {
    const names = namesOf(imp.spec);
    if (!names) continue;
    for (const [imported, local] of imp.named) if (names.has(imported)) b.tables.add(local);
    if (imp.namespace) b.namespaces.set(imp.namespace, names);
  }

  const takeFrom = (pattern: ts.ObjectBindingPattern, names: ReadonlySet<string>): void => {
    for (const el of pattern.elements) {
      const key = el.propertyName ?? el.name;
      if (ts.isIdentifier(el.name) && ts.isIdentifier(key) && names.has(key.text)) {
        b.tables.add(el.name.text);
      }
    }
  };

  for (let changed = true; changed; ) {
    const before = b.tables.size + b.namespaces.size;
    for (const decl of parsed.declarations) {
      if (!decl.initializer) continue;
      const spec = dynamicImportOf(decl.initializer);
      const names = spec ? namesOf(spec) : null;
      const init = unwrap(decl.initializer);
      if (names && ts.isIdentifier(decl.name)) b.namespaces.set(decl.name.text, names);
      if (names && ts.isObjectBindingPattern(decl.name)) takeFrom(decl.name, names);
      if (ts.isIdentifier(decl.name) && isTable(init, b)) b.tables.add(decl.name.text);
      if (ts.isIdentifier(init)) {
        const held = b.namespaces.get(init.text);
        if (held && ts.isIdentifier(decl.name)) b.namespaces.set(decl.name.text, held);
        if (held && ts.isObjectBindingPattern(decl.name)) takeFrom(decl.name, held);
      }
    }
    changed = b.tables.size + b.namespaces.size !== before;
  }
  return b;
}

/** Export names of the table per module, settled across chains of re-exports. */
function exportedNames(parsed: ReadonlyMap<string, Parsed>): Map<string, Set<string>> {
  const exportedAs = new Map<string, Set<string>>();
  for (const [file, p] of parsed) exportedAs.set(file, new Set(p.declaredTable));

  for (let changed = true; changed; ) {
    changed = false;
    for (const [file, p] of parsed) {
      const mine = exportedAs.get(file) as Set<string>;
      const add = (name: string): void => {
        if (mine.has(name)) return;
        mine.add(name);
        changed = true;
      };
      for (const from of p.exportsFrom) {
        const target = resolveModule(file, from.spec, parsed);
        const theirs = target ? exportedAs.get(target) : undefined;
        if (!theirs) continue;
        if (from.pairs === 'all') for (const name of theirs) add(name);
        else for (const [imported, as] of from.pairs) if (theirs.has(imported)) add(as);
      }
      if (p.localExports.length > 0 || p.exportedVariables.length > 0) {
        const b = bindingsOf(file, p, parsed, exportedAs);
        for (const [local, as] of p.localExports) if (b.tables.has(local)) add(as);
        for (const name of p.exportedVariables) if (b.tables.has(name)) add(name);
      }
    }
  }
  return exportedAs;
}

/**
 * Every place the given sources write the comments table, outside the files allowed to.
 *
 * Read from each file's syntax tree: the table is the export declared as `pgTable('comments', ...)`,
 * followed through every import of it (named, aliased, namespace or dynamic), re-export and local
 * alias. A write is an `insert`, `update` or `delete` call whose argument is that table, or a raw
 * SQL string that writes a table named `comments`. A comment or a string that merely says
 * `insert(comments)` is not one, and `db.insert(s.comments)` is.
 */
export function commentWrites(
  sources: ReadonlyMap<string, string>,
  doors: ReadonlySet<string>,
): CommentWrite[] {
  const parsed = new Map<string, Parsed>();
  for (const [file, text] of sources) parsed.set(file, parse(file, text));
  const exportedAs = exportedNames(parsed);

  const writes: CommentWrite[] = [];
  for (const [file, p] of parsed) {
    if (doors.has(file)) continue;
    const lineOf = (node: ts.Node): number =>
      p.sf.getLineAndCharacterOfPosition(node.getStart(p.sf)).line + 1;
    const b = bindingsOf(file, p, parsed, exportedAs);
    for (const call of p.calls) {
      const callee = call.expression as ts.PropertyAccessExpression;
      const [target] = call.arguments;
      if (target && isTable(target, b)) {
        const how = `.${callee.name.text}(${target.getText(p.sf)})`;
        writes.push({ file, line: lineOf(callee.name), how });
      }
    }
    for (const node of p.strings) {
      if (RAW_WRITES.some((re) => re.test(node.text))) {
        writes.push({ file, line: lineOf(node), how: 'raw SQL on comments' });
      }
    }
  }
  return writes.sort((a, c) => a.file.localeCompare(c.file) || a.line - c.line);
}
