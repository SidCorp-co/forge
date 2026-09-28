import ts from 'typescript';

export const DECLARATION_VALUES = ['whole-tree'];

/** A declaration line: `@gate-input <value>`, opening a `//` comment or a line of a block comment. */
const DECLARATION_RE = /^[ \t]*(?:\/\/|\/\*\*?|\*)[ \t]*@gate-input\b[ \t]*([^\s*]*)/gm;

export const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

export const SOURCE_FILE_RE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|rs)$/;

const TOPLEVEL_RE = /rev-parse\s+--show-toplevel/;

/** The calls that list a directory's entries, which is what makes a read a walk. */
const LISTING_CALLS = new Set([
  'readdirSync',
  'readdir',
  'opendirSync',
  'opendir',
  'globSync',
  'glob',
]);

export const ENUMERATES_RE = new RegExp(
  `\\b(?:${[...LISTING_CALLS].join('|')})\\s*\\(|\\bls-files\\b`,
);

/** Calls whose result names the same place as their first argument. */
const SAME_PLACE = new Set([
  'fileURLToPath',
  'pathToFileURL',
  'normalize',
  'realpathSync',
  'String',
]);

/** Every declaration the source carries, in order, with the 1-based line each sits on. */
export function declarationsIn(source) {
  const found = [];
  for (const m of source.matchAll(DECLARATION_RE)) {
    const line = source.slice(0, m.index).split('\n').length;
    found.push({ value: m[1], line });
  }
  return found;
}

const depthOf = (dir) => (dir === '.' || dir === '' ? 0 : dir.split('/').length);

/** The package directory a runner stands in for this file: the deepest one that contains it. */
export function cwdOf(file, packageDirs) {
  let best = '.';
  for (const dir of packageDirs) {
    if ((dir === '.' || file.startsWith(`${dir}/`)) && depthOf(dir) > depthOf(best)) best = dir;
  }
  return best;
}

