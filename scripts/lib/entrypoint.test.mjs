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
import { builtinModules } from 'node:module';
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
 * Every place a non-test source file naming `import.meta` reaches past what this walk allows, as
 * `{ file, line, how }`. Read off the parsed code, so a string or a comment is never a read.
 *
 * The rule is an allow-list (ISS-1236 r10): process is read only in the forms below, each handing
 * back something that is not process and does not hold the launch entry (`argv[1]`); every other read
 * of process, by name, import, re-export or destructuring, is refused. What it allows, and why:
 * - `process.env` and anything under it: the environment's strings, holding nothing of process;
 * - `process.exitCode`, `.platform`, `.arch`, `.version`, `.pid`: a number or a short string;
 * - `process.execPath` and `.execArgv`: node's own binary and options, never the launch entry;
 *
 * - `process.exit()`, `.kill()`, `.cwd()`: nothing, a boolean, or the working directory;
 * - `process.stdout` and `.stderr`: `.write()` called, a boolean back, and `.isTTY` read, a boolean;
 * - `process.argv.length`, and `argv[n]`, `.at(n)` and `.slice(n)` for a literal `n` of 2 or more:
 *   the arguments after the entry;
 * - `process.on()` and `.once()` as a statement with a literal event and an arrow listener: process
 *   calls a listener with itself as `this`, which an arrow does not take, and the call's value is
 *   dropped;
 *
 * - `typeof process`: a string. The global object (`globalThis`, `global`, `self`, `window`) is
 *   read only by a stated name other than `eval`, `Function`, `Reflect` and `require`; its `process`
 *   is judged as above.
 *
 * Refused outright wherever it stands in such a file, each a route to process, or to code built from
 * a string that names it, that no reading of this file can follow:
 * - `eval` and `Function`, by name or off the global object;
 * - a value's `constructor`, by name, by a string, or destructured: off a function it is `Function`;
 * - a prototype reached or changed (`prototype`, `__proto__`, `getPrototypeOf`, `setPrototypeOf`):
 *   the allowed forms call natives such as `Array.prototype.slice`, and one replaced here would hand
 *   back the entry from `process.argv.slice(2)`;
 *
 * - a property read by a key the walk cannot resolve — bracketed, destructured or by `Reflect.get` —
 *   since that key can be `constructor`. A key resolves where it is a string literal, a const name
 *   holding one, a number (a numeric literal, arithmetic, or a name every write gives a number), a
 *   symbol, or a loop's name over a list of these written in place. `Reflect` is used only as
 *   `Reflect.<name>()`;
 * - a property descriptor read (`getOwnPropertyDescriptor(s)`, `__lookupGetter__`,
 *   `__lookupSetter__`), which hands a property's value without naming it, `constructor` among them;
 *
 * - the file loading itself by a path or a `file:` URL, in any spelling Node resolves to it; a module
 *   named by anything but a literal; a module loaded from a URL (`data:` carries code as a string);
 * - a node module outside a named set: `node:cluster`'s `settings.exec` is the launch entry, and
 *   `node:vm`, `node:inspector`, `node:repl` and `node:module` (its `Module._compile`, and the
 *   require `createRequire` makes) run a string as code; and `require` itself.
 *
 * What static reading of one file's own code still cannot see, and so passes:
 * - what another file hands this one: a value it exports (`import { entry } from './other.mjs'`
 *   holding argv[1]), a function it exports that this file calls, what a module it imports hands
 *   back. Node's own modules are other files too, which is why only a named set of them is allowed;
 * - what a caller in another file hands a function of this one: a parameter, or its `this`;
 * - code built outside this file: a string another file runs, a native addon, a child process;
 *
 * - the file loaded back by a name only something outside it resolves — its package's own name, an
 *   `#` import, a symlink — which hands back its own exports, holding nothing this rule let through.
 *
 * What criterion 29 leaves outside by its own words, though static reading sees it:
 * - a launch check in a file that never names `import.meta`: the criterion is about files that do;
 * - the launch entry read from anything but `process.argv`, such as `/proc/self/cmdline` or a stack
 *   trace: the criterion is about `process.argv`.
 */
function handWrittenLaunchChecks(files) {
  return files
    .filter(([rel, text]) => !HELPERS.has(rel) && text.includes('meta'))
    .flatMap(([rel, text]) => launchRoutes(rel, text));
}

/** What wraps an expression without changing its value. */
const WRAPS = [
  ts.isParenthesizedExpression,
  ts.isAsExpression,
  ts.isTypeAssertionExpression,
  ts.isNonNullExpression,
  ts.isSatisfiesExpression,
];
const GLOBAL_NAMES = ['globalThis', 'global', 'self', 'window'];
const CODE_BUILDERS = ['eval', 'Function'];
/** Names the global object is never read by: code builders, and what reads a property by any key. */
const GLOBAL_REFUSED = [...CODE_BUILDERS, 'Reflect', 'require'];
/**
 * Node modules a guarded file may load: none hands back process or the launch entry. A child or a
 * worker runs with its own argv (a worker's is node and `[worker eval]` or its file), and `util`'s
 * `parseArgs` reads only the arguments after the entry.
 */
const NODE_MODULES = new Set([
  'child_process',
  'crypto',
  'fs',
  'fs/promises',
  'http',
  'os',
  'path',
  'url',
  'util',
  'worker_threads',
]);
/** Names that reach or change a prototype, whose methods the allowed forms of process call. */
const PROTOTYPE_NAMES = new Set(['prototype', '__proto__', 'getPrototypeOf', 'setPrototypeOf']);
/** Node modules that run a string as code: `vm`'s scripts, the inspector's `Runtime.evaluate`, the
 *  REPL's input, and `module`'s `Module` and its `_compile`, reached too by the require `createRequire` makes. */
const STRING_RUNNERS = new Set(['inspector', 'inspector/promises', 'module', 'repl', 'vm']);
const DESCRIPTOR_READERS = new Set([
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  '__lookupGetter__',
  '__lookupSetter__',
]);
/** Operators whose value is always a number or a bigint. */
const ARITHMETIC = new Set([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
]);
/** Operators that keep a number a number when both sides are one. */
const NUMBER_PRESERVING = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

