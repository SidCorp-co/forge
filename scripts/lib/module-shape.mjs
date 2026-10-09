// Pattern v2's declaration checks (docs/patterns/core-module.md, ADR 0008) over
// packages/core/src, and the markers its findings are written as. The import rules are
// dependency-cruiser's (module-boundaries.mjs); the semantic rules are the ESLint rules in
// scripts/eslint-module-shape. Pure functions: nothing here reads the disk.

export const KINDS = ['kernel', 'domain', 'read-model', 'adapter', 'door', 'platform'];

export const RULES = ['kind', 'table-writer', 'route-query', 'refusal', 'global-fetch'];

export const ROOT_MODULE = '(root)';
const SRC = 'packages/core/src/';

/** The kinds that may own a table; a read model derives and a door composes. */
export const OWNING_KINDS = ['kernel', 'domain', 'adapter', 'platform'];

/** The technical layers, each defined by one kind. */
export const LAYER_OF_KIND = { platform: 'platform', adapter: 'adapters' };

const SHAPE =
  'shape { contexts: [{ name, label }], modules: { "<dir>": { kind, context, owns?, reads?, projections? } } }';

/** The declared contexts in dependency order, or the faults that stop them being read. */
function parseContexts(list) {
  if (!Array.isArray(list) || list.length === 0)
    return { faults: [`modules.json: no \`contexts\` list — ${SHAPE}`], order: [] };
  const faults = [];
  const order = [];
  for (const [i, c] of list.entries()) {
    if (typeof c?.name !== 'string' || !/^[a-z][a-z-]*$/.test(c.name))
      faults.push(`modules.json: contexts[${i}] has no kebab-case \`name\` — ${SHAPE}`);
    else if (order.includes(c.name)) faults.push(`modules.json: context ${c.name} is listed twice`);
    else order.push(c.name);
    if (typeof c?.label !== 'string' || !c.label.trim())
      faults.push(`modules.json: contexts[${i}] has no \`label\`, its root module label`);
  }
  for (const layer of Object.values(LAYER_OF_KIND))
    if (!order.includes(layer)) faults.push(`modules.json: the ${layer} layer is not a context`);
  return { faults, order };
}

/** Refuses a declaration it cannot read whole, naming the entry and the valid shape. */
export function parseDeclaration(doc) {
  const modules = doc?.modules;
  if (!modules || typeof modules !== 'object') {
    return { faults: [`modules.json: no \`modules\` object — ${SHAPE}`] };
  }
  const { faults, order } = parseContexts(doc.contexts);
  const owners = new Map();
  for (const [path, spec] of Object.entries(modules)) {
    if (!KINDS.includes(spec?.kind)) {
      faults.push(
        `modules.json: ${path} declares kind ${JSON.stringify(spec?.kind)}, not one of ${KINDS.join(', ')}`,
      );
    }
    if (spec?.context === undefined) {
      faults.push(`modules.json: ${path} declares no context — one of ${order.join(', ')}`);
    } else if (!order.includes(spec.context)) {
      faults.push(
        `modules.json: ${path} declares context ${JSON.stringify(spec.context)}, not one of ${order.join(', ')}`,
      );
    } else {
      const layer = LAYER_OF_KIND[spec.kind];
      if (layer && spec.context !== layer)
        faults.push(
          `modules.json: ${path} is a ${spec.kind} module in ${spec.context}; every ${spec.kind} module is in ${layer}`,
        );
      if (
        Object.values(LAYER_OF_KIND).includes(spec.context) &&
        ['domain', 'read-model'].includes(spec.kind)
      )
        faults.push(
          `modules.json: ${path} is a ${spec.kind} in the ${spec.context} layer, which holds no domain or read model`,
        );
    }
    if (spec?.owns?.length && KINDS.includes(spec.kind) && !OWNING_KINDS.includes(spec.kind)) {
      faults.push(
        `modules.json: ${path} is a ${spec.kind} and owns ${spec.owns.join(', ')}; only ${OWNING_KINDS.join(', ')} modules own tables`,
      );
    }
    if (spec?.projections !== undefined && spec.kind !== 'read-model')
      faults.push(
        `modules.json: ${path} is a ${spec.kind} and declares projections; only a read model keeps a projection table`,
      );
    for (const table of [...(spec?.owns ?? []), ...(spec?.projections ?? [])]) {
      const prior = owners.get(table);
      if (prior)
        faults.push(
          `modules.json: table ${table} is owned by both ${prior} and ${path}; a table has one writer`,
        );
      else owners.set(table, path);
    }
  }
  for (const [path, spec] of Object.entries(modules))
    faults.push(...readsFaults(path, spec, owners));
  return { faults, modules, owners, contexts: order };
}

/** A `reads` list is a read model's, and names each owned table or view once. */
function readsFaults(path, spec, owners) {
  if (spec?.reads === undefined) return [];
  if (spec.kind !== 'read-model')
    return [
      `modules.json: ${path} is a ${spec.kind} and declares reads; only a read model declares the tables it SELECTs`,
    ];
  if (!Array.isArray(spec.reads) || spec.reads.some((t) => typeof t !== 'string'))
    return [`modules.json: ${path} reads is not a list of table names — ${SHAPE}`];
  const faults = [];
  const seen = new Set();
  for (const table of spec.reads) {
    if (seen.has(table)) faults.push(`modules.json: ${path} reads ${table} twice`);
    seen.add(table);
    if (!owners.has(table))
      faults.push(
        `modules.json: ${path} reads ${table}, which no module owns; a read names an owner's table or view`,
      );
  }
  return faults;
}

