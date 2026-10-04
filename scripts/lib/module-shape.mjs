// Pattern v2's module rules (docs/conventions/domain-entities.md, ADR 0008), measured over
// packages/core/src. Pure functions: the CLI hands in the declaration, the file texts and the import
// graph archmap built, and gets findings back. Nothing here reads the disk.

export const KINDS = ['kernel', 'domain', 'read-model', 'adapter', 'door', 'platform'];

/** What each kind may import, besides itself. The order is the dependency direction. */
export const MAY_IMPORT = {
  door: ['door', 'read-model', 'domain', 'kernel', 'adapter', 'platform'],
  'read-model': ['read-model', 'domain', 'kernel', 'platform'],
  domain: ['domain', 'kernel', 'adapter', 'platform'],
  kernel: ['kernel', 'platform'],
  adapter: ['adapter', 'platform'],
  platform: ['platform'],
};

export const RULES = [
  'kind',
  'direction',
  'public-face',
  'cycle',
  'table-writer',
  'route-query',
  'refusal',
  'status-write',
];

export const ROOT_MODULE = '(root)';
const SRC = 'packages/core/src/';

/** The kinds that may own a table; a read model derives and a door composes. */
export const OWNING_KINDS = ['kernel', 'domain', 'adapter', 'platform'];

/** The technical layers, each defined by one kind. */
export const LAYER_OF_KIND = { platform: 'platform', adapter: 'adapters' };

const SHAPE =
  'shape { contexts: [{ name, label }], modules: { "<dir>": { kind, context, owns? } } }';

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
    for (const table of spec?.owns ?? []) {
      const prior = owners.get(table);
      if (prior)
        faults.push(
          `modules.json: table ${table} is owned by both ${prior} and ${path}; a table has one writer`,
        );
      else owners.set(table, path);
    }
  }
  return { faults, modules, owners, contexts: order };
}