function launchRoutes(rel, text) {
  const kind = rel.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : /\.[mc]?ts$/.test(rel)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const src = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const visit = (fn) => {
    const walk = (node) => {
      fn(node);
      ts.forEachChild(node, walk);
    };
    walk(src);
  };
  let namesMeta = false;
  visit((node) => {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword)
      namesMeta = true;
  });
  if (!namesMeta) return [];

  const { bindingAt, naming, inType } = scopes(src, visit);
  const unbound = (id) => bindingAt(id).length === 0;
  const unwrap = (node) => {
    let n = node;
    while (n && WRAPS.some((is) => is(n))) n = n.expression;
    return n;
  };
  const outer = (node) => {
    let n = node;
    while (n.parent && WRAPS.some((is) => is(n.parent))) n = n.parent;
    return n;
  };
  const literalText = (node) => {
    const n = unwrap(node);
    return n && ts.isStringLiteralLike(n) ? n.text : null;
  };
  const global = (node, name) => {
    const n = unwrap(node);
    return !!n && ts.isIdentifier(n) && n.text === name && unbound(n);
  };

  const found = [];
  const say = (node, how) => {
    const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
    if (!found.some((f) => f.line === line + 1)) found.push({ file: rel, line: line + 1, how });
  };
  const shown = (node) => node.getText(src).replace(/\s+/g, ' ').slice(0, 120);

  // Keys: what a computed key is, where the walk can tell.
  const soleDecl = (id) => {
    const decls = bindingAt(id);
    if (decls.length !== 1) return null;
    const { decl } = decls[0];
    return ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl : null;
  };
  const looping = (decl) => {
    const loop = decl.parent.parent;
    return ts.isForOfStatement(loop) || ts.isForInStatement(loop);
  };
  const writes = writesByDecl(src, visit, bindingAt, unwrap);
  /** Whether an expression is always a number or a bigint, neither of which names `constructor`. */
  const numeric = (node, assumed = new Set()) => {
    const n = unwrap(node);
    if (!n) return false;
    if (ts.isNumericLiteral(n) || ts.isBigIntLiteral(n) || ts.isPostfixUnaryExpression(n))
      return true;
    if (ts.isPrefixUnaryExpression(n)) return n.operator !== ts.SyntaxKind.ExclamationToken;
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (ARITHMETIC.has(op)) return true;
      return NUMBER_PRESERVING.has(op) && numeric(n.left, assumed) && numeric(n.right, assumed);
    }
    if (ts.isConditionalExpression(n))
      return numeric(n.whenTrue, assumed) && numeric(n.whenFalse, assumed);
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (['Number', 'parseInt', 'parseFloat'].some((name) => global(callee, name))) return true;
      return (
        ts.isPropertyAccessExpression(callee) &&
        (global(callee.expression, 'Math') || global(callee.expression, 'Number'))
      );
    }
    if (!ts.isIdentifier(n)) return false;
    // A name is a number where its first value and every later write is one; a write that reads the
    // name itself is judged on the assumption that it is, which only a non-number elsewhere undoes.
    const decl = soleDecl(n);
    if (!decl || looping(decl)) return false;
    if (assumed.has(decl)) return true;
    assumed.add(decl);
    const later = writes.get(decl) ?? [];
    if (decl.initializer ? !numeric(decl.initializer, assumed) : later.length === 0) return false;
    return later.every((w) => !!w && (!ts.isBinaryExpression(w) || numeric(w.right, assumed)));
  };
  /** Whether a key is one the walk resolves: a string it reads, a number or a symbol. */
  const resolved = (node) => {
    const n = unwrap(node);
    if (!n) return false;
    if (ts.isStringLiteralLike(n) || numeric(n)) return true;
    if (ts.isIdentifier(n)) {
      const decl = soleDecl(n);
      if (!decl || (writes.get(decl) ?? []).length > 0) return false;
      // A loop's name takes each item of the list it walks: resolved where every item is.
      if (looping(decl)) return listed(decl.parent.parent.expression);
      return (
        !!decl.initializer &&
        !!(decl.parent.flags & ts.NodeFlags.Const) &&
        resolved(decl.initializer)
      );
    }
    if (ts.isPropertyAccessExpression(n)) return global(n.expression, 'Symbol');
    if (!ts.isCallExpression(n)) return false;
    const callee = unwrap(n.expression);
    return (
      global(callee, 'Symbol') ||
      (ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'for' &&
        global(callee.expression, 'Symbol'))
    );
  };

  /** Whether a loop walks a list written in place whose every item is a resolved key. */
  const listed = (list) => {
    const n = unwrap(list);
    return !!n && ts.isArrayLiteralExpression(n) && n.elements.every((el) => resolved(el));
  };
  /** The stated names read off `node` one after another, and the outermost of those reads. */
  const chain = (node) => {
    const path = [];
    let end = outer(node);
    for (;;) {
      const p = end.parent;
      if (ts.isPropertyAccessExpression(p) && p.expression === end) path.push(p.name.text);
      else if (ts.isElementAccessExpression(p) && p.expression === end) {
        const key = unwrap(p.argumentExpression);
        if (ts.isStringLiteralLike(key)) path.push(key.text);
        else if (ts.isNumericLiteral(key)) path.push(Number(key.text));
        else break;
      } else break;
      end = outer(p);
    }
    const call =
      ts.isCallExpression(end.parent) && end.parent.expression === end ? end.parent : null;
    return { path, end, call };
  };

  // Modules: a default or namespace import of process's module is a name for process.
  const processImports = new Set();
  const nodeModule = (spec) => {
    const bare = spec.replace(/^node:/, '');
    return spec.startsWith('node:') || builtinModules.includes(bare) ? bare : null;
  };
  const own = pathToFileURL(join(ROOT, rel));
  const stem = (p) => p.replace(/\.[mc]?[jt]sx?$/, '');
  const isSelf = (spec) => {
    if (!/^(\.\.?\/|\/|file:)/.test(spec)) return false;
    try {
      return stem(resolve(fileURLToPath(new URL(spec, own)))) === stem(fileURLToPath(own));
    } catch {
      return false;
    }
  };
  /** Why a module this file loads, other than by a static import of process, is refused. */
  const loadRefusal = (spec) => {
    if (spec === null) return 'a module named by something other than a literal';
    if (isSelf(spec)) return 'the file loading itself';
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec) && !/^(node|file):/.test(spec))
      return 'a module loaded from a URL, which can carry code as a string';
    const node = nodeModule(spec);
    if (node === 'process') return 'process loaded where its uses cannot be followed';
    if (node !== null && STRING_RUNNERS.has(node))
      return `a node module that runs a string as code (${node})`;
    if (node !== null && !NODE_MODULES.has(node))
      return `a node module outside the set this walk allows (${node})`;
    return null;
  };
  visit((node) => {
    if (!ts.isImportDeclaration(node)) return;
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) return;
    const spec = literalText(node.moduleSpecifier);
    const bound = clause.namedBindings;
    const builtin = nodeModule(spec ?? '');
    if (builtin === 'process') {
      if (clause.name) processImports.add(clause);
      if (bound && ts.isNamespaceImport(bound)) processImports.add(bound);
      if (bound && ts.isNamedImports(bound) && bound.elements.some((el) => !el.isTypeOnly))
        say(node, `process's members imported by name: ${shown(node)}`);
      return;
    }
    const why = loadRefusal(spec);
    if (why) say(node, `${why}: ${shown(node)}`);
  });

  const isProcess = (node) => {
    if (ts.isIdentifier(node)) {
      if (naming(node) || inType(node)) return false;
      const decls = bindingAt(node);
      if (decls.length === 0) return node.text === 'process';
      return decls.some((d) => processImports.has(d.decl));
    }
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
    const name = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : literalText(node.argumentExpression);
    return name === 'process' && isGlobal(unwrap(node.expression));
  };
  function isGlobal(node) {
    if (ts.isIdentifier(node))
      return !naming(node) && !inType(node) && GLOBAL_NAMES.includes(node.text) && unbound(node);
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
    const name = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : literalText(node.argumentExpression);
    return GLOBAL_NAMES.includes(name) && isGlobal(unwrap(node.expression));
  }
  const literalAtLeast = (arg, n) => {
    const k = unwrap(arg);
    return !!k && ts.isNumericLiteral(k) && Number(k.text) >= n;
  };
  /** Whether a read of process is one the allow-list in the header names. */
  const processAllowed = (ref) => {
    const { path, call } = chain(ref);
    if (path.length === 0) return ts.isTypeOfExpression(outer(ref).parent);
    const [first, second] = path;
    switch (first) {
      case 'env':
      case 'exitCode':
      case 'platform':
      case 'arch':
      case 'version':
      case 'pid':
      case 'execPath':
      case 'execArgv':
        return true;
      case 'exit':
      case 'kill':
      case 'cwd':
        return path.length === 1 && !!call;
      case 'stdout':
      case 'stderr':
        return path.length === 2 && (second === 'write' ? !!call : second === 'isTTY' && !call);
      case 'argv':
        if (second === 'length') return path.length === 2;
        if (typeof second === 'number') return second >= 2;
        if (path.length !== 2 || !call || !['at', 'slice'].includes(second)) return false;
        return literalAtLeast(call.arguments[0], 2);
      case 'on':
      case 'once': {
        if (path.length !== 1 || !call || !ts.isExpressionStatement(outer(call).parent))
          return false;
        const [event, listener] = call.arguments;
        return (
          call.arguments.length === 2 &&
          literalText(event) !== null &&
          ts.isArrowFunction(unwrap(listener))
        );
      }
      default:
        return false;
    }
  };
  visit((node) => {
    if (inType(node)) return;
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      const spec = literalText(node.moduleSpecifier);
      const why = nodeModule(spec ?? '') === 'process' ? 'process re-exported' : loadRefusal(spec);
      if (why) say(node, `${why}: ${shown(node)}`);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      say(node, `a module loaded by import = require(): ${shown(node)}`);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const why = loadRefusal(literalText(node.arguments[0]));
      if (why) say(node, `${why}: ${shown(node)}`);
    }
    if (ts.isIdentifier(node) && !naming(node)) {
      if (node.text === 'require' && unbound(node))
        say(node, `require, which loads a module by any name: ${shown(outer(node).parent)}`);
      if (CODE_BUILDERS.includes(node.text) && unbound(node))
        say(node, `code built from a string: ${shown(outer(node).parent)}`);
      if (node.text === 'Reflect' && unbound(node)) {
        const { path, call } = chain(node);
        if (path.length !== 1 || !call)
          say(
            node,
            `Reflect used other than by calling one of its functions: ${shown(outer(node).parent)}`,
          );
        else if (path[0] === 'get' && (call.arguments.length < 2 || !resolved(call.arguments[1])))
          say(node, `a property read by a key this walk cannot resolve: ${shown(call)}`);
      }
    }
    if (
      (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
      node.text === 'constructor' &&
      !ts.isMethodDeclaration(node.parent) &&
      !ts.isPropertyDeclaration(node.parent)
    )
      say(node, `a value's constructor, which off a function is Function: ${shown(node.parent)}`);
    if (ts.isStringLiteralLike(node) && node.text === 'constructor')
      say(node, `a value's constructor named by a string: ${shown(node.parent)}`);
    if (
      (ts.isPropertyAccessExpression(node) && DESCRIPTOR_READERS.has(node.name.text)) ||
      (ts.isElementAccessExpression(node) &&
        DESCRIPTOR_READERS.has(literalText(node.argumentExpression)))
    )
      say(
        node,
        `a property descriptor read, which hands a value without naming it: ${shown(node)}`,
      );
    const named =
      ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)
        ? node.text
        : null;
    if (named !== null && PROTOTYPE_NAMES.has(named) && !ts.isImportSpecifier(node.parent))
      say(
        node,
        `a prototype reached or changed, whose methods the allowed reads call: ${shown(node.parent)}`,
      );
    if (ts.isElementAccessExpression(node) && !resolved(node.argumentExpression)) {
      const p = outer(node).parent;
      const written =
        (ts.isBinaryExpression(p) &&
          p.left === outer(node) &&
          p.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
        ts.isDeleteExpression(p);
      if (!written) say(node, `a property read by a key this walk cannot resolve: ${shown(node)}`);
    }
    if (
      ts.isComputedPropertyName(node) &&
      (ts.isBindingElement(node.parent) || destructuring(node.parent.parent)) &&
      !resolved(node.expression)
    )
      say(node, `a property destructured by a key this walk cannot resolve: ${shown(node.parent)}`);
    const reference =
      ts.isIdentifier(node) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node);
    if (reference && isProcess(node) && !processAllowed(node))
      say(
        node,
        `process read outside what this walk allows: ${shown(outer(chain(node).end).parent)}`,
      );
    if (reference && isGlobal(node)) {
      const { path } = chain(node);
      const stated = typeof path[0] === 'string' && !GLOBAL_REFUSED.includes(path[0]);
      if (!stated && !ts.isTypeOfExpression(outer(node).parent))
        say(
          node,
          `the global object read outside what this walk allows: ${shown(outer(node).parent)}`,
        );
    }
  });
  return found;

  /** Whether an object or array literal is the target of an assignment or a loop, not a value. */
  function destructuring(literal) {
    let n = literal;
    while (
      n &&
      (ts.isObjectLiteralExpression(n) ||
        ts.isArrayLiteralExpression(n) ||
        ts.isPropertyAssignment(n) ||
        ts.isShorthandPropertyAssignment(n) ||
        ts.isSpreadAssignment(n) ||
        ts.isSpreadElement(n) ||
        ts.isParenthesizedExpression(n))
    ) {
      const p = n.parent;
      if (
        ts.isBinaryExpression(p) &&
        p.left === n &&
        p.operatorToken.kind === ts.SyntaxKind.EqualsToken
      )
        return true;
      if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === n) return true;
      n = p;
    }
    return false;
  }
}