/** The declared module a core file belongs to: the longest declared path that contains it. */
export function moduleOf(file, modules) {
  if (!file.startsWith(SRC)) return null;
  const rel = file.slice(SRC.length);
  if (!rel.includes('/')) return ROOT_MODULE;
  const parts = rel.split('/');
  for (let n = parts.length - 1; n >= 1; n--) {
    const key = parts.slice(0, n).join('/');
    if (modules[key]) return key;
  }
  return parts[0];
}

export function kindOf(mod, modules) {
  return modules[mod]?.kind ?? null;
}

/** Every top-level directory with no declared kind. */
export function kindFindings(dirs, modules) {
  return dirs
    .filter((d) => !modules[d])
    .map((d) => ({
      rule: 'kind',
      module: d,
      file: `${SRC}${d}`,
      detail: `${d} declares no kind in modules.json`,
    }));
}

function lineAt(text, offset) {
  let n = 1;
  for (let k = 0; k < offset; k++) if (text.charCodeAt(k) === 10) n += 1;
  return n;
}

/** The tables and views the schema files declare: drizzle export name to SQL name. */
export function declaredTables(schemaTexts) {
  const out = new Map();
  const re = /export\s+const\s+(\w+)\s*=\s*pg(?:Table|View|MaterializedView)\(\s*['"](\w+)['"]/g;
  for (const text of schemaTexts) for (const m of text.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

/**
 * Every declared table one file SELECTs: a raw SQL `FROM` or `JOIN` naming it, or a value import of
 * it from a schema file (a type-only import reads nothing).
 */
export function tableReads(text, tables) {
  const bySql = new Map([...tables].map(([name, sql]) => [sql, name]));
  const out = [];
  for (const m of text.matchAll(/(?<!\bDELETE\s+)\b(?:FROM|JOIN)\s+"?(\w+)"?/gi)) {
    const name = bySql.get(m[1]);
    if (name) out.push({ table: name, via: 'sql', line: lineAt(text, m.index) });
  }
  const imports = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*\/db\/schema[^'"/]*['"]/g;
  for (const m of text.matchAll(imports)) {
    if (m[1]) continue;
    for (const part of m[2].split(',')) {
      const spec = part.trim();
      if (!spec || spec.startsWith('type ')) continue;
      const name = spec.split(/\s+as\s+/)[0].trim();
      if (tables.has(name)) out.push({ table: name, via: 'import', line: lineAt(text, m.index) });
    }
  }
  return out;
}

/** A route file by its name, or by the Hono router it builds under any name. */
export function isRouteFile(file, text = '') {
  return (
    /(^|\/)routes\.ts$|-routes\.ts$|\.routes\.ts$|\/routes\/[^/]+\.ts$/.test(file) ||
    /\bnew Hono\b/.test(text)
  );
}

/** Findings per module, per rule. */
export function tally(findings, modules, dirs) {
  const names = new Set([...Object.keys(modules), ...dirs]);
  const out = {};
  for (const m of [...names].sort()) {
    out[m] = {
      kind: modules[m]?.kind ?? null,
      counts: Object.fromEntries(RULES.map((r) => [r, 0])),
      findings: [],
    };
  }
  for (const f of findings) {
    if (!out[f.module])
      out[f.module] = {
        kind: null,
        counts: Object.fromEntries(RULES.map((r) => [r, 0])),
        findings: [],
      };
    out[f.module].counts[f.rule] += 1;
    out[f.module].findings.push(f);
  }
  return out;
}

export function totals(byModule) {
  const t = Object.fromEntries(RULES.map((r) => [r, 0]));
  for (const m of Object.values(byModule)) for (const r of RULES) t[r] += m.counts[r];
  return t;
}

/** The reconciliation markers: one node per module, Wrong while any rule fails. */
export function markers(byModule, { atSha, rewriteAt = 2 }) {
  const nodes = {};
  for (const [m, row] of Object.entries(byModule)) {
    const aspects = RULES.filter((r) => row.counts[r] > 0);
    nodes[m] = {
      kind: row.kind,
      mark: aspects.length ? 'wrong' : 'matched',
      aspects,
      rewriteDue: aspects.length >= rewriteAt,
      counts: row.counts,
      evidence: row.findings.map((f) => ({
        rule: f.rule,
        kind: 'repo',
        file: f.file,
        ...(f.line ? { line: f.line } : {}),
        detail: f.detail,
        ...(atSha ? { atSha } : {}),
      })),
    };
  }
  return {
    formatVersion: 1,
    root: 'pattern-v2',
    requirement: 'REQ-12',
    adr: '0008',
    generatedBy: 'scripts/check-module-shape.mjs',
    atSha: atSha ?? null,
    rules: RULES,
    totals: totals(byModule),
    nodes,
  };
}
