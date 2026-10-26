#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'packages/core/src';
const READER = 'packages/core/src/lib/device-pool.ts';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo', 'drizzle']);

/**
 * The files that may read `projects.repoPath`, each for a reason that is not a working directory.
 * A working directory is a device's (`runners.repoPath`), read through `readDeviceBinding` in
 * READER — ISS-1236.
 */
export const DECLARED = new Map([
  ['packages/core/src/db/schema.ts', 'defines the column'],
  [
    'packages/core/src/projects/projections.ts',
    "the project's own setting, as its reads answer it",
  ],
  ['packages/core/src/projects/service.ts', "the project's own setting, as its reads answer it"],
  ['packages/core/src/projects/health-routes.ts', "the project's own setting, shown on its row"],
  [
    'packages/core/src/devices/routes.ts',
    'the default offered beside a device assignment, which is what binding a device starts from',
  ],
  [
    'packages/core/src/release-batch/readiness.ts',
    'whether the project declares a repository (`declaresRepository`)',
  ],
  [
    'packages/core/src/prompt/facts/resolve.ts',
    'whether the project declares a repository (`declaresRepository`)',
  ],
  [
    'packages/core/src/projects/agent-config-schema.ts',
    'names the column in the refusal of the retired `agentConfig.repoPath`; reads nothing',
  ],
  [
    'packages/core/src/integrations/status-service.ts',
    "the git remote the integrations status shows, read on core's own host",
  ],
]);

function die(message) {
  console.error(`check-repo-path-readers: ${message}`);
  process.exit(2);
}

const SQL_WORDS = new Set([
  'on',
  'where',
  'join',
  'left',
  'inner',
  'using',
  'group',
  'order',
  'limit',
  'set',
]);

/** `projects`, optionally schema-qualified and quoted, where a clause names the table it reads. */
const TABLE_IN_SQL = String.raw`(?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?projects"?(?![\w"])`;
const NAMES_PROJECTS = new RegExp(
  String.raw`\b(?:from|join|update|into)\s+${TABLE_IN_SQL}(?:\s+(?:as\s+)?"?([a-z_][a-z0-9_]*)"?)?`,
  'gi',
);
const REPO = new Set(['repoPath', 'repo_path']);
const SELECTS = ['select', 'selectDistinct', 'selectDistinctOn'];
const JOINS = ['from', 'innerJoin', 'leftJoin', 'rightJoin', 'fullJoin', 'crossJoin'];

const calls = (node, names) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  names.includes(node.expression.name.text);
const keyOf = (name) =>
  name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : null;
const unwrap = (node) => {
  let at = node;
  while (
    at &&
    (ts.isParenthesizedExpression(at) ||
      ts.isAsExpression(at) ||
      ts.isNonNullExpression(at) ||
      ts.isSatisfiesExpression(at) ||
      ts.isTypeAssertionExpression(at) ||
      ts.isAwaitExpression(at))
  ) {
    at = at.expression;
  }
  return at;
};

/**
 * What one file binds to the projects table, followed by symbol rather than by name: an import of
 * `projects` under any local name, a namespace import's `projects`, `alias()` of the table, and any
 * variable or destructured binding holding it. Out of reach: the table handed to a function and read
 * through its parameter, a re-export under another name, a table name built at runtime.
 */