/** Each name a file declares, with the scope it is visible in, and what reads a name. */
function scopes(src, visit) {
  const declared = new Map();
  const FUNCTIONS = [ts.isFunctionLike, ts.isSourceFile];
  const BLOCKS = [
    ts.isBlock,
    ts.isSourceFile,
    ts.isForStatement,
    ts.isForOfStatement,
    ts.isForInStatement,
    ts.isCaseBlock,
    ts.isCatchClause,
    ts.isModuleBlock,
  ];
  const nearest = (node, kinds) => {
    let n = node.parent;
    while (n && !kinds.some((is) => is(n))) n = n.parent;
    return n ?? src;
  };
  const scopeOf = (decl) => {
    let d = decl;
    while (ts.isBindingElement(d)) d = d.parent.parent;
    if (ts.isParameter(d)) return d.parent;
    if (ts.isVariableDeclaration(d)) {
      if (ts.isCatchClause(d.parent)) return d.parent;
      const scoped = d.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const);
      return scoped ? nearest(d.parent, BLOCKS) : nearest(d.parent, FUNCTIONS);
    }
    // A function or class expression's own name is visible only inside it.
    if (ts.isFunctionExpression(d) || ts.isClassExpression(d)) return d;
    return nearest(d, BLOCKS);
  };
  const declare = (name, decl) =>
    declared.set(name, [...(declared.get(name) ?? []), { scope: scopeOf(decl), decl }]);
  visit((node) => {
    if (ts.isImportClause(node) && node.name) declare(node.name.text, node);
    if (
      ts.isNamespaceImport(node) ||
      ts.isImportSpecifier(node) ||
      ts.isImportEqualsDeclaration(node)
    )
      declare(node.name.text, node);
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name)
    )
      declare(node.name.text, node);
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      declare(node.name.text, node);
  });
  /** The declarations `id`'s name has where it stands: those of the innermost scope holding one. */
  const bindingAt = (id) => {
    const decls = declared.get(id.text) ?? [];
    for (let n = id; n; n = n.parent) {
      const here = decls.filter((d) => d.scope === n);
      if (here.length > 0) return here;
    }
    return [];
  };
  /** An identifier that names something rather than reading it. */
  const naming = (id) => {
    const p = id.parent;
    // A re-export from this file names its local in front: `export { process as p }` reads process.
    if (ts.isExportSpecifier(p))
      return !!p.parent.parent.moduleSpecifier || (p.propertyName ?? p.name) !== id;
    if ('name' in p && p.name === id && !ts.isPropertyAccessExpression(p))
      return !ts.isShorthandPropertyAssignment(p);
    return (
      (ts.isPropertyAccessExpression(p) && p.name === id) ||
      (ts.isQualifiedName(p) && p.right === id) ||
      (ts.isBindingElement(p) && p.propertyName === id) ||
      (ts.isImportSpecifier(p) && p.propertyName === id) ||
      ts.isLabeledStatement(p) ||
      ts.isBreakOrContinueStatement(p)
    );
  };
  /** Whether a node sits in a type, where nothing runs. */
  const inType = (node) => {
    for (let n = node.parent; n; n = n.parent) {
      if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return true;
      if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return true;
      if (ts.isStatement(n) || ts.isSourceFile(n)) return false;
    }
    return false;
  };
  return { bindingAt, naming, inType };
}

