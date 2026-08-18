// @generated codemap 0.13.0 — vendored by `cm install`; edit the plugin, not this.
// The declared-edge graph: flows, edges, guards, hacks — plus the checks that keep it from
// rotting (codemap/1 §7 referential + structural tiers) and the impact query.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { diag, baselineKey } from './parse.mjs';

const trim = (t) => (t.length > 60 ? `${t.slice(0, 57)}...` : t);

/**
 * Does `anchor` appear in the target's source at all?
 *
 * Deliberately not resolution: no LSP, no parse, no import graph. An anchor is a promise with an
 * expiry, and a word-boundary match on its first dot-segment is enough to make it self-report when
 * it expires — `file.ts#someSchema.default` asks only whether `someSchema` is still in that file.
 * `$` counts as a word character on both sides so `db.$connect` matches and `mysaveThing` does not.
 */
function anchorPresent(src, anchor) {
  const sym = anchor.split('.')[0];
  if (!sym) return true;
  const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\w$])${esc}(?:[^\\w$]|$)`).test(src);
}

// cm:why one target is legitimately named by several edges, so the read is cached per run — and an
//   unreadable file is skipped rather than reported: existsSync already passed, so cm cannot judge it
function readTarget(root, path, cache) {
  if (!cache.has(path)) {
    let v;
    try { v = statSync(join(root, path)).isDirectory() ? { dir: true } : { src: readFileSync(join(root, path), 'utf8') }; }
    catch { v = {}; }
    cache.set(path, v);
  }
  return cache.get(path);
}

export function buildGraph(perFile) {
  const g = { flows: new Map(), edges: [], guards: [], hacks: [], whys: [], byFile: new Map() };
  for (const { relPath, annotations } of perFile) {
    for (const a of annotations) {
      const bucket = g.byFile.get(relPath) ?? [];
      bucket.push(a);
      g.byFile.set(relPath, bucket);
      if (a.tag === 'flow') {
        const f = g.flows.get(a.flow) ?? { name: a.flow, steps: [] };
        f.steps.push(a);
        g.flows.set(a.flow, f);
      } else if (a.tag === 'edge') g.edges.push(a);
      else if (a.tag === 'guard') g.guards.push(a);
      else if (a.tag === 'hack') g.hacks.push(a);
      else if (a.tag === 'why') g.whys.push(a);
    }
  }
  return g;
}

export function referentialDiags(g, { root, reg }) {
  const out = [];
  const declared = new Set((reg.flows ?? []).map((f) => f.name));
  const registryPresent = !reg._missing;

  for (const [name, flow] of g.flows) {
    if (registryPresent && !declared.has(name)) {
      out.push(diag('CM101', flow.steps[0].file, flow.steps[0].line, name));
    }
    const ids = new Map();
    for (const s of flow.steps) {
      const prev = ids.get(s.step);
      if (prev) out.push(diag('CM105', s.file, s.line, `${name}/${s.step} also at ${prev.file}:${prev.line}`));
      else ids.set(s.step, s);
    }
    for (const s of flow.steps) {
      if (s.after && !ids.has(s.after)) out.push(diag('CM103', s.file, s.line, `after:${s.after}`));
    }
  }

  const targets = new Map();
  const externals = new Set((reg.externals ?? []).map((x) => x.name));
  for (const e of g.edges) {
    // cm:guard an external target is checked only as far as its NAME — the path inside it is not in the
    //   tree, so CM102's promise cannot cover it, and pretending otherwise is worse than saying so (§8)
    if (e.external) {
      if (registryPresent && !externals.has(e.external)) out.push(diag('CM107', e.file, e.line, e.external));
      continue;
    }
    const [path, anchor] = e.target.split('#');
    if (!existsSync(join(root, path))) { out.push(diag('CM102', e.file, e.line, e.target)); continue; }
    if (!anchor) continue;
    const t = readTarget(root, path, targets);
    if (t.dir) out.push(diag('CM106', e.file, e.line, `${e.target} — the target is a directory, so it has no symbols`));
    else if (t.src !== undefined && !anchorPresent(t.src, anchor)) out.push(diag('CM106', e.file, e.line, e.target));
  }

  return out;
}

/**
 * codemap/1 §7.1 — is there any evidence the declared coupling exists at the other end?
 *
 * `CM102` answers *does the target exist* and `CM106` *is the symbol still there*. This asks the weaker
 * question neither can: *is the coupling real*. It must stay weak, because several kinds are deliberately
 * reference-free — `naming` IS a string, `sideeffect` happens in SQL or a cron, and a `contract` across a
 * process boundary is HTTP-mediated — so it is warning-only, never gating, and narrow by construction:
 * only `contract` and `lockstep`, only with a `#symbol`, only when NEITHER file names the other.
 *
 * Evidence is a basename match, not an import graph, and it is biased toward silence: a generic name
 * (`index`, `types`) matches easily and the check stays quiet. A false negative costs nothing; a false
 * positive is what gets a warning tier switched off.
 */
