// Which package a root-level consumer reaches, and whether the manifest it stands under declares it
// (ISS-140). A root consumer is a file under scripts/ or .forge/, or a `paths` target of a
// resolution map like .arch-tsconfig.json: code that runs from the repository root rather than from
// a workspace package. Under `node-linker=hoisted` every package any manifest declares sits in the
// root node_modules, so such a file can import one its own manifest never names and nothing fails.
//
// Declared means named in the manifest's dependencies, devDependencies, optionalDependencies or
// peerDependencies, or the manifest's own name. Nothing here calls `require.resolve`: from a worktree
// under .claude/worktrees/ node's upward walk reaches the parent checkout's hoisted node_modules and
// resolves what this checkout never declared. A spawned bin is the one thing a manifest does not
// name, so it is read off the installed `package.json` of each package the manifest DOES declare —
// a file under that manifest's own node_modules, never a walk upward.

import { builtinModules } from 'node:module';
import ts from 'typescript';

const BUILTINS = new Set(builtinModules);
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
/** The runtime itself: `pnpm exec node` runs no package's bin. */
const RUNTIME_BINS = new Set(['node']);
const LOADER_FLAGS = new Set(['--import', '--loader', '--experimental-loader', '--require']);
/** npm's own name grammar: what is not one is a flag, a glob or a path, never a package. */
const PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
/** The calls that build a path, the only place a `'node_modules', '<pkg>'` run of pieces is one. */
const PATH_BUILDERS = new Set(['join', 'resolve']);