function tableBindings(file, checker) {
  const tables = new Set();
  const namespaces = new Set();
  const isNamespace = (node) => {
    const at = unwrap(node);
    return Boolean(at && ts.isIdentifier(at) && namespaces.has(checker.getSymbolAtLocation(at)));
  };
  const isTable = (node) => {
    const at = unwrap(node);
    if (!at) return false;
    if (ts.isIdentifier(at)) {
      const symbol = checker.getSymbolAtLocation(at);
      return symbol ? tables.has(symbol) : at.text === 'projects';
    }
    if (ts.isPropertyAccessExpression(at)) {
      return at.name.text === 'projects' && isNamespace(at.expression);
    }
    if (ts.isElementAccessExpression(at)) {
      return keyOf(at.argumentExpression) === 'projects' && isNamespace(at.expression);
    }
    if (ts.isCallExpression(at)) {
      const callee = ts.isIdentifier(at.expression)
        ? at.expression.text
        : ts.isPropertyAccessExpression(at.expression)
          ? at.expression.name.text
          : null;
      if (callee === 'alias') return isTable(at.arguments[0]);
      if (callee === 'pgTable') return keyOf(at.arguments[0]) === 'projects';
    }
    return false;
  };
  const isModule = (node) => {
    const at = unwrap(node);
    return Boolean(
      at &&
        (isNamespace(at) ||
          (ts.isCallExpression(at) && at.expression.kind === ts.SyntaxKind.ImportKeyword)),
    );
  };
  const declarations = [];
  const collect = (node) => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'projects') {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) tables.add(symbol);
    } else if (ts.isNamespaceImport(node)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) namespaces.add(symbol);
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      declarations.push(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  for (let grew = true; grew; ) {
    grew = false;
    const add = (name) => {
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol && !tables.has(symbol)) {
        tables.add(symbol);
        grew = true;
      }
    };
    for (const decl of declarations) {
      if (ts.isIdentifier(decl.name)) {
        if (isTable(decl.initializer)) add(decl.name);
      } else if (ts.isObjectBindingPattern(decl.name) && isModule(decl.initializer)) {
        for (const element of decl.name.elements) {
          if (
            keyOf(element.propertyName ?? element.name) === 'projects' &&
            ts.isIdentifier(element.name)
          ) {
            add(element.name);
          }
        }
      }
    }
  }
  return { isTable, holdsTable: (node) => holdsTable(node, isTable, checker, tables) };
}

/** An object literal member whose value is the table: `{ project: t }`, `{ projects }`, `{ ...t }`. */
function holdsTable(member, isTable, checker, tables) {
  if (ts.isPropertyAssignment(member)) return isTable(member.initializer);
  if (ts.isSpreadAssignment(member)) return isTable(member.expression);
  if (ts.isShorthandPropertyAssignment(member)) {
    const symbol = checker.getShorthandAssignmentValueSymbol(member);
    return symbol ? tables.has(symbol) : member.name.text === 'projects';
  }
  return false;
}

/** The call among `names` a drizzle chain under `node` started from, if it started from one. */
function chainStart(node, names) {
  for (let at = node; at; ) {
    if (calls(at, names)) return at;
    if (ts.isCallExpression(at) || ts.isPropertyAccessExpression(at)) at = at.expression;
    else if (ts.isAwaitExpression(at) || ts.isParenthesizedExpression(at)) at = at.expression;
    else return null;
  }
  return null;
}

/**
 * Whether a relational `columns` option leaves the path in: drizzle includes only the columns set
 * true where any is, and every column but those set false where none is. A shape it cannot read
 * counts as leaving it in.
 */
function columnsKeepPath(options) {
  const columns =
    options && ts.isObjectLiteralExpression(options)
      ? options.properties.find((p) => ts.isPropertyAssignment(p) && keyOf(p.name) === 'columns')
      : undefined;
  if (!columns) return true;
  if (!ts.isObjectLiteralExpression(columns.initializer)) return true;
  const set = new Map();
  for (const p of columns.initializer.properties) {
    if (!ts.isPropertyAssignment(p)) return true;
    const value = p.initializer.kind;
    if (value !== ts.SyntaxKind.TrueKeyword && value !== ts.SyntaxKind.FalseKeyword) return true;
    set.set(keyOf(p.name), value === ts.SyntaxKind.TrueKeyword);
  }
  const named = [...REPO].map((k) => set.get(k)).find((v) => v !== undefined);
  return [...set.values()].some(Boolean) ? named === true : named !== false;
}