// cm:guard a pair of files in different languages CANNOT reference each other — measured, that was 26 of
//   36 hits in one repo, so firing there is a bug in the check and not a threshold to tune (§7.1)
const FAMILY = { ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', go: 'go', php: 'php', py: 'py', rs: 'rs' };
const family = (p) => FAMILY[p.split('.').pop()] ?? null;

export function advisoryDiags(g, { root, baseline = {} }) {
  const out = [];
  const cache = new Map();
  const stem = (p) => p.split('/').pop().replace(/\.\w+$/, '');
  // cm:why an import names the file in JS and the package DIRECTORY in Go, so both count as evidence
  const names = (p) => [stem(p), p.split('/').slice(-2, -1)[0]].filter(Boolean);
  // cm:guard evidence must come from CODE — the edge's own annotation names the target, so counting
  //   comments made the check unable to fire at all, silently passing everything it was built to find
  const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|#|--|\*|\/\*)/.test(l)).join('\n');
  // cm:why prose prefixed with a tag was the cheapest way to clear CM001, and nothing looked at what the
  //   tag carried — the baseline already holds the evidence, since those exact words are frozen (ISS-27)
  for (const a of [...g.guards, ...g.whys, ...g.hacks, ...g.edges]) {
    const frozen = baseline[a.file];
    if (frozen && a.text && frozen.has(baselineKey(a.text))) {
      out.push(diag('CM302', a.file, a.line, trim(a.text)));
    }
  }

  for (const e of g.edges) {
    if (e.external || !['contract', 'lockstep'].includes(e.kind)) continue;
    const [path, anchor] = e.target.split('#');
    if (!anchor || path === e.file) continue;
    const fam = family(e.file);
    if (!fam || fam !== family(path)) continue;
    const target = readTarget(root, path, cache);
    const source = readTarget(root, e.file, cache);
    if (target.src === undefined || source.src === undefined) continue;
    const src = codeOnly(source.src);
    const tgt = codeOnly(target.src);
    if (names(path).some((n) => anchorPresent(src, n))
      || names(e.file).some((n) => anchorPresent(tgt, n))) continue;
    out.push(diag('CM301', e.file, e.line, `${e.kind} -> ${e.target}`));
  }
  return out;
}

export function structuralDiags(g) {
  const out = [];
  for (const [name, flow] of g.flows) {
    if (flow.steps.length === 1) {
      out.push(diag('CM201', flow.steps[0].file, flow.steps[0].line, name));
      continue;
    }
    const roots = flow.steps.filter((s) => !s.after);
    if (roots.length !== 1) {
      out.push(diag('CM202', flow.steps[0].file, flow.steps[0].line,
        roots.length === 0 ? `${name} has no root step (every step has after:)` : `${name} has ${roots.length} root steps`));
      continue;
    }
    const { cycle } = orderFlow(flow);
    if (cycle) out.push(diag('CM202', flow.steps[0].file, flow.steps[0].line, `${name} cycles at ${cycle}`));
  }
  return out;
}

/** Topological walk of the after: chain. Branching is allowed; cycles are not. */
export function orderFlow(flow) {
  const byStep = new Map(flow.steps.map((s) => [s.step, s]));
  const children = new Map();
  for (const s of flow.steps) {
    if (!s.after) continue;
    const arr = children.get(s.after) ?? [];
    arr.push(s);
    children.set(s.after, arr);
  }
  const roots = flow.steps.filter((s) => !s.after);
  const ordered = [];
  const seen = new Set();
  let cycle = null;
  (function walk(node, depth) {
    if (seen.has(node.step)) { cycle = node.step; return; }
    seen.add(node.step);
    ordered.push({ ...node, depth });
    for (const c of children.get(node.step) ?? []) walk(c, depth + 1);
  })(roots[0] ?? flow.steps[0], 0);
  for (const s of flow.steps) if (!seen.has(s.step)) ordered.push({ ...s, depth: 0, detached: true });
  return { ordered, cycle, byStep };
}

/**
 * One annotation's full sentence: its own line plus its §4 continuation.
 *
 * Authors put the rule first and the consequence second, so the half a truncating reader loses is
 * systematically the actionable one — `… is the ONLY authority on which URLs are` with the
 * `… must not import` gone. Joining here rather than in the parser is what keeps `canonical` and
 * `cm fmt` line-local (§4).
 */
export function annText(a) {
  return [a.text, a.wrap].filter(Boolean).join(' ');
}

// cm:guard every branch of the result is projected through annText — the PreToolUse hook reads this JSON,
//   so an unprojected field hands an agent half an invariant with no sign a second half existed (ISS-3)
const full = (a) => (a.wrap ? { ...a, text: annText(a), wrap: undefined } : a);

/**
 * Blast radius of a path: what the type system and LSP cannot tell you.
 * Derivable references stay LSP's job on purpose (codemap/1 §1).
 */
export function impact(g, relPath) {
  const guards = g.guards.filter((a) => a.file === relPath).map(full);
  const hacks = g.hacks.filter((a) => a.file === relPath).map(full);
  const outgoing = g.edges.filter((e) => e.file === relPath).map(full);
  const incoming = g.edges.filter((e) => {
    const t = e.target.split('#')[0];
    return e.file !== relPath && (t === relPath || relPath.startsWith(`${t}/`) || t.startsWith(`${relPath}/`));
  }).map(full);
  // cm:guard cm:why now has a reader — principle 1 says a kind exists only if a tool consumes it, and this
  //   was the one tag nothing read, which is what made relabeling prose into it invisible (ISS-27)
  const whys = g.whys.filter((a) => a.file === relPath).map(full);
  const flows = [];
  for (const [name, flow] of g.flows) {
    const mine = flow.steps.filter((s) => s.file === relPath);
    if (!mine.length) continue;
    const { ordered } = orderFlow(flow);
    const neighbours = [];
    for (const s of mine) {
      const i = ordered.findIndex((o) => o.step === s.step);
      for (const j of [i - 1, i + 1]) {
        const n = ordered[j];
        if (n && n.file !== relPath) neighbours.push(full(n));
      }
    }
    flows.push({ name, steps: mine.map(full), neighbours });
  }
  return { guards, hacks, whys, outgoing, incoming, flows };
}

export function mermaid(flow) {
  const { ordered } = orderFlow(flow);
  const id = (s) => s.step.replace(/[^a-z0-9]/gi, '_');
  const lines = ['flowchart TD'];
  for (const s of ordered) {
    const label = `${s.step}<br/><small>${s.file}:${s.line}</small>`;
    lines.push(`  ${id(s)}["${label}"]`);
  }
  for (const s of ordered) {
    if (s.after) lines.push(`  ${id({ step: s.after })} --> ${id(s)}`);
  }
  return lines.join('\n');
}
