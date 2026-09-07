// The evidence layer behind check-flow-coverage: what a coverage report can be
// asked about one `cm:flow` annotation, separated from the gate that judges it.
//
// Two evidence levels, deliberately both computed. `f` is istanbul's per-function
// invocation count, and it is what the gate has always read: entering the function
// once settles the step, whatever that call then did. `s` is the per-statement
// execution count for the statement the annotation actually names. The second is
// the truer reading of "this step ran" and it would re-open every settled step at
// once, so it is measured and REPORTED while the gate keeps reading the first.

export const FLOW_RE = /cm:flow\s+([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/;

// cm:why a cm:flow annotation sits on a comment line ABOVE the code it names, so the step's line falls just outside its own function — hence the tightest containing function, or failing that one declared within 5 lines below
const LOOKAHEAD = 5;

export function parseSites(grepStdout, flows) {
  const byFlow = new Map(flows.map((f) => [f, []]));
  for (const line of (grepStdout ?? '').split('\n')) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const file = line.slice(0, at);
    const rest = line.slice(at + 1);
    const at2 = rest.indexOf(':');
    if (at2 < 0) continue;
    const lineNo = Number(rest.slice(0, at2));
    const m = FLOW_RE.exec(rest.slice(at2 + 1));
    if (!m || !Number.isFinite(lineNo)) continue;
    if (!byFlow.has(m[1])) continue;
    byFlow.get(m[1]).push({ flow: m[1], step: m[2], file, line: lineNo });
  }
  return byFlow;
}

export function fnHitsAt(entry, line) {
  let best = null;
  for (const [id, fn] of Object.entries(entry.fnMap ?? {})) {
    const start = fn.decl?.start?.line ?? fn.loc?.start?.line;
    const end = fn.loc?.end?.line;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start > line + LOOKAHEAD || end < line) continue;
    if (!best || end - start < best.span)
      best = { span: end - start, hits: entry.f?.[id] ?? 0, name: fn.name };
  }
  return best;
}

// cm:guard the statement a step NAMES is the nearest one at or below the annotation, never the tightest enclosing one — a `cm:flow` above a function sits inside no statement, and widening to enclosing statements would answer with the whole function body and make this level identical to the function level it exists to distinguish
export function stmtHitsAt(entry, line) {
  let best = null;
  for (const [id, loc] of Object.entries(entry.statementMap ?? {})) {
    const start = loc.start?.line;
    if (!Number.isFinite(start)) continue;
    if (start < line || start > line + LOOKAHEAD) continue;
    if (!best || start < best.line) best = { line: start, hits: entry.s?.[id] ?? 0 };
  }
  return best;
}

function fileKey(source, site) {
  const suffix = `/${site.file}`;
  return Object.keys(source.data).find(
    (k) => k.endsWith(suffix) || k.endsWith(suffix.replace(/^\/packages\/[^/]+[/]/, '/')),
  );
}

/**
 * What one source says about one annotation site.
 *
 * `state` is the GATING verdict and reads `f` only. `stmt` is advisory: `covered`,
 * `uncovered`, or `unknown` when no statement was found at or below the annotation.
 */
export function lookup(source, site) {
  if (source.missing) return { state: 'nosource', stmt: 'unknown' };
  const key = fileKey(source, site);
  if (!key) return { state: 'outofscope', stmt: 'unknown' };
  const entry = source.data[key];
  const fn = fnHitsAt(entry, site.line);
  if (!fn) return { state: 'nofn', stmt: 'unknown' };
  const stmt = stmtHitsAt(entry, site.line);
  return {
    state: fn.hits > 0 ? 'covered' : 'uncovered',
    hits: fn.hits,
    fn: fn.name,
    stmt: stmt === null ? 'unknown' : stmt.hits > 0 ? 'covered' : 'uncovered',
    stmtHits: stmt?.hits,
  };
}

// cm:guard a step with several annotation sites is covered when ANY site is, per source and per level independently — collapsing the two levels into one merge would let a function-hit at site A vouch for a statement at site B
export function mergeSites(prev, per) {
  if (!prev) return per;
  return prev.map((p, i) => {
    const next = per[i];
    const state = p.state === 'covered' ? p : next;
    const stmt = p.stmt === 'covered' ? p.stmt : next.stmt;
    return { ...state, stmt };
  });
}
