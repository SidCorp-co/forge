// Pattern v2's import rules (docs/conventions/domain-entities.md, ADR 0008), as a dependency-cruiser
// rule set generated from packages/core/src/modules.json, and the keys its violations are reported
// by. Pure functions: the CLI hands in the declaration and the cruise result.

import { ROOT_MODULE, tableReads } from './module-shape.mjs';

export const SRC = 'packages/core/src/';

/** What each kind may import, besides itself. The order is the dependency direction. */
export const MAY_IMPORT = {
  door: ['door', 'read-model', 'domain', 'kernel', 'adapter', 'platform'],
  'read-model': ['read-model', 'domain', 'kernel', 'platform'],
  domain: ['domain', 'kernel', 'adapter', 'platform'],
  kernel: ['kernel', 'platform'],
  adapter: ['adapter', 'platform'],
  platform: ['platform'],
};

export const BOUNDARY_RULES = [
  'context-direction',
  'kind-direction',
  'runtime-cycle',
  'face-only',
  'adapter-port',
  'undeclared-read',
];

/**
 * The composition roots, by the heavy face each may import: the route-mount registry takes
 * routes.ts, and the MCP registry and the assistant's chat toolset take tool.ts.
 */
export const REGISTRIES = {
  'routes.ts': ['route-registry.ts'],
  'tool.ts': ['mcp/registry.ts', 'assistant/tools/registry.ts'],
};

const TESTS =
  '\\.test\\.ts$|\\.spec\\.ts$|\\.d\\.ts$|/tests?/|/__tests__/|/test-helpers?(/|\\.ts$)';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const any = (patterns) => patterns.map((p) => `(?:${p})`).join('|');

/** The files of one declared module: its directory minus any nested module declared inside it. */
export function modulePattern(mod, modules) {
  if (mod === ROOT_MODULE) return `^${esc(SRC)}[^/]+$`;
  const nested = Object.keys(modules)
    .filter((m) => m.startsWith(`${mod}/`))
    .map((m) => esc(m.slice(mod.length + 1)));
  const guard = nested.length ? `(?!(?:${nested.join('|')})/)` : '';
  return `^${esc(SRC)}${esc(mod)}/${guard}`;
}

const fileOf = (mod, name) =>
  `^${esc(SRC)}${mod === ROOT_MODULE ? '' : `${esc(mod)}/`}${esc(name)}$`;

/** A module's read files: `read.ts`, `<x>-read.ts`, or anything under a `read/` directory. */
export function readFilePattern(mod, modules) {
  return `${modulePattern(mod, modules)}(?:|.*/)(?:read\\.ts|[\\w-]+-read\\.ts|read/[^/]+)$`;
}

/** The owners whose tables or views a read model declares under `reads`. */
export function ownersRead(spec, modules) {
  const out = new Set();
  for (const table of spec?.reads ?? [])
    for (const [mod, s] of Object.entries(modules)) if (s.owns?.includes(table)) out.add(mod);
  return [...out];
}

/** Every read model that declares a read of a table or view `mod` owns. */
const readersOf = (mod, modules) =>
  Object.keys(modules).filter((m) => ownersRead(modules[m], modules).includes(mod));

/** The direction and face rules the declaration implies, over every import including type-only. */
export function importRuleSet({ modules, contexts }) {
  const names = Object.keys(modules);
  const of = (pred) => names.filter((m) => pred(modules[m], m));
  const pat = (mods) => any(mods.map((m) => modulePattern(m, modules)));
  const forbidden = [];
  const push = (name, comment, from, to) => {
    if (from.path === '' || to.path === '') return;
    forbidden.push({ name, severity: 'error', comment, from, to });
  };

  for (const [rank, ctx] of contexts.entries()) {
    const above = of((s) => contexts.indexOf(s.context) > rank);
    if (!above.length) continue;
    const say = `${ctx} imports only its own context or one listed before it in modules.json contexts`;
    const own = of((s) => s.context === ctx && s.kind !== 'door' && !s.reads?.length);
    if (own.length) push('context-direction', say, { path: pat(own) }, { path: pat(above) });
    for (const reader of of((s) => s.context === ctx && s.kind !== 'door' && s.reads?.length)) {
      const declared = ownersRead(modules[reader], modules).map((o) => readFilePattern(o, modules));
      push(
        'context-direction',
        `${say}, or the read files of an owner it declares under reads`,
        { path: modulePattern(reader, modules) },
        declared.length ? { path: pat(above), pathNot: any(declared) } : { path: pat(above) },
      );
    }
  }

  for (const [kind, may] of Object.entries(MAY_IMPORT)) {
    const own = of((s) => s.kind === kind);
    const banned = of((s) => !may.includes(s.kind));
    if (!own.length || !banned.length) continue;
    push(
      'kind-direction',
      `a ${kind} module imports only ${may.join(', ')} modules`,
      { path: pat(own) },
      { path: pat(banned) },
    );
  }

  const rootOf = (f) => `^${esc(SRC)}${esc(f)}$`;
  const registries = Object.values(REGISTRIES).flat().map(rootOf);
  for (const mod of names) {
    const { kind } = modules[mod];
    if (kind === 'platform' || mod === ROOT_MODULE) continue;
    const self = modulePattern(mod, modules);
    const index = fileOf(mod, 'index.ts');
    const rule = kind === 'adapter' ? 'adapter-port' : 'face-only';
    const say =
      kind === 'adapter'
        ? `${mod} is reached only through its port, ${mod}/index.ts`
        : `${mod} is reached only through ${mod}/index.ts; its routes.ts and tool.ts only from the registries`;
    const readers = readersOf(mod, modules).map((r) => modulePattern(r, modules));
    if (readers.length) {
      const reads = readFilePattern(mod, modules);
      push(
        rule,
        say,
        { pathNot: any([self, ...registries]) },
        { path: self, pathNot: any([index, reads]) },
      );
      push(
        rule,
        `${say}; its read files also from a read model that declares one of its tables under reads`,
        { pathNot: any([self, ...registries, ...readers]) },
        { path: reads, pathNot: index },
      );
    } else {
      push(rule, say, { pathNot: any([self, ...registries]) }, { path: self, pathNot: index });
    }
    for (const [face, roots] of Object.entries(REGISTRIES)) {
      push(
        rule,
        say,
        { path: any(roots.map(rootOf)), pathNot: self },
        { path: self, pathNot: any([index, fileOf(mod, face)]) },
      );
    }
  }

  return { forbidden };
}

