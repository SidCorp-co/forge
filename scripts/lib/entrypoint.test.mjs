import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launched } from './entrypoint.mjs';

/**
 * ISS-1236 r6: a script launched through a symlinked folder, or from a real path holding a space,
 * exited 0 having run nothing. This launches every guarded script both ways and walks every
 * script and package source for a launch check written by hand.
 *
 * @gate-input whole-tree
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The two helpers: the only files that may hold the comparison itself. */
const HELPERS = new Set(['scripts/lib/entrypoint.mjs', 'packages/core/src/lib/entrypoint.ts']);

/**
 * Every script that runs when launched, with arguments it refuses or a run that only reads, and the
 * words only its own `main` prints. A launch whose guard answered no exits 0 having printed nothing.
 */
const GUARDED = [
  ['scripts/check-repo-path-readers.mjs', ['--bogus'], /the only mode is --all/],
  ['scripts/check-merged-at-writers.mjs', ['--bogus'], /the only mode is --all/],
  ['scripts/check-lazy-module-init.mjs', [], /only --all is supported/],
  ['scripts/check-status-tuples.mjs', ['--bogus'], /the only mode is --all/],
  ['scripts/check-doc-citations.mjs', [], /the only mode is --all/],
  ['scripts/check-retired-model.mjs', [], /check-retired-model: \d+ files scanned/],
  ['scripts/cut-runner-tag.mjs', [], /usage: cut-runner-tag\.mjs/],
  ['scripts/next-runner-version.mjs', [], /next-runner-version: |version=/],
  ['scripts/runner-release-commit.mjs', ['--cwd', '.'], /runner-release-commit: /],
  ['scripts/lib/whole-tree-shell.mjs', ['--print-grammar'], /whole-tree spawn grammar/],
  ['scripts/verify.mjs', ['--entrypoint-test-unknown-flag'], /unknown|usage/i],
];

let scratch;
/** `scripts/` reached through a symlinked folder: argv names the link, the module its target. */
let linked;
/** A copy of `scripts/` whose real path holds a space, beside links to what it imports from. */
let spaced;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'entrypoint-'));
  linked = join(scratch, 'linked');
  mkdirSync(linked);
  symlinkSync(join(ROOT, 'scripts'), join(linked, 'scripts'));
  spaced = join(scratch, 'a checkout');
  mkdirSync(spaced);
  cpSync(join(ROOT, 'scripts'), join(spaced, 'scripts'), {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  });
  symlinkSync(join(ROOT, 'node_modules'), join(spaced, 'node_modules'));
  symlinkSync(join(ROOT, 'packages'), join(spaced, 'packages'));
  for (const file of ['package.json', 'pnpm-workspace.yaml', 'turbo.json']) {
    cpSync(join(ROOT, file), join(spaced, file));
  }
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('launched — the one comparison', () => {
  it('answers yes for the file itself, through a symlinked folder, and from a path with a space', () => {
    const dir = join(scratch, 'a module dir');
    mkdirSync(dir);
    const file = join(dir, 'm.mjs');
    writeFileSync(file, '');
    symlinkSync(dir, join(scratch, 'module-link'));
    const url = pathToFileURL(file).href;
    expect(url).toContain('%20');
    expect(launched(url, file)).toBe(true);
    expect(launched(url, join(scratch, 'module-link', 'm.mjs'))).toBe(true);
  });

  it('answers no for another file, a file that is not there, and no entry at all', () => {
    const file = join(scratch, 'one.mjs');
    writeFileSync(file, '');
    writeFileSync(join(scratch, 'two.mjs'), '');
    const url = pathToFileURL(file).href;
    expect(launched(url, join(scratch, 'two.mjs'))).toBe(false);
    expect(launched(url, join(scratch, 'absent.mjs'))).toBe(false);
    expect(launched(url, '')).toBe(false);
  });
});