/** `<x>.query.projects` or `<x>.query['projects']`. */
const relationalOnTable = (table) =>
  (ts.isPropertyAccessExpression(table) && table.name.text === 'projects') ||
  (ts.isElementAccessExpression(table) && keyOf(table.argumentExpression) === 'projects')
    ? ts.isPropertyAccessExpression(table.expression) && table.expression.name.text === 'query'
    : false;

/** Whether `node` sits in the options of a relational `findFirst`/`findMany`. */
function inRelationalRead(node) {
  for (let at = node.parent; at; at = at.parent) {
    if (calls(at, ['findFirst', 'findMany'])) {
      const table = at.expression.expression;
      return (
        (ts.isPropertyAccessExpression(table) || ts.isElementAccessExpression(table)) &&
        ts.isPropertyAccessExpression(table.expression) &&
        table.expression.name.text === 'query'
      );
    }
  }
  return false;
}

/**
 * Whether this node hands the file every column of projects, `repoPath` among them, and how to
 * name it: a select with no selection over the table, the relational query, a relation naming it,
 * an argument-less `returning()` after a write, the column map, or an object holding the table.
 */
function wholeRow(node, bound, relations) {
  const { isTable } = bound;
  if (calls(node, JOINS) && isTable(node.arguments[0])) {
    const select = chainStart(node.expression.expression, SELECTS);
    if (!select) return null;
    const selection = select.expression.name.text === 'selectDistinctOn' ? 1 : 0;
    return select.arguments.length <= selection ? '' : null;
  }
  if (calls(node, ['findFirst', 'findMany']) && relationalOnTable(node.expression.expression)) {
    return columnsKeepPath(node.arguments[0]) ? '' : null;
  }
  if (calls(node, ['returning']) && node.arguments.length === 0) {
    const write = chainStart(node.expression.expression, ['update', 'insert', 'delete']);
    return write && isTable(write.arguments[0]) ? '' : null;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'getTableColumns' &&
    isTable(node.arguments[0])
  ) {
    return '';
  }
  if (
    ts.isPropertyAssignment(node) &&
    relations.has(keyOf(node.name)) &&
    ts.isObjectLiteralExpression(node.parent) &&
    ts.isPropertyAssignment(node.parent.parent) &&
    keyOf(node.parent.parent.name) === 'with' &&
    inRelationalRead(node.parent.parent)
  ) {
    const keeps =
      node.initializer.kind === ts.SyntaxKind.TrueKeyword || columnsKeepPath(node.initializer);
    return keeps ? ` (relation ${keyOf(node.name)})` : null;
  }
  if (ts.isObjectLiteralElementLike(node) && bound.holdsTable(node)) {
    return ' (an object holding the table)';
  }
  return null;
}

/** A string or template's own text at its own offset; a template's `${...}` is blanked. */
function literalText(node, source, isTable) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { at: node.getStart(), body: source.slice(node.getStart(), node.end) };
  }
  if (!ts.isTemplateExpression(node)) return null;
  const at = node.getStart();
  let body = source.slice(at, node.end);
  for (const span of node.templateSpans) {
    const from = span.expression.getFullStart() - 2 - at;
    const to = span.literal.getStart() + 1 - at;
    // A binding of the table, interpolated by drizzle, is kept as its name, so the text still
    // says which table it reads.
    const kept = isTable(span.expression)
      ? 'projects'.padStart(to - from)
      : body.slice(from, to).replace(/[^\n]/g, ' ');
    body = body.slice(0, from) + kept + body.slice(to);
  }
  return { at, body };
}

const qualified = (alias, column) =>
  new RegExp(String.raw`(?<![\w"])"?${alias}"?\s*\.\s*(?:"?${column}"?(?![\w"]))`, 'gi');

