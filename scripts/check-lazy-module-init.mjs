#!/usr/bin/env node
// Refuse a read of `env` or `db` that runs when a core module is merely IMPORTED.
//
// ISS-1067. `config/env.ts` used to validate the environment at module scope and
// `db/client.ts` used to construct the postgres pool there, so importing anything
// whose graph reached either did work — and on a missing variable, threw inside
// the import. That failure has no assertion and no test name in it: the CI log
// for PR #457 showed three stack frames, `env.ts` → `db/client.ts` →
// `knowledge/service.ts`, and the file's three cases reported as skipped.
//
// Both are lazy now. This checker is what keeps them lazy, because the property
// is invisible in a green run: a seventh module-scope reader breaks nothing today
// and restores the whole side effect for every importer downstream of it.
//
// THE RULE is "does this read run when the file is imported", which is NOT the
// same as "is this read outside a function":
//   - a module-scope IIFE is a function body that runs at import, and is caught;
//   - a computed member name (`class C { [env.PORT]() {} }`) is evaluated where
//     the class is, not where the body is called, and is caught;
//   - `import * as config` then `config.env.PORT` is caught, the same as a named
//     import would be;
//   - a `typeof db` in a type position erases at compile time, and is not;
//   - the THEN branch of a block guarded by the entrypoint comparison
//     (`import.meta.url === \`file://${process.argv[1]}\``) does not run when the
//     file is imported — that guard is false precisely when another module is
//     importing it — and is not caught. Its ELSE branch runs on every import and
//     is, and so is an unguarded read elsewhere in the same file. The comparison
//     is matched STRUCTURALLY against that one shape, because anything looser is a
//     way to silence this gate: `import.meta.url === import.meta.url` is always
//     true, and so is `import.meta.url === (process.argv, import.meta.url)`.
//
// WHAT IT CANNOT HOLD, stated because a gate whose limit is unwritten gets read
// as holding more than it does: a named function CALLED at module scope runs at
// import, and a syntactic walk does not follow that call. Nothing in core does
// this today; if something starts to, this checker will not say so.
//
// Modes: --all (CI, the only mode — the property is about every importer of these
// two modules, and a staged subset would report clean on a tree that is not)
// Exit: 0 clean · 1 a read runs at import · 2 could not run.

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

// cm:guard a NAMESPACE import is tracked too. `import * as config from '../config/env.js'` followed
// by `config.env.PORT` reads the environment at import exactly as `env.PORT` does, and a checker that
// only understood named imports would report that file clean — the gate answering "no" to a question
// it never asked.
/**
 * What this file binds to the lazy exports.
 *
 * `direct`: local name -> export name, from `import { env }` / `import { db as x }`.
 * `namespaces`: local name -> export name, from `import * as ns`, read through `ns.env` / `ns.db`.
 */
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

// cm:guard `import.meta.url === \`file://${process.argv[1]}\`` is the entrypoint test, and a block it
// guards does not run when the file is imported — which is the whole property this checker holds.
// Recognised through a binding as well, because `const isMain = import.meta.url === …; if (isMain) {…}`
// is how packages/core/src/index.ts spells it.
// cm:guard the ONE canonical shape and nothing else, matched STRUCTURALLY: one side
// `import.meta.url`, the other a template whose head is `file://` and whose single substitution is
// `process.argv[…]`. Anything looser is a way to silence this gate rather than a guard.
// `import.meta.url === import.meta.url` is always true. So is
// `import.meta.url === (process.argv, import.meta.url)`, which is why the first fix here — a regex
// for `process.argv` over the operand's TEXT — was still wrong: a comma expression mentions
// `process.argv` and evaluates to `import.meta.url`. A checker that can be satisfied by mentioning a
// token is satisfied by a comment.
function entrypointBindings(sourceFile) {
  const names = new Set();
  const isImportMetaUrl = (node) =>
    ts.isPropertyAccessExpression(node) && node.getText(sourceFile) === 'import.meta.url';
  // cm:guard `process.argv[1]` and no other index. `process.argv[2]` is a CLI's first ARGUMENT, so
  // `import.meta.url === \`file://${process.argv[2]}\`` is true whenever a tool is handed this
  // module's own path — the block runs during an import and the gate would call it a guard.
  const isProcessArgvOne = (node) =>
    ts.isElementAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.getText(sourceFile) === 'process.argv' &&
    ts.isNumericLiteral(node.argumentExpression) &&
    node.argumentExpression.text === '1';
  // cm:guard head EXACTLY `file://` and an empty tail: the whole template is the entrypoint path and
  // nothing else. A head that merely starts with it, or a tail carrying more, is a different string.
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

// cm:guard exported so scripts/check-lazy-module-init.test.mjs can hand it fixture TEXT rather than
// plant files in the tree. The alternative was a `--scan-root` flag, which is the one affordance
// this checker must not have: a run that can narrow its own scope reports clean on a tree that is
// not, which is what the `--all` refusal below exists to prevent.
/** Every read of a tracked name that runs when this file is imported. */
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

  // cm:guard an IIFE's body runs at import, so `runsAtImport` stays true through it. Every OTHER
  // function boundary turns it false: `cors({ origin: (o) => env.X.includes(o) })` is the shape
  // this change introduced on purpose, and a checker that flagged any callback would refuse it.
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
      // cm:guard only the THEN branch is outside the property. The test runs at import, and so does
      // the ELSE branch — `if (isMain) {…} else { const port = env.PORT; }` reads the environment on
      // every import, which is the exact case the guard is supposed to be about not doing.
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

    // cm:guard a COMPUTED member name is evaluated where the class or object literal is, not where
    // the body is called: `class C { [env.PORT]() {} }` at module scope reads the environment at
    // import while its body never runs. The name is walked with the ENCLOSING state and the body
    // with the deferred one, because the two are different moments in the same node.
    if ('name' in node && node.name !== undefined && ts.isComputedPropertyName(node.name)) {
      walk(node.name, runsAtImport);
    }

    // cm:guard a type query erases at compile time, so `Pick<typeof db, 'select'>` reads nothing at
    // runtime. 24 of core's 26 module-scope mentions of `db` are exactly this shape, and a checker
    // that counted them would be 92% noise on its first run.
    // cm:guard `isTypeQueryNode` and NOTHING wider. A name bound to a VALUE reaches type syntax only
    // through `typeof`, so this is the narrowest guard that holds the tree — measured: the scan is
    // clean on all 952 files with this alone. `isTypeNode` also holds it today and skips more of the
    // tree than the rule needs, which is where a false negative would come from.
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

// cm:guard `main` runs only when this file IS the command. Its own test IMPORTS it, to hand
// `importTimeReads` fixture text rather than plant files in the tree, and an import that walked 952
// files and called process.exit would take the test runner down with it.
if (import.meta.url === `file://${process.argv[1]}`) main();

// cm:guard --all is the only mode. The property is about every importer of the two modules, so a
// staged subset would report clean on a tree that is not — and a checker that accepted a subset
// would pass the commit that reintroduced the side effect in a file the commit did not touch.
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