describe('every guarded script runs where it is launched from', () => {
  const run = (base, rel, args) => {
    const out = spawnSync(process.execPath, [join(base, rel), ...args], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: out.status, said: `${out.stdout}${out.stderr}` };
  };

  for (const [rel, args, says] of GUARDED) {
    it(`${rel}, launched through a symlinked folder, runs its main`, () => {
      const { said } = run(linked, rel, args);
      expect(said).toMatch(says);
    });

    it(`${rel}, launched from a real path holding a space, runs its main`, () => {
      const { said } = run(spaced, rel, args);
      expect(said).toMatch(says);
    });
  }

  it('lists every script under scripts/ that asks the helper', () => {
    const asking = sourceFiles('scripts').filter(
      (rel) => !HELPERS.has(rel) && /\blaunched\(import\.meta\.url\)/.test(read(rel)),
    );
    expect(asking.sort()).toEqual(GUARDED.map(([rel]) => rel).sort());
  });
});

/**
 * Every place a non-test source file naming `import.meta` reads the process's launch entry
 * (`argv[1]`) itself, as `{ file, line, how }`. Read off the parsed code, so a string or a comment is
 * never a read and no spelling is missed by a text search: an index, `.at()`, a destructuring, a
 * `slice` that keeps the entry, a method that walks it, and each through a name holding argv.
 */
function handWrittenLaunchChecks(files) {
  return files
    .filter(([rel, text]) => !HELPERS.has(rel) && text.includes('argv') && text.includes('meta'))
    .flatMap(([rel, text]) => entryReads(rel, text));
}

/** What wraps an expression without changing its value: argv inside one is still argv. */
const WRAPS = [
  ts.isParenthesizedExpression,
  ts.isAsExpression,
  ts.isTypeAssertionExpression,
  ts.isNonNullExpression,
  ts.isSatisfiesExpression,
];

/** Methods that ask whether argv holds a literal flag: the only walks of the entry that compare nothing to it. */
const FLAG_TESTS = new Set(['includes', 'indexOf', 'lastIndexOf']);