/**
 * Every write to a name a file declares, by its declaration: the assignment or update that wrote it,
 * or null where it was written by a destructuring or a loop, whose value the walk does not read.
 */
function writesByDecl(src, visit, bindingAt, unwrap) {
  const writes = new Map();
  const note = (id, how) => {
    for (const { decl } of bindingAt(id)) writes.set(decl, [...(writes.get(decl) ?? []), how]);
  };
  const targets = (node, acc = []) => {
    const n = unwrap(node);
    if (!n) return acc;
    if (ts.isIdentifier(n)) acc.push(n);
    else if (ts.isArrayLiteralExpression(n))
      for (const el of n.elements) targets(ts.isSpreadElement(el) ? el.expression : el, acc);
    else if (ts.isObjectLiteralExpression(n))
      for (const el of n.properties) {
        if (ts.isShorthandPropertyAssignment(el)) acc.push(el.name);
        else if (ts.isPropertyAssignment(el)) targets(el.initializer, acc);
        else if (ts.isSpreadAssignment(el)) targets(el.expression, acc);
      }
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      targets(n.left, acc);
    return acc;
  };
  visit((node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const left = unwrap(node.left);
      if (ts.isIdentifier(left)) note(left, node);
      else for (const id of targets(left)) note(id, null);
    }
    const updated =
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator);
    if (updated && ts.isIdentifier(unwrap(node.operand))) note(unwrap(node.operand), node);
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    )
      for (const id of targets(node.initializer)) note(id, null);
  });
  return writes;
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
      1,
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
      4,
    ],
    [
      'packages/core/src/satisfies-var.ts',
      'const v = process.argv satisfies string[];\nif (import.meta.filename === v[1]) main();\n',
      1,
    ],
    [
      'packages/core/src/asserted.ts',
      'const v = <string[]>process.argv;\nif (import.meta.filename === (v as string[])[1]!) main();\n',
      1,
    ],
    [
      'scripts/quoted.mjs',
      "const { 'argv': v } = process;\nif (import.meta.filename === v[1]) main();\n",
      1,
    ],
    [
      'scripts/computed.mjs',
      "const k = 'argv';\nconst { [k]: v } = process;\nif (import.meta.filename === v[1]) main();\n",
      2,
    ],
    [
      'scripts/process-alias.mjs',
      'const p = process;\nif (import.meta.filename === p.argv[1]) main();\n',
      1,
    ],
    [
      'scripts/required.cjs',
      "if (__filename === require('node:process').argv[1] && import.meta) main();\n",
      1,
    ],
    [
      'scripts/global-bracket.mjs',
      "if (import.meta.filename === globalThis['process'].argv[1]) main();\n",
      1,
    ],
    [
      'scripts/nested.mjs',
      'const { argv: [, entry] } = process;\nif (import.meta.filename === entry) main();\n',
      1,
    ],
    [
      'scripts/nested-keyed.mjs',
      'const { argv: { 1: entry } } = process;\nif (import.meta.filename === entry) main();\n',
      1,
    ],
    [
      'scripts/nested-assigned.mjs',
      'let entry;\n({ argv: [, entry] } = process);\nif (import.meta.filename === entry) main();\n',
      2,
    ],
    [
      'scripts/process-rest.mjs',
      'const { ...p } = process;\nif (import.meta.filename === p.argv[1]) main();\n',
      1,
    ],
    [
      'scripts/process-taken.mjs',
      'const { process: p } = globalThis;\nif (import.meta.filename === p.argv[1]) main();\n',
      1,
    ],
    [
      'scripts/process-passed.mjs',
      'const read = (p) => p.argv[1];\nif (import.meta.filename === read(process)) main();\n',
      2,
    ],
    [
      'scripts/process-computed.mjs',
      "const k = 'argv';\nif (import.meta.filename === process[k][1]) main();\n",
      2,
    ],
    [
      'scripts/process-spread.mjs',
      'const p = { ...process };\nif (import.meta.filename === p.argv[1]) main();\n',
      1,
    ],
    [
      'scripts/assigned-key.mjs',
      'let v;\n({ argv: v } = process);\nif (import.meta.filename === v[1]) main();\n',
      2,
    ],
    [
      'scripts/assigned-short.mjs',
      'let argv;\n({ argv } = process);\nif (import.meta.filename === argv[1]) main();\n',
      2,
    ],
    [
      'scripts/joined-key.mjs',
      "const k = 'ar' + 'gv';\nif (import.meta.filename === process[k][1]) main();\n",
      2,
    ],
    [
      'scripts/process-assigned.mjs',
      'let p;\np = process;\nif (import.meta.filename === p.argv[1]) main();\n',
      2,
    ],
    [
      'scripts/default-named.mjs',
      "import { default as p } from 'node:process';\nif (import.meta.filename === p.argv[1]) main();\n",
      1,
    ],
    [
      'scripts/dynamic.mjs',
      "const p = await import('node:process');\nif (import.meta.filename === p.default.argv[1]) main();\n",
      1,
    ],
    [
      'scripts/dynamic-then.mjs',
      "import('process').then((m) => m.argv[1] === import.meta.filename && main());\n",
      1,
    ],
    [
      'scripts/required-alias.mjs',
      "const r = require;\nif (import.meta.filename === r('process').argv[1]) main();\n",
      1,
    ],
    [
      'scripts/dynamic-passed.mjs',
      "function entry(p) {\n  return p.argv[1];\n}\nif (import.meta.filename === entry(await import('node:process'))) main();\n",
      4,
    ],
    [
      'scripts/dynamic-bracket.mjs',
      "const p = (await import('node:process'))['default'];\nif (import.meta.filename === p.argv[1]) main();\n",
      1,
    ],
    [
      'scripts/global-alias.mjs',
      'const g = globalThis;\nif (import.meta.filename === g.process.argv[1]) main();\n',
      1,
    ],
    [
      'scripts/global-reflected.mjs',
      "if (import.meta.filename === Reflect.get(globalThis, 'process').argv[1]) main();\n",
      1,
    ],
    [
      'scripts/dynamic-default.mjs',
      "const { default: p } = await import('node:process');\nif (import.meta.filename === p.argv[1]) main();\n",
      1,
    ],
    [
      'scripts/dynamic-default-assigned.mjs',
      "let p;\n({ default: p } = await import('node:process'));\nif (import.meta.filename === p.argv[1]) main();\n",
      2,
    ],
    [
      'scripts/global-taken-assigned.mjs',
      'let p;\n({ process: p } = globalThis);\nif (import.meta.filename === p.argv[1]) main();\n',
      2,
    ],
    [
      'scripts/process-passed-param.mjs',
      'function f(p) {\n  return p.argv[1];\n}\nconst x = 1;\nif (import.meta.filename === f(globalThis.process)) main();\n',
      5,
    ],
    [
      'scripts/default-nested.mjs',
      "const { default: { argv: v } } = await import('node:process');\nif (import.meta.filename === v[1]) main();\n",
      1,
    ],
    [
      'scripts/global-nested.mjs',
      'const { process: { argv: v } } = globalThis;\nif (import.meta.filename === v[1]) main();\n',
      1,
    ],
    [
      'scripts/global-self.mjs',
      'if (import.meta.filename === globalThis.global.process.argv[1]) main();\n',
      1,
    ],
    [
      'scripts/global-self-alias.mjs',
      "const g = globalThis['global'];\nif (import.meta.filename === g.process.argv[1]) main();\n",
      1,
    ],
    [
      'scripts/global-self-taken.mjs',
      'const { global: g } = globalThis;\nif (import.meta.filename === g.process.argv[1]) main();\n',
      1,
    ],
    [
      'scripts/global-self-assigned.mjs',
      'let g;\n({ global: g } = globalThis);\nif (import.meta.filename === g.process.argv[1]) main();\n',
      2,
    ],
    [
      'scripts/global-shadow-elsewhere.mjs',
      'function unrelated(globalThis) {}\nif (import.meta.filename === globalThis.process.argv[1]) main();\n',
      2,
    ],
    [
      'scripts/global-alias-named.mjs',
      'const window = globalThis;\nif (import.meta.filename === window.process.argv[1]) main();\n',
      1,
    ],
    ['scripts/evaluated.mjs', "if (import.meta.filename === eval('process.argv[1]')) main();\n", 1],
    [
      'scripts/constructed.mjs',
      "const read = new Function('return process.argv[1]');\nif (import.meta.filename === read()) main();\n",
      1,
    ],
    [
      'scripts/evaluated-global.mjs',
      "if (import.meta.filename === globalThis.eval('process.argv[1]')) main();\n",
      1,
    ],
    [
      'scripts/constructed-global.mjs',
      "if (import.meta.filename === globalThis.Function('return process.argv[1]')()) main();\n",
      1,
    ],
    [
      'scripts/evaluated-alias.mjs',
      "const run = eval;\nif (import.meta.filename === run('process.argv[1]')) main();\n",
      1,
    ],
    [
      'scripts/constructed-own.mjs',
      "const read = (() => {}).constructor('return process.argv[1]');\nif (import.meta.filename === read()) main();\n",
      1,
    ],
    [
      'scripts/evaluated-taken.mjs',
      "const { eval: run } = globalThis;\nif (import.meta.filename === run('process.argv[1]')) main();\n",
      1,
    ],
    [
      'scripts/constructed-taken.mjs',
      "const { Function: Build } = globalThis;\nif (import.meta.filename === Build('return process.argv[1]')()) main();\n",
      1,
    ],
    [
      'scripts/evaluated-assigned.mjs',
      "let run;\n({ eval: run } = globalThis);\nif (import.meta.filename === run('process.argv[1]')) main();\n",
      2,
    ],
    [
      'scripts/this-call.mjs',
      'function entry() {\n  return this.argv[1];\n}\nif (import.meta.filename === entry.call(process)) main();\n',
      4,
    ],
    [
      'scripts/this-apply.mjs',
      'function entry() {\n  return this.argv[1];\n}\nif (import.meta.filename === entry.apply(process)) main();\n',
      4,
    ],
    [
      'scripts/this-bind.mjs',
      'function entry() {\n  return this.argv[1];\n}\nif (import.meta.filename === entry.bind(process)()) main();\n',
      4,
    ],
    [
      'scripts/this-reassigned.mjs',
      'let binding = process.binding;\nbinding = function () {\n  return this.argv[1];\n};\nif (import.meta.filename === binding.call(process)) main();\n',
      5,
    ],
    [
      'scripts/this-reassigned-apply.mjs',
      'let binding = process.binding;\n[binding] = [function () {\n  return this.argv[1];\n}];\nif (import.meta.filename === binding.apply(process)) main();\n',
      5,
    ],
    [
      'scripts/this-redeclared-bind.mjs',
      'const binding = process.binding;\nfunction f(binding) {\n  return binding.bind(process)();\n}\nif (import.meta.filename === f(function () { return this.argv[1]; })) main();\n',
      3,
    ],
    [
      'scripts/this-planted.mjs',
      'process.entry = function () {\n  return this.argv[1];\n};\nconst binding = process.entry;\nif (import.meta.filename === binding.call(process)) main();\n',
      5,
    ],
    [
      'scripts/this-planted-direct.mjs',
      "process['entry'] = function () {\n  return this.argv[1];\n};\nif (import.meta.filename === process.entry.apply(process)) main();\n",
      4,
    ],
    [
      'scripts/this-planted-computed.mjs',
      "const k = 'entry';\nprocess[k] = function () {\n  return this.argv[1];\n};\nif (import.meta.filename === process.entry.bind(process)()) main();\n",
      2,
    ],
    [
      'scripts/this-method.mjs',
      'process.entry = function () {\n  return this.argv[1];\n};\nif (import.meta.filename === process.entry()) main();\n',
      1,
    ],
    [
      'scripts/this-getter.mjs',
      "Object.defineProperty(Object.prototype, 'entry', {\n  get() {\n    return this.argv.at(1);\n  },\n});\nif (import.meta.url === process.entry) main();\n",
      1,
    ],
    [
      'scripts/this-alias.mjs',
      'function entry() {\n  const self = this;\n  return self.argv[1];\n}\nprocess.entry = entry;\nif (import.meta.filename === process.entry()) main();\n',
      5,
    ],
    [
      'scripts/this-class-method.mjs',
      'class Entry {\n  read() {\n    const [, entry] = this.argv;\n    return entry;\n  }\n}\nprocess.read = Entry.prototype.read;\nif (import.meta.filename === process.read()) main();\n',
      7,
    ],
    [
      'scripts/chained.mjs',
      "if (import.meta.filename === process.on('exit', () => {}).argv[1]) main();\n",
      1,
    ],
    [
      'scripts/value-of.mjs',
      'const p = process.valueOf();\nif (import.meta.filename === p.argv[1]) main();\n',
      1,
    ],
    [
      'scripts/from.mjs',
      'const a = Array.from(process.argv);\nif (import.meta.url === a[1]) main();\n',
      1,
    ],
    [
      'scripts/var.mjs',
      'const args = process.argv;\n\nif (import.meta.url === pathToFileURL(args[1]).href) main();\n',
      1,
    ],
    [
      'scripts/var-var.mjs',
      'const a = process.argv;\nconst b = a;\nif (import.meta.url === b.at(1)) main();\n',
      1,
    ],
    [
      'scripts/spread.mjs',
      'const a = [...process.argv];\nif (import.meta.url === a[1]) main();\n',
      1,
    ],
    [
      'scripts/index-var.mjs',
      'const i = 1;\nif (import.meta.url === process.argv[i]) main();\n',
      2,
    ],
    [
      'scripts/imported.mjs',
      "import { argv } from 'node:process';\nif (import.meta.url.endsWith(argv[1])) main();\n",
      1,
    ],
    [
      'scripts/renamed.mjs',
      "import { argv as v } from 'node:process';\nif (import.meta.url.endsWith(v[1])) main();\n",
      1,
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
      1,
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
      4,
    ],
    [
      'scripts/arrow.mjs',
      'const isMain = (v) => import.meta.url === pathToFileURL(v.at(1)).href;\nif (isMain(process.argv)) main();\n',
      2,
    ],
    ['scripts/filename.mjs', 'if (import.meta.filename === process.argv[1]) main();\n', 1],
    [
      'scripts/newurl.mjs',
      "const argv = process.argv;\nif (import.meta.url === new URL(argv[1], 'file://').href) main();\n",
      1,
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
    // judge-147's evaders inside the bound (ISS-1236 r8), and their neighbours.
    [
      'scripts/scoped-call.mjs',
      'function pick(list) {\n  return list[1];\n}\nfunction unrelated() {\n  function pick(other) {\n    return other.length;\n  }\n  return pick([]);\n}\nif (import.meta.url === pick(process.argv)) main();\n',
      10,
    ],
    [
      'scripts/scoped-param.mjs',
      'function pick(list) {\n  return list.length;\n}\nfunction run(pick) {\n  return pick(process.argv);\n}\nconst ROOT = import.meta.url;\n',
      5,
    ],
    [
      'scripts/self-reexport.mjs',
      "export { argv } from 'node:process';\nimport { argv as av } from './self-reexport.mjs';\nif (import.meta.url === av[1]) main();\n",
      1,
    ],
    [
      'scripts/self-local.mjs',
      "export const entry = process.argv;\nimport { entry as e } from './self-local.mjs';\nif (import.meta.url === e[1]) main();\n",
      1,
    ],
    [
      'scripts/self-namespace.mjs',
      "export * from 'node:process';\nimport * as me from './self-namespace.js';\nif (import.meta.url === me.argv[1]) main();\n",
      1,
    ],
    [
      'scripts/self-dynamic.mjs',
      "export const entry = process.argv;\nconst { entry: e } = await import('./self-dynamic.mjs');\nif (import.meta.url === e.at(1)) main();\n",
      1,
    ],
    [
      'scripts/self-function.mjs',
      "export function pick(list) {\n  return list[1];\n}\nimport { pick as p } from './self-function';\nif (import.meta.url === p(process.argv)) main();\n",
      4,
    ],
    [
      'scripts/require-computed.mjs',
      "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nconst p = load('node:' + 'process');\nif (import.meta.url === p.argv[1]) main();\n",
      1,
    ],
    [
      'scripts/require-made-renamed.mjs',
      "import { createRequire as make } from 'node:module';\nif (import.meta.url === make(import.meta.url)(id).argv[1]) main();\n",
      1,
    ],
    [
      'scripts/builtin-computed.mjs',
      "const p = process.getBuiltinModule(['node', 'process'].join(':'));\nif (import.meta.url === p.argv[1]) main();\n",
      1,
    ],
    [
      'scripts/import-computed.mjs',
      "const id = 'node:process';\nconst p = await import(id);\nif (import.meta.url === p.default.argv[1]) main();\n",
      2,
    ],
    [
      'scripts/import-computed-handed.mjs',
      'const m = await import(name);\nrun(m);\nconst ROOT = import.meta.url;\n',
      1,
    ],
    [
      'scripts/arguments.mjs',
      'function pick(list) {\n  return arguments[0][1];\n}\nif (import.meta.url === pick(process.argv)) main();\n',
      4,
    ],
    [
      'scripts/arguments-computed.mjs',
      'function pick() {\n  const i = 0;\n  return arguments[i][1];\n}\nif (import.meta.url === pick(process.argv)) main();\n',
      5,
    ],
    [
      'scripts/arguments-whole.mjs',
      'function pick() {\n  return [...arguments][0][1];\n}\nif (import.meta.url === pick(process.argv)) main();\n',
      4,
    ],
    [
      'scripts/arguments-arrow.mjs',
      'function outer() {\n  const read = () => arguments[0].at(1);\n  return read();\n}\nif (import.meta.url === outer(process.argv)) main();\n',
      5,
    ],
    [
      'packages/core/src/m.mts',
      'if (import.meta.url === pathToFileURL(process.argv[1]).href) main();\n',
      1,
    ],
    ['scripts/c.cts', 'const isMain = import.meta && process.argv.at(1);\n', 1],
    // ISS-1236 r9, judge-149: a specifier Node resolves to the file itself by a query, a fragment, an
    // escape or the file's own URL, and a function's constructor held before it is called.
    [
      'scripts/self-query.mjs',
      "export { argv } from 'node:process';\nimport { argv as av } from './self-query.mjs?q';\nif (import.meta.url === av[1]) main();\n",
      1,
    ],
    [
      'scripts/self-hash.mjs',
      "export { argv } from 'node:process';\nimport { argv as av } from './self-hash.mjs#h';\nif (import.meta.url === av[1]) main();\n",
      1,
    ],
    [
      'scripts/self-star-query.mjs',
      "export * from 'node:process';\nimport * as me from './self-star-query.mjs?q';\nif (import.meta.url === me.argv[1]) main();\n",
      1,
    ],
    [
      'scripts/self-escaped.mjs',
      "export { argv } from 'node:process';\nimport { argv as av } from './%73elf-escaped.mjs';\nif (import.meta.url === av[1]) main();\n",
      1,
    ],
    [
      'scripts/self-url.mjs',
      `export { argv } from 'node:process';\nimport { argv as av } from '${pathToFileURL(join(ROOT, 'scripts/self-url.mjs')).href}';\nif (import.meta.url === av[1]) main();\n`,
      1,
    ],
    [
      'scripts/self-rooted.mjs',
      `export { argv } from 'node:process';\nimport { argv as av } from '${join(ROOT, 'scripts/self-rooted.mjs')}?x';\nif (import.meta.url === av[1]) main();\n`,
      1,
    ],
    [
      'scripts/self-doubled.mjs',
      "export { argv } from 'node:process';\nimport { argv as av } from '././/self-doubled.mjs';\nif (import.meta.url === av[1]) main();\n",
      1,
    ],
    [
      'scripts/self-dynamic-query.mjs',
      "export const entry = process.argv;\nconst { entry: e } = await import('./self-dynamic-query.mjs?q');\nif (import.meta.url === e.at(1)) main();\n",
      1,
    ],
    [
      'scripts/constructor-held.mjs',
      "const F = (() => {}).constructor;\nconst entry = F('return process.argv[1]')();\nif (import.meta.url === entry) main();\n",
      1,
    ],
    [
      'scripts/constructor-async.mjs',
      "const AF = Object.getPrototypeOf(async function () {}).constructor;\nconst entry = await AF('return process.argv[1]')();\nif (import.meta.url === entry) main();\n",
      1,
    ],
    [
      'scripts/constructor-generator.mjs',
      "const GF = function* () {}.constructor;\nconst entry = GF('yield process.argv[1]')().next().value;\nif (import.meta.url === entry) main();\n",
      1,
    ],
    [
      'scripts/constructor-method.mjs',
      "const o = { m() {} };\nconst F = o.m['constructor'];\nif (import.meta.url === F('return process.argv[1]')()) main();\n",
      2,
    ],
    [
      'scripts/constructor-bound.mjs',
      "function f() {}\nconst F = f.bind(null).constructor;\nif (import.meta.url === F('return process.argv[1]')()) main();\n",
      2,
    ],
    [
      'scripts/constructor-destructured.mjs',
      "const { constructor: F } = () => {};\nif (import.meta.url === F('return process.argv[1]')()) main();\n",
      1,
    ],
    [
      'scripts/constructor-assigned.mjs',
      "let F;\n({ constructor: F } = () => {});\nif (import.meta.url === F('return process.argv[1]')()) main();\n",
      2,
    ],
    [
      'scripts/constructor-reflect.mjs',
      "const F = Reflect.get(() => {}, 'constructor');\nif (import.meta.url === F('return process.argv[1]')()) main();\n",
      1,
    ],
    [
      'scripts/constructor-described.mjs',
      "const F = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), 'constructor').value;\nif (import.meta.url === F('return process.argv[1]')()) main();\n",
      1,
    ],
    [
      'scripts/constructor-computed.mjs',
      "const k = ['constr', 'uctor'].join('');\nfunction f() {}\nconst F = f[k];\nif (import.meta.url === F('return process.argv[1]')()) main();\n",
      3,
    ],
    // r10: judge-154's twelve evaders and two string builders, the plan consult's replaced
    // `slice`, the spellings the allow-list was written against, and the former allowances it refuses.
    [
      'scripts/j154-s15-export-destructure.mjs',
      "import { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nexport const { argv: A } = process;\nimport { A as a2 } from './j154-s15-export-destructure.mjs?x';\nconst entry = a2[1];\nif (entry === self) console.log('PLANTED RAN');\n",
      3,
    ],
    [
      'scripts/j154-x03-export-destructure-plain-self.mjs',
      "import { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nexport const { argv } = process;\nimport { argv as a2 } from './j154-x03-export-destructure-plain-self.mjs';\nconst entry = a2[1];\nif (entry === self) console.log('PLANTED RAN');\n",
      3,
    ],
    [
      'scripts/j154-x05-export-var-destructure-self.mjs',
      "import { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nexport var { argv: V } = process;\nimport { V as v2 } from './j154-x05-export-var-destructure-self.mjs#v';\nconst entry = v2[1];\nif (entry === self) console.log('PLANTED RAN');\n",
      3,
    ],
    [
      'scripts/j154-k14-computed-destructure.mjs',
      "import { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nconst { ['constructor']: F } = () => {};\nconst entry = F('return process.argv[1]')();\nif (entry === self) console.log('PLANTED RAN');\n",
      3,
    ],
    [
      'scripts/j154-x07-ctor-destructure-template.mjs',
      "import { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nconst { [`constructor`]: F } = () => {};\nconst entry = F('return process.argv[1]')();\nif (entry === self) console.log('PLANTED RAN');\n",
      3,
    ],
    [
      'scripts/j154-x13-ctor-assign-computed.mjs',
      "import { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nlet F;\n({ ['constructor']: F } = Math.max);\nconst entry = F('return process.argv[1]')();\nif (entry === self) console.log('PLANTED RAN');\n",
      4,
    ],
    [
      'scripts/j154-x09-ctor-destructure-native-computed.mjs',
      "import { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nconst { ['constructor']: F } = Math.max;\nconst entry = F('return process.argv[1]')();\nif (entry === self) console.log('PLANTED RAN');\n",
      3,
    ],
    [
      'scripts/j154-x12-ctor-const-key-written-fn-destructure.mjs',
      "import { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nconst k = 'constructor';\nconst { [k]: F } = () => {};\nconst entry = F('return process.argv[1]')();\nif (entry === self) console.log('PLANTED RAN');\n",
      3,
    ],
    [
      'scripts/j154-k13-const-key-native.mjs',
      "import { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nconst k = 'constructor';\nconst F = Math.max[k];\nconst entry = F('return process.argv[1]')();\nif (entry === self) console.log('PLANTED RAN');\n",
      3,
    ],
    [
      'scripts/j154-x10-ctor-const-key-destructure.mjs',
      "import { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nconst k = 'constructor';\nconst { [k]: F } = Math.max;\nconst entry = F('return process.argv[1]')();\nif (entry === self) console.log('PLANTED RAN');\n",
      3,
    ],
    [
      'scripts/j154-x11-ctor-const-key-reflect.mjs',
      "import { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nconst k = 'constructor';\nconst F = Reflect.get(Math.max, k);\nconst entry = F('return process.argv[1]')();\nif (entry === self) console.log('PLANTED RAN');\n",
      3,
    ],
    [
      'scripts/j154-k12-concat-key-native.mjs',
      "import { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nconst F = Math.max['constr' + 'uctor'];\nconst entry = F('return process.argv[1]')();\nif (entry === self) console.log('PLANTED RAN');\n",
      3,
    ],
    [
      'scripts/j154-b01-inspector-eval.mjs',
      "import { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nimport { Session } from 'node:inspector';\nconst s = new Session();\ns.connect();\nlet entry;\ns.post('Runtime.evaluate', { expression: 'process.argv[1]' }, (e, r) => { entry = r.result.value; });\nif (entry === self) console.log('PLANTED RAN');\n",
      3,
    ],
    [
      'scripts/j154-b03-module-compile.mjs',
      "import { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst M = require('node:module');\nconst m = new M('x');\nm._compile('module.exports = process.argv[1]', '/x.js');\nconst entry = m.exports;\nif (entry === self) console.log('PLANTED RAN');\n",
      3,
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source, searched rather than run
    [
      'scripts/slice-replaced.mjs',
      'Array.prototype.slice = function () {\n  return this[1];\n};\nconst entry = process.argv.slice(2);\nif (import.meta.url === `file://${entry}`) main();\n',
      1,
    ],
    [
      'scripts/proto-index.mjs',
      "Object.defineProperty(Object.getPrototypeOf([]), '2', { get() { return this[1]; } });\nif (import.meta.url === process.argv[2]) main();\n",
      1,
    ],
    [
      'scripts/proto-literal.mjs',
      'const t = { __proto__: Object.getPrototypeOf(() => {}) };\nconst F = t[key];\nconst ROOT = import.meta.url;\n',
      1,
    ],
    [
      'scripts/global-process.mjs',
      'if (import.meta.url === globalThis.process.argv[1]) main();\n',
      1,
    ],
    [
      'scripts/default-import.mjs',
      "import p from 'node:process';\nif (import.meta.url === p.argv[1]) main();\n",
      2,
    ],
    [
      'scripts/namespace-default.mjs',
      "import * as p from 'process';\nif (import.meta.url === p.default.argv[1]) main();\n",
      2,
    ],
    [
      'scripts/listener-this.mjs',
      "process.on('exit', function () {\n  if (import.meta.url === this.argv[1]) main();\n});\n",
      1,
    ],
    [
      'scripts/on-chained.mjs',
      "const p = process.on('exit', () => {});\nif (import.meta.url === p.argv[1]) main();\n",
      1,
    ],
    [
      'scripts/slice-by-name.mjs',
      'const n = 1;\nconst [entry] = process.argv.slice(n);\nif (import.meta.url === entry) main();\n',
      2,
    ],
    [
      'scripts/reflect-alias.mjs',
      "const get = Reflect.get;\nconst F = get(Math.max, 'constr' + 'uctor');\nconst ROOT = import.meta.url;\n",
      1,
    ],
    [
      'scripts/global-reflect.mjs',
      'const F = globalThis.Reflect.get(Math.max, key);\nconst ROOT = import.meta.url;\n',
      1,
    ],
    [
      'scripts/cluster.mjs',
      "import cluster from 'node:cluster';\ncluster.setupPrimary();\nif (import.meta.filename === cluster.settings.exec) main();\n",
      1,
    ],
    [
      'scripts/data-url.mjs',
      "const m = await import('data:text/javascript,export default process.argv[1]');\nif (import.meta.url === m.default) main();\n",
      1,
    ],
    [
      'scripts/vm-bare.mjs',
      "import vm from 'vm';\nif (import.meta.url === vm.runInThisContext('process.argv[1]')) main();\n",
      1,
    ],
    [
      'scripts/export-process.mjs',
      "import p from 'node:process';\nexport { p as proc };\nconst ROOT = import.meta.url;\n",
      2,
    ],
    [
      'scripts/export-default-process.mjs',
      'export default process;\nconst ROOT = import.meta.url;\n',
      1,
    ],
    [
      'scripts/shorthand-process.mjs',
      'const o = { process };\nif (import.meta.url === o.process.argv[1]) main();\n',
      1,
    ],
    [
      'scripts/counter-written.mjs',
      "let i = 0;\ni = 'constr' + 'uctor';\nconst F = Math.max[i];\nconst ROOT = import.meta.url;\n",
      3,
    ],
    [
      'scripts/listed-built.mjs',
      "for (const k of ['constr' + 'uctor']) use(Math.max[k]);\nconst ROOT = import.meta.url;\n",
      1,
    ],
    [
      'scripts/flags.mjs',
      "const json = process.argv.includes('--json');\nconst n = process.argv.length;\nconst ROOT = import.meta.url;\n",
      1,
    ],
    ['scripts/node.mjs', 'const node = process.argv[0];\nconst ROOT = import.meta.url;\n', 1],
    [
      'scripts/parsed.mjs',
      'function parse(v) {\n  return v.slice(2);\n}\nparse(process.argv);\nconst ROOT = import.meta.url;\n',
      4,
    ],
    ['scripts/tail.mjs', 'const [, , ...rest] = process.argv;\nconst ROOT = import.meta.url;\n', 1],
    [
      'scripts/shadowed.mjs',
      "const window = text.slice(0, 9);\nconst KEY = Symbol.for('x');\nconst held = globalThis[KEY];\nconst w = window.slice(1);\nconst ROOT = import.meta.url;\n",
      3,
    ],
    [
      'scripts/process-uses.mjs',
      "if (typeof process !== 'undefined') process.exitCode = 1;\nconst { env, platform } = process;\nconst home = process['env'].HOME;\nconst onServer = typeof window === 'undefined' && globalThis.fetch;\nconst sync = process.binding('spawn_sync');\nprocess.on('exit', () => {}).once('beforeExit', () => {});\nfunction watched(...args) {\n  return original.apply(this, args);\n}\nclass Watched extends Base {\n  constructor() {\n    super();\n    live.add(this);\n    this.once('exit', () => live.delete(this));\n  }\n}\nconst ROOT = import.meta.url;\n",
      2,
    ],
    [
      'scripts/nested-tail.mjs',
      'const { argv: [, , ...rest] } = process;\nconst ROOT = import.meta.url;\n',
      1,
    ],
    [
      'scripts/param-tail.mjs',
      'function flags([, , ...rest]) {\n  return rest;\n}\nflags(process.argv);\nconst ROOT = import.meta.url;\n',
      4,
    ],
    [
      'scripts/scoped-allowed.mjs',
      "function pick(list) {\n  return list.slice(2);\n}\nfunction other() {\n  function pick(x) {\n    return x[1];\n  }\n  return pick(['a', 'b']);\n}\npick(process.argv);\nconst ROOT = import.meta.url;\n",
      10,
    ],
    [
      'scripts/import-computed-read.mjs',
      'const { resolveConfig } = await import(url);\nconst ROOT = import.meta.url;\n',
      1,
    ],
    [
      'scripts/require-literal.mjs',
      "import { createRequire } from 'node:module';\nconst ts = createRequire(import.meta.url)('typescript');\nuse(ts);\n",
      1,
    ],
    [
      'scripts/arguments-tail.mjs',
      'function flags() {\n  return arguments[0].slice(2).concat(arguments.length);\n}\nflags(process.argv);\nconst ROOT = import.meta.url;\n',
      4,
    ],
    [
      'scripts/constructor-uses.mjs',
      "console.log('constructor');\nconst own = Object.hasOwn({}, 'constructor');\nfunction f() {}\nconst key = pick();\nconst t = typeof f[key];\nconst is = f[key] === expected;\nconst of = v instanceof f[key];\nconst r = typeof Reflect.get(f, 'constructor');\nconst rn = Reflect.get(f, 'constructor').name;\nconst rq = Reflect.get(f, 'constructor') === expected;\nconst ri = v instanceof Reflect.get(f, 'constructor');\nconst dn = Object.getOwnPropertyDescriptor(f, 'constructor').value.name;\nconst dw = Object.getOwnPropertyDescriptor(f, 'constructor').writable;\nclass A {\n  constructor(x) {\n    this.x = x;\n  }\n}\nconst kind = err.constructor.name;\nconst same = err.constructor === TypeError;\nconst made = err instanceof A.prototype.constructor;\nA.prototype.constructor = A;\nconst plain = typeof v.constructor;\nconst k = 'constructor';\nconst ROOT = import.meta.url;\n",
      1,
    ],
    [
      'scripts/self-sibling.mjs',
      "export { argv } from 'node:process';\nimport { argv as av } from './self-sibling-two.mjs?q';\nimport { x } from 'pkg/self-sibling.mjs';\nconst ROOT = import.meta.url + av[1] + x;\n",
      1,
    ],
    [
      'scripts/self-other.mjs',
      "export const NAME = 'x';\nimport { NAME as n } from './self-other.mjs';\nconst ROOT = import.meta.url + n;\n",
      2,
    ],
  ];

  // FIXTURE TEXT — the forms of process the allow-list names, keys it resolves, the helpers, and
  // files it never reads.
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
      'scripts/shadowed-param.mjs',
      'function pick(window) {\n  return window.process;\n}\nconst ROOT = import.meta.url;\n',
    ],
    [
      'scripts/local.mjs',
      "const argv = text.split(' ');\nconst [head, ...rest] = argv;\nconst x = argv[1];\nconst ROOT = import.meta.url;\n",
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source, searched rather than run
    [
      'scripts/inline.mjs',
      'const SCRIPT = `const [url] = process.argv.slice(1); ${x}`;\n// compares import.meta.url with process.argv[1]\nconst ROOT = import.meta.url;\n',
    ],
    ['scripts/no-meta.mjs', 'const entry = process.argv[1];\n'],
    ['scripts/lib/entrypoint.mjs', 'realpathSync(fileURLToPath(import.meta.url)) === argv[1]'],
    [
      'packages/core/src/lib/entrypoint.ts',
      'export const isEntrypoint = (u) => u === process.argv[1] && import.meta.url;',
    ],
    [
      'scripts/allowed-forms.mjs',
      "if (typeof process !== 'undefined') process.exitCode = 1;\nconst home = process.env.HOME ?? process.env['USERPROFILE'];\nconst { NODE_ENV } = process.env;\nprocess.stdout.write(process.platform + process.arch + process.version);\nif (process.stderr.isTTY) process.stderr.write(String(process.pid));\nconst node = process.execPath + process.execArgv.join(' ');\nconst here = process.cwd();\nconst flags = process.argv.slice(2);\nconst first = process.argv[2] ?? process.argv.at(3);\nconst n = process.argv.length;\nprocess.on('SIGTERM', () => process.exit(0));\nprocess.once('exit', () => {});\nprocess.kill(process.pid, 0);\nconst ROOT = import.meta.url;\n",
    ],
    [
      'scripts/keys-resolved.mjs',
      "const lines = text.split('\\n');\nfor (let i = 0; i < lines.length; i++) use(lines[i], lines[i + 1], lines[lines.length - 1]);\nconst K = 'name';\nconst S = Symbol('x');\nuse(obj[K], obj[Symbol.iterator], obj[S], obj[2], obj[-1]);\nfor (const kind of ['fileLines', 'maxFunctionLines']) use(obj[kind]);\nobj[key] = 1;\ndelete obj[key];\nconst ROOT = import.meta.url;\n",
    ],
    [
      'scripts/global-stated.mjs',
      "const onServer = typeof window === 'undefined' && globalThis.fetch;\nglobalThis.fetch = mock;\nconst ROOT = import.meta.url;\n",
    ],
    [
      'scripts/node-modules.mjs',
      "import { spawnSync } from 'node:child_process';\nimport fs from 'fs';\nimport { Worker } from 'node:worker_threads';\nimport { parseArgs } from 'node:util';\nimport { x } from './sibling.mjs';\nimport ts from 'typescript';\nconst ROOT = import.meta.url;\n",
    ],
    [
      'scripts/class-constructor.mjs',
      'class A {\n  constructor(x) {\n    this.x = x;\n  }\n}\nconst ROOT = import.meta.url;\n',
    ],
    [
      'scripts/entry-of.mjs',
      "import { entryOf } from './lib/entry-of.mjs';\nconst v = entryOf(data, key);\nconst ROOT = import.meta.url;\n",
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
    // Each says what it refused and quotes the code it refused.
    for (const f of found) expect(f.how).toMatch(/^[A-Za-z][^:]*: \S/);
  });

  it('passes the forms of process it names, the keys it resolves, the helpers and a file never naming import.meta', () => {
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
      /\.(mjs|cjs|js|ts|tsx|mts|cts)$/.test(entry.name) &&
      !/\.(test|fixture)\./.test(entry.name)
    ) {
      acc.push(path);
    }
  }
  return acc;
}
