// Pattern v2's import rules (docs/conventions/domain-entities.md, ADR 0008), as a dependency-cruiser
// rule set generated from packages/core/src/modules.json, and the shrink-only baseline over its
// violations. Pure functions: the CLI hands in the declaration and the cruise result.

import { ROOT_MODULE } from './module-shape.mjs';

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
];

/** The composition roots: the only files that import a module's heavy face. */
export const REGISTRIES = { routes: 'route-registry.ts', tool: 'mcp/registry.ts' };

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
    const own = of((s) => s.context === ctx && s.kind !== 'door');
    const above = of((s) => contexts.indexOf(s.context) > rank);
    if (!own.length || !above.length) continue;
    push(
      'context-direction',
      `${ctx} imports only its own context or one listed before it in modules.json contexts`,
      { path: pat(own) },
      { path: pat(above) },
    );
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

  const registries = Object.values(REGISTRIES).map((f) => `^${esc(SRC)}${esc(f)}$`);
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
    push(rule, say, { pathNot: any([self, ...registries]) }, { path: self, pathNot: index });
    push(
      rule,
      say,
      { path: any(registries), pathNot: self },
      {
        path: self,
        pathNot: any([index, fileOf(mod, 'routes.ts'), fileOf(mod, 'tool.ts')]),
      },
    );
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

/** One baseline key per (rule, importing file, imported file), over the cruises' summaries. */
export function violationKeys(summaries) {
  const out = Object.fromEntries(BOUNDARY_RULES.map((r) => [r, new Set()]));
  for (const v of summaries.flatMap((s) => s?.violations ?? [])) {
    const rule = v.rule?.name;
    if (!out[rule] || !v.from || !v.to) continue;
    out[rule].add(`${v.from.slice(SRC.length)} -> ${v.to.slice(SRC.length)}`);
  }
  return Object.fromEntries(Object.entries(out).map(([r, s]) => [r, [...s].sort()]));
}

/**
 * The verdict over the current violations, the committed baseline and the baseline at the base
 * revision: what is new, what is stale, and which rule's frozen count rose.
 */
export function judge(current, baseline, before) {
  const fresh = [];
  const stale = [];
  const grown = [];
  for (const rule of BOUNDARY_RULES) {
    const now = new Set(current[rule] ?? []);
    const frozen = new Set(baseline?.[rule] ?? []);
    for (const k of now) if (!frozen.has(k)) fresh.push(`${rule}: ${k}`);
    for (const k of frozen) if (!now.has(k)) stale.push(`${rule}: ${k}`);
    if (before && Array.isArray(before[rule]) && frozen.size > before[rule].length)
      grown.push(`${rule}: ${before[rule].length} -> ${frozen.size}`);
  }
  return { fresh, stale, grown };
}