function scriptKind(file) {
  if (/\.(tsx)$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.(jsx)$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.(mjs|cjs|js)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const calleeName = (expr) =>
  ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : '';

/** A place: `depth` directories below the root, `file` when its last segment is a file. */
const place = (depth, file = false) => ({ depth, file });

function walkSegments(from, text) {
  let depth = from.depth;
  const segs = text.split(/[\\/]/);
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue;
    depth += seg === '..' ? -1 : 1;
  }
  return place(depth, !['', '.', '..'].includes(segs.at(-1)));
}

/**
 * Where each expression in a test's source resolves: import.meta.dirname, __dirname,
 * import.meta.url, __filename and process.cwd() are anchored, and dirname, join, resolve,
 * new URL, fileURLToPath, a template, a `+` and a const binding carry the place along. A base no
 * rule reads is taken to be the file's own directory, which is what a climb from it usually is.
 */
function resolver(file, source, cwd) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const bindings = new Map();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const list = bindings.get(node.name.text) ?? [];
      list.push(node.initializer);
      bindings.set(node.name.text, list);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const fileDepth = depthOf(file);
  const own = place(fileDepth - 1);
  const cwdPlace = place(depthOf(cwd));
  const literal = (n) =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;
  const relative = (text) => (text.startsWith('/') || /^[a-z]+:/i.test(text) ? null : text);

  /** A string literal, or a name bound to one and nothing else. */
  function textOf(node, seen) {
    const text = literal(node);
    if (text !== null || !ts.isIdentifier(node) || seen.has(node.text)) return text;
    const inits = bindings.get(node.text) ?? [];
    return inits.length === 1 ? literal(inits[0]) : null;
  }

  function evaluate(node, seen = new Set()) {
    if (!node) return null;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression?.(node)
    ) {
      return evaluate(node.expression, seen);
    }
    const text = literal(node);
    if (text !== null) return relative(text) === null ? null : walkSegments(cwdPlace, text);
    if (ts.isIdentifier(node)) {
      if (node.text === '__dirname') return own;
      if (node.text === '__filename') return place(fileDepth, true);
      if (seen.has(node.text)) return null;
      const next = new Set(seen).add(node.text);
      const found = (bindings.get(node.text) ?? []).map((init) => evaluate(init, next));
      return shallowest(found);
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isMetaProperty(node.expression)) {
        if (node.name.text === 'dirname') return own;
        if (node.name.text === 'filename' || node.name.text === 'url')
          return place(fileDepth, true);
        return null;
      }
      if (['pathname', 'href'].includes(node.name.text)) return evaluate(node.expression, seen);
      return null;
    }
    if (ts.isCallExpression(node)) return evaluateCall(node, seen);
    if (ts.isNewExpression(node) && calleeName(node.expression) === 'URL') {
      const [spec, base] = node.arguments ?? [];
      const specText = spec ? textOf(spec, seen) : null;
      if (!base || specText === null || relative(specText) === null) return null;
      if (literal(base) !== null) return null;
      const from = evaluate(base, seen) ?? place(fileDepth, true);
      return walkSegments(from.file ? place(from.depth - 1) : from, specText);
    }
    if (ts.isTemplateExpression(node)) {
      if (node.head.text !== '' || node.templateSpans.length !== 1) return null;
      const [span] = node.templateSpans;
      return climbFrom(span.expression, span.literal.text, seen);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const tail = literal(node.right);
      return tail === null ? null : climbFrom(node.left, tail, seen);
    }
    return null;
  }

  /** `${base}<tail>` or `base + '<tail>'`: a base no rule reads counts as the file's own directory
   * only where the tail climbs, since that is when the text is a path being built. */
  function climbFrom(baseNode, tail, seen) {
    const from = evaluate(baseNode, seen);
    if (from) return walkSegments(place(from.depth), tail);
    return /(^|[\\/])\.\.([\\/]|$)/.test(tail) ? walkSegments(own, tail) : null;
  }

  function evaluateCall(node, seen) {
    const name = calleeName(node.expression);
    const args = node.arguments;
    if (name === 'cwd' && ts.isPropertyAccessExpression(node.expression)) return cwdPlace;
    if (SAME_PLACE.has(name)) return evaluate(args[0], seen);
    if (name === 'toString' && ts.isPropertyAccessExpression(node.expression)) {
      return evaluate(node.expression.expression, seen);
    }
    if (name === 'dirname') {
      const from = evaluate(args[0], seen) ?? place(fileDepth);
      return place(from.depth - 1);
    }
    if (name !== 'join' && name !== 'resolve') return null;
    if (args.length === 0) return name === 'resolve' ? cwdPlace : null;
    let at = null;
    for (const [i, arg] of args.entries()) {
      const text = textOf(arg, seen);
      if (text !== null) {
        if (relative(text) === null) return null;
        at = walkSegments(at ?? cwdPlace, text);
        continue;
      }
      const value = evaluate(arg, seen);
      if (value && (i === 0 || name === 'resolve')) at = place(value.depth);
      else if (i === 0) at = own;
      else return null;
    }
    return at;
  }

  return { sf, evaluate };
}

function shallowest(values) {
  let best = null;
  for (const v of values) if (v && (best === null || v.depth < best.depth)) best = v;
  return best;
}

/**
 * The first expression in the source that resolves to the repository root or above it, the one
 * place a walk covers every path, as `{ line, text }`, or null. `cwd` is the directory a runner
 * stands in for this file, which is where `process.cwd()` and a bare relative path resolve.
 */
