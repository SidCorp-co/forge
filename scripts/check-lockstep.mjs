#!/usr/bin/env node
// The second join: codemap's declaration meets git's measurement.
//
// `cm` knows which files declare `cm:edge lockstep` — "these two must change
// together". git knows which files a change actually touched. Neither knows
// that one half of a pair moved and the other did not, and neither can: `cm`
// has no business knowing your merge-base, and git has never heard of an edge.
//
// Ships ADVISORY. A lockstep edge means "the other side likely needs the same
// change", not "every keystroke here needs a matching one there" — a rename or
// a comment edit legitimately moves one side alone. Blocking on that would
// teach people to route around the checker, which is worse than not having it.
// `--strict` exits 1 for a caller that has decided otherwise.
//
// Exit: 0 nothing one-sided (or advisory mode) · 1 one-sided under --strict
//       · 2 could not run.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CM = '.forge/codemap/cm';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: !r.error && r.status === 0,
    out: r.stdout ?? '',
    err: `${r.error?.message ?? ''}${r.stderr ?? ''}`,
  };
}

function die(message) {
  console.error(`lockstep: ${message}`);
  process.exit(2);
}

function lockstepEdges() {
  const r = run(CM, ['graph', '--json']);
  if (!r.ok)
    die(
      `could not read the declared graph — ${CM} graph --json failed: ${r.err.trim().split('\n')[0] ?? '?'}`,
    );
  let graph;
  try {
    graph = JSON.parse(r.out);
  } catch {
    die(`${CM} graph --json did not return JSON`);
  }
  // cm:edge contract -> .forge/codemap/cm — `from`/`to`/`kind`/`line`/`why` are `cm graph --json`'s edge shape; a rename there empties this checker silently, which reads as "no pairs drifted" rather than as a break
  const edges = (graph.edges ?? []).filter((e) => e.kind === 'lockstep' && e.from && e.to);
  if (edges.length === 0) {
    die(
      "the declared graph carries no lockstep edge — this checker's entire scope is empty, which is exit 2, not a pass",
    );
  }
  return edges;
}

function changedFiles(mode, since) {
  if (mode === 'staged') {
    const r = run('git', ['diff', '--name-only', '--cached']);
    return r.ok ? r.out.split('\n').filter(Boolean) : null;
  }
  const base =
    since ??
    (() => {
      const r = run('git', ['merge-base', 'origin/main', 'HEAD']);
      return r.ok ? r.out.trim() : null;
    })();
  if (!base) return null;
  // cm:why compare the base against the WORKING TREE, not against HEAD — the reader of this advisory is mid-change, and a pair they have already broken but not yet committed is exactly the one worth naming
  const r = run('git', ['diff', '--name-only', base]);
  return r.ok ? r.out.split('\n').filter(Boolean) : null;
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const unknown = argv.filter(
  (a, i) =>
    a.startsWith('--') &&
    !['--all', '--staged', '--strict', '--json', '--since'].includes(a) &&
    argv[i - 1] !== '--since',
);
if (unknown.length) die(`unknown flag(s): ${unknown.join(' ')}`);

const edges = lockstepEdges();
const pairFiles = new Set(edges.flatMap((e) => [e.from, e.to]));

if (flag('--all')) {
  console.log(`lockstep: ${edges.length} edge(s) across ${pairFiles.size} file(s)`);
  if (flag('--json')) console.log(JSON.stringify(edges, null, 2));
  else for (const e of edges) console.log(`  ${e.from}\n    ↔ ${e.to}  — ${e.why ?? ''}`);
  process.exit(0);
}

const changed = changedFiles(flag('--staged') ? 'staged' : 'since', value('--since'));
if (changed === null) {
  die('could not compute the changed set — fetch origin/main, or pass --since <ref>');
}

const changedSet = new Set(changed);
const seen = new Set();
const oneSided = [];
for (const e of edges) {
  const movedFrom = changedSet.has(e.from);
  const movedTo = changedSet.has(e.to);
  if (movedFrom === movedTo) continue;
  const key = [e.from, e.to].sort().join(' :: ');
  if (seen.has(key)) continue;
  seen.add(key);
  // cm:guard `line` belongs to the file that DECLARES the edge, which is always `from` — printing it beside `to` points the reader at an unrelated line in a file they did not open
  oneSided.push({
    moved: movedFrom ? e.from : e.to,
    still: movedFrom ? e.to : e.from,
    why: e.why,
    line: movedFrom ? e.line : null,
  });
}

console.log(
  `lockstep: ${edges.length} edge(s) across ${pairFiles.size} file(s), ${changed.length} changed`,
);

if (flag('--json')) {
  console.log(JSON.stringify({ changed: changed.length, oneSided }, null, 2));
  process.exit(flag('--strict') && oneSided.length ? 1 : 0);
}

if (oneSided.length === 0) {
  console.log('lockstep: every declared pair moved together, or neither half moved');
  process.exit(0);
}

console.log(`\n${oneSided.length} declared pair(s) where one half moved and the other did not:\n`);
for (const p of oneSided) {
  console.log(`  changed   ${p.moved}${p.line ? `:${p.line}` : ''}`);
  console.log(`  untouched ${p.still}`);
  if (p.why) console.log(`            ${p.why}`);
  console.log('');
}
console.log(
  'This is advice, not a verdict — a rename or a comment edit legitimately moves one\n' +
    'side alone. Either make the matching change, or, if the pair no longer holds,\n' +
    'delete the cm:edge instead of leaving a coupling that is not true.',
);
process.exit(flag('--strict') ? 1 : 0);
