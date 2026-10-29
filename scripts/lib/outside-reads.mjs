// A test that reads a file outside its own package reaches that file by no import, so the direct
// selection (`direct-tests.mjs`) and CI's `changes` filter both skip it on a change to that file
// alone, and the skip reads as a pass (ISS-134). The test declares the path with
// `// @direct-test-of <path>`; this finds the paths a test builds and reads, and refuses one no
// declaration covers, and a declaration outside the package the filter of its CI job does not match.
//
// It reads source, so it sees a path only where the test spells it from values it can evaluate:
// string literals, `__dirname`, `import.meta.url` / `dirname` / `filename`, and a `const` bound to
// one of those in the file or exported by a module it imports by a relative or aliased specifier.
// A path built from a parameter, a loop variable or anything else is not seen (scripts/README.md).

import { posix } from 'node:path';
import {
  declarationCovers,
  declarationsOf,
  resolveSpecifier,
  VITEST_COLLECTIONS,
} from './direct-tests.mjs';
import { globToRegExp } from './gate.mjs';
import { declaresWholeTree } from './whole-tree-gates.mjs';

/**
 * Calls that build, compare or print a path rather than read it: their arguments are not reads.
 * Any other call handed a path is, a test's own helper included, since that is how a helper reads.
 */
const NOT_READS = new Set([
  ...['join', 'resolve', 'dirname', 'normalize', 'relative', 'basename', 'extname', 'parse'],
  ...['isAbsolute', 'matchesGlob', 'fileURLToPath', 'pathToFileURL', 'URL', 'String'],
  // A resolution base: a require from it reads no file of it.
  'createRequire',
  ...['startsWith', 'endsWith', 'includes', 'indexOf', 'replace', 'replaceAll', 'slice', 'split'],
  ...['expect', 'log', 'error', 'warn', 'push', 'add', 'has', 'set', 'get'],
]);

/** How deep an imported `const` is followed into the module that exports it. */
const IMPORT_DEPTH = 3;

/** The directory a test's package is: `packages/<name>/`, or the top directory (`scripts/`). */
export function homeOf(path) {
  const parts = path.split('/');
  return parts[0] === 'packages' ? `${parts[0]}/${parts[1]}/` : `${parts[0]}/`;
}

/** A repo path normalized, or null when it climbs above the repository root. */
function inRepo(p) {
  const n = posix.normalize(p === '' ? '.' : p);
  if (n === '..' || n.startsWith('../') || n.startsWith('/')) return null;
  return n === '.' ? '' : n.replace(/\/$/, '');
}

/** `posix.join` from a repo path, where `''` is the root: never an absolute `/…`. */
const joinRepo = (base, rest) => posix.join(base === '' ? '.' : base, rest);

const pathValue = (p) => (p === null ? null : { k: 'path', p });

