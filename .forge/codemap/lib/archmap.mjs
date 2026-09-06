// @generated codemap 0.19.0 — vendored by `cm install`; edit the plugin, not this.
// codemap/1 §7.1 — the real import graph CM301 was missing (graph.mjs:108 confesses the gap).
//
// archmap is a sibling tool, vendored independently at `.forge/archmap` the same way codemap
// vendors itself at `.forge/codemap` — never a dependency of this package. A repo that has not
// run `archmap install` gets `null` here, and CM301 falls back to its basename heuristic exactly
// as before: this module only ever ADDS evidence, never a requirement.

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const VENDOR_BIN = join('.forge', 'archmap', 'archmap');

// cm:guard undirected on purpose — CM301 asks "is there evidence at either end", never which way
//   an edge points, so a->b and b->a are the same fact and must look up the same way
function link(adjacency, a, b) {
  if (!a || !b || a === b) return;
  for (const [x, y] of [[a, b], [b, a]]) {
    const set = adjacency.get(x) ?? new Set();
    set.add(y);
    adjacency.set(x, set);
  }
}

/**
 * archmap's exported graph document (its SPEC §10.4), reduced to a file-to-file adjacency set.
 * `null` covers every reason the graph is unavailable — not vendored, the command failed, the
 * output did not parse as its own contract — and all of those mean "no evidence", not "no edge".
 */
export function loadImportGraph(root) {
  const bin = join(root, VENDOR_BIN);
  if (!existsSync(bin)) return null;

  let out;
  try {
    // cm:guard maxBuffer is explicit and generous — the default 1 MiB truncates a compact export well
    //   under a thousand files (measured: 1.8 MB on a 1905-file repo), and a truncated parse must fail
    out = execFileSync(bin, ['graph', '--json', '--compact'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }

  let doc;
  try { doc = JSON.parse(out); } catch { return null; }
  if (!doc || typeof doc.formatVersion !== 'number' || !Array.isArray(doc.edges)) return null;

  const adjacency = new Map();
  for (const e of doc.edges) {
    if (e.resolved) link(adjacency, e.fromFile, e.toFile);
  }
  return { formatVersion: doc.formatVersion, adjacency };
}

/** Is there evidence, in either direction, that `a` and `b` are actually wired together? */
export function connected(graph, a, b) {
  return graph?.adjacency.get(a)?.has(b) ?? false;
}