function entryReads(rel, text) {
  const kind = rel.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : rel.endsWith('.ts')
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const src = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  let namesMeta = false;
  const processNames = new Set();
  /** Each name holding argv, with how far into argv it starts: `slice(2)` holds it from 2. */
  const argvNames = new Map();
  const functions = new Map();
  const visit = (fn) => {
    const walk = (node) => {
      fn(node);
      ts.forEachChild(node, walk);
    };
    walk(src);
  };

  /** Names bound by an import: a function another file owns, which this file's walk cannot read. */
  const imported = new Set();
  visit((node) => {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword)
      namesMeta = true;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.name) imported.add(clause.name.text);
      const bound = clause?.namedBindings;
      if (bound && ts.isNamespaceImport(bound)) imported.add(bound.name.text);
      if (bound && ts.isNamedImports(bound))
        for (const el of bound.elements) imported.add(el.name.text);
    }
    if (ts.isImportDeclaration(node) && /^(node:)?process$/.test(node.moduleSpecifier.text ?? '')) {
      const clause = node.importClause;
      if (clause?.name) processNames.add(clause.name.text);
      const bound = clause?.namedBindings;
      if (bound && ts.isNamespaceImport(bound)) processNames.add(bound.name.text);
      if (bound && ts.isNamedImports(bound)) {
        for (const el of bound.elements) {
          if ((el.propertyName ?? el.name).text === 'argv') argvNames.set(el.name.text, 0);
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      functions.set(node.name.text, node.initializer);
    }
  });
  if (!namesMeta) return [];

  const isProcess = (node) =>
    (ts.isIdentifier(node) && (node.text === 'process' || processNames.has(node.text))) ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === 'process' &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis');
  const unwrap = (node) => {
    let n = node;
    while (n && WRAPS.some((is) => is(n))) n = n.expression;
    return n;
  };
  const literal = (node) => {
    const n = unwrap(node);
    if (n && ts.isNumericLiteral(n)) return Number(n.text);
    if (
      n &&
      ts.isPrefixUnaryExpression(n) &&
      n.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(n.operand)
    ) {
      return -Number(n.operand.text);
    }
    return null;
  };
  /** Where in argv `node` starts, when it holds argv; null when it does not. */
  const startOf = (node) => {
    const n = unwrap(node);
    if (!n) return null;
    if (ts.isIdentifier(n)) return argvNames.has(n.text) ? argvNames.get(n.text) : null;
    if (
      ts.isPropertyAccessExpression(n) &&
      n.name.text === 'argv' &&
      isProcess(unwrap(n.expression))
    )
      return 0;
    if (
      ts.isElementAccessExpression(n) &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      n.argumentExpression.text === 'argv' &&
      isProcess(unwrap(n.expression))
    ) {
      return 0;
    }
    if (
      ts.isArrayLiteralExpression(n) &&
      n.elements.length === 1 &&
      ts.isSpreadElement(n.elements[0])
    ) {
      return startOf(n.elements[0].expression);
    }
    if (
      ts.isCallExpression(n) &&
      n.arguments.length === 1 &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'from' &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'Array'
    ) {
      return startOf(n.arguments[0]);
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'slice'
    ) {
      const from = startOf(n.expression.expression);
      const k = n.arguments.length === 0 ? 0 : literal(n.arguments[0]);
      if (from !== null && k !== null && k >= 0) return from + k;
    }
    return null;
  };

  // A name bound to argv makes another, so the bindings are read until no new one appears.
  const bind = (name, start) => {
    if (start === null || argvNames.get(name) === start) return false;
    if (argvNames.has(name) && argvNames.get(name) < start) return false;
    argvNames.set(name, start);
    return true;
  };
  /** A property key's name where the source states it, null where it is computed. */
  const keyOf = (key) => {
    if (ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))
      return key.text;
    if (ts.isComputedPropertyName(key) && ts.isStringLiteralLike(key.expression))
      return key.expression.text;
    return null;
  };
  for (let changed = true; changed; ) {
    changed = false;
    visit((node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          changed = bind(node.name.text, startOf(node.initializer)) || changed;
          if (isProcess(unwrap(node.initializer)) && !processNames.has(node.name.text)) {
            processNames.add(node.name.text);
            changed = true;
          }
        }
        if (ts.isObjectBindingPattern(node.name) && isProcess(unwrap(node.initializer))) {
          for (const el of node.name.elements) {
            const key = keyOf(el.propertyName ?? el.name);
            if ((key === 'argv' || key === null) && ts.isIdentifier(el.name)) {
              changed = bind(el.name.text, 0) || changed;
            }
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        changed = bind(node.left.text, startOf(node.right)) || changed;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        functions.has(node.expression.text)
      ) {
        const params = functions.get(node.expression.text).parameters;
        node.arguments.forEach((arg, i) => {
          const param = params[i]?.name;
          if (param && ts.isIdentifier(param)) changed = bind(param.text, startOf(arg)) || changed;
        });
      }
    });
  }

  const found = [];
  const say = (node, how) => {
    const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
    if (!found.some((f) => f.line === line + 1)) found.push({ file: rel, line: line + 1, how });
  };
  /** Whether a destructuring of argv from `start` binds its entry, by itself or in a rest. */
  const bindsEntry = (elements, start) =>
    elements.some((el, i) => {
      if (ts.isOmittedExpression(el)) return false;
      const rest = ts.isSpreadElement(el) || (ts.isBindingElement(el) && el.dotDotDotToken);
      return rest ? start + i <= 1 : start + i === 1;
    });
  const reachesEntry = (start, index) =>
    index === null || index < 0 ? start <= 1 : start + index === 1;
  const outer = (node) => {
    let n = node;
    while (n.parent && WRAPS.some((is) => is(n.parent))) n = n.parent;
    return n;
  };
  /** An identifier that names something rather than reading it. */
  const naming = (id) => {
    const p = id.parent;
    return (
      (ts.isPropertyAccessExpression(p) && p.name === id) ||
      ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) &&
        p.name === id) ||
      (ts.isBindingElement(p) && p.propertyName === id) ||
      ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) &&
        p.name === id) ||
      ((ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)) && p.name === id) ||
      ts.isImportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p)
    );
  };

  /**
   * How a use of a value holding argv from its entry reads that entry, or null where it cannot: the
   * uses that leave the entry alone are named, and every other use is a read.
   */
  const entryRead = (node, start) => {
    const self = outer(node);
    const p = self.parent;
    const text = () => p.getText(src);
    if (ts.isPropertyAccessExpression(p) && p.expression === self) {
      const method = p.name.text;
      const call = ts.isCallExpression(p.parent) && p.parent.expression === p ? p.parent : null;
      if (!call) return method === 'length' ? null : `argv read by .${method}: ${text()}`;
      if (method === 'slice') {
        const kept = startOf(call);
        if (kept === null) return `argv sliced from where it cannot be told: ${call.getText(src)}`;
        return kept <= 1 ? `argv sliced keeping its entry: ${call.getText(src)}` : null;
      }
      if (method === 'at')
        return reachesEntry(start, literal(call.arguments[0]))
          ? `argv read by .at(): ${call.getText(src)}`
          : null;
      const flagTest =
        FLAG_TESTS.has(method) &&
        call.arguments.every((x) => ts.isStringLiteralLike(x) || ts.isNumericLiteral(x));
      return flagTest ? null : `argv walked by .${method}(): ${call.getText(src)}`;
    }
    if (ts.isElementAccessExpression(p) && p.expression === self) {
      return reachesEntry(start, literal(p.argumentExpression))
        ? `argv read by index: ${text()}`
        : null;
    }
    if (ts.isVariableDeclaration(p) && p.initializer === self) {
      if (ts.isIdentifier(p.name)) return null;
      if (ts.isArrayBindingPattern(p.name))
        return bindsEntry(p.name.elements, start) ? `argv destructured: ${text()}` : null;
      return `argv destructured: ${text()}`;
    }
    if (
      ts.isBinaryExpression(p) &&
      p.right === self &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = p.left;
      if (ts.isIdentifier(left)) return null;
      if (ts.isArrayLiteralExpression(left))
        return bindsEntry(left.elements, start) ? `argv destructured: ${text()}` : null;
      return `argv destructured: ${text()}`;
    }
    if (
      ts.isSpreadElement(p) &&
      ts.isArrayLiteralExpression(p.parent) &&
      p.parent.elements.length === 1
    )
      return null;
    if (ts.isCallExpression(p) && p.arguments.includes(self)) {
      const callee = p.expression;
      if (startOf(p) !== null) return null;
      if (ts.isIdentifier(callee) && imported.has(callee.text)) return null;
      if (ts.isIdentifier(callee) && functions.has(callee.text)) {
        const param = functions.get(callee.text).parameters[p.arguments.indexOf(self)];
        if (param && !param.dotDotDotToken && ts.isIdentifier(param.name)) return null;
        if (param && !param.dotDotDotToken && ts.isArrayBindingPattern(param.name)) {
          return bindsEntry(param.name.elements, start)
            ? `argv destructured by ${callee.text}(): ${text()}`
            : null;
        }
        return `argv destructured by ${callee.text}(): ${text()}`;
      }
      return `argv handed to ${callee.getText(src)}(): ${text()}`;
    }
    return `argv used whole: ${text()}`;
  };

  visit((node) => {
    if (ts.isIdentifier(node) && naming(node)) return;
    if (
      !ts.isIdentifier(node) &&
      !ts.isPropertyAccessExpression(node) &&
      !ts.isElementAccessExpression(node) &&
      !ts.isCallExpression(node) &&
      !ts.isArrayLiteralExpression(node)
    ) {
      return;
    }
    if (WRAPS.some((is) => is(node))) return;
    const start = startOf(node);
    if (start === null || start > 1) return;
    const how = entryRead(node, start);
    if (how) say(node, how);
  });
  return found;
}