export function rootReach(file, source, { cwd = '.' } = {}) {
  const top = source.match(TOPLEVEL_RE);
  if (top) return { line: source.slice(0, top.index).split('\n').length, text: top[0] };
  const { sf, evaluate } = resolver(file, source, cwd);
  let hit = null;
  const visit = (node) => {
    if (hit) return;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    const pathy =
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTemplateExpression(node) ||
      ts.isBinaryExpression(node) ||
      (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression));
    const listed =
      ts.isCallExpression(node) && LISTING_CALLS.has(calleeName(node.expression))
        ? node.arguments[0]
        : null;
    for (const candidate of [pathy ? node : null, listed]) {
      const at = candidate && evaluate(candidate);
      if (at && at.depth <= 0) {
        const line = sf.getLineAndCharacterOfPosition(candidate.getStart(sf)).line + 1;
        hit = { line, text: candidate.getText(sf).replace(/\s+/g, ' ') };
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hit;
}

/** True when a path the source builds resolves to the repository root. */
export function reachesRoot(file, source, options) {
  return rootReach(file, source, options) !== null;
}

/** Which of `[{ path, source }]` declare a whole-tree input, and each refused, with its remedy. */
export function judgeDeclarations({ files, packageDirs = ['.'] }) {
  const declared = [];
  const refused = [];
  let tests = 0;
  for (const { path, source } of files) {
    const isTest = TEST_FILE_RE.test(path);
    if (isTest) tests++;
    const found = declarationsIn(source);
    if (found.length === 0) {
      const reach =
        isTest && ENUMERATES_RE.test(source)
          ? rootReach(path, source, { cwd: cwdOf(path, packageDirs) })
          : null;
      if (reach) {
        refused.push({
          path,
          why:
            `line ${reach.line} builds \`${reach.text}\`, which resolves to the repository root, and it lists a directory, so its input is the ` +
            'whole tree and not the paths its job is selected by — add a line `// @gate-input whole-tree` (or ' +
            '` * @gate-input whole-tree` in its opening docblock) so it runs on every change',
        });
      }
      continue;
    }
    const bad = found.filter((d) => !DECLARATION_VALUES.includes(d.value));
    if (bad.length > 0) {
      for (const d of bad) {
        refused.push({
          path,
          why: `line ${d.line} declares \`@gate-input ${d.value || '(nothing)'}\`, and the only valid shape is \`@gate-input ${DECLARATION_VALUES.join(' | ')}\``,
        });
      }
      continue;
    }
    if (!isTest) {
      refused.push({
        path,
        why: `line ${found[0].line} declares a whole-tree input in a file that is not a JavaScript test file, which no vitest configuration can run — move the test into a \`*.test.*\` file`,
      });
      continue;
    }
    declared.push(path);
  }
  return { tests, declared: declared.sort(), refused };
}

/**
 * What a run of the declared files proves: every one collected by some configuration, and every
 * one executing at least one case. `collected` maps a configuration to the declared files it
 * collects; `executed` maps a file to the number of cases that passed or failed in it;
 * `loadErrors` maps a file whose suite errored before recording any case to vitest's message.
 */
export function judgeRun({ declared, collected, executed, loadErrors = {} }) {
  const reached = new Set(Object.values(collected).flat());
  const refused = [];
  for (const path of declared) {
    if (!reached.has(path)) {
      refused.push({
        path,
        why: 'no vitest configuration collects it, so declaring it runs nothing — bring it into a config’s include list',
      });
    } else if (path in loadErrors && !(executed[path] > 0)) {
      refused.push({
        path,
        why: `failed to load, so none of its cases ran: ${loadErrors[path]} — fix what it imports or evaluates at load; the declaration stays`,
      });
    } else if (!(executed[path] > 0)) {
      refused.push({
        path,
        why: 'the run executed no case in it, so a green here would assert nothing — un-skip it or drop the declaration',
      });
    }
  }
  return { refused };
}

/** The declarations half's exit: 1 on a refusal, 2 on an empty scope, 0 otherwise. */
export function declarationExit({ declared, refused }) {
  if (refused.length > 0) return 1;
  return declared.length === 0 ? 2 : 0;
}