/** The package a bare specifier names (`@a/b/c` -> `@a/b`, `x/y` -> `x`), or null for anything else. */
export function packageOf(spec) {
  if (typeof spec !== 'string' || spec === '') return null;
  if (/^[./#]/.test(spec) || /^[a-z][a-z0-9+.-]*:/i.test(spec)) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (spec.startsWith('@') && parts.length < 2) return null;
  if (!PACKAGE_NAME.test(name) || BUILTINS.has(name)) return null;
  return name;
}

/** Every name a manifest declares, its own included. */
export function declaredNames(manifest) {
  const names = new Set(DEP_FIELDS.flatMap((f) => Object.keys(manifest?.[f] ?? {})));
  if (manifest?.name) names.add(manifest.name);
  return names;
}

/** What a path under node_modules/ points at: `{package}`, `{bin}`, or null for neither. */
export function nodeModulesTarget(path) {
  const m = /^(?:\.\/)?node_modules\/(.*)$/.exec(path);
  if (!m) return null;
  const rest = m[1];
  if (rest.startsWith('.bin/')) {
    const bin = rest.slice(5).split('/')[0];
    return bin ? { bin } : null;
  }
  if (rest === '' || rest.startsWith('.')) return null;
  const pkg = packageOf(rest);
  return pkg ? { package: pkg } : null;
}

function literal(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

/**
 * A run of pieces, literal or null: `join(..., 'node_modules', ...)` when `isPath` (a list of
 * directory names to skip is not a path), and `['pnpm', 'exec', <bin>]` or a loader flag anywhere.
 */
function sequenceUses(nodes, isPath, push, note) {
  const v = nodes.map(literal);
  for (let i = 0; i < v.length; i++) {
    if (isPath && v[i] === 'node_modules' && i + 1 < v.length) {
      const next = v[i + 1];
      if (next === '.bin') {
        if (v[i + 2]) push({ bin: v[i + 2] }, nodes[i + 2]);
        else if (i + 2 < v.length)
          note(
            nodes[i + 2],
            'names a bin under node_modules/.bin through a value this cannot read',
          );
      } else if (next?.startsWith('@') && !next.includes('/') && v[i + 2]) {
        push({ package: `${next}/${v[i + 2]}` }, nodes[i + 1]);
      } else if (next) {
        const target = nodeModulesTarget(`node_modules/${next}`);
        if (target) push(target, nodes[i + 1]);
      }
    }
    if (v[i] === 'pnpm' && v[i + 1] === 'exec' && v[i + 2]) push({ bin: v[i + 2] }, nodes[i + 2]);
    if (LOADER_FLAGS.has(v[i]) && v[i + 1]) {
      const pkg = packageOf(v[i + 1]);
      if (pkg) push({ package: pkg, via: v[i] }, nodes[i + 1]);
    }
  }
}

function importSpecifier(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    return node.moduleSpecifier;
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return null;
  const callee = node.expression;
  const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
  const isResolve =
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'resolve' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'require';
  if (callee.kind === ts.SyntaxKind.ImportKeyword || isRequire || isResolve) {
    return node.arguments[0];
  }
  return null;
}

function calleeName(call) {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  return ts.isPropertyAccessExpression(c) ? c.name.text : null;
}

function how(target) {
  if (target.bin) return 'runs';
  return target.via ? `loads (${target.via})` : 'names a path into';
}

function scriptKind(file) {
  return /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

/**
 * Every package and bin one source file reaches: module specifiers (static, dynamic, `require`,
 * `require.resolve`), string paths under node_modules/, `pnpm exec <bin>` / `npx <bin>`, and a
 * node loader flag's value. A string that merely CONTAINS an import statement — a fixture a test
 * writes — is a string, not an import, which is why this parses rather than greps.
 *
 * @returns {{ uses: Array<{line:number, package?:string, bin?:string, how:string}>, notes: Array<{line:number, text:string}> }}
 */
export function sourceUses(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const uses = [];
  const notes = [];
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const push = (target, node, how) => uses.push({ line: lineOf(node), how, ...target });
  const note = (node, what) => notes.push({ line: lineOf(node), text: what });

  const visit = (node) => {
    const spec = importSpecifier(node);
    const specText = literal(spec);
    if (specText !== null) {
      const pkg = packageOf(specText);
      if (pkg) push({ package: pkg }, spec, 'imports');
    }
    const s = literal(node);
    if (s !== null && node !== spec) {
      const target = nodeModulesTarget(s);
      if (target) push(target, node, 'names a path into');
      for (const m of s.matchAll(/(?:^|[\s(;&|])(?:pnpm\s+exec|npx)\s+([@\w][\w@./-]*)/g)) {
        push({ bin: m[1] }, node, 'runs');
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      sequenceUses([...node.elements], false, (t, n) => push(t, n, how(t)), note);
    }
    if (ts.isCallExpression(node)) {
      const args = [...node.arguments];
      sequenceUses(args, PATH_BUILDERS.has(calleeName(node)), (t, n) => push(t, n, how(t)), note);
      if (literal(args[0]) === 'pnpm' && args[1] && ts.isArrayLiteralExpression(args[1])) {
        const [first, second] = args[1].elements;
        const bin = literal(second);
        if (literal(first) === 'exec' && bin) push({ bin }, second, 'runs');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { uses: dedupe(uses), notes };
}

function dedupe(uses) {
  const seen = new Set();
  return uses.filter((u) => {
    const key = `${u.line}\0${u.package ?? ''}\0${u.bin ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every `paths` target of a tsconfig-shaped resolution map that points under node_modules/. */
export function pathMapUses(text) {
  const parsed = JSON.parse(text);
  const lines = text.split('\n');
  const uses = [];
  for (const [key, targets] of Object.entries(parsed?.compilerOptions?.paths ?? {})) {
    for (const target of targets) {
      const t = nodeModulesTarget(target);
      if (!t) continue;
      const at = lines.findIndex((l) => l.includes(JSON.stringify(target)));
      uses.push({ line: at + 1, how: `maps \`${key}\` into`, ...t });
    }
  }
  return uses;
}

/** The bins the declared packages provide, read off each one's installed package.json. */
export function providedBins(declared, readInstalled) {
  const bins = new Map();
  for (const name of declared) {
    const pkg = readInstalled(name);
    if (!pkg?.bin) continue;
    if (typeof pkg.bin === 'string') bins.set(name.split('/').pop(), name);
    else for (const bin of Object.keys(pkg.bin)) bins.set(bin, name);
  }
  return bins;
}

/** A use the manifest does not cover, or null. `bins` is only read for a bin use. */
export function undeclared(use, declared, bins) {
  if (use.package) return declared.has(use.package) ? null : use;
  if (RUNTIME_BINS.has(use.bin) || use.bin.startsWith('-')) return null;
  return bins.has(use.bin) ? null : use;
}

/** The allowance list's own faults: each entry names one consumer and one package or bin, and its price. */
export function allowanceFaults(allowed) {
  if (allowed === undefined) return [];
  if (!Array.isArray(allowed)) return ['`allowed` is not an array'];
  const faults = [];
  allowed.forEach((a, i) => {
    const at = `allowed[${i}]`;
    if (typeof a?.consumer !== 'string' || a.consumer === '')
      faults.push(`${at} names no consumer`);
    if ((typeof a?.package === 'string') === (typeof a?.bin === 'string')) {
      faults.push(`${at} names neither or both of \`package\` and \`bin\``);
    }
    for (const field of ['why', '$costs', 'endsWhen']) {
      if (typeof a?.[field] !== 'string' || a[field].trim() === '') {
        faults.push(`${at} carries no \`${field}\` — an allowance is priced or it is not taken`);
      }
    }
  });
  return faults;
}

const keyOf = (file, u) => `${file}\0${u.package ? `p:${u.package}` : `b:${u.bin}`}`;

/**
 * Splits the undeclared uses into what an allowance covers and what it does not, and names every
 * allowance that covers nothing — a stale entry is refused, so the list shrinks with its cause.
 */
export function judge(findings, allowed = []) {
  const allow = new Map(allowed.map((a) => [keyOf(a.consumer, a), a]));
  const hit = new Set();
  const refused = [];
  const excused = [];
  for (const f of findings) {
    const k = keyOf(f.file, f);
    if (allow.has(k)) {
      hit.add(k);
      excused.push(f);
    } else refused.push(f);
  }
  const stale = [...allow].filter(([k]) => !hit.has(k)).map(([, a]) => a);
  return { refused, excused, stale };
}
