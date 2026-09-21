#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOT = join(ROOT, 'packages', 'core', 'src');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.next', '.turbo']);

/** The two modules whose exports must not be read at import time, and the export each owns. */
const LAZY_EXPORTS = [
  { file: 'config/env.ts', specifier: /config\/env\.js$/, name: 'env' },
  { file: 'db/client.ts', specifier: /db\/client\.js$/, name: 'db' },
];

function die(message) {
  console.error(`check-lazy-module-init: ${message}`);
  process.exit(2);
}

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

function trackedNames(sourceFile) {
  const direct = new Map();
  const namespaces = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const spec = statement.moduleSpecifier.text;
    const lazy = LAZY_EXPORTS.find((e) => e.specifier.test(spec));
    if (lazy === undefined) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.set(bindings.name.text, lazy.name);
      continue;
    }
    if (!ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === lazy.name) direct.set(element.name.text, lazy.name);
    }
  }
  return { direct, namespaces };
}

function entrypointBindings(sourceFile) {
  const names = new Set();
  const isImportMetaUrl = (node) =>
    ts.isPropertyAccessExpression(node) && node.getText(sourceFile) === 'import.meta.url';
  const isProcessArgvOne = (node) =>
    ts.isElementAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.getText(sourceFile) === 'process.argv' &&
    ts.isNumericLiteral(node.argumentExpression) &&
    node.argumentExpression.text === '1';
  const isEntrypointUrlTemplate = (node) =>
    ts.isTemplateExpression(node) &&
    node.head.text === 'file://' &&
    node.templateSpans.length === 1 &&
    node.templateSpans[0].literal.text === '' &&
    isProcessArgvOne(node.templateSpans[0].expression);
  const isEntrypointTest = (node) => {
    if (node === undefined || !ts.isBinaryExpression(node)) return false;
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
    const sides = [node.left, node.right];
    const urlSide = sides.findIndex(isImportMetaUrl);
    if (urlSide === -1) return false;
    return isEntrypointUrlTemplate(sides[1 - urlSide]);
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && isEntrypointTest(declaration.initializer)) {
        names.add(declaration.name.text);
      }
    }
  }
  return { names, isEntrypointTest };
}

export function importTimeReads(path, text) {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
  const { direct, namespaces } = trackedNames(sourceFile);
  if (direct.size === 0 && namespaces.size === 0) return [];
  const { names: entrypointNames, isEntrypointTest } = entrypointBindings(sourceFile);
  const lines = text.split('\n');
  const found = [];

  const guardsEntrypoint = (expression) =>
    (ts.isIdentifier(expression) && entrypointNames.has(expression.text)) ||
    isEntrypointTest(expression);

  const isImmediatelyInvoked = (node) => {
    // `(() => env.X)()` wraps the arrow in a ParenthesizedExpression, so the CallExpression is the
    // GRANDparent — climbing only one level is how the first version of this check reported clean
    // on the very fixture it was written for.
    let outermost = node;
    while (outermost.parent !== undefined && ts.isParenthesizedExpression(outermost.parent)) {
      outermost = outermost.parent;
    }
    const parent = outermost.parent;
    if (parent === undefined || !ts.isCallExpression(parent)) return false;
    return parent.expression === outermost;
  };

  const walk = (node, runsAtImport) => {
    if (ts.isIfStatement(node) && guardsEntrypoint(node.expression)) {
      walk(node.expression, runsAtImport);
      if (node.thenStatement) walk(node.thenStatement, false);
      if (node.elseStatement) walk(node.elseStatement, runsAtImport);
      return;
    }

    let next = runsAtImport;
    const isFunctionLike =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node) ||
      ts.isConstructorDeclaration(node);
    if (isFunctionLike) next = isImmediatelyInvoked(node) ? runsAtImport : false;

    if ('name' in node && node.name !== undefined && ts.isComputedPropertyName(node.name)) {
      walk(node.name, runsAtImport);
    }

    if (ts.isTypeQueryNode(node)) return;

    if (next && ts.isIdentifier(node)) {
      const parent = node.parent;
      const record = (name, at) => {
        const { line } = sourceFile.getLineAndCharacterOfPosition(at.getStart(sourceFile));
        found.push({ line: line + 1, name, text: (lines[line] ?? '').trim() });
      };

      // `ns.env` / `ns.db` through a namespace import. Read off the property access so the namespace
      // identifier alone — `typeof ns`, passing `ns` around — is not counted.
      if (
        namespaces.has(node.text) &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === namespaces.get(node.text)
      ) {
        record(namespaces.get(node.text), node);
      } else if (direct.has(node.text)) {
        const isBinding = ts.isImportSpecifier(parent);
        const isPropertyName =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node);
        if (!isBinding && !isPropertyName) record(direct.get(node.text), node);
      }
    }
    ts.forEachChild(node, (child) => walk(child, next));
  };

  ts.forEachChild(sourceFile, (child) => walk(child, true));
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) main();

function main() {
  if (!process.argv.includes('--all')) {
    die(
      'only --all is supported: the property is repo-wide and a subset reports clean on a tree that is not',
    );
  }

  let files;
  try {
    files = sourceFiles(SCAN_ROOT);
  } catch (err) {
    die(`could not read ${relative(ROOT, SCAN_ROOT)}: ${err.message}`);
  }
  if (files.length === 0) {
    die(`scanned 0 files under ${relative(ROOT, SCAN_ROOT)} — the scope matched nothing`);
  }

  const offenders = [];
  for (const path of files) {
    const rel = relative(ROOT, path);
    // The two modules own their own exports and are where the lazy read is built.
    if (LAZY_EXPORTS.some((e) => rel.endsWith(e.file))) continue;
    const reads = importTimeReads(path, readFileSync(path, 'utf8'));
    if (reads.length > 0) offenders.push({ path: rel, reads });
  }

  console.log(`lazy-module-init: ${files.length} file(s) scanned`);
  if (offenders.length === 0) process.exit(0);

  const total = offenders.reduce((n, o) => n + o.reads.length, 0);
  console.error(
    `\ncheck-lazy-module-init: ${total} read(s) across ${offenders.length} file(s) run at import\n`,
  );
  for (const { path, reads } of offenders) {
    console.error(`  ${path}`);
    for (const read of reads) console.error(`    :${read.line}  ${read.name}  ${read.text}`);
  }
  console.error(
    '\nEach of these makes IMPORTING this file do work: reading `env` validates the whole\n' +
      'environment and throws on a missing variable, and reading `db` constructs the postgres\n' +
      'pool. Every module downstream of this one inherits that, and the failure it produces\n' +
      'names no test and carries no assertion (ISS-1067).\n' +
      '\n' +
      'Move the read to the moment the value is needed. The three shapes already in the tree:\n' +
      '  a request callback   packages/core/src/index.ts, the cors `origin` callback\n' +
      '  a memoised function  packages/core/src/integrations/rocketchat/connection-manager.ts\n' +
      '  a lazy middleware    packages/core/src/lib/upload-body-limit.ts\n',
  );
  process.exit(1);
}