export function isTestFile(file) {
  return /\.test\.ts$|\.d\.ts$|\/tests?\/|\/__tests__\/|\/test-helpers?\b|\.spec\.ts$/.test(file);
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

function crossEdges(edges, modules) {
  const out = [];
  for (const e of edges) {
    if (!e.fromFile || !e.toFile || isTestFile(e.fromFile) || isTestFile(e.toFile)) continue;
    const from = moduleOf(e.fromFile, modules);
    const to = moduleOf(e.toFile, modules);
    if (!from || !to || from === to) continue;
    out.push({ ...e, from, to });
  }
  return out;
}

/** An import from a kind to a kind it may not reach. */
export function directionFindings(edges, modules) {
  const out = [];
  for (const e of crossEdges(edges, modules)) {
    const fk = kindOf(e.from, modules);
    const tk = kindOf(e.to, modules);
    if (!fk || !tk || MAY_IMPORT[fk].includes(tk)) continue;
    out.push({
      rule: 'direction',
      module: e.from,
      file: e.fromFile,
      detail: `${fk} ${e.from} imports ${tk} ${e.to} (${e.toFile.slice(SRC.length)})`,
    });
  }
  return out;
}

/** An import that lands anywhere in a non-platform module but its index.ts. */
export function publicFaceFindings(edges, modules) {
  const out = [];
  for (const e of crossEdges(edges, modules)) {
    const tk = kindOf(e.to, modules);
    if (!tk || tk === 'platform') continue;
    const face = e.to === ROOT_MODULE ? `${SRC}index.ts` : `${SRC}${e.to}/index.ts`;
    if (e.toFile === face) continue;
    out.push({
      rule: 'public-face',
      module: e.from,
      file: e.fromFile,
      detail: `imports ${e.toFile.slice(SRC.length)}, an internal of ${e.to}`,
    });
  }
  return out;
}

/** Strongly connected components of a directed graph, largest first. */
export function components(graph) {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const on = new Set();
  const out = [];
  let i = 0;
  const visit = (v) => {
    index.set(v, i);
    low.set(v, i);
    i += 1;
    stack.push(v);
    on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (on.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        on.delete(w);
        comp.push(w);
      } while (w !== v);
      out.push(comp.sort());
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return out.sort((a, b) => b.length - a.length);
}

/** Each module inside an import cycle, with the cycle it sits in. */
export function cycleFindings(edges, modules) {
  const graph = new Map();
  for (const e of crossEdges(edges, modules)) {
    if (!graph.has(e.from)) graph.set(e.from, new Set());
    if (!graph.has(e.to)) graph.set(e.to, new Set());
    graph.get(e.from).add(e.to);
  }
  const cycles = components(graph).filter((c) => c.length > 1);
  const findings = [];
  for (const c of cycles) {
    for (const m of c) {
      findings.push({
        rule: 'cycle',
        module: m,
        file: m === ROOT_MODULE ? `${SRC}index.ts` : `${SRC}${m}`,
        detail: `sits in an import cycle of ${c.length} modules`,
      });
    }
  }
  return { findings, cycles };
}

function lineAt(text, offset) {
  let n = 1;
  for (let k = 0; k < offset; k++) if (text.charCodeAt(k) === 10) n += 1;
  return n;
}

/** The tables the schema files declare: drizzle export name to SQL name. */
export function declaredTables(schemaTexts) {
  const out = new Map();
  const re = /export\s+const\s+(\w+)\s*=\s*pgTable\(\s*['"](\w+)['"]/g;
  for (const text of schemaTexts) for (const m of text.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

/** Every write to a declared table in one file: drizzle calls and raw SQL. */
export function tableWrites(text, tables) {
  const bySql = new Map([...tables].map(([name, sql]) => [sql, name]));
  const out = [];
  for (const m of text.matchAll(/\.(insert|update|delete)\(\s*(?:\w+\.)?(\w+)\s*[),]/g)) {
    if (tables.has(m[2])) out.push({ table: m[2], op: m[1], line: lineAt(text, m.index) });
  }
  const raw = /\b(?:INSERT\s+INTO|DELETE\s+FROM)\s+"?(\w+)"?|\bUPDATE\s+"?(\w+)"?\s+SET\b/g;
  for (const m of text.matchAll(raw)) {
    const name = bySql.get(m[1] ?? m[2]);
    if (name) out.push({ table: name, op: 'sql', line: lineAt(text, m.index) });
  }
  return out;
}

/** A write by any module but the table's declared owner, and every write to an undeclared table. */
export function tableWriterFindings(writes, owners) {
  const findings = [];
  const writers = new Map();
  for (const w of writes) {
    if (!writers.has(w.table)) writers.set(w.table, new Set());
    writers.get(w.table).add(w.module);
    const owner = owners.get(w.table);
    if (owner === w.module) continue;
    findings.push({
      rule: 'table-writer',
      module: w.module,
      file: w.file,
      line: w.line,
      detail: owner
        ? `writes ${w.table}, owned by ${owner}`
        : `writes ${w.table}, which declares no owner`,
    });
  }
  const multiWriter = Object.fromEntries(
    [...writers]
      .filter(([, s]) => s.size > 1)
      .sort((a, b) => b[1].size - a[1].size)
      .map(([t, s]) => [t, [...s].sort()]),
  );
  return { findings, multiWriter };
}

/** A route file by its name, or by the Hono router it builds under any name. */
export function isRouteFile(file, text = '') {
  return (
    /(^|\/)routes\.ts$|-routes\.ts$|\.routes\.ts$|\/routes\/[^/]+\.ts$/.test(file) ||
    /\bnew Hono\b/.test(text)
  );
}

const QUERY =
  /\b(?:db|tx|trx)\s*\.\s*(?:select|selectDistinct|selectDistinctOn|insert|update|delete|execute|transaction|query)\b/g;

/** A route file holding database calls of its own. */
export function routeQueryFindings(file, text, mod) {
  if (!isRouteFile(file, text)) return [];
  const n = [...text.matchAll(QUERY)].length;
  if (n === 0) return [];
  return [
    { rule: 'route-query', module: mod, file, detail: `${n} database call(s) in a route file` },
  ];
}

const RULE_STATUSES = new Set(['409', '412', '422', '423', '428']);
/** Codes the MCP door throws for what REST answers 400, 401, 404, 413, 500 or 503: transport, not rules. */
export const TRANSPORT_CODES = new Set([
  'BAD_REQUEST',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL',
  'UNAVAILABLE',
]);
const REFUSAL_PATTERNS = [
  {
    re: /new\s+HTTPException\(\s*(\d{3})/g,
    hit: (m, kind) => RULE_STATUSES.has(m[1]) || (m[1] === '403' && kind !== 'platform'),
    say: (m) => `throws HTTPException ${m[1]} in the error handler's shape, not the envelope`,
  },
  {
    re: /\bclass\s+(\w+)\s+extends\s+(?:Error|HTTPException|\w+Error)\b/g,
    hit: (_m, kind) => kind !== 'platform' && kind !== 'adapter',
    say: (m) =>
      `declares error class ${m[1]}; a rule refusal is the envelope, an invariant a plain Error`,
  },
  {
    re: /throw\s+new\s+Error\(\s*[`'"]([A-Z][A-Z0-9_]{2,}):/g,
    hit: (m) => !TRANSPORT_CODES.has(m[1]),
    say: (m) => `throws the code ${m[1]} as text`,
  },
  {
    re: /export\s+(?:const|type)\s+(\w*(?:REFUSAL_CODES|RefusalCode|_CODES))\b/g,
    hit: (_m, kind) => kind !== 'platform',
    say: (m) => `declares refusal codes ${m[1]} in core, not in contracts`,
  },
];

/** Refusals in any shape but the envelope, and refusal codes declared outside contracts. */
export function refusalFindings(file, text, mod, kind) {
  const out = [];
  for (const p of REFUSAL_PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      if (!p.hit(m, kind)) continue;
      out.push({
        rule: 'refusal',
        module: mod,
        file,
        line: lineAt(text, m.index),
        detail: p.say(m),
      });
    }
  }
  return out;
}

export const TRANSITION_MODULE = 'lifecycle';

/** A status column written anywhere but the kernel transition. */
export function statusWriteFindings(file, text, mod) {
  if (mod === TRANSITION_MODULE) return [];
  const out = [];
  const re = /\.update\(\s*(?:\w+\.)?(\w+)\s*\)\s*\.set\(\s*\{([^}]{0,600})\}/g;
  for (const m of text.matchAll(re)) {
    if (!/(^|[\s,{])(?:status|\w+Status)\s*:/.test(m[2])) continue;
    out.push({
      rule: 'status-write',
      module: mod,
      file,
      line: lineAt(text, m.index),
      detail: `writes a status on ${m[1]} outside the kernel transition`,
    });
  }
  return out;
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
export function markers(byModule, { atSha, cycles, multiWriter, rewriteAt = 2 }) {
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
    cycles,
    multiWriterTables: multiWriter,
    nodes,
  };
}