/** The reads of projects' repo path in an SQL text, each at its offset in that text. */
function sqlReads(body) {
  const reads = [];
  const aliases = new Set();
  let named = false;
  for (const hit of body.matchAll(NAMES_PROJECTS)) {
    named = true;
    if (hit[1] && !SQL_WORDS.has(hit[1].toLowerCase())) aliases.add(hit[1]);
  }
  aliases.add('projects');
  if (named) {
    for (const hit of body.matchAll(/(?<![\w"]|\.\s*)"?repo_path"?(?![\w"])/gi)) {
      reads.push({ index: hit.index, how: 'repo_path (in SQL over projects)' });
    }
    // `SELECT *` takes projects' columns only where its own FROM clause, up to the next SELECT,
    // names the table; `SELECT * FROM aged` over a CTE takes whatever the CTE chose.
    for (const hit of body.matchAll(/\bselect\s+(?:distinct\s+)?\*(?:(?!\bselect\b)[\s\S])*/gi)) {
      if (new RegExp(NAMES_PROJECTS.source, 'i').test(hit[0])) {
        reads.push({ index: hit.index, how: 'a whole row of projects (SELECT *)' });
      }
    }
  }
  for (const alias of named ? aliases : ['projects']) {
    for (const hit of body.matchAll(qualified(alias, 'repo_path'))) {
      reads.push({
        index: hit.index,
        how: alias === 'projects' ? 'projects.repo_path' : `${alias}.repo_path (projects)`,
      });
    }
    for (const hit of body.matchAll(qualified(alias, String.raw`\*`))) {
      reads.push({
        index: hit.index,
        how:
          alias === 'projects'
            ? 'a whole row of projects (projects.*)'
            : `a whole row of projects (${alias}.*)`,
      });
    }
  }
  return reads;
}

/** Text of an access path as written, a string key in single quotes. */
const spelled = (node, file) =>
  ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
    ? `${spelled(node.expression, file)}['${node.argumentExpression.text}']`
    : node.getText(file).replace(/\?\./g, '.');

/** Every read of the path in one parsed file, against the checker its program built. */
function readsOf(rel, file, checker, relations) {
  const bound = tableBindings(file, checker);
  const source = file.text;
  const reads = [];
  const at = (pos, how) =>
    reads.push({ rel, line: file.getLineAndCharacterOfPosition(pos).line + 1, how, pos });
  const named = (table, column) => {
    const path = spelled(unwrap(table), file);
    return path === 'projects' ? `projects${column}` : `${path}${column} (projects)`;
  };
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      REPO.has(node.name.text) &&
      bound.isTable(node.expression)
    ) {
      at(node.getStart(), named(node.expression, `.${node.name.text}`));
    }
    if (
      ts.isElementAccessExpression(node) &&
      REPO.has(keyOf(node.argumentExpression)) &&
      bound.isTable(node.expression)
    ) {
      at(node.getStart(), named(node.expression, `['${keyOf(node.argumentExpression)}']`));
    }
    if (
      ts.isBindingElement(node) &&
      REPO.has(keyOf(node.propertyName ?? node.name)) &&
      ts.isObjectBindingPattern(node.parent) &&
      ts.isVariableDeclaration(node.parent.parent) &&
      bound.isTable(node.parent.parent.initializer)
    ) {
      const path = spelled(unwrap(node.parent.parent.initializer), file);
      const of = path === 'projects' ? '' : 'projects, ';
      at(node.getStart(), `${path}.repoPath (${of}destructured)`);
    }
    const whole = wholeRow(node, bound, relations);
    if (whole !== null) {
      const name = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression);
      at(
        name ? node.expression.name.getStart() : node.getStart(),
        `a whole row of projects${whole}`,
      );
    }
    const literal = literalText(node, source, bound.isTable);
    if (literal) for (const r of sqlReads(literal.body)) at(literal.at + r.index, r.how);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return reads.sort((a, b) => a.pos - b.pos).map(({ pos: _pos, ...r }) => r);
}

/**
 * One program over the files, binding each without resolving a module or loading a library, so
 * every identifier answers with its own declaration's symbol.
 */
