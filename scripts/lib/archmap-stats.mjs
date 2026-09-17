// Reading `archmap check --stats`, and telling a tool that changed its wording apart from one that
// never got to speak.
//
// R7 in `conformance-audit.mjs` is the only rule that RUNS anything, and it is deliberately
// fail-closed: stdout it cannot parse yields `measured: null`, which FAILS the rule. That is right
// for the case it was written for — archmap renaming its stats line while the repo's graph quietly
// stops resolving — and wrong for the case it cannot distinguish, because until ISS-1085 the reader
// looked at `stdout` alone and never at `status`, `signal` or `error`. So "archmap renamed its
// output", "archmap was killed" and "archmap exited before printing" were one message with one
// remedy, and a run that met the second was told it failed the hardened profile.
//
// Measured 2026-09-17: one `pnpm verify` on a box at load 25/48 cores reported R7 red while
// `relations · archmap` — the gate, spawning the same binary over the same graph four lines
// earlier — reported `ok, 2750 files`. One run, one binary, one graph, two spawns, and only the
// second came back unreadable. The isolated re-run was green, and so was CI's `conformance` job at
// both heads. Nothing was wrong with the graph; the audit could not hear its own subprocess and had
// no way to say so.
//
// ORDER MATTERS, and the parse comes first on purpose. `archmap check` is a checker and exits
// non-zero when it finds violations, printing its stats line all the same — so deciding on the exit
// status BEFORE parsing would turn every genuine violation into "could not run", which is the one
// outcome worse than the false red this fixes: a gate that goes quiet.
//
// cm:guard the disposition is decided by STRUCTURAL signals only — node's own `error`, the `signal`
// that killed it, the process's own exit status. `stderr` is carried into the message and never
// consulted to reach the verdict, for exactly the reason `prerequisite.mjs:couldNotStart` gives:
// the moment a reader decides on what the process PRINTED, a compile error mentioning a missing
// module becomes "could not run".

/**
 * Both phrasings archmap has printed: `N unresolvable edges` (<= 0.1.2) and
 * `N unresolvable of M possible edges` (0.1.3+).
 */
export const UNRESOLVABLE_EDGES = /(\d+)\s+unresolvable(?:\s+of\s+\d+\s+possible)?\s+edges/;

function firstLine(text) {
  const line = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  return line ? ` — ${line}` : '';
}

/**
 * What R7 may conclude from one `archmap check --stats` spawn.
 *
 * `{ measured: N }`    the stats line was read, whatever the exit status.
 * `{ measured: null }` archmap ran to completion and printed something this cannot parse — the
 *                      wording case, which stays a FAILURE so it is loud.
 * `{ blocked: '…' }`   archmap never got to print — the rule could not be evaluated, which is
 *                      `n/a` and exit 2 rather than a claim that the repo fails its profile.
 */
export function readUnresolvableEdges(spawnResult) {
  const r = spawnResult ?? {};
  const match = UNRESOLVABLE_EDGES.exec(r.stdout ?? '');
  if (match) return { measured: Number(match[1]) };

  if (r.error) {
    return {
      blocked: `archmap could not be run — ${r.error.code ?? r.error.message ?? 'spawn failed'}`,
    };
  }
  if (r.signal) {
    return { blocked: `archmap was killed by ${r.signal} before it printed its stats` };
  }
  if (typeof r.status === 'number' && r.status !== 0) {
    return {
      blocked: `archmap check --stats exited ${r.status} and printed no stats${firstLine(r.stderr)}`,
    };
  }
  return { measured: null };
}