describe('no file decides it was launched by hand', () => {
  // FIXTURE TEXT — every spelling this rule refuses, as source, each with the line it is refused at.
  const refused = [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source, searched rather than run
    ['scripts/a.mjs', 'if (import.meta.url === `file://${process.argv[1]}`) main();\n', 1],
    [
      'scripts/b.mjs',
      'if (import.meta.url === pathToFileURL(process.argv[ 1 ]).href) main();\n',
      1,
    ],
    [
      'scripts/at.mjs',
      'main;\nif (import.meta.url === pathToFileURL(process.argv.at(1)).href) main();\n',
      2,
    ],
    [
      'scripts/at-end.mjs',
      'if (import.meta.url === pathToFileURL(process.argv.at(-1)).href) main();\n',
      1,
    ],
    [
      'scripts/hole.mjs',
      'const [, entry] = process.argv;\nif (import.meta.url === pathToFileURL(entry).href) main();\n',
      1,
    ],
    [
      'scripts/named.mjs',
      'const [node, entry, ...rest] = process.argv;\nif (import.meta.filename === entry) main();\n',
      1,
    ],
    [
      'scripts/rest.mjs',
      'const [, ...rest] = process.argv;\nif (import.meta.url.endsWith(rest[0])) main();\n',
      1,
    ],
    [
      'scripts/assigned.mjs',
      'let node, entry;\n[node, entry] = process.argv;\nif (import.meta.url === entry) main();\n',
      2,
    ],
    [
      'scripts/sliced.mjs',
      'const [entry] = process.argv.slice(1);\nif (import.meta.url === entry) main();\n',
      1,
    ],
    [
      'scripts/sliced-var.mjs',
      'const rest = process.argv.slice(1);\nif (import.meta.url === rest[0]) main();\n',
      2,
    ],
    [
      'scripts/sliced-joined.mjs',
      "const entry = process.argv.slice(1).join('');\nif (import.meta.url === pathToFileURL(entry).href) main();\n",
      1,
    ],
    [
      'scripts/sliced-alone.mjs',
      'export const all = process.argv.slice(1);\nexport const ROOT = import.meta.url;\n',
      1,
    ],
    [
      'scripts/sliced-all.mjs',
      'const all = process.argv.slice();\nif (import.meta.url === all.pop()) main();\n',
      1,
    ],
    [
      'scripts/joined.mjs',
      "if (process.argv.join(' ').includes(fileURLToPath(import.meta.url))) main();\n",
      1,
    ],
    [
      'scripts/keyed.mjs',
      'const { 1: entry } = process.argv;\nif (import.meta.filename === entry) main();\n',
      1,
    ],
    [
      'scripts/keyed-assigned.mjs',
      'let entry;\n({ 1: entry } = process.argv);\nif (import.meta.filename === entry) main();\n',
      2,
    ],
    ['scripts/keyed-string.mjs', "if (import.meta.filename === process.argv['1']) main();\n", 1],
    [
      'scripts/stringified.mjs',
      'if (JSON.stringify(process.argv).includes(import.meta.filename)) main();\n',
      1,
    ],
    [
      'scripts/returned.mjs',
      'function args() {\n  return process.argv;\n}\nif (import.meta.url.endsWith(args()[1])) main();\n',
      2,
    ],
    [
      'scripts/param-keyed.mjs',
      'function isMain({ 1: entry }) {\n  return import.meta.filename === entry;\n}\nif (isMain(process.argv)) main();\n',
      4,
    ],
    [
      'scripts/param-hole.mjs',
      'function isMain([, entry]) {\n  return import.meta.filename === entry;\n}\nisMain(process.argv);\n',
      4,
    ],
    [
      'scripts/param-rest.mjs',
      'const isMain = (...all) => import.meta.filename === all[0][1];\nisMain(process.argv);\n',
      2,
    ],
    [
      'packages/core/src/satisfies.ts',
      'function isMain(v: string[]) {\n  return import.meta.filename === v[1];\n}\nisMain(process.argv satisfies string[]);\n',
      2,
    ],
    [
      'packages/core/src/satisfies-var.ts',
      'const v = process.argv satisfies string[];\nif (import.meta.filename === v[1]) main();\n',
      2,
    ],
    [
      'packages/core/src/asserted.ts',
      'const v = <string[]>process.argv;\nif (import.meta.filename === (v as string[])[1]!) main();\n',
      2,
    ],
    [
      'scripts/quoted.mjs',
      "const { 'argv': v } = process;\nif (import.meta.filename === v[1]) main();\n",
      2,
    ],
    [
      'scripts/computed.mjs',
      "const k = 'argv';\nconst { [k]: v } = process;\nif (import.meta.filename === v[1]) main();\n",
      3,
    ],
    [
      'scripts/process-alias.mjs',
      'const p = process;\nif (import.meta.filename === p.argv[1]) main();\n',
      2,
    ],
    [
      'scripts/from.mjs',
      'const a = Array.from(process.argv);\nif (import.meta.url === a[1]) main();\n',
      2,
    ],
    [
      'scripts/var.mjs',
      'const args = process.argv;\n\nif (import.meta.url === pathToFileURL(args[1]).href) main();\n',
      3,
    ],
    [
      'scripts/var-var.mjs',
      'const a = process.argv;\nconst b = a;\nif (import.meta.url === b.at(1)) main();\n',
      3,
    ],
    [
      'scripts/spread.mjs',
      'const a = [...process.argv];\nif (import.meta.url === a[1]) main();\n',
      2,
    ],
    [
      'scripts/index-var.mjs',
      'const i = 1;\nif (import.meta.url === process.argv[i]) main();\n',
      2,
    ],
    [
      'scripts/imported.mjs',
      "import { argv } from 'node:process';\nif (import.meta.url.endsWith(argv[1])) main();\n",
      2,
    ],
    [
      'scripts/renamed.mjs',
      "import { argv as v } from 'node:process';\nif (import.meta.url.endsWith(v[1])) main();\n",
      2,
    ],
    [
      'scripts/default.mjs',
      "import proc from 'node:process';\nif (import.meta.url.endsWith(proc.argv[1])) main();\n",
      2,
    ],
    [
      'scripts/star.mjs',
      "import * as p from 'process';\nif (import.meta.url.endsWith(p.argv.at(1))) main();\n",
      2,
    ],
    [
      'scripts/taken.mjs',
      'const { argv: v } = process;\nif (import.meta.filename === v.at(1)) main();\n',
      2,
    ],
    ['scripts/bracket.mjs', "if (import.meta.url.endsWith(process['argv'][1])) main();\n", 1],
    [
      'scripts/global.mjs',
      'if (import.meta.url.endsWith(globalThis.process.argv[1])) main();\n',
      1,
    ],
    ['scripts/optional.mjs', 'if (import.meta.url.endsWith(process.argv?.[1])) main();\n', 1],
    [
      'scripts/found.mjs',
      'if (process.argv.some((a) => a === fileURLToPath(import.meta.url))) main();\n',
      1,
    ],
    [
      'scripts/includes.mjs',
      'if (process.argv.includes(fileURLToPath(import.meta.url))) main();\n',
      1,
    ],
    [
      'scripts/loop.mjs',
      'for (const a of process.argv) if (a === fileURLToPath(import.meta.url)) main();\n',
      1,
    ],
    [
      'scripts/param.mjs',
      'function isMain(v) {\n  return import.meta.url === pathToFileURL(v[1]).href;\n}\nif (isMain(process.argv)) main();\n',
      2,
    ],
    [
      'scripts/arrow.mjs',
      'const isMain = (v) => import.meta.url === pathToFileURL(v.at(1)).href;\nif (isMain(process.argv)) main();\n',
      1,
    ],
    ['scripts/filename.mjs', 'if (import.meta.filename === process.argv[1]) main();\n', 1],
    [
      'scripts/newurl.mjs',
      "const argv = process.argv;\nif (import.meta.url === new URL(argv[1], 'file://').href) main();\n",
      2,
    ],
    [
      'packages/core/src/c.ts',
      'const isMain = argv[1] && import.meta.url === x(process.argv[1] as string);\n',
      1,
    ],
    [
      'packages/web-v2/src/w.tsx',
      'export const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;\n',
      1,
    ],
  ];

  // FIXTURE TEXT — reads of argv that never touch the launch entry, and launch checks through a helper.
  const allowed = [
    ['scripts/helper.mjs', 'if (launched(import.meta.url)) main();\n'],
    [
      'scripts/args.mjs',
      'const args = process.argv.slice(2);\nconst first = args[0];\nconst ROOT = import.meta.url;\n',
    ],
    [
      'scripts/mode.mjs',
      "if (process.argv[2] !== '--all') fail();\nconst at = process.argv.at(2);\nconst ROOT = import.meta.dirname;\n",
    ],
    [
      'scripts/flags.mjs',
      "const json = process.argv.includes('--json');\nconst n = process.argv.length;\nconst ROOT = import.meta.url;\n",
    ],
    ['scripts/node.mjs', 'const node = process.argv[0];\nconst ROOT = import.meta.url;\n'],
    [
      'scripts/parsed.mjs',
      'function parse(v) {\n  return v.slice(2);\n}\nparse(process.argv);\nconst ROOT = import.meta.url;\n',
    ],
    ['scripts/tail.mjs', 'const [, , ...rest] = process.argv;\nconst ROOT = import.meta.url;\n'],
    [
      'scripts/param-tail.mjs',
      'function flags([, , ...rest]) {\n  return rest;\n}\nflags(process.argv);\nconst ROOT = import.meta.url;\n',
    ],
    [
      'scripts/local.mjs',
      "const argv = text.split(' ');\nconst [head, ...rest] = argv;\nconst x = argv[1];\nconst ROOT = import.meta.url;\n",
    ],
    [
      'scripts/inline.mjs',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source, searched rather than run
      'const SCRIPT = `const [url] = process.argv.slice(1); ${x}`;\n// compares import.meta.url with process.argv[1]\nconst ROOT = import.meta.url;\n',
    ],
    ['scripts/no-meta.mjs', 'const entry = process.argv[1];\n'],
    ['scripts/lib/entrypoint.mjs', 'realpathSync(fileURLToPath(import.meta.url)) === argv[1]'],
    [
      'packages/core/src/lib/entrypoint.ts',
      'export const isEntrypoint = (u) => u === process.argv[1] && import.meta.url;',
    ],
  ];

  it('refuses every spelling of a hand-read launch entry, naming file and line', () => {
    const found = handWrittenLaunchChecks(refused.map(([rel, text]) => [rel, text]));
    expect([...new Set(found.map((f) => f.file))]).toEqual(refused.map(([rel]) => rel));
    for (const [rel, , line] of refused) {
      expect(
        found.filter((f) => f.file === rel).map((f) => f.line),
        rel,
      ).toContain(line);
    }
    for (const f of found) expect(f.how).toMatch(/argv/);
  });

  it('passes a read of argv that leaves the entry alone, a string, a comment and the helpers', () => {
    expect(handWrittenLaunchChecks(allowed)).toEqual([]);
  });

  it('finds none under scripts/ or any package source', () => {
    const roots = [
      'scripts',
      ...readdirSync(join(ROOT, 'packages')).map((p) => `packages/${p}/src`),
    ];
    const files = roots.flatMap((r) => sourceFiles(r)).map((rel) => [rel, read(rel)]);
    expect(files.length).toBeGreaterThan(100);
    expect(handWrittenLaunchChecks(files)).toEqual([]);
  });
});

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function sourceFiles(rel, acc = []) {
  let entries;
  try {
    entries = readdirSync(join(ROOT, rel), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return acc;
    throw err;
  }
  for (const entry of entries) {
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '.next', 'target', 'coverage'].includes(entry.name)) {
        sourceFiles(path, acc);
      }
    } else if (
      /\.(mjs|cjs|js|ts|tsx)$/.test(entry.name) &&
      !/\.(test|fixture)\./.test(entry.name)
    ) {
      acc.push(path);
    }
  }
  return acc;
}
