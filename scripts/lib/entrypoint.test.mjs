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
 *
 * Its bound is static reading of the one file's own code (ISS-1236 r8). Inside it, process and argv
 * are followed through names, aliases, destructuring, the parameters and `arguments` of the
 * function a call names where it is made, a function's `this`, process's methods returning process,
 * the file's own exports imported back by any specifier Node resolves to the file, and a module
 * loaded by a name it cannot read, which is taken as process. Code built from a string is refused
 * where it is built: `eval`, `Function`, and a value's `constructor` taken, which off a function is
 * `Function` or one of its kin.
 *
 * What static reading of the file's own code cannot see, and so passes:
 * - what code built from a string runs, where the builder is `vm.runInThisContext`, `vm.Script` and
 *   its kin, or an import of a `data:` URL: the string is data the walk does not parse, and these
 *   builders are not refused where they are built;
 * - a function of another file handed argv or process, whose body is in that file;
 * - a native handed `this` as its receiver (`fn.call(this)`), whose body is not in any file;
 *
 * - the file named through what lies outside it: a specifier reaching it through a symlink, a
 *   package's own name or an import map;
 * - a key computed at run time, which can name `constructor` off a value not written here as a
 *   function.
 *
 * What criterion 29 leaves outside by its own words, though static reading sees it:
 * - a launch check in a file that never names `import.meta`: the criterion is about files that do;
 * - the launch entry read from anything but `process.argv` — `process.report`,
 *   `/proc/self/cmdline`: the criterion is about `process.argv`.
 */