function scriptKind(ts, file) {
  if (/\.[jt]sx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function calleeName(ts, callee) {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** `const` bindings by name, and the named imports with the specifier each came from. */
function bindingsOf(ts, sf) {
  const consts = new Map();
  const imports = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    ) {
      const list = consts.get(node.name.text) ?? [];
      list.push(node.initializer);
      consts.set(node.name.text, list);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          imports.set(el.name.text, {
            specifier: node.moduleSpecifier.text,
            exported: (el.propertyName ?? el.name).text,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { consts, imports };
}

/**
 * The evaluator of one module: what a path expression in `path` names, as
 * `{k:'path', p}` (a repo path, `''` the root), `{k:'url', p, dir}` or `{k:'str', s}`, or null.
 * `load(from, specifier)` returns `{ path, source }` of an imported module, or null.
 */
function moduleEvaluator({ ts, path, source, load, depth = 0, cache = new Map() }) {
  const key = `${depth}:${path}`;
  if (cache.has(key)) return cache.get(key);
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(ts, path));
  const { consts, imports } = bindingsOf(ts, sf);
  const dir = posix.dirname(path);
  const busy = new Set();

  const evalIdent = (name) => {
    if (name === '__dirname') return pathValue(dir);
    if (name === '__filename') return pathValue(path);
    const decls = consts.get(name);
    if (decls) {
      if (decls.length !== 1 || busy.has(name)) return null;
      busy.add(name);
      try {
        return evaluate(decls[0]);
      } finally {
        busy.delete(name);
      }
    }
    const imported = imports.get(name);
    if (!imported || depth >= IMPORT_DEPTH) return null;
    const mod = load(path, imported.specifier);
    if (!mod) return null;
    return moduleEvaluator({ ts, ...mod, load, depth: depth + 1, cache }).exported(
      imported.exported,
    );
  };

  const joinOnto = (base, rest, resets) => {
    let p = base;
    for (const v of rest) {
      if (v?.k === 'str') p = inRepo(joinRepo(p, v.s));
      else if (v?.k === 'path' && resets) p = v.p;
      else return null;
      if (p === null) return null;
    }
    return pathValue(p);
  };

  const evaluate = (node) => {
    if (!node) return null;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return evaluate(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return { k: 'str', s: node.text };
    if (ts.isIdentifier(node)) return evalIdent(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      const obj = node.expression;
      if (ts.isMetaProperty(obj) && obj.keywordToken === ts.SyntaxKind.ImportKeyword) {
        if (node.name.text === 'url') return { k: 'url', p: path, dir: false };
        if (node.name.text === 'dirname') return pathValue(dir);
        if (node.name.text === 'filename') return pathValue(path);
        return null;
      }
      if (node.name.text === 'pathname') {
        const v = evaluate(obj);
        return v?.k === 'url' ? pathValue(v.p) : null;
      }
      return null;
    }
    if (ts.isTemplateExpression(node)) {
      const first = evaluate(node.templateSpans[0]?.expression);
      if (node.head.text !== '' || first?.k !== 'path') return null;
      let tail = '';
      node.templateSpans.forEach((span, i) => {
        if (i > 0) {
          const v = evaluate(span.expression);
          tail = v?.k === 'str' && tail !== null ? tail + v.s : null;
        }
        if (tail !== null) tail += span.literal.text;
      });
      return tail === null ? null : pathValue(inRepo(joinRepo(first.p, tail)));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluate(node.left);
      const right = evaluate(node.right);
      if (left?.k === 'path' && right?.k === 'str')
        return pathValue(inRepo(joinRepo(left.p, right.s)));
      if (left?.k === 'str' && right?.k === 'str') return { k: 'str', s: left.s + right.s };
      return null;
    }
    if (ts.isNewExpression(node) && calleeName(ts, node.expression) === 'URL') {
      const [spec, base] = (node.arguments ?? []).map(evaluate);
      if (spec?.k === 'url' && base === undefined) return spec;
      if (spec?.k !== 'str' || base?.k !== 'url' || spec.s.startsWith('/') || /^\w+:/.test(spec.s))
        return null;
      const from = base.dir ? base.p : posix.dirname(base.p);
      const p = inRepo(joinRepo(from, spec.s));
      return p === null
        ? null
        : { k: 'url', p, dir: /(^|\/)\.{0,2}$/.test(spec.s) || spec.s.endsWith('/') };
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(ts, node.expression);
      const args = node.arguments.map(evaluate);
      if (name === 'fileURLToPath') return args[0]?.k === 'url' ? pathValue(args[0].p) : null;
      if (name === 'dirname')
        return args[0]?.k === 'path' ? pathValue(inRepo(posix.dirname(args[0].p || '.'))) : null;
      if (name === 'normalize') return args[0]?.k === 'path' ? args[0] : null;
      if (name === 'join' || name === 'resolve') {
        if (args[0]?.k !== 'path') return null;
        return joinOnto(args[0].p, args.slice(1), name === 'resolve');
      }
      return null;
    }
    return null;
  };

  /** Every place a path value is handed to something that is not a path builder: a read. */
  const reads = () => {
    const found = [];
    const consider = (expr) => {
      const v = evaluate(expr);
      if (v?.k !== 'path' && v?.k !== 'url') return;
      const line = sf.getLineAndCharacterOfPosition(expr.getStart(sf)).line + 1;
      found.push({ target: v.p, line, via: expr.getText(sf).replace(/\s+/g, ' ').slice(0, 90) });
    };
    const visit = (node) => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
        const name = calleeName(ts, node.expression);
        if (!NOT_READS.has(name ?? '')) {
          for (const arg of node.arguments) {
            consider(arg);
            if (ts.isObjectLiteralExpression(arg)) {
              for (const prop of arg.properties)
                if (ts.isPropertyAssignment(prop)) consider(prop.initializer);
            }
            if (ts.isArrayLiteralExpression(arg)) for (const el of arg.elements) consider(el);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  };

  const exported = (name) => {
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (
        stmt.declarationList.declarations.some(
          (d) => ts.isIdentifier(d.name) && d.name.text === name,
        )
      )
        return evalIdent(name);
    }
    return null;
  };

  const api = { reads, exported, evaluate };
  cache.set(key, api);
  return api;
}

/**
 * The files and directories `path` builds a path to and hands to a call, each once by target:
 * `{ target, kind: 'file' | 'dir', line, via }`. A target no tracked file is or lies under is not
 * a read of this tree, and the repository root is the whole-tree declaration's (`whole-tree-gates`).
 */
export function readsOf({ ts, path, source, known, load }) {
  const isDir = (p) => {
    for (const f of known) if (f.startsWith(`${p}/`)) return true;
    return false;
  };
  const seen = new Map();
  for (const r of moduleEvaluator({ ts, path, source, load }).reads()) {
    if (r.target === '' || seen.has(r.target)) continue;
    const kind = known.has(r.target) ? 'file' : isDir(r.target) ? 'dir' : null;
    if (kind) seen.set(r.target, { ...r, kind });
  }
  return [...seen.values()];
}

/** A declaration covering a read: the file itself, or a directory (`a/b/`) above or equal to it. */
export function covered(declared, read) {
  if (read.kind === 'file') return declared.some((d) => declarationCovers(d, read.target));
  return declared.some((d) => d.endsWith('/') && `${read.target}/`.startsWith(d));
}

/** The `dorny/paths-filter` filters of ci.yml's `changes` job, by output name. */
export function ciFiltersOf(ciText) {
  const at = ciText.indexOf('uses: dorny/paths-filter');
  if (at < 0) return null;
  const lines = ciText.slice(at).split('\n');
  const start = lines.findIndex((l) => /^\s*filters:\s*\|\s*$/.test(l));
  if (start < 0) return null;
  const filters = new Map();
  let indent = null;
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const lead = line.length - line.trimStart().length;
    indent ??= lead;
    if (lead < indent) break;
    const name = lead === indent ? /^\s*([\w-]+):\s*$/.exec(line)?.[1] : null;
    if (name) {
      current = [];
      filters.set(name, current);
      continue;
    }
    const pattern = /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line)?.[1];
    if (pattern && current) current.push(pattern);
  }
  return filters;
}

/** The `changes` outputs a ci.yml job's `if:` runs it on (`needs.changes.outputs.<name> == 'true'`). */
export function jobOutputsOf(ciText, job) {
  const lines = ciText.split('\n');
  const at = lines.indexOf(`  ${job}:`);
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && /^ {2}\S/.test(l));
  const body = lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
  const cond = /^ {4}if:\s*(.+)$/m.exec(body)?.[1] ?? '';
  return [...cond.matchAll(/needs\.changes\.outputs\.([\w-]+)\s*==\s*'true'/g)].map((m) => m[1]);
}

/** Whether a filter pattern selects `declared`: the file, or every file under a directory. */
export function filterMatches(patterns, declared) {
  const probe = declared.endsWith('/') ? `${declared}\u0001/\u0001` : declared;
  return patterns.some((p) => globToRegExp(p).test(probe));
}

/**
 * Every refusal for the tests in `tests` (`{ path, source }`, each a file a vitest collection
 * collects): an outside read no `@direct-test-of` covers, and an outside declaration the `changes`
 * filter of the collection's CI job does not match. A collection whose job is missing from ci.yml,
 * or names no filter, is refused too, since its declarations could then not be checked.
 */
export function judgeOutsideReads({ ts, tests, known, load, ciText }) {
  const refused = [];
  const filters = ciFiltersOf(ciText);
  if (!filters)
    return {
      refused: [
        {
          path: '.github/workflows/ci.yml',
          why: 'no `dorny/paths-filter` `filters: |` block was found, so no declaration can be checked against it',
        },
      ],
      reads: 0,
    };
  const jobPatterns = new Map();
  for (const c of VITEST_COLLECTIONS) {
    const outputs = jobOutputsOf(ciText, c.ciJob) ?? [];
    const unknown = outputs.filter((o) => !filters.has(o));
    if (outputs.length === 0 || unknown.length > 0) {
      refused.push({
        path: '.github/workflows/ci.yml',
        why: `job \`${c.ciJob}\`, which runs the ${c.name} tests, ${outputs.length === 0 ? 'runs on no `changes` output' : `names outputs the filter does not define: ${unknown.join(', ')}`}`,
      });
    }
    jobPatterns.set(
      c.name,
      outputs.flatMap((o) => filters.get(o) ?? []),
    );
  }
  let reads = 0;
  for (const { path, source } of tests) {
    const collection = VITEST_COLLECTIONS.find((c) => c.test.test(path));
    // A whole-tree test runs on every change (`whole-tree-gates`), so no one path selects it.
    if (!collection || declaresWholeTree(source)) continue;
    const home = homeOf(path);
    const declared = declarationsOf(source);
    for (const read of readsOf({ ts, path, source, known, load })) {
      if (`${read.target}/`.startsWith(home)) continue;
      reads += 1;
      if (covered(declared, read)) continue;
      const decl = read.kind === 'dir' ? `${read.target}/` : read.target;
      refused.push({
        path,
        why: `line ${read.line} reads ${read.kind === 'dir' ? 'the directory ' : ''}\`${decl}\` outside ${home} (${read.via}), and no \`@direct-test-of\` covers it, so a change to it alone selects no test — add \`// @direct-test-of ${decl}\``,
      });
    }
    for (const d of declared) {
      if (d.startsWith(home)) continue;
      const patterns = jobPatterns.get(collection.name) ?? [];
      if (filterMatches(patterns, d)) continue;
      refused.push({
        path,
        why: `declares \`@direct-test-of ${d}\`, and the \`changes\` filter of job \`${collection.ciJob}\`, which runs it, does not match it, so a change to it alone skips the test on main — add \`'${d.endsWith('/') ? `${d}**` : d}'\` under one of ${jobOutputsOf(ciText, collection.ciJob).join(', ')} in ci.yml`,
      });
    }
  }
  return { refused, reads };
}

/** The `load` for `readsOf`: the module a specifier in `from` names, read through `read(path)`. */
export function moduleLoader({ known, aliasesOf, read }) {
  return (from, specifier) => {
    const hit = resolveSpecifier(from, specifier, { known, aliasesOf });
    if (!hit) return null;
    const source = read(hit);
    return source === null ? null : { path: hit, source };
  };
}