/**
 * A cycle that leaves its module. dependency-cruiser keeps one cycle per import, so filtering that
 * cycle by type would hide a runtime cycle behind a found one through a type edge; this rule runs
 * on a graph that holds runtime imports only (`cruiseOptions`).
 */
export function cycleRuleSet({ modules }) {
  return {
    forbidden: Object.keys(modules).map((mod) => {
      const self = modulePattern(mod, modules);
      return {
        name: 'runtime-cycle',
        severity: 'error',
        comment: `${mod} sits in a runtime import cycle with another module`,
        from: { path: self },
        to: { circular: true, via: { pathNot: self } },
      };
    }),
  };
}

/**
 * The two cruises over core; `tsConfig` must be an absolute path. `imports` sees every import;
 * `cycles` sees only those that evaluate at load: a type-only import is erased by
 * verbatimModuleSyntax and a dynamic import runs on call.
 */
export function cruiseOptions(declaration, tsConfig) {
  const base = {
    validate: true,
    tsConfig: { fileName: tsConfig },
    doNotFollow: { path: 'node_modules' },
    includeOnly: { path: `^${esc(SRC)}` },
  };
  return {
    imports: {
      ...base,
      ruleSet: importRuleSet(declaration),
      tsPreCompilationDeps: true,
      exclude: { path: TESTS },
    },
    cycles: {
      ...base,
      ruleSet: cycleRuleSet(declaration),
      tsPreCompilationDeps: false,
      exclude: { path: TESTS, dynamic: true },
    },
  };
}

/**
 * What each read model SELECTs that its `reads` does not declare, as `<file> -> <table>` keys, and
 * each declared read that no file of the read model uses: neither a SELECT of the table nor an
 * import of its owner's read files. `files` maps each core source file to its text and the core
 * files it imports.
 */
export function readFindings({ modules, files, tables, moduleOf }) {
  const undeclared = new Set();
  const used = new Map();
  for (const [file, { text, imports }] of files) {
    const mod = moduleOf(file);
    const spec = modules[mod];
    if (spec?.kind !== 'read-model') continue;
    const declared = new Set([...(spec.reads ?? []), ...(spec.projections ?? [])]);
    if (!used.has(mod)) used.set(mod, new Set());
    for (const { table } of tableReads(text, tables)) {
      if (declared.has(table)) used.get(mod).add(table);
      else undeclared.add(`${file.slice(SRC.length)} -> ${table}`);
    }
    for (const table of declared) {
      const owner = Object.keys(modules).find((m) => modules[m].owns?.includes(table));
      const pattern = owner && new RegExp(readFilePattern(owner, modules));
      if (pattern && imports.some((i) => pattern.test(i))) used.get(mod).add(table);
    }
  }
  const unused = [];
  for (const [mod, spec] of Object.entries(modules))
    for (const table of spec.reads ?? [])
      if (!used.get(mod)?.has(table))
        unused.push(
          `${mod} declares reads ${table}, but no file of it SELECTs ${table} or imports its owner's read files; drop it from reads`,
        );
  return { undeclared: [...undeclared].sort(), unused };
}

/** One key per (rule, importing file, imported file), over the cruises' summaries. */
export function violationKeys(summaries) {
  const out = Object.fromEntries(BOUNDARY_RULES.map((r) => [r, new Set()]));
  for (const v of summaries.flatMap((s) => s?.violations ?? [])) {
    const rule = v.rule?.name;
    if (!out[rule] || !v.from || !v.to) continue;
    out[rule].add(`${v.from.slice(SRC.length)} -> ${v.to.slice(SRC.length)}`);
  }
  return Object.fromEntries(Object.entries(out).map(([r, s]) => [r, [...s].sort()]));
}
