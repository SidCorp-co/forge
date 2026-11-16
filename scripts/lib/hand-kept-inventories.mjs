// Relations axis (ISS-1254): a test does not keep its own copy of what a registry registers. A
// literal list of route paths, MCP doors, timers, report queries, outbox events, guides or core
// modules goes stale the day one is added, and either fails a builder who never touched the test
// or, worse, passes while it no longer covers what it names. The test reads the registry instead;
// a classification a person must decide (which input is a credential) stays a table, keyed by the
// registry's names and failing by name on a new one, and is a Record with its reasons rather than
// a bare list. Registries are read from their source with the TypeScript parser or as JSON, never
// imported, so a value the reader cannot read stops the check rather than reading as empty.

import ts from 'typescript';

/** A route path with every parameter name erased, so `:id` and `{projectId}` compare equal. */
export const routeKey = (text) => text.replace(/\{[^}]+\}/g, ':_').replace(/:[A-Za-z_]\w*/g, ':_');

/**
 * The names one registry declares, as a Set, or `{ unreadable }` naming why they cannot be read.
 * `reader` is one of: `array` (the string elements of `const <symbol> = [...]`), `json-keys` (the
 * keys of the object at `pointer`), `openapi-routes` (every path and `METHOD path` an OpenAPI
 * document serves), `property` (every string a property named `property` holds in an object
 * literal of the source).
 */
export function readRegistry(spec, sources) {
  const names = new Set();
  for (const [file, text] of sources) {
    const read = READERS[spec.reader]?.(spec, file, text);
    if (read === undefined)
      return { unreadable: `registry "${spec.name}": no reader "${spec.reader}"` };
    if (typeof read === 'string') return { unreadable: `registry "${spec.name}": ${read}` };
    for (const n of read) names.add(n);
  }
  if (names.size === 0)
    return { unreadable: `registry "${spec.name}" read no name from ${spec.source}` };
  return { names };
}

const READERS = {
  array(spec, file, text) {
    const init = initializerOf(file, text, spec.symbol);
    if (typeof init === 'string') return init;
    if (!ts.isArrayLiteralExpression(init))
      return `${spec.symbol} in ${file} is not an array literal`;
    const out = [];
    for (const el of init.elements) {
      if (!ts.isStringLiteral(el))
        return `${spec.symbol} in ${file} holds ${el.getText()}, not a string literal`;
      out.push(el.text);
    }
    return out;
  },
  'json-keys'(spec, file, text) {
    let node;
    try {
      node = JSON.parse(text);
    } catch (err) {
      return `${file} is not JSON: ${err.message}`;
    }
    for (const part of (spec.pointer ?? '').split('/').filter(Boolean)) node = node?.[part];
    if (!node || typeof node !== 'object') return `${file} holds no object at ${spec.pointer}`;
    return Object.keys(node);
  },
  'openapi-routes'(_spec, file, text) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      return `${file} is not JSON: ${err.message}`;
    }
    if (!doc?.paths || typeof doc.paths !== 'object') return `${file} holds no paths`;
    const out = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      out.push(routeKey(path));
      for (const method of Object.keys(ops ?? {}))
        out.push(`${method.toUpperCase()} ${routeKey(path)}`);
    }
    return out;
  },
  property(spec, file, text) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const out = [];
    const visit = (n) => {
      if (
        ts.isPropertyAssignment(n) &&
        (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
        n.name.text === spec.property &&
        ts.isStringLiteral(n.initializer)
      )
        out.push(n.initializer.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  },
};

/**
 * Every array literal in `text` whose string elements name at least `min` members of one
 * registry, those making up at least half of it: `{ line, registry, names }`. Only a bare list is
 * read. An object keyed by registry names is a table with a value per name, a classification a
 * reviewer reads, and is the shape this asks a hand-kept list to take when it cannot be derived.
 */
export function findInventories(file, text, registries) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const found = [];
  const visit = (n) => {
    if (ts.isArrayLiteralExpression(n)) {
      const strings = n.elements
        .filter((e) => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
        .map((e) => e.text);
      for (const reg of registries) {
        if (strings.length < reg.min) continue;
        const key = reg.reader === 'openapi-routes' ? routeKey : (s) => s;
        const names = [...new Set(strings.filter((s) => reg.names.has(key(s))))];
        if (names.length >= reg.min && names.length * 2 >= n.elements.length) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          found.push({ line, registry: reg.name, names });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Each allowance missing what prices it; [] when every one is whole. */
export function allowanceFaults(allowed, registryNames) {
  if (allowed === undefined) return [];
  if (!Array.isArray(allowed)) return ['`allowed` is not an array'];
  const faults = [];
  allowed.forEach((a, i) => {
    const at = `allowed[${i}]`;
    if (typeof a?.file !== 'string' || a.file === '') faults.push(`${at} names no file`);
    if (!registryNames.includes(a?.registry))
      faults.push(
        `${at} names registry ${JSON.stringify(a?.registry)}, not one of ${registryNames.join(', ')}`,
      );
    for (const field of ['why', 'endsWhen']) {
      if (typeof a?.[field] !== 'string' || a[field].trim() === '')
        faults.push(`${at} carries no \`${field}\` — an allowance is priced or it is not taken`);
    }
  });
  return faults;
}

/**
 * `HAND_KEPT_INVENTORY` for each list no allowance covers, naming the registry to derive it from,
 * and `HAND_KEPT_ALLOWANCE_STALE` for each allowance that covers no list, so the list of allowances
 * shrinks with its cause.
 */
export function judge(findings, registries, allowed = []) {
  const keyOf = (file, registry) => `${file}\0${registry}`;
  const allow = new Set(allowed.map((a) => keyOf(a.file, a.registry)));
  const covered = new Set();
  const refused = [];
  let excused = 0;
  for (const f of findings) {
    const k = keyOf(f.file, f.registry);
    if (allow.has(k)) {
      covered.add(k);
      excused += 1;
      continue;
    }
    const reg = registries.find((r) => r.name === f.registry);
    const shown = f.names.slice(0, 3).join(', ') + (f.names.length > 3 ? ', …' : '');
    refused.push(
      `HAND_KEPT_INVENTORY ${f.file}:${f.line} lists ${f.names.length} ${f.registry} by hand (${shown}). ` +
        `Read them from ${reg?.source ?? 'their registry'} instead; where a person must classify each, ` +
        'key a table by the registry and fail by name on an unclassified one.',
    );
  }
  for (const a of allowed) {
    if (!covered.has(keyOf(a.file, a.registry)))
      refused.push(
        `HAND_KEPT_ALLOWANCE_STALE ${a.file} (${a.registry}) is allowed but lists none: remove the allowance`,
      );
  }
  return { refused, excused };
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function initializerOf(file, text, name) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer)
        return unwrap(d.initializer);
  }
  return `${file} declares no ${name}`;
}

/** `x as const satisfies T` and `(x)` read as `x`. */
function unwrap(node) {
  let n = node;
  while (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n))
    n = n.expression;
  return n;
}