function program(sources) {
  const files = new Map(
    [...sources].map(([rel, text]) => [
      rel,
      ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    ]),
  );
  const host = {
    getSourceFile: files.get.bind(files),
    fileExists: files.has.bind(files),
    readFile: sources.get.bind(sources),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    getDirectories: () => [],
    directoryExists: () => false,
  };
  const built = ts.createProgram({
    rootNames: [...files.keys()],
    options: { noResolve: true, noLib: true, types: [] },
    host,
  });
  return { checker: built.getTypeChecker(), file: built.getSourceFile.bind(built) };
}

/** The names of the relations that target projects, read off every `one(<table>)`/`many(<table>)`. */
function relationsToTable(built, rels) {
  const names = new Set();
  for (const rel of rels) {
    const file = built.file(rel);
    const { isTable } = tableBindings(file, built.checker);
    const visit = (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        ['one', 'many'].includes(node.initializer.expression.text) &&
        isTable(node.initializer.arguments[0])
      ) {
        names.add(keyOf(node.name));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return names;
}

/**
 * Every read of `projects.repoPath` in one source file, parsed rather than pattern-matched so a
 * comment, a regular expression or a string holding a quote cannot hide what follows it, and
 * followed by symbol so no other name for the table hides it either.
 */
export function readsIn(rel, source, relations = new Set()) {
  const built = program(new Map([[rel, source]]));
  return readsOf(rel, built.file(rel), built.checker, relations);
}

/**
 * Text every read this check reports contains: every shape spells `projects`, in
 * SQL in any case, or is a relational find. A file holding neither is not bound — four in five,
 * and most of the run's time.
 */
export const MAY_READ_TABLE = /projects|find(?:First|Many)/i;

function walk(rel, acc) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path, acc);
      continue;
    }
    if (!/\.ts$/.test(entry.name)) continue;
    if (/\.(test|fixture)\.ts$/.test(entry.name) || /\.fixture\./.test(entry.name)) continue;
    acc.push(path);
  }
  return acc;
}

function main() {
  if (process.argv[2] !== '--all')
    die('the only mode is --all — a staged subset reports clean on a tree that is not');
  if (!existsSync(join(ROOT, READER))) {
    die(`${READER} is not there, so nothing reads a device's binding and this rule cannot hold`);
  }
  const gone = [...DECLARED.keys()].filter((rel) => !existsSync(join(ROOT, rel)));
  if (gone.length > 0) {
    die(`a declared reader no longer exists — remove it from DECLARED: ${gone.join(', ')}`);
  }

  const files = walk(SOURCE, []);
  if (files.length === 0) die(`no source files found under ${SOURCE}`);

  const sources = new Map(
    files
      .map((rel) => [rel, readFileSync(join(ROOT, rel), 'utf8')])
      .filter(([, text]) => MAY_READ_TABLE.test(text)),
  );
  const built = program(sources);
  const relations = relationsToTable(
    built,
    [...sources.keys()].filter((rel) => rel.startsWith(`${SOURCE}/db/`)),
  );
  if (relations.size === 0) {
    die(
      `no relation under ${SOURCE}/db targets projects, so a relational read of one cannot be seen`,
    );
  }
  const reads = [...sources.keys()]
    .filter((rel) => !DECLARED.has(rel))
    .flatMap((rel) => readsOf(rel, built.file(rel), built.checker, relations));

  if (reads.length > 0) {
    console.error(
      `check-repo-path-readers: ${reads.length} read(s) of projects.repoPath outside the declared readers:\n`,
    );
    for (const r of reads) console.error(`  ${r.rel}:${r.line} — ${r.how}`);
    console.error(
      `\nA working directory is the device's, never the project's (ISS-1236): every box keeps the\n` +
        `project at its own path, so the project's value names some other box. Take it from\n` +
        `\`readDeviceBinding\` in ${READER}, which refuses a device the project never bound.\n` +
        `If this file reads the project's own setting for another reason, add it to DECLARED in\n` +
        `scripts/check-repo-path-readers.mjs with that reason.`,
    );
    process.exit(1);
  }

  console.log(
    `repo-path-readers: ${files.length} file(s) scanned, ${DECLARED.size} declared reader(s)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
