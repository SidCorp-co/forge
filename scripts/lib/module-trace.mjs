// Requirement trace (ISS-221): every unit packages/core/src/modules.json declares — a core module, a
// web-v2 feature directory, a runner crate — names in `serves` the requirements and workflow steps it
// exists for, checked against the committed design snapshot .forge/design-index.json. Code that
// serves no requirement or workflow step is dead (owner, 2026-10-05). Pure functions: the CLI hands
// in the declaration, the snapshot and the directories on disk.

export const TRACE_RULES = ['trace-empty', 'trace-unknown', 'trace-via'];

/** The declaration section and the directory listing each scope is judged against. */
export const TRACE_SCOPES = {
  core: { section: 'modules', dir: 'packages/core/src' },
  web: { section: 'web', dir: 'packages/web-v2/src/features' },
  runner: { section: 'runner', dir: 'packages/runner' },
};

const SERVES =
  '`serves`: a list of "REQ-<n>", "<workflow>" or "<workflow>#<step>" from .forge/design-index.json, or "via:<unit>" naming a unit of the same scope that serves one directly';

/** Whether `ref` names a live requirement or an existing workflow step in the snapshot. */
export function designRefExists(ref, index) {
  if (/^REQ-\d+$/.test(ref)) {
    const req = index.requirements?.[ref];
    return Boolean(req) && req.status !== 'dropped';
  }
  const m = /^([a-z0-9][a-z0-9-]*)(?:#([\w-]+))?$/.exec(ref);
  if (!m) return false;
  const flow = index.workflows?.[m[1]];
  return Boolean(flow) && (!m[2] || flow.steps.includes(m[2]));
}

/**
 * Findings per rule, keyed `<scope>:<unit>` (empty) or `<scope>:<unit> -> <ref>`, and the faults
 * that stop a declaration being read at all. `present` maps each scope to the units on disk, so a
 * directory with no declaration is untraced and a declaration with no directory is a fault.
 */
export function traceFindings(doc, index, present) {
  const out = Object.fromEntries(TRACE_RULES.map((r) => [r, []]));
  const faults = [];
  for (const [scope, { section }] of Object.entries(TRACE_SCOPES)) {
    const units = doc?.[section];
    if (!units || typeof units !== 'object') {
      faults.push(`modules.json: no \`${section}\` object — each unit declares ${SERVES}`);
      continue;
    }
    const direct = (name) =>
      Array.isArray(units[name]?.serves) && units[name].serves.some((r) => !r.startsWith('via:'));
    for (const name of present[scope] ?? [])
      if (!units[name]) out['trace-empty'].push(`${scope}:${name}`);
    for (const [name, spec] of Object.entries(units)) {
      if (present[scope] && !present[scope].includes(name)) {
        faults.push(
          `modules.json: ${section}.${name} has no directory under ${TRACE_SCOPES[scope].dir}`,
        );
        continue;
      }
      const serves = spec?.serves ?? [];
      if (!Array.isArray(serves) || serves.some((r) => typeof r !== 'string')) {
        faults.push(`modules.json: ${section}.${name} serves is not a list of strings — ${SERVES}`);
        continue;
      }
      if (serves.length === 0) out['trace-empty'].push(`${scope}:${name}`);
      for (const ref of serves) {
        if (ref.startsWith('via:')) {
          const target = ref.slice(4);
          if (target === name || !direct(target))
            out['trace-via'].push(`${scope}:${name} -> ${ref}`);
        } else if (!designRefExists(ref, index)) {
          out['trace-unknown'].push(`${scope}:${name} -> ${ref}`);
        }
      }
    }
  }
  for (const r of TRACE_RULES) out[r].sort();
  return { findings: out, faults };
}

/** New entries, frozen entries that no longer occur, and rules whose frozen count rose over the base. */
export function judgeTrace(current, baseline, before) {
  const fresh = [];
  const stale = [];
  const grown = [];
  for (const rule of TRACE_RULES) {
    const now = new Set(current[rule] ?? []);
    const frozen = new Set(baseline?.[rule] ?? []);
    for (const k of now) if (!frozen.has(k)) fresh.push(`${rule}: ${k}`);
    for (const k of frozen) if (!now.has(k)) stale.push(`${rule}: ${k}`);
    if (before && Array.isArray(before[rule]) && frozen.size > before[rule].length)
      grown.push(`${rule}: ${before[rule].length} -> ${frozen.size}`);
  }
  return { fresh, stale, grown };
}

export const TRACE_RULE_SAYS = {
  'trace-empty': 'serves names no requirement or workflow step',
  'trace-unknown': 'names a requirement or workflow step .forge/design-index.json does not hold',
  'trace-via': 'serves through a unit that serves nothing directly',
};