function handWrittenLaunchChecks(files) {
  return files
    .filter(([rel, text]) => !HELPERS.has(rel) && text.includes('meta'))
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

/**
 * Process's methods that hand back process itself (an emitter's chainable calls, and valueOf): the
 * call is process as much as the name it was made on.
 */
const RETURNS_PROCESS = new Set([
  'addListener',
  'off',
  'on',
  'once',
  'prependListener',
  'prependOnceListener',
  'removeAllListeners',
  'removeListener',
  'setMaxListeners',
  'valueOf',
]);

/** Methods that ask whether argv holds a literal flag: the only walks of the entry that compare nothing to it. */
const FLAG_TESTS = new Set(['includes', 'indexOf', 'lastIndexOf']);

function entryReads(rel, text) {
  const kind = rel.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : /\.[mc]?ts$/.test(rel)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const src = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  let namesMeta = false;
  const processNames = new Set();
  /** Each name holding argv, with how far into argv it starts: `slice(2)` holds it from 2. */
  const argvNames = new Map();
  /** Names holding a function that loads a module by name: `require`, and one `createRequire` made. */
  const loaders = new Set();
  /** Names bound to `createRequire` itself. */
  const requireMakers = new Set(['createRequire']);
  /** What this file exports, by exported name: a local name, a name of process's module, or a value. */
  const exportsLocal = new Map();
  const exportsProcess = new Map();
  const exportsValue = new Map();
  let exportsAllOfProcess = false;
  /** Names bound by importing the file itself: each local name with the export it reads. */
  const selfImports = new Map();
  /** Names holding the file's own module namespace. */
  const selfNs = new Set();
  /** For each function of this file called with argv, the positions argv was handed in, from where. */
  const heldArguments = new Map();
  const visit = (fn) => {
    const walk = (node) => {
      fn(node);
      ts.forEachChild(node, walk);
    };
    walk(src);
  };

  /** Each name this file declares, with each declaration and the scope it is visible in; and the names holding a symbol. */
  const declared = new Map();
  const symbols = new Set();
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
  /** The node a declaration's name is visible inside. */
  const scopeOf = (decl) => {
    let d = decl;
    while (ts.isBindingElement(d)) d = d.parent.parent;
    if (ts.isParameter(d)) return d.parent;
    if (ts.isVariableDeclaration(d)) {
      if (ts.isCatchClause(d.parent)) return d.parent;
      const scoped = d.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const);
      return scoped ? nearest(d.parent, BLOCKS) : nearest(d.parent, FUNCTIONS);
    }
    return nearest(d, BLOCKS);
  };
  const declare = (name, decl) =>
    declared.set(name, [...(declared.get(name) ?? []), { scope: scopeOf(decl), decl }]);
  /** The declarations `id`'s name has where it stands: those of the innermost scope holding one. */
  const bindingAt = (id) => {
    const decls = declared.get(id.text) ?? [];
    for (let n = id; n; n = n.parent) {
      const here = decls.filter((d) => d.scope === n);
      if (here.length > 0) return here;
    }
    return [];
  };
  /** Whether `id` names a declaration of this file rather than a global, at the place it stands. */
  const shadowed = (id) => bindingAt(id).length > 0;
  /** The function a declaration binds its name to, or null. */
  const fnOf = (decl) => {
    if (ts.isFunctionDeclaration(decl)) return decl;
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) return null;
    let init = decl.initializer;
    while (WRAPS.some((is) => is(init))) init = init.expression;
    return ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? init : null;
  };
  const MODULE_SPEC = /^(node:)?process$/;
  /**
   * Whether a module specifier names this file itself, resolved as Node resolves one: a relative or
   * absolute path or a `file:` URL, read as a URL against the file's own, its query and fragment
   * dropped and its escapes decoded, with or without the file's extension.
   */
  const stem = (p) => p.replace(/\.[mc]?[jt]sx?$/, '');
  const own = pathToFileURL(join(ROOT, rel));
  const isSelf = (spec) => {
    if (!/^(\.\.?\/|\/|file:)/.test(spec)) return false;
    try {
      return stem(resolve(fileURLToPath(new URL(spec, own)))) === stem(fileURLToPath(own));
    } catch {
      return false;
    }
  };
  const exported = (node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const defaulted = (node) =>
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  visit((node) => {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword)
      namesMeta = true;
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier.text ?? '';
      const clause = node.importClause;
      const bound = clause?.namedBindings;
      if (clause?.name) declare(clause.name.text, clause);
      if (bound && ts.isNamespaceImport(bound)) declare(bound.name.text, bound);
      if (bound && ts.isNamedImports(bound))
        for (const el of bound.elements) declare(el.name.text, el);
      if (MODULE_SPEC.test(spec)) {
        if (clause?.name) processNames.add(clause.name.text);
        if (bound && ts.isNamespaceImport(bound)) processNames.add(bound.name.text);
        if (bound && ts.isNamedImports(bound)) {
          for (const el of bound.elements) {
            const name = (el.propertyName ?? el.name).text;
            if (name === 'argv') argvNames.set(el.name.text, 0);
            if (name === 'default') processNames.add(el.name.text);
          }
        }
      }
      if (/^(node:)?module$/.test(spec) && bound && ts.isNamedImports(bound)) {
        for (const el of bound.elements)
          if ((el.propertyName ?? el.name).text === 'createRequire')
            requireMakers.add(el.name.text);
      }
      if (isSelf(spec)) {
        if (clause?.name) selfImports.set(clause.name.text, 'default');
        if (bound && ts.isNamespaceImport(bound)) selfNs.add(bound.name.text);
        if (bound && ts.isNamedImports(bound))
          for (const el of bound.elements)
            selfImports.set(el.name.text, (el.propertyName ?? el.name).text);
      }
    }
    if (ts.isExportDeclaration(node)) {
      const spec =
        node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : null;
      const clause = node.exportClause;
      if (spec !== null && MODULE_SPEC.test(spec)) {
        if (!clause) exportsAllOfProcess = true;
        else if (ts.isNamespaceExport(clause)) exportsProcess.set(clause.name.text, '*');
        else
          for (const el of clause.elements)
            exportsProcess.set(el.name.text, (el.propertyName ?? el.name).text);
      }
      if (spec === null && clause && ts.isNamedExports(clause))
        for (const el of clause.elements)
          exportsLocal.set(el.name.text, (el.propertyName ?? el.name).text);
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      if (ts.isIdentifier(node.expression)) exportsLocal.set('default', node.expression.text);
      else exportsValue.set('default', node.expression);
    }
    if (ts.isVariableStatement(node) && exported(node))
      for (const d of node.declarationList.declarations)
        if (ts.isIdentifier(d.name)) exportsLocal.set(d.name.text, d.name.text);
    if (ts.isFunctionDeclaration(node) && node.name && exported(node))
      exportsLocal.set(defaulted(node) ? 'default' : node.name.text, node.name.text);
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name)
    ) {
      declare(node.name.text, node);
      const init = ts.isVariableDeclaration(node) ? node.initializer : undefined;
      const callee = init && ts.isCallExpression(init) ? init.expression.getText(src) : '';
      if (callee === 'Symbol' || callee === 'Symbol.for') symbols.add(node.name.text);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name)
      declare(node.name.text, node);
  });
  if (!namesMeta) return [];

  /** The function of this file a name declared at the top of it holds, or null. */
  const topFunction = (name) =>
    (declared.get(name) ?? [])
      .filter((d) => d.scope === src)
      .map((d) => fnOf(d.decl))
      .find(Boolean) ?? null;
  /**
   * What a called name is where the call is made: `{ fn }` for a function of this file, `{ foreign }`
   * for another file's import, `{}` for anything else. A call is resolved by the scope it stands in,
   * so a function of the same name nested elsewhere never stands in for the one called.
   */
  const calleeAt = (id) => {
    const here = bindingAt(id);
    const fn = here.map((d) => fnOf(d.decl)).find(Boolean);
    if (fn) return { fn };
    const imports = here.some(
      (d) =>
        ts.isImportSpecifier(d.decl) || ts.isImportClause(d.decl) || ts.isNamespaceImport(d.decl),
    );
    if (!imports) return {};
    if (!selfImports.has(id.text)) return { foreign: true };
    const local = exportsLocal.get(selfImports.get(id.text));
    const target = local === undefined ? null : topFunction(local);
    return target ? { fn: target } : {};
  };

  // A global object's name, where no declaration of this file's shadows it, and every name holding one.
  const GLOBAL_NAMES = ['globalThis', 'global', 'self', 'window'];
  /** The globals that turn a string into code: whatever reaches one reaches code no walk can read. */
  const CODE_BUILDERS = ['eval', 'Function'];
  /** Names this file has given the global object: shadowing never applies to a proven alias. */
  const globalAliases = new Set();
  /** The name a property read states, dotted or bracketed by a string; null where it is computed. */
  const propName = (node) =>
    ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : null;
  /** The global object: a global's name or a name holding it, and its own self-properties. */
  function isGlobal(node) {
    if (ts.isIdentifier(node)) {
      return globalAliases.has(node.text) || (GLOBAL_NAMES.includes(node.text) && !shadowed(node));
    }
    const name = propName(node);
    return GLOBAL_NAMES.includes(name) && isGlobal(unwrap(node.expression));
  }
  /**
   * Whether `this` here is the instance a constructor is building. Anywhere else a function's
   * `this` is whatever it was called on, process included once the function sits on process.
   */
  function constructed(node) {
    let at = node.parent;
    while (at && (ts.isArrowFunction(at) || !ts.isFunctionLike(at))) at = at.parent;
    return !!at && ts.isConstructorDeclaration(at);
  }
  /**
   * A function that loads a module by name: `require` and a name holding one, a loader
   * `createRequire` makes, another module's `require`, and `getBuiltinModule`.
   */
  function isLoader(node) {
    const n = unwrap(node);
    if (!n) return false;
    if (ts.isIdentifier(n)) return n.text === 'require' || loaders.has(n.text);
    const name = propName(n);
    if (name === 'require' || name === 'getBuiltinModule') return true;
    if (!ts.isCallExpression(n)) return false;
    const made = unwrap(n.expression);
    return (
      (ts.isIdentifier(made) && requireMakers.has(made.text)) || propName(made) === 'createRequire'
    );
  }
  const loads = (call) =>
    call.expression.kind === ts.SyntaxKind.ImportKeyword || isLoader(call.expression);
  /** The file's own module namespace: a name holding it, or a load of the file by its literal path. */
  function isSelfNs(node) {
    const n = unwrap(node);
    if (!n) return false;
    if (ts.isIdentifier(n)) return selfNs.has(n.text);
    if (ts.isAwaitExpression(n)) return isSelfNs(n.expression);
    if (!ts.isCallExpression(n) || !loads(n)) return false;
    const [first] = n.arguments;
    return !!first && ts.isStringLiteralLike(first) && isSelf(first.text);
  }
  function isProcess(node) {
    if (ts.isIdentifier(node))
      return node.text === 'process' || processNames.has(node.text) || selfNs.has(node.text);
    if (node.kind === ts.SyntaxKind.ThisKeyword) return !constructed(node);
    if (ts.isAwaitExpression(node)) return isProcess(unwrap(node.expression));
    if (
      ts.isCallExpression(node) &&
      RETURNS_PROCESS.has(propName(unwrap(node.expression))) &&
      isProcess(unwrap(unwrap(node.expression).expression))
    ) {
      return true;
    }
    // Whatever loads the module by name — require, a require made elsewhere, import() — hands over
    // process; a load whose name this walk cannot read could be process, and is taken as process. The
    // file's own namespace re-exports what it likes of process, so it is taken as process too.
    if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      if (!first) return false;
      if (ts.isStringLiteralLike(first)) return MODULE_SPEC.test(first.text) || isSelfNs(node);
      return loads(node);
    }
    const name = propName(node);
    if (name === 'process') return isGlobal(unwrap(node.expression));
    if (name === 'default') return isProcess(unwrap(node.expression));
    if (name !== null && isSelfNs(unwrap(node.expression))) return exportIsProcess(name);
    return false;
  }
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
  /** The argv positions the `arguments` an identifier names were handed, or undefined. */
  const argumentsOf = (node) => {
    if (!node || !ts.isIdentifier(node) || node.text !== 'arguments') return undefined;
    let fn = node.parent;
    while (fn && (!ts.isFunctionLike(fn) || ts.isArrowFunction(fn))) fn = fn.parent;
    return fn ? heldArguments.get(fn) : undefined;
  };
  /** What the file's export `name` holds of argv: the index it starts from, or null. */
  function exportStart(name) {
    if (exportsLocal.has(name)) return argvNames.get(exportsLocal.get(name)) ?? null;
    if (exportsProcess.has(name)) return exportsProcess.get(name) === 'argv' ? 0 : null;
    if (exportsValue.has(name)) return startOf(exportsValue.get(name));
    return exportsAllOfProcess && name === 'argv' ? 0 : null;
  }
  /** Whether the file's export `name` holds process. */
  function exportIsProcess(name) {
    if (exportsLocal.has(name)) return processNames.has(exportsLocal.get(name));
    if (exportsProcess.has(name)) return ['default', '*'].includes(exportsProcess.get(name));
    if (exportsValue.has(name)) return isProcess(unwrap(exportsValue.get(name)));
    return false;
  }
  /** Where in argv `node` starts, when it holds argv; null when it does not. */
  const startOf = (node) => {
    const n = unwrap(node);
    if (!n) return null;
    if (ts.isIdentifier(n)) return argvNames.has(n.text) ? argvNames.get(n.text) : null;
    if (ts.isElementAccessExpression(n)) {
      const held = argumentsOf(unwrap(n.expression));
      const k = literal(n.argumentExpression);
      if (held && k !== null && held.has(k)) return held.get(k);
    }
    if (propName(n) !== null && propName(n) !== 'argv' && isSelfNs(unwrap(n.expression)))
      return exportStart(propName(n));
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
  const keyOf = (key) => {
    if (ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))
      return key.text;
    if (ts.isComputedPropertyName(key) && ts.isStringLiteralLike(key.expression))
      return key.expression.text;
    return null;
  };
  const hold = (set, name) => {
    if (set.has(name)) return false;
    set.add(name);
    return true;
  };
  /**
   * What a name receives from a value: argv from where it starts, process, or a global object.
   * `value` is the expression assigned; true where any of the three is news.
   */
  const receive = (name, value) => {
    const held = unwrap(value);
    let news = bind(name, startOf(value));
    if (isGlobal(held)) news = hold(globalAliases, name) || news;
    if (isProcess(held)) news = hold(processNames, name) || news;
    if (isLoader(held)) news = hold(loaders, name) || news;
    if (isSelfNs(held)) news = hold(selfNs, name) || news;
    return news;
  };
  /** What a name bound to the file's own export `key` receives: what that export holds. */
  const mirror = (name, key) => {
    let news = bind(name, exportStart(key));
    if (exportIsProcess(key)) news = hold(processNames, name) || news;
    const local = exportsLocal.get(key);
    if (local !== undefined && globalAliases.has(local)) news = hold(globalAliases, name) || news;
    if (local !== undefined && loaders.has(local)) news = hold(loaders, name) || news;
    return news;
  };
  /** Record that a function of this file was handed argv, from `start`, at position `i`. */
  const holdArgument = (fn, i, start) => {
    if (start === null) return false;
    const held = heldArguments.get(fn) ?? new Map();
    heldArguments.set(fn, held);
    if (held.has(i) && held.get(i) <= start) return false;
    held.set(i, start);
    return true;
  };
  /**
   * The bindings an object destructuring of process or a global takes: each target with its stated
   * key (null where computed, '...' for a rest). Works on a declared pattern and an assigned literal.
   */
  const targets = (pattern) =>
    (ts.isObjectBindingPattern(pattern) ? pattern.elements : pattern.properties).flatMap((el) => {
      if (ts.isBindingElement(el)) {
        if (!ts.isIdentifier(el.name)) return [];
        return [[el.dotDotDotToken ? '...' : keyOf(el.propertyName ?? el.name), el.name.text]];
      }
      if (ts.isShorthandPropertyAssignment(el)) return [[el.name.text, el.name.text]];
      if (ts.isSpreadAssignment(el) && ts.isIdentifier(el.expression))
        return [['...', el.expression.text]];
      if (ts.isPropertyAssignment(el) && ts.isIdentifier(el.initializer))
        return [[keyOf(el.name), el.initializer.text]];
      return [];
    });
  /** Bind what a destructuring of `value` hands each of its targets. */
  const destructure = (pattern, value) => {
    const held = unwrap(value);
    const fromProcess = isProcess(held);
    const fromGlobal = isGlobal(held);
    const fromSelf = isSelfNs(held);
    let news = false;
    for (const [key, name] of targets(pattern)) {
      if (fromSelf && key !== null && key !== '...') news = mirror(name, key) || news;
      if (fromProcess) {
        if (key === 'argv' || key === null) news = bind(name, 0) || news;
        if (key === 'default' || key === '...' || key === null)
          news = hold(processNames, name) || news;
      }
      if (fromGlobal) {
        if (key === 'process' || key === null) news = hold(processNames, name) || news;
        if (key === '...' || key === null || GLOBAL_NAMES.includes(key))
          news = hold(globalAliases, name) || news;
      }
    }
    return news;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, key] of selfImports) changed = mirror(name, key) || changed;
    visit((node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name))
          changed = receive(node.name.text, node.initializer) || changed;
        if (ts.isObjectBindingPattern(node.name))
          changed = destructure(node.name, node.initializer) || changed;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(node.left)) changed = receive(node.left.text, node.right) || changed;
        if (ts.isObjectLiteralExpression(node.left))
          changed = destructure(node.left, node.right) || changed;
      }
      const fn =
        ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          ? calleeAt(node.expression).fn
          : undefined;
      if (fn) {
        node.arguments.forEach((arg, i) => {
          const param = fn.parameters[i]?.name;
          if (param && ts.isIdentifier(param)) changed = receive(param.text, arg) || changed;
          if (!ts.isArrowFunction(fn)) changed = holdArgument(fn, i, startOf(arg)) || changed;
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
  /** Whether a function of this file is what `node` holds: one written here, or a name bound to one. */
  const isFunctionValue = (node) => {
    const n = unwrap(node);
    if (!n) return false;
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isClassExpression(n)) return true;
    return (
      ts.isIdentifier(n) &&
      bindingAt(n).some(({ decl }) => fnOf(decl) !== null || ts.isClassDeclaration(decl))
    );
  };
  /**
   * Whether `node` takes a value's `constructor` for use: read by its name, destructured, asked of
   * `Reflect.get` and its kin by name, or read off a function by a key computed at run time. Only its
   * `name` read, a comparison of it and a write to it leave it unused.
   */
  const constructorTaken = (node) => {
    if (
      ts.isBindingElement(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node)
    ) {
      const key = ts.isBindingElement(node) ? (node.propertyName ?? node.name) : node.name;
      const named =
        (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === 'constructor';
      if (!named) return false;
      if (ts.isBindingElement(node)) return true;
      const obj = node.parent;
      const p = outer(obj).parent;
      return (
        ts.isBinaryExpression(p) &&
        p.left === outer(obj) &&
        p.operatorToken.kind === ts.SyntaxKind.EqualsToken
      );
    }
    if (ts.isStringLiteralLike(node) && node.text === 'constructor') {
      const p = outer(node).parent;
      return ts.isCallExpression(p) && p.arguments.includes(outer(node));
    }
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
    const self = outer(node);
    const p = self.parent;
    const written =
      ts.isBinaryExpression(p) &&
      p.left === self &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    if (
      ts.isElementAccessExpression(node) &&
      propName(node) === null &&
      literal(node.argumentExpression) === null
    )
      return !written && isFunctionValue(node.expression);
    if (propName(node) !== 'constructor' || written) return false;
    if (ts.isPropertyAccessExpression(p) && p.expression === self && p.name.text === 'name')
      return false;
    if (ts.isTypeOfExpression(p)) return false;
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
        ].includes(op)
      )
        return false;
      if (op === ts.SyntaxKind.InstanceOfKeyword && p.right === self) return false;
    }
    return true;
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
      const at = ts.isIdentifier(callee) ? calleeAt(callee) : {};
      if (at.foreign) return null;
      if (at.fn) {
        const params = at.fn.parameters;
        const param = params[p.arguments.indexOf(self)];
        // Past every parameter, and none a rest: only `arguments` holds it, and that is judged where it is read.
        if (!param && !params.at(-1)?.dotDotDotToken) return null;
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

  /** A destructuring of process whose argv is itself destructured: judged as argv's own would be. */
  const nestedArgv = (pattern, whole) => {
    for (const el of pattern.elements) {
      const prop = ts.isBindingElement(el)
        ? el.propertyName
        : ts.isPropertyAssignment(el)
          ? el.name
          : null;
      const inner = ts.isBindingElement(el)
        ? el.name
        : ts.isPropertyAssignment(el)
          ? el.initializer
          : null;
      if (!prop || !inner || ts.isIdentifier(inner)) continue;
      const key = keyOf(prop);
      if (key !== 'argv' && key !== null) continue;
      const items = inner.elements;
      const array = ts.isArrayBindingPattern(inner) || ts.isArrayLiteralExpression(inner);
      if (!array || bindsEntry(items, 0))
        say(whole, `argv destructured inside process: ${whole.getText(src)}`);
    }
  };

  /**
   * How a use of process could reach argv without naming it, or null where it cannot: a property
   * read by a stated name, a typeof, and a name or a destructuring by stated keys that holds it.
   */
  const processLeak = (node, what = 'process') => {
    const self = outer(node);
    const p = self.parent;
    if (ts.isCallExpression(self) && self.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return ts.isAwaitExpression(p)
        ? null
        : `process module handed on as a promise: ${p.getText(src)}`;
    }
    if (ts.isPropertyAccessExpression(p) && p.expression === self) return null;
    if (ts.isElementAccessExpression(p) && p.expression === self) {
      const key = p.argumentExpression;
      const stated = ts.isStringLiteralLike(key) || (ts.isIdentifier(key) && symbols.has(key.text));
      return stated ? null : `${what} read by a computed key: ${p.getText(src)}`;
    }
    if (ts.isTypeOfExpression(p)) return null;
    // A wrapper handing its own `this` on as the receiver of what it wraps: a function of this file
    // has its `this` judged where it is read, like this one.
    const forwarded =
      self.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isCallExpression(p) &&
      p.arguments[0] === self &&
      ['call', 'apply', 'bind'].includes(propName(p.expression));
    if (forwarded) return null;
    if (ts.isExpressionStatement(p) && ts.isCallExpression(self)) return null;
    const pattern =
      ts.isVariableDeclaration(p) && p.initializer === self
        ? p.name
        : ts.isBinaryExpression(p) &&
            p.right === self &&
            p.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? p.left
          : null;
    if (pattern && ts.isIdentifier(pattern)) return null;
    if (pattern && (ts.isObjectBindingPattern(pattern) || ts.isObjectLiteralExpression(pattern))) {
      const items = ts.isObjectBindingPattern(pattern) ? pattern.elements : pattern.properties;
      // Each target a plain name under a stated key; only argv may be destructured further, and that
      // nested pattern is judged as argv's own. Anything deeper is a binding this walk cannot follow.
      const followed = (key, target) =>
        key !== null &&
        !(what !== 'process' && CODE_BUILDERS.includes(key)) &&
        (ts.isIdentifier(target) ||
          (key === 'argv' &&
            (ts.isArrayBindingPattern(target) || ts.isArrayLiteralExpression(target))));
      const stated = items.every((el) => {
        if (ts.isBindingElement(el))
          return !el.dotDotDotToken && followed(keyOf(el.propertyName ?? el.name), el.name);
        if (ts.isPropertyAssignment(el)) return followed(keyOf(el.name), el.initializer);
        return ts.isShorthandPropertyAssignment(el) && followed(el.name.text, el.name);
      });
      return stated
        ? null
        : `${what} destructured past what this walk can follow: ${p.getText(src)}`;
    }
    return `${what} handed on whole: ${p.getText(src)}`;
  };

  visit((node) => {
    if (
      (ts.isIdentifier(node) && !naming(node)) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isCallExpression(node) ||
      ts.isAwaitExpression(node) ||
      node.kind === ts.SyntaxKind.ThisKeyword
    ) {
      if (!WRAPS.some((is) => is(node)) && isProcess(node)) {
        const leak = processLeak(node);
        if (leak) say(node, leak);
      }
      if (
        !(ts.isIdentifier(node) && naming(node)) &&
        !WRAPS.some((is) => is(node)) &&
        isGlobal(node)
      ) {
        const leak = processLeak(node, 'the global object');
        if (leak) say(node, leak);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name)
    ) {
      if (isProcess(unwrap(node.initializer))) nestedArgv(node.name, node);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(node.left) &&
      isProcess(unwrap(node.right))
    ) {
      nestedArgv({ elements: node.left.properties }, node);
    }
    const builder =
      (ts.isIdentifier(node) &&
        CODE_BUILDERS.includes(node.text) &&
        !naming(node) &&
        !shadowed(node)) ||
      (CODE_BUILDERS.includes(propName(node)) && isGlobal(unwrap(node.expression))) ||
      constructorTaken(node);
    if (builder) {
      say(
        node,
        `code built from a string, which no walk can read for process or argv: ${node.getText(src)}`,
      );
    }
    // A function handed argv holds it in `arguments` too: an element read by a stated index is judged
    // as argv's own read below, and any other use of `arguments` could reach the entry.
    if (argumentsOf(node) && !naming(node)) {
      const self = outer(node);
      const p = self.parent;
      const indexed = ts.isElementAccessExpression(p) && p.expression === self;
      if (indexed && literal(p.argumentExpression) === null)
        say(p, `arguments of a function handed argv read by a computed index: ${p.getText(src)}`);
      const counted =
        ts.isPropertyAccessExpression(p) && p.expression === self && p.name.text === 'length';
      if (!indexed && !counted)
        say(node, `arguments of a function handed argv used whole: ${p.getText(src)}`);
    }
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
      2,
    ],
    [
      'scripts/process-taken.mjs',
      'const { process: p } = globalThis;\nif (import.meta.filename === p.argv[1]) main();\n',
      2,
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
      3,
    ],
    [
      'scripts/assigned-short.mjs',
      'let argv;\n({ argv } = process);\nif (import.meta.filename === argv[1]) main();\n',
      3,
    ],
    [
      'scripts/joined-key.mjs',
      "const k = 'ar' + 'gv';\nif (import.meta.filename === process[k][1]) main();\n",
      2,
    ],
    [
      'scripts/process-assigned.mjs',
      'let p;\np = process;\nif (import.meta.filename === p.argv[1]) main();\n',
      3,
    ],
    [
      'scripts/default-named.mjs',
      "import { default as p } from 'node:process';\nif (import.meta.filename === p.argv[1]) main();\n",
      2,
    ],
    [
      'scripts/dynamic.mjs',
      "const p = await import('node:process');\nif (import.meta.filename === p.default.argv[1]) main();\n",
      2,
    ],
    [
      'scripts/dynamic-then.mjs',
      "import('process').then((m) => m.argv[1] === import.meta.filename && main());\n",
      1,
    ],
    [
      'scripts/required-alias.mjs',
      "const r = require;\nif (import.meta.filename === r('process').argv[1]) main();\n",
      2,
    ],
    [
      'scripts/dynamic-passed.mjs',
      "function entry(p) {\n  return p.argv[1];\n}\nif (import.meta.filename === entry(await import('node:process'))) main();\n",
      4,
    ],
    [
      'scripts/dynamic-bracket.mjs',
      "const p = (await import('node:process'))['default'];\nif (import.meta.filename === p.argv[1]) main();\n",
      2,
    ],
    [
      'scripts/global-alias.mjs',
      'const g = globalThis;\nif (import.meta.filename === g.process.argv[1]) main();\n',
      2,
    ],
    [
      'scripts/global-reflected.mjs',
      "if (import.meta.filename === Reflect.get(globalThis, 'process').argv[1]) main();\n",
      1,
    ],
    [
      'scripts/dynamic-default.mjs',
      "const { default: p } = await import('node:process');\nif (import.meta.filename === p.argv[1]) main();\n",
      2,
    ],
    [
      'scripts/dynamic-default-assigned.mjs',
      "let p;\n({ default: p } = await import('node:process'));\nif (import.meta.filename === p.argv[1]) main();\n",
      3,
    ],
    [
      'scripts/global-taken-assigned.mjs',
      'let p;\n({ process: p } = globalThis);\nif (import.meta.filename === p.argv[1]) main();\n',
      3,
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
      2,
    ],
    [
      'scripts/global-self-taken.mjs',
      'const { global: g } = globalThis;\nif (import.meta.filename === g.process.argv[1]) main();\n',
      2,
    ],
    [
      'scripts/global-self-assigned.mjs',
      'let g;\n({ global: g } = globalThis);\nif (import.meta.filename === g.process.argv[1]) main();\n',
      3,
    ],
    [
      'scripts/global-shadow-elsewhere.mjs',
      'function unrelated(globalThis) {}\nif (import.meta.filename === globalThis.process.argv[1]) main();\n',
      2,
    ],
    [
      'scripts/global-alias-named.mjs',
      'const window = globalThis;\nif (import.meta.filename === window.process.argv[1]) main();\n',
      2,
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
      2,
    ],
    [
      'scripts/this-getter.mjs',
      "Object.defineProperty(Object.prototype, 'entry', {\n  get() {\n    return this.argv.at(1);\n  },\n});\nif (import.meta.url === process.entry) main();\n",
      3,
    ],
    [
      'scripts/this-alias.mjs',
      'function entry() {\n  const self = this;\n  return self.argv[1];\n}\nprocess.entry = entry;\nif (import.meta.filename === process.entry()) main();\n',
      3,
    ],
    [
      'scripts/this-class-method.mjs',
      'class Entry {\n  read() {\n    const [, entry] = this.argv;\n    return entry;\n  }\n}\nprocess.read = Entry.prototype.read;\nif (import.meta.filename === process.read()) main();\n',
      3,
    ],
    [
      'scripts/chained.mjs',
      "if (import.meta.filename === process.on('exit', () => {}).argv[1]) main();\n",
      1,
    ],
    [
      'scripts/value-of.mjs',
      'const p = process.valueOf();\nif (import.meta.filename === p.argv[1]) main();\n',
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
    // judge-147's evaders inside the bound (ISS-1236 r8), and their neighbours.
    [
      'scripts/scoped-call.mjs',
      'function pick(list) {\n  return list[1];\n}\nfunction unrelated() {\n  function pick(other) {\n    return other.length;\n  }\n  return pick([]);\n}\nif (import.meta.url === pick(process.argv)) main();\n',
      2,
    ],
    [
      'scripts/scoped-param.mjs',
      'function pick(list) {\n  return list.length;\n}\nfunction run(pick) {\n  return pick(process.argv);\n}\nconst ROOT = import.meta.url;\n',
      5,
    ],
    [
      'scripts/self-reexport.mjs',
      "export { argv } from 'node:process';\nimport { argv as av } from './self-reexport.mjs';\nif (import.meta.url === av[1]) main();\n",
      3,
    ],
    [
      'scripts/self-local.mjs',
      "export const entry = process.argv;\nimport { entry as e } from './self-local.mjs';\nif (import.meta.url === e[1]) main();\n",
      3,
    ],
    [
      'scripts/self-namespace.mjs',
      "export * from 'node:process';\nimport * as me from './self-namespace.js';\nif (import.meta.url === me.argv[1]) main();\n",
      3,
    ],
    [
      'scripts/self-dynamic.mjs',
      "export const entry = process.argv;\nconst { entry: e } = await import('./self-dynamic.mjs');\nif (import.meta.url === e.at(1)) main();\n",
      3,
    ],
    [
      'scripts/self-function.mjs',
      "export function pick(list) {\n  return list[1];\n}\nimport { pick as p } from './self-function';\nif (import.meta.url === p(process.argv)) main();\n",
      2,
    ],
    [
      'scripts/require-computed.mjs',
      "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nconst p = load('node:' + 'process');\nif (import.meta.url === p.argv[1]) main();\n",
      4,
    ],
    [
      'scripts/require-made-renamed.mjs',
      "import { createRequire as make } from 'node:module';\nif (import.meta.url === make(import.meta.url)(id).argv[1]) main();\n",
      2,
    ],
    [
      'scripts/builtin-computed.mjs',
      "const p = process.getBuiltinModule(['node', 'process'].join(':'));\nif (import.meta.url === p.argv[1]) main();\n",
      2,
    ],
    [
      'scripts/import-computed.mjs',
      "const id = 'node:process';\nconst p = await import(id);\nif (import.meta.url === p.default.argv[1]) main();\n",
      3,
    ],
    [
      'scripts/import-computed-handed.mjs',
      'const m = await import(name);\nrun(m);\nconst ROOT = import.meta.url;\n',
      2,
    ],
    [
      'scripts/arguments.mjs',
      'function pick(list) {\n  return arguments[0][1];\n}\nif (import.meta.url === pick(process.argv)) main();\n',
      2,
    ],
    [
      'scripts/arguments-computed.mjs',
      'function pick() {\n  const i = 0;\n  return arguments[i][1];\n}\nif (import.meta.url === pick(process.argv)) main();\n',
      3,
    ],
    [
      'scripts/arguments-whole.mjs',
      'function pick() {\n  return [...arguments][0][1];\n}\nif (import.meta.url === pick(process.argv)) main();\n',
      2,
    ],
    [
      'scripts/arguments-arrow.mjs',
      'function outer() {\n  const read = () => arguments[0].at(1);\n  return read();\n}\nif (import.meta.url === outer(process.argv)) main();\n',
      2,
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
      3,
    ],
    [
      'scripts/self-hash.mjs',
      "export { argv } from 'node:process';\nimport { argv as av } from './self-hash.mjs#h';\nif (import.meta.url === av[1]) main();\n",
      3,
    ],
    [
      'scripts/self-star-query.mjs',
      "export * from 'node:process';\nimport * as me from './self-star-query.mjs?q';\nif (import.meta.url === me.argv[1]) main();\n",
      3,
    ],
    [
      'scripts/self-escaped.mjs',
      "export { argv } from 'node:process';\nimport { argv as av } from './%73elf-escaped.mjs';\nif (import.meta.url === av[1]) main();\n",
      3,
    ],
    [
      'scripts/self-url.mjs',
      `export { argv } from 'node:process';\nimport { argv as av } from '${pathToFileURL(join(ROOT, 'scripts/self-url.mjs')).href}';\nif (import.meta.url === av[1]) main();\n`,
      3,
    ],
    [
      'scripts/self-rooted.mjs',
      `export { argv } from 'node:process';\nimport { argv as av } from '${join(ROOT, 'scripts/self-rooted.mjs')}?x';\nif (import.meta.url === av[1]) main();\n`,
      3,
    ],
    [
      'scripts/self-doubled.mjs',
      "export { argv } from 'node:process';\nimport { argv as av } from '././/self-doubled.mjs';\nif (import.meta.url === av[1]) main();\n",
      3,
    ],
    [
      'scripts/self-dynamic-query.mjs',
      "export const entry = process.argv;\nconst { entry: e } = await import('./self-dynamic-query.mjs?q');\nif (import.meta.url === e.at(1)) main();\n",
      3,
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
      'scripts/constructor-computed.mjs',
      "const k = ['constr', 'uctor'].join('');\nfunction f() {}\nconst F = f[k];\nif (import.meta.url === F('return process.argv[1]')()) main();\n",
      3,
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
      'scripts/shadowed-param.mjs',
      'function pick(window) {\n  return window.process;\n}\nconst ROOT = import.meta.url;\n',
    ],
    [
      'scripts/shadowed.mjs',
      "const window = text.slice(0, 9);\nconst KEY = Symbol.for('x');\nconst held = globalThis[KEY];\nconst w = window.slice(1);\nconst ROOT = import.meta.url;\n",
    ],
    [
      'scripts/process-uses.mjs',
      "if (typeof process !== 'undefined') process.exitCode = 1;\nconst { env, platform } = process;\nconst home = process['env'].HOME;\nconst onServer = typeof window === 'undefined' && globalThis.fetch;\nconst sync = process.binding('spawn_sync');\nprocess.on('exit', () => {}).once('beforeExit', () => {});\nfunction watched(...args) {\n  return original.apply(this, args);\n}\nclass Watched extends Base {\n  constructor() {\n    super();\n    live.add(this);\n    this.once('exit', () => live.delete(this));\n  }\n}\nconst ROOT = import.meta.url;\n",
    ],
    [
      'scripts/nested-tail.mjs',
      'const { argv: [, , ...rest] } = process;\nconst ROOT = import.meta.url;\n',
    ],
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
    [
      'scripts/scoped-allowed.mjs',
      "function pick(list) {\n  return list.slice(2);\n}\nfunction other() {\n  function pick(x) {\n    return x[1];\n  }\n  return pick(['a', 'b']);\n}\npick(process.argv);\nconst ROOT = import.meta.url;\n",
    ],
    [
      'scripts/import-computed-read.mjs',
      'const { resolveConfig } = await import(url);\nconst ROOT = import.meta.url;\n',
    ],
    [
      'scripts/require-literal.mjs',
      "import { createRequire } from 'node:module';\nconst ts = createRequire(import.meta.url)('typescript');\nuse(ts);\n",
    ],
    [
      'scripts/arguments-tail.mjs',
      'function flags() {\n  return arguments[0].slice(2).concat(arguments.length);\n}\nflags(process.argv);\nconst ROOT = import.meta.url;\n',
    ],
    [
      'scripts/constructor-uses.mjs',
      "class A {\n  constructor(x) {\n    this.x = x;\n  }\n}\nconst kind = err.constructor.name;\nconst same = err.constructor === TypeError;\nconst made = err instanceof A.prototype.constructor;\nA.prototype.constructor = A;\nconst plain = typeof v.constructor;\nconst k = 'constructor';\nconst ROOT = import.meta.url;\n",
    ],
    [
      'scripts/self-sibling.mjs',
      "export { argv } from 'node:process';\nimport { argv as av } from './self-sibling-two.mjs?q';\nimport { x } from 'pkg/self-sibling.mjs';\nconst ROOT = import.meta.url + av[1] + x;\n",
    ],
    [
      'scripts/self-other.mjs',
      "export const NAME = 'x';\nimport { NAME as n } from './self-other.mjs';\nconst ROOT = import.meta.url + n;\n",
    ],
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
    for (const f of found) expect(f.how).toMatch(/argv|process|global/);
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
      /\.(mjs|cjs|js|ts|tsx|mts|cts)$/.test(entry.name) &&
      !/\.(test|fixture)\./.test(entry.name)
    ) {
      acc.push(path);
    }
  }
  return acc;
}
