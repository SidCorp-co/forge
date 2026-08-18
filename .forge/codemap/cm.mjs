#!/usr/bin/env node
// @generated codemap 0.13.0 — vendored by `cm install`; edit the plugin, not this.
// cm — the codemap/1 CLI. Zero dependencies on purpose (see registry.mjs).
//
// A positional path resolves against the CWD first, which is what a shell user means, and falls back to
// root-relative only when that finds nothing. Preferring root the other way round made `.` inside a
// subdirectory scope to the whole repo, and a literal "." matched no walked path at all — a clean 0-file
// report. Every fail-open bug this CLI has shipped is that shape: a scope nobody could compute, reported
// as a scope with nothing wrong in it. Hence exit 2 (§9.1) for anything that cannot be resolved.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, normalize } from 'node:path';
import {
  findRoot, loadRegistry, saveRegistry, loadBaseline, saveBaseline,
  selects, walk, changedSince, changedStaged, changedRanges, headBlob, dirtyFiles,
  vendoredVersion, compareVersions,
  toolVersion, SPEC_VERSION, DEFAULT_REGISTRY,
} from './lib/registry.mjs';
import { analyzeFile } from './lib/analyze.mjs';
import { profileFor } from './lib/languages.mjs';
import { buildGraph, referentialDiags, structuralDiags, advisoryDiags, orderFlow, impact, mermaid, annText } from './lib/graph.mjs';
import { canonical, CODE_TABLE, PROSE_CODES, baselineKey } from './lib/parse.mjs';
import { applyFmt } from './lib/rewrite.mjs';
import { candidateFiles } from './lib/candidates.mjs';
import { install } from './lib/install.mjs';
import { renderHelp, VERBS } from './lib/help.mjs';

// cm:guard the bootstrap prompt pins a TAG, never a branch — a floating gate turns a PR red with no
//   code change, which is the property §8.1's pin exists to protect (ISS-B)
const TAG_HINT = 'codemap-v0.13.0';

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n, s) => (COLOR ? `[${n}m${s}[0m` : s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';

// cm:guard every flag that takes a value MUST be listed here — an unlisted one has its value parsed as a
// path, which silently narrowed `cm verify --since <ref>` to zero files and made the CI gate a no-op
const VALUE_FLAGS = new Set(['--since', '--tier', '--limit', '--description']);
const TIERS = new Set(['all', 'grammar', 'referential', 'structural', 'advisory']);

// cm:guard exit 2 is "the gate could not run", exit 1 is "the gate ran and failed" — CI must be able to
// tell a missing ref or a mistyped flag from a real violation, or a broken invocation reads as a lint error
function die(msg, hint) {
  console.error(red(`codemap: ${msg}`));
  if (hint) console.error(dim(`  ${hint}`));
  process.exit(2);
}

const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]));
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (VALUE_FLAGS.has(a) && !a.includes('=')) i++;
    continue;
  }
  positional.push(a);
}
const flagValue = (name) => {
  const hit = argv.find((a) => a === name || a.startsWith(`${name}=`));
  if (hit === undefined) return null;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  // cm:why `cm verify --since --json` used to take "--json" as the ref and die in git with a stack trace
  const next = argv[argv.indexOf(name) + 1];
  if (next === undefined || next.startsWith('--')) die(`${name} needs a value`);
  return next;
};

const numericFlag = (name, fallback) => {
  const raw = flagValue(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) die(`${name} needs a number, got "${raw}"`);
  return n;
};

const root = findRoot();

function loadOrDie() {
  try { return loadRegistry(root); } catch (e) { die(e.message); }
}

/** Positional paths, resolved against the repo root. A path that resolves to nothing is fatal (exit 2). */
function scopeFromPositional(reg) {
  const files = [];
  const unresolved = [];
  let all = null;
  for (const p of positional) {
    // cm:guard resolve against the CWD first — root-relative is only the fallback (see the header)
    const fromCwd = resolve(p);
    const rel = (existsSync(fromCwd) ? relative(root, fromCwd) : p)
      .split('\\').join('/').replace(/\/+$/, '').replace(/^\.\//, '').replace(/^\.$/, '');
    if (rel.startsWith('..')) {
      die(`${p} is outside the repo root ${root}`, 'cm only reasons about paths inside the tree it onboarded');
    }
    const abs = rel === '' ? root : join(root, rel);
    if (!existsSync(abs)) { unresolved.push(p); continue; }
    if (statSync(abs).isDirectory()) {
      // cm:why walk() is only needed to expand a directory — doing it for a single file made the
      // PostToolUse hook walk an entire monorepo on every edit
      all ??= walk(root, reg);
      files.push(...all.filter((f) => rel === '' || f.startsWith(`${rel}/`)));
    } else files.push(rel);
  }
  if (unresolved.length) {
    die(`no such path: ${unresolved.join(', ')}`,
      'a path that matches nothing used to scan 0 files and exit 0 — a typo cannot be a green gate');
  }
  return files;
}

function fileList(reg) {
  const since = flagValue('--since');
  if (since && flags.has('--staged')) die('--since and --staged are mutually exclusive');
  let files;
  try {
    if (positional.length) files = scopeFromPositional(reg);
    else if (flags.has('--staged')) files = changedStaged(root);
    else if (since) files = changedSince(root, since);
    else files = walk(root, reg);
  } catch (e) {
    die(e.message, 'in a shallow CI clone the ref often is not fetched — try: git fetch --deepen 50');
  }
  return [...new Set(files)].filter((f) => selects(reg, f));
}

/** Every selected file — the scope for anything that reasons about prose (verify, baseline, init). */
function allFiles(reg) {
  return walk(root, reg).filter((f) => selects(reg, f));
}

/**
 * The shortlist that carries annotations, via `git grep`. Enough for impact/flow/ls, which read the
 * graph and never prose — and it is what keeps `cm impact` fast enough to run from a PreToolUse hook
 * on a monorepo.
 */
function annotatedFiles(reg) {
  return candidateFiles(root, reg);
}

// cm:guard every command must analyze against the SAME frozen set — a command that skips it disagrees
//   with verify about which line is an annotation's wrap, and the graph it builds is then a different graph
function analyzeAll(reg, files, baseline = loadBaseline(root)) {
  const perFile = [];
  for (const rel of files) {
    let src;
    try { src = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    const r = analyzeFile({ relPath: rel, src, reg, frozen: baseline?.[rel] });
    perFile.push({ relPath: rel, ...r });
  }
  return perFile;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Normalize every CM009 in `perFile`, in place on disk. Shared by `cm fmt` and `cm verify --fix` so
 * the hook and CI cannot normalize differently.
 *
 * @returns {Array<{file: string, line: number}>} only what was really rewritten — a fix that did not
 *   apply is reported, never counted. Claiming a rewrite that did not happen left CM009 permanently
 *   unfixable behind a "fix: run cm fmt" hint (see lib/rewrite.mjs).
 */
function fixCanonical(perFile) {
  const done = [];
  for (const f of perFile) {
    const fixes = f.diags.filter((d) => d.code === 'CM009' && d.canonical);
    if (!fixes.length) continue;
    const abs = join(root, f.relPath);
    const before = readFileSync(abs, 'utf8');
    const { src, applied, failed } = applyFmt(before, fixes);
    if (applied.length) writeFileSync(abs, src);
    done.push(...applied.map((d) => ({ file: f.relPath, line: d.line })));
    for (const d of failed) {
      console.error(yellow(`${f.relPath}:${d.line} CM009 could not be normalized automatically`));
      console.error(dim(`  rewrite by hand to: ${d.leader ?? '//'} ${d.canonical}`));
    }
  }
  return done;
}

// cm:guard cm fmt owns this and `verify --fix` must NOT: the post-edit hook runs --fix, and a target is
//   CONTENT, so it is only ever rewritten to a path that resolves — never guessed at (ISS-5)
function migrateTargets(perFile) {
  const done = [];
  for (const f of perFile) {
    const fixes = [];
    for (const d of f.diags) {
      if (!d.relative || d.col === undefined) continue;
      // cm:guard split the #symbol off BEFORE resolving — 110 of 186 edges in the field carry an anchor,
      //   and resolving it as part of the path made every one of them fail existsSync and stay unmigrated
      const [rel, anchor] = d.relative.target.split('#');
      const resolved = normalize(join(dirname(f.relPath), rel)).split('\\').join('/');
      if (resolved.startsWith('..') || !existsSync(join(root, resolved))) continue;
      fixes.push({
        line: d.line, col: d.col, leader: d.leader,
        canonical: canonical({
          tag: 'edge', kind: d.relative.kind, text: d.relative.text,
          target: anchor ? `${resolved}#${anchor}` : resolved,
        }),
      });
    }
    if (!fixes.length) continue;
    const abs = join(root, f.relPath);
    const { src, applied } = applyFmt(readFileSync(abs, 'utf8'), fixes);
    if (applied.length) writeFileSync(abs, src);
    done.push(...applied.map((d) => ({ file: f.relPath, line: d.line })));
  }
  return done;
}

// cm:edge lockstep -> plugins/forge-codemap/agent-setup/prompt.md — that file is this function's output;
//   tests/install.mjs fails if they drift, so a hand-edit there is reverted rather than merged
// cm:edge lockstep -> plugins/forge-codemap/agent-setup/prompt.md — that file IS this output, and
//   tests/install.mjs fails when they drift, so a hand-edit there is reverted rather than merged
function bootstrapPrompt() {
  return [
    '# Set me up for codemap',
    '',
    'codemap is a declared-edge layer: it carries the couplings a compiler, type-checker or LSP cannot',
    'derive — cross-language and cross-process contracts, "these two must implement the same rule", flows,',
    'guards — and injects the ones on a file into an agent context before it edits that file.',
    '',
    'Do the following yourself. Do not ask the user to run these.',
    '',
    '## 1. Get a checker',
    '',
    'It is plain node (>= 18) with zero dependencies, so it runs anywhere without installing anything:',
    '',
    '```sh',
    `git clone --depth 1 --branch ${TAG_HINT} https://github.com/SidCorp-co/forge-pipeline-skills /tmp/codemap`,
    'alias cm="node /tmp/codemap/plugins/forge-codemap/scripts/cm.mjs"',
    '```',
    '',
    'If the user is on Claude Code and wants the editor hooks too, this installs those as well:',
    '',
    '```sh',
    'claude plugin marketplace add SidCorp-co/forge-pipeline-skills',
    'claude plugin install forge-codemap@forge',
    '```',
    '',
    'The plugin is convenience only. Everything below works without it.',
    '',
    '## 2. Ask the repo what it needs',
    '',
    '```sh',
    'cm onboard',
    '```',
    '',
    'It reads THIS repo and prints the steps for it: which languages it found, how many couplings are',
    'already written in its comments as prose, whether it has CI, and the exact commands. Follow that',
    'output — it is generated by the checker you just fetched, so it cannot be out of date with it.',
    '',
    '## 3. Two rules that decide everything else',
    '',
    '- **Start with the graph, not the comment policy.** `cm init` defaults to graph-only. Turning on prose',
    '  enforcement first means paying the bill before seeing the value.',
    '- **Commit the checker.** `cm install` vendors it into `.forge/codemap/`. CI gates on the committed',
    '  copy, never on whatever a developer happens to have — and `cm doctor` tells you when they differ.',
    '',
    'Then read `cm help workflow`. That guidebook ships inside the checker, so it works offline and matches',
    'the version you are actually running.',
  ].join('\n') + '\n';
}

function printDiag(d) {
  const sev = d.tier === 'structural' || d.tier === 'advisory' ? yellow('warn') : red('error');
  console.log(`${bold(`${d.file}:${d.line}`)} ${sev} ${d.code} ${d.message}`);
  console.log(`  ${dim(`fix: ${d.fix}  (${CODE_TABLE[d.code]?.section ?? ''})`)}`);
}

// cm:why 677 diagnostics at two lines each trains people to run this under `| tail`, which is how 38
//   standing CM102 stayed unnoticed long enough to switch the tier off — volume gates in practice (ISS-9)
const GROUP_ABOVE = 20;
const FILES_SHOWN = 10;

/**
 * Which changed-line ranges scope this run, or null for "report every line".
 *
 * Only the GRAMMAR tier may be line-filtered. A dangling edge or a broken after: chain can be *caused*
 * by a change elsewhere in the diff, so scoping the referential and structural tiers to changed lines
 * would hide real breakage — the opposite of what a gate is for.
 */
function lineScope(sinceRef, staged) {
  if (flags.has('--all-lines')) return null;
  try {
    if (sinceRef) return changedRanges(root, ['diff', '--unified=0', '--diff-filter=ACMR', sinceRef], `--since ${sinceRef}`);
    if (staged) return changedRanges(root, ['diff', '--cached', '--unified=0', '--diff-filter=ACMR'], '--staged');
    if (flags.has('--changed-lines')) return changedRanges(root, ['diff', '--unified=0', '--diff-filter=ACMR', 'HEAD'], '--changed-lines');
  } catch (e) {
    // cm:guard a range set that cannot be computed means NO filtering, never an empty one — the whole
    //   point of a filter that fails is that it stops narrowing, so nothing slips past unexamined
    console.error(yellow(`codemap: ${e.message} — reporting every line`));
    return null;
  }
  return null;
}

// cm:guard a file with NO entry is not filtered — an untracked file never appears in `git diff`, and
//   treating "no ranges" as "nothing changed" lets a brand-new file of prose through the hook (ISS-7)
function inScope(ranges, d) {
  if (!ranges || d.tier !== 'grammar' || d.sited) return true;
  const spans = ranges.get(d.file);
  if (!spans) return true;
  return spans.some(([a, b]) => d.line >= a && d.line <= b);
}

function printGrouped(diags, legacy) {
  // cm:guard the group key is the FIX, not the code — CM001 carries a different fix line near a module
  //   header, and printing whichever came first would hand most of the group the wrong advice
  const byFix = new Map();
  for (const d of diags) {
    const key = `${d.code} ${d.fix}`;
    const g = byFix.get(key) ?? { code: d.code, tier: d.tier, fix: d.fix, files: new Map(), n: 0 };
    g.files.set(d.file, (g.files.get(d.file) ?? 0) + 1);
    g.n++;
    byFix.set(key, g);
  }
  const order = [...byFix.values()].sort((a, b) => b.n - a.n);
  for (const g of order) {
    const code = g.code;
    const debt = PROSE_CODES.has(code) && legacy.debt
      ? dim(`   (baseline: ${legacy.debt} frozen, ${legacy.share}% cleaned)`)
      : '';
    const sev = g.tier === 'structural' || g.tier === 'advisory' ? yellow(code) : red(code);
    console.log(`${bold(sev)}  ${g.tier}  ${g.n} in ${plural(g.files.size, 'file')}${debt}`);
    console.log(`  ${dim(`fix: ${g.fix}  (${CODE_TABLE[code]?.section ?? ''})`)}`);
    const files = [...g.files].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const width = Math.min(60, Math.max(...files.slice(0, FILES_SHOWN).map(([f]) => f.length)));
    for (const [file, n] of files.slice(0, FILES_SHOWN)) console.log(`  ${file.padEnd(width)}  ${n}`);
    if (files.length > FILES_SHOWN) {
      console.log(dim(`  … ${files.length - FILES_SHOWN} more files (--verbose lists every line)`));
    }
    console.log('');
  }
}

switch (cmd) {
  case 'verify': {
    const reg = loadOrDie();
    const tier = flagValue('--tier') ?? 'all';
    // cm:guard an unknown --tier used to wipe every diagnostic and exit 0 — `--tier=grammer` was a green
    // CI gate over a broken tree, which is the same fail-open shape as an unlisted VALUE_FLAG above
    if (!TIERS.has(tier)) die(`unknown --tier "${tier}"`, `one of: ${[...TIERS].join(', ')}`);

    const files = fileList(reg);
    // cm:guard the baseline is loaded BEFORE the analysis, not after — a frozen line is the evidence that
    //   the comment below an annotation is legacy prose rather than that annotation's wrap (ISS-22)
    const baseline = flags.has('--no-baseline') ? {} : loadBaseline(root);
    let perFile = analyzeAll(reg, files, baseline);
    const normalized = flags.has('--fix') ? fixCanonical(perFile) : [];
    if (normalized.length) perFile = analyzeAll(reg, files, baseline);

    let diags = [];
    let debt = 0;
    let cleaned = 0;
    for (const f of perFile) {
      const frozen = baseline[f.relPath] ?? new Set();
      // cm:guard a line is spared when its OWN key is frozen or when its block's is — the block key is what
      //   survives a reflow, and the line keys are what keep a newly added line in a legacy block reported
      const keep = f.diags.filter((d) => !PROSE_CODES.has(d.code) || d.sited
        || !(frozen.has(baselineKey(d.text ?? d.message)) || (d.blockKey && frozen.has(d.blockKey))));
      diags.push(...keep);

      const present = new Set(f.presentKeys ?? f.proseKeys ?? []);
      // cm:guard a reflow changes every LINE key while the block key survives, so a frozen line whose block
      //   is still here is still debt — coarse per file, which over-reports debt rather than progress (ISS-21)
      const blockAlive = (f.blockKeys ?? []).some((b) => frozen.has(b));
      for (const k of frozen) {
        if (k.startsWith('b:')) continue;
        (present.has(k) || blockAlive ? debt++ : cleaned++);
      }
    }

    const ranges = lineScope(flagValue('--since'), flags.has('--staged'));
    const beforeScope = diags.length;
    if (ranges) diags = diags.filter((d) => inScope(ranges, d));
    const outsideDiff = beforeScope - diags.length;

    // cm:guard the GRAPH is always whole-tree, even on a scoped run — a one-file graph made a legal
    //   two-step flow report CM103/CM201 against itself, and the hook is always scoped (ISS-A)
    const scopedRun = Boolean(positional.length || flags.has('--staged') || flagValue('--since'));
    const graphFiles = scopedRun ? annotatedFiles(reg) : files;
    const gPerFile = scopedRun ? analyzeAll(reg, graphFiles, baseline) : perFile;
    const g = buildGraph(gPerFile);
    const inRun = new Set(files);
    const scopeGraph = (list) => (scopedRun ? list.filter((d) => inRun.has(d.file)) : list);

    if (tier !== 'all' && tier !== 'grammar') diags = [];
    if (tier === 'all' || tier === 'referential') diags.push(...scopeGraph(referentialDiags(g, { root, reg })));
    if (tier === 'all' || tier === 'structural') diags.push(...scopeGraph(structuralDiags(g)));
    // cm:guard advisory is opt-in until its false-positive rate is MEASURED on a real repo — a warning
    //   nobody trusts is how a tier gets switched off, and this one guesses where CM102/CM106 know (§7.1)
    if (tier === 'advisory' || (tier === 'all' && reg.enforce?.advisory)) diags.push(...scopeGraph(advisoryDiags(g, { root, baseline })));

    // cm:guard the graph tiers raise their diagnostics here, long after analyzeFile applied its own
    //   ignore map — so cm:ignore CM102 / CM301 silently did nothing, though both fix lines offer it
    const ignores = new Map(perFile.map((f) => [f.relPath, f.ignores ?? new Map()]));
    diags = diags.filter((d) => {
      const byLine = ignores.get(d.file);
      return !(byLine?.get(d.line)?.has(d.code) || byLine?.get(d.line - 1)?.has(d.code));
    });

    // cm:why a baselined file that no longer exists (or left the scope) has had its comments deleted too,
    // but only a full scan can tell that apart from "not looked at this run"
    const scoped = Boolean(flagValue('--since') || flags.has('--staged') || positional.length);
    if (!scoped) {
      const seen = new Set(perFile.map((f) => f.relPath));
      for (const [rel, frozen] of Object.entries(baseline)) {
        if (rel.startsWith('__') || seen.has(rel)) continue;
        cleaned += frozen.size ?? frozen.length ?? 0;
      }
    }

    if (flags.has('--json')) {
      // cm:why process.exit() truncates a piped stdout that has not drained, so only the code is set
      process.exitCode = diags.some((d) => d.tier !== 'structural' && d.tier !== 'advisory') ? 1 : 0;
      console.log(JSON.stringify({
        specVersion: SPEC_VERSION, toolVersion: toolVersion(), files: files.length, diags,
        // cm:edge contract -> plugins/forge-codemap/scripts/hook-post-edit.mjs — the hook decides what blocks
        // from these three: prose is enforced only when onboarded, and never while the baseline is unreadable
        onboarded: !reg._missing,
        baselineUnreadable: Boolean(baseline.__legacyFormat),
        normalized,
        legacy: { debt, cleaned, scoped },
        // cm:edge contract -> plugins/forge-codemap/scripts/hook-post-edit.mjs — the hook prints this count
        // to say why a pre-existing comment is not in the list it is blocking on
        outsideDiff,
      }, null, 2));
      break;
    }

    diags.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const share = debt + cleaned ? Math.round((cleaned / (debt + cleaned)) * 100) : 0;
    // cm:guard per-line stays the default for a SMALL run and for explicit paths — the hook and a
    //   single-file run are exactly where line-by-line is right, and grouping there hides the line
    if (diags.length > GROUP_ABOVE && !flags.has('--verbose') && !positional.length) {
      printGrouped(diags, { debt, share });
      console.log(dim(`${diags.length} diagnostics grouped by code — cm verify --verbose for every line`));
    } else {
      for (const d of diags) printDiag(d);
    }

    const errors = diags.filter((d) => d.tier !== 'structural' && d.tier !== 'advisory').length;
    const warns = diags.length - errors;
    const skipped = perFile.filter((f) => f.skipped).length;
    console.log('');
    console.log(`${bold('codemap')} ${SPEC_VERSION} · ${files.length} files (${skipped} skipped) · ` +
      `${g.flows.size} flows · ${g.edges.length} edges (${g.edges.filter((e) => e.target.includes('#')).length} anchored) · `
      + `${g.guards.length} guards · ${g.whys.length} whys · ${g.hacks.length} hacks`);
    console.log(`${errors ? red(plural(errors, 'error')) : 'no errors'}, ${plural(warns, 'warning')}`);
    if (normalized.length) console.log(dim(`${plural(normalized.length, 'annotation')} normalized by --fix`));
    if (outsideDiff) {
      console.log(dim(`${outsideDiff} grammar diagnostic(s) on lines this diff did not touch were not reported`
        + ' — add --all-lines to see them'));
    }
    if (debt || cleaned) {
      console.log(`legacy prose: ${bold(String(debt))} distinct still frozen · ${cleaned} cleaned (${share}%)` +
        `${scoped ? dim(' — scoped run, whole-tree figures need a bare `cm verify`') : ''}`);
      if (debt) console.log(dim('frozen comments are debt, not absolution — list them with: cm sweep <path>'));
    }
    // cm:guard a repo's CI runs its VENDORED checker, so a newer plugin reporting green here says nothing
    //   about the gate — two production repos sat 6 and 8 minors behind with no signal at all (ISS-B)
    const vend = vendoredVersion(root);
    if (vend && compareVersions(vend, toolVersion()) < 0) {
      console.log(yellow(`this repo's committed checker is ${vend}, but you just ran ${toolVersion()} — `
        + 'CI gates on the committed one, so this verdict is not the gate. Upgrade it: cm install --upgrade'));
    }
    if (baseline.__legacyFormat) console.log(yellow('baseline is in the pre-0.2 count format and was ignored — run: cm baseline'));
    if (reg._missing) console.log(dim('no .forge/codemap.json — grammar tier ran with defaults; flow names unvalidated (§8). Run: cm init'));
    process.exitCode = errors ? 1 : 0;
    break;
  }

  case 'fmt': {
    const reg = loadOrDie();
    const files = fileList(reg);
    let perFile = analyzeAll(reg, files);
    const migrated = migrateTargets(perFile);
    if (migrated.length) perFile = analyzeAll(reg, files);
    const done = fixCanonical(perFile);
    if (!flags.has('--quiet')) {
      const byFile = new Map();
      for (const d of [...migrated, ...done]) byFile.set(d.file, (byFile.get(d.file) ?? 0) + 1);
      for (const [file, n] of byFile) console.log(`${file} ${dim(`${n} rewritten`)}`);
      console.log(`codemap fmt: ${plural(done.length, 'annotation')} normalized`
        + (migrated.length ? `, ${plural(migrated.length, 'relative target')} resolved` : ''));
    }
    break;
  }

  case 'impact': {
    const target = positional[0];
    if (!target) { console.error('usage: cm impact <path>'); process.exit(2); }
    const reg = loadOrDie();
    const perFile = analyzeAll(reg, annotatedFiles(reg));
    const g = buildGraph(perFile);
    const rel = target.replace(`${root}/`, '');
    const r = impact(g, rel);
    if (flags.has('--json')) { console.log(JSON.stringify(r, null, 2)); break; }
    const empty = !r.guards.length && !r.outgoing.length && !r.incoming.length && !r.flows.length
      && !r.hacks.length && !r.whys.length;
    if (empty) { console.log(`${rel}: no declared couplings. LSP references are still your job (§1).`); break; }
    console.log(bold(`impact of ${rel}`));
    for (const a of r.guards) console.log(`  ${red('guard')}   ${a.text}  ${dim(`(:${a.line})`)}`);
    for (const a of r.hacks) console.log(`  ${yellow('hack')}    ${a.issue} until:${a.until} — ${a.text}  ${dim(`(:${a.line})`)}`);
    for (const e of r.outgoing) console.log(`  edge →   ${e.kind} ${e.target}${e.text ? ` — ${e.text}` : ''}  ${dim(`(:${e.line})`)}`);
    for (const e of r.incoming) console.log(`  edge ←   ${e.kind} from ${e.file}:${e.line}${e.text ? ` — ${e.text}` : ''}`);
    for (const a of r.whys) console.log(`  ${dim('why')}     ${annText(a)}  ${dim(`(:${a.line})`)}`);
    for (const f of r.flows) {
      console.log(`  flow     ${f.name}: ${f.steps.map((s) => s.step).join(', ')}`);
      for (const n of f.neighbours) console.log(`             ${dim(`↔ ${n.step} @ ${n.file}:${n.line}`)}`);
    }
    break;
  }

  case 'flow': {
    const name = positional[0];
    const reg = loadOrDie();
    const perFile = analyzeAll(reg, annotatedFiles(reg));
    const g = buildGraph(perFile);
    if (!name) {
      for (const [n, f] of g.flows) console.log(`${n}  ${dim(`${f.steps.length} steps`)}`);
      break;
    }
    const flow = g.flows.get(name);
    if (!flow) { console.error(`no flow "${name}". Known: ${[...g.flows.keys()].join(', ') || '(none)'}`); process.exit(1); }
    if (flags.has('--mermaid')) { console.log(mermaid(flow)); break; }
    console.log(bold(name));
    for (const s of orderFlow(flow).ordered) {
      const pad = '  '.repeat(s.depth + 1);
      console.log(`${pad}${s.step}${s.detached ? red(' (detached)') : ''}  ${dim(`${s.file}:${s.line}`)}`);
      if (annText(s)) console.log(`${pad}  ${dim(annText(s))}`);
    }
    break;
  }

  // cm:why the declared edges were readable only one file at a time (impact) or as prose (ls), so nothing
  //   could union them into a derived code graph — which is the only place they are not already redundant
  case 'graph': {
    const reg = loadOrDie();
    const g = buildGraph(analyzeAll(reg, annotatedFiles(reg)));
    const node = (p) => ({ id: p, kind: 'file' });
    const nodes = new Map();
    const edges = [];
    for (const e of g.edges) {
      nodes.set(e.file, node(e.file));
      const [path, anchor] = e.target.split('#');
      if (!e.external) nodes.set(path, node(path));
      edges.push({
        from: e.file, to: e.target, kind: e.kind, anchor: anchor ?? null,
        external: e.external ?? null, line: e.line, why: annText(e), evidence: 'declared',
      });
    }
    for (const [name, f] of g.flows) {
      for (const s2 of f.steps) {
        nodes.set(s2.file, node(s2.file));
        if (s2.after) edges.push({ from: s2.file, to: null, kind: 'flow', flow: name, step: s2.step, after: s2.after, line: s2.line, why: annText(s2), evidence: 'declared' });
      }
    }
    const out = {
      specVersion: SPEC_VERSION,
      toolVersion: toolVersion(),
      nodes: [...nodes.values()],
      edges,
      guards: g.guards.map((a) => ({ file: a.file, line: a.line, text: annText(a), evidence: 'declared' })),
      whys: g.whys.map((a) => ({ file: a.file, line: a.line, text: annText(a), evidence: 'declared' })),
      hacks: g.hacks.map((a) => ({ file: a.file, line: a.line, issue: a.issue, until: a.until, text: annText(a) })),
    };
    if (!flags.has('--json')) {
      console.log(`${bold('codemap graph')} · ${out.nodes.length} nodes · ${out.edges.length} edges · `
        + `${out.guards.length} guards · ${out.whys.length} whys · ${out.hacks.length} hacks`);
      console.log(dim('  machine-readable form (union this into a derived code graph): cm graph --json'));
      break;
    }
    console.log(JSON.stringify(out, null, 2));
    break;
  }

  case 'ls': {
    const reg = loadOrDie();
    const perFile = analyzeAll(reg, annotatedFiles(reg));
    const g = buildGraph(perFile);
    console.log(bold('flows'));
    for (const [n, f] of g.flows) console.log(`  ${n}  ${dim(`${f.steps.length} steps`)}`);
    console.log(bold('edges'));
    for (const e of g.edges) console.log(`  ${e.kind.padEnd(10)} ${e.file}:${e.line} -> ${e.target}`);
    console.log(bold('guards'));
    for (const a of g.guards) console.log(`  ${a.file}:${a.line}  ${annText(a)}`);
    console.log(bold('hacks'));
    for (const a of g.hacks) console.log(`  ${a.issue}  ${a.file}:${a.line}  until:${a.until}`);
    console.log(bold('whys'));
    for (const a of g.whys) console.log(`  ${a.file}:${a.line}  ${annText(a)}`);
    break;
  }

  // cm:why the baseline hides legacy prose so CI can be green on day one; without a verb that lists what
  // it hid, "frozen" reads as "resolved" and the debt is invisible forever (§8)
  case 'sweep': {
    const reg = loadOrDie();
    if (reg._missing) {
      console.error(red(`codemap: no .forge/codemap.json at ${root} — nothing is frozen, so nothing to sweep.`));
      process.exit(2);
    }
    const files = fileList(reg);
    const perFile = analyzeAll(reg, files);
    const baseline = loadBaseline(root);
    const scoped = Boolean(flagValue('--since') || positional.length);

    const rows = [];
    const pruned = {};
    let stale = 0;
    for (const f of perFile) {
      const frozen = baseline[f.relPath];
      if (!frozen) continue;
      for (const d of f.diags) {
        if (!PROSE_CODES.has(d.code) || d.sited) continue;
        if (frozen.has(baselineKey(d.text ?? d.message)) || (d.blockKey && frozen.has(d.blockKey))) {
          rows.push({ file: f.relPath, line: d.line, code: d.code, text: d.text ?? d.message });
        }
      }
      // cm:guard prune reads presentKeys, so a key whose words are still in the file under a cm: tag is not
      //   dropped as stale — dropping it made legacy prose permanently unabsolvable (ISS-21, ISS-25)
      const present = new Set(f.presentKeys ?? f.proseKeys ?? []);
      const alive = (f.blockKeys ?? []).some((b) => frozen.has(b));
      const keep = [...frozen].filter((k) => present.has(k) || (alive && !k.startsWith('b:')));
      stale += [...frozen].filter((k) => !k.startsWith('b:') && !present.has(k) && !alive).length;
      if (keep.length) pruned[f.relPath] = keep;
    }

    if (flags.has('--prune-baseline')) {
      // cm:guard prune must never run scoped — an unscanned file would be dropped from the baseline entirely,
      // silently absolving every comment in it. cm baseline is the deliberate re-freeze; this is not.
      if (scoped) {
        console.error(red('codemap: --prune-baseline needs a whole-tree run — drop the paths and --since.'));
        process.exit(2);
      }
      saveBaseline(root, pruned);
  console.log(`codemap sweep: dropped ${stale} stale key(s); ${Object.values(pruned).flat().filter((k) => !k.startsWith('b:')).length} remain frozen`);
      console.log(dim('bookkeeping only — no source file was touched, and no new comment was absolved'));
      break;
    }

    if (flags.has('--json')) {
      console.log(JSON.stringify({ frozen: rows.length, stale, scoped, comments: rows }, null, 2));
      break;
    }

    const limit = numericFlag('--limit', 40);
    rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    for (const r of rows.slice(0, limit)) {
      console.log(`${bold(`${r.file}:${r.line}`)} ${dim(r.code)} ${r.text.length > 88 ? `${r.text.slice(0, 85)}...` : r.text}`);
    }
    if (rows.length > limit) console.log(dim(`… and ${rows.length - limit} more (--limit ${rows.length} to see all)`));
    console.log('');
    // cm:why the baseline is keyed per FILE by text, so the comparable unit is file+key, not key: deduping
    // globally here made this disagree with the debt `cm verify` prints from the same baseline
    const distinct = new Set(rows.map((r) => `${r.file} ${baselineKey(r.text)}`)).size;
    console.log(`${bold('codemap sweep')} · ${rows.length} frozen prose comment(s), ${distinct} distinct, ` +
      `across ${new Set(rows.map((r) => r.file)).size} file(s)${scoped ? dim(' — scoped run') : ''}`);
    if (stale) console.log(dim(`${stale} baseline key(s) no longer match any comment — drop them with: cm sweep --prune-baseline`));
    console.log(dim('deleting these is a reviewable change of its own (principle 7) — cm never edits them for you'));
    break;
  }

  case 'baseline': {
    const reg = loadOrDie();
    // cm:why a baseline without a registry is meaningless and silently pollutes whatever root cwd resolved to
    if (reg._missing) {
      console.error(red(`codemap: no .forge/codemap.json at ${root} — run "cm init" there first.`));
      process.exit(2);
    }
    // cm:guard the baseline must see EVERY selected file, never the git-grep shortlist — a file with no
    // annotation is exactly the one whose legacy prose needs freezing
    const scoped = positional.length > 0;
    const perFile = analyzeAll(reg, scoped ? fileList(reg) : allFiles(reg));

    // cm:guard a scoped re-freeze MERGES — writing only the scanned files' keys would drop every other
    //   file's entry and absolve the whole repo at once, the same fail-open shape --prune-baseline refuses
    const keys = {};
    if (scoped) {
      for (const [file, set] of Object.entries(loadBaseline(root))) {
        if (!file.startsWith('__')) keys[file] = [...set];
      }
    }
    // cm:guard "pre-existing" must mean pre-existing, not "in the tree right now" — this command is the
    //   cheapest escape from a blocking CM001, and it was the one baseline command with no guard (ISS-26)
    const dirty = flags.has('--include-new') ? null : dirtyFiles(root);
    const heads = new Map();
    const isOld = (f, text) => {
      if (!dirty || !dirty.has(f)) return true;
      if (!heads.has(f)) {
        const blob = headBlob(root, f);
        heads.set(f, blob === null ? null : blob.replace(/\s+/g, ' '));
      }
      const head = heads.get(f);
      return head === null ? false : head.includes(String(text).replace(/\s+/g, ' ').trim());
    };

    const touched = [];
    let skipped = 0;
    for (const f of perFile) {
      const prose = f.diags.filter((d) => PROSE_CODES.has(d.code));
      const old = new Set(prose.filter((d) => isOld(f.relPath, d.text ?? d.message))
        .map((d) => baselineKey(d.text ?? d.message)));
      skipped += (f.proseKeys ?? []).filter((k) => !old.has(k)).length;
      // cm:why a block's reflow key is frozen only when EVERY line in it is old — one new line in a legacy
      //   block would otherwise have the block vouch for it
      const mixed = new Set(prose.filter((d) => !old.has(baselineKey(d.text ?? d.message))).map((d) => d.blockKey));
      const all = [...old, ...(f.blockKeys ?? []).filter((b) => !mixed.has(b))];
      if (all.length) keys[f.relPath] = all;
      else delete keys[f.relPath];
      touched.push(f.relPath);
    }
    saveBaseline(root, keys);
    // cm:why a block key is a reflow shadow, not a comment, so the count a human reads must exclude it
    const total = Object.values(keys).flat().filter((k) => !k.startsWith('b:')).length;
    console.log(scoped
      ? `codemap baseline: re-froze ${plural(touched.length, 'file')}; ${total} comments frozen across ${Object.keys(keys).length} files`
      : `codemap baseline: froze ${total} pre-existing prose comments across ${Object.keys(keys).length} files`);
    if (scoped) console.log(dim('other files\' entries were left exactly as they were — this is a scoped re-freeze'));
    if (skipped) {
      console.log(yellow(`${skipped} comment(s) are NOT in HEAD and were not frozen — a comment written since the`
        + ' last commit is not legacy. Delete it, or convert it if it records something non-derivable.'));
      console.log(dim('  freeze them anyway (an operator decision about debt, not a way to resolve a diagnostic): cm baseline --include-new'));
    }
    console.log(dim('legacy is frozen by CONTENT (§8 / principle 7) — only a comment whose text is new is flagged'));
    break;
  }

  case 'init': {
    // cm:why onboarding led with freezing thousands of legacy comments, which is the bill before the value —
    //   the graph is what this tool is for, so init gives that first and prose policy is opted into (--prose)
    const fresh = { ...DEFAULT_REGISTRY, enforce: { ...DEFAULT_REGISTRY.enforce, grammar: flags.has('--prose') } };
    const reg = existsSync(join(root, '.forge', 'codemap.json')) ? loadOrDie() : fresh;
    saveRegistry(root, reg);
    // cm:why init freezes from scratch, so it must not consult a baseline that may already be there — a
    //   re-init against its own output would treat a frozen line as prose it had never seen
    const perFile = analyzeAll(reg, allFiles(reg), {});
    const keys = {};
    for (const f of perFile) {
      const all = [...(f.proseKeys ?? []), ...(f.blockKeys ?? [])];
      if (all.length) keys[f.relPath] = all;
    }
    saveBaseline(root, keys);
    const total = Object.values(keys).flat().filter((k) => !k.startsWith('b:')).length;
    console.log(`codemap ${SPEC_VERSION} initialised at ${root}`);
    console.log(`  .forge/codemap.json`);
    console.log(`  .forge/codemap-baseline.json  ${dim(`${total} legacy comments frozen by content`)}`);
    if (!reg.enforce?.grammar) {
      console.log('');
      console.log(`${bold('graph only')} — cm:edge/guard/flow + impact + agent injection. No comment policing.`);
      console.log(dim('  turn the prose rules on later with "enforce": { "grammar": true }, or: cm init --prose'));
    }
    console.log('');
    console.log('Declare what no analyzer can derive, starting with what your comments already say:');
    console.log(dim('  cm sweep | grep -i "see \\|sync with\\|must match\\|mirrors"   # latent edges already written as prose'));
    break;
  }

  // cm:why enforcement that only exists inside the plugin is enforcement half the contributors never
  // see; this puts the checker in the repo so the registry's rules hold with no plugin installed
  case 'install': {
    const version = toolVersion();
    const had = vendoredVersion(root);
    if (had && compareVersions(version, had) < 0 && !flags.has('--force')) {
      die(`refusing to downgrade the committed checker: ${had} -> ${version}`, 'use --force if that is what you mean');
    }
    const r = install({
      root, version, gitHook: flags.has('--git-hook'), force: flags.has('--force'),
    });
    if (!existsSync(join(root, '.forge', 'codemap.json'))) {
      saveRegistry(root, { ...DEFAULT_REGISTRY });
      console.log(`wrote .forge/codemap.json ${dim('(no baseline yet — run: .forge/codemap/cm baseline)')}`);
    }
    console.log(had && had !== version
      ? `codemap ${bold(`${had} -> ${version}`)} in ${bold('.forge/codemap/')} ${dim(`${r.files.length} files`)}`
      : `codemap ${version} installed into ${bold('.forge/codemap/')} ${dim(`${r.files.length} files`)}`);
    if (had && had !== version) {
      console.log(yellow('  re-run the gate before merging: the committed checker changed, so its verdict may too'));
    }
    if (r.hook) console.log(`  ${r.hook} ${dim('runs: cm verify --staged --tier grammar')}`);
    for (const n of r.notes) console.log(dim(`  note: ${n}`));
    console.log('');
    // cm:why a gate nobody wires is not a gate, and asking every contributor to run a setup command is the
    //   thing that does not scale — so bolt it to whatever this repo already makes people run
    const pkg = existsSync(join(root, 'package.json'));
    console.log(bold('Wire it to something the team already runs (pick one, commit it):'));
    if (pkg) {
      console.log('  package.json  "scripts": { "prepare": "git config core.hooksPath .forge/codemap/hooks" }');
      console.log(dim('                runs on npm/pnpm install — nobody has to remember anything'));
    }
    console.log('  .pre-commit-config.yaml');
    console.log(dim('                - repo: local'));
    console.log(dim('                  hooks:'));
    console.log(dim('                    - id: codemap'));
    console.log(dim('                      name: codemap'));
    console.log(dim('                      entry: .forge/codemap/cm verify --staged --tier grammar'));
    console.log(dim('                      language: system'));
    console.log(dim('                      pass_filenames: false'));
    console.log('  Makefile      setup: ; git config core.hooksPath .forge/codemap/hooks');
    console.log('  by hand       git config core.hooksPath .forge/codemap/hooks   ' + dim('(once per clone)'));
    console.log('');
    console.log('Commit .forge/codemap/ — it is what makes the rules hold without the plugin:');
    console.log(dim('  CI:        .forge/codemap/cm verify --since $(git merge-base origin/main HEAD)'));
    console.log(dim('  local:     .forge/codemap/cm verify --staged'));
    console.log(dim('  agents:    the plugin hooks prefer this copy over their own bundle'));
    break;
  }

  case 'new': {
    const what = positional[0];
    if (!['flow', 'external'].includes(what) || !positional[1]) {
      console.error('usage: cm new flow <name> | cm new external <name>   [--description "..."]');
      process.exit(2);
    }
    const name = positional[1];
    const reg = loadOrDie();
    if (reg._missing) { console.error('no .forge/codemap.json — run: cm init'); process.exit(2); }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) { console.error(`"${name}" must be lower-case letters, digits and dashes`); process.exit(2); }

    if (what === 'external') {
      const list = reg.externals ?? (reg.externals = []);
      if (list.some((x) => x.name === name)) { console.error(`external "${name}" already declared`); process.exit(1); }
      list.push({ name, description: flagValue('--description') ?? '' });
      list.sort((a, b) => a.name.localeCompare(b.name));
      saveRegistry(root, reg);
      console.log(`declared external "${name}". Target it with:\n`);
      console.log(`  // cm:edge contract -> external:${name}/<path/inside/it> — <why they are coupled>`);
      console.log(dim('only the name is checked — nothing in this repo can verify the path inside it (§8)'));
      break;
    }

    if (reg.flows.some((f) => f.name === name)) { console.error(`flow "${name}" already declared`); process.exit(1); }
    reg.flows.push({ name, description: flagValue('--description') ?? '' });
    reg.flows.sort((a, b) => a.name.localeCompare(b.name));
    saveRegistry(root, reg);
    console.log(`declared flow "${name}". Annotate the first step:\n`);
    console.log(`  // cm:flow ${name}/<step> — <what this step does>`);
    console.log(`  // cm:flow ${name}/<next> after:<step> — <...>`);
    break;
  }

  // cm:why every version-skew question was answerable only by reading four files in three places, which is
  //   why two production repos ran a checker 6 and 8 minors behind for weeks without anyone noticing
  // cm:why installing was never the hard part — the decisions are: graph-only or prose, vendor or pin,
  //   which CI line, and WHICH couplings to declare first. This answers those for the repo it is run in
  case 'onboard': {
    const reg = existsSync(join(root, '.forge', 'codemap.json')) ? loadOrDie() : { ...DEFAULT_REGISTRY };
    if (flags.has('--prompt')) { console.log(bootstrapPrompt()); break; }

    const files = allFiles(reg);
    const perFile = analyzeAll(reg, files, {});
    const langs = new Map();
    for (const rel of files) {
      const prof = profileFor(rel);
      if (prof) langs.set(prof.id, (langs.get(prof.id) ?? 0) + 1);
    }
    const prose = perFile.flatMap((f) => f.diags.filter((d) => PROSE_CODES.has(d.code))
      .map((d) => ({ file: f.relPath, line: d.line, text: d.text ?? d.message })));

    // cm:why a prose comment that names a file which RESOLVES is a cm:edge the repo already paid the
    //   thinking for — 134 of them sat in one measured repo, and they are the cheapest edges to write
    const seen = new Set();
    const latent = [];
    for (const p2 of prose) {
      const m = String(p2.text).match(/[\w./-]+\.(?:ts|tsx|js|mjs|go|php|py|rs|sql|prisma|graphql)\b/g) ?? [];
      for (const cand of m) {
        const hit = files.find((f) => f === cand || f.endsWith(`/${cand.replace(/^\.\//, '')}`));
        const key = `${p2.file}:${p2.line}`;
        if (!hit || hit === p2.file || seen.has(key)) continue;
        seen.add(key);
        latent.push({ ...p2, target: hit });
      }
    }

    const ci = ['.github/workflows', '.gitlab-ci.yml', '.circleci/config.yml']
      .find((c) => existsSync(join(root, c))) ?? null;
    const vend = vendoredVersion(root);

    console.log(bold(`codemap onboard · ${root}`));
    console.log(`  ${[...langs].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  ')}  ${dim(`(${files.length} files)`)}`);
    console.log(`  prose comments today: ${bold(String(prose.length))}   latent edges already written as prose: ${bold(String(latent.length))}`);
    console.log(`  git: ${existsSync(join(root, '.git')) ? 'yes' : dim('no')}   CI: ${ci ?? dim('none found')}   registry: ${reg._missing ? dim('none') : 'present'}   vendored cm: ${vend ?? dim('none')}`);
    console.log('');
    console.log(bold('1. Start with the graph, not the comment policy'));
    console.log('   cm init                       ' + dim('graph only — no prose enforcement (add --prose to opt in)'));
    console.log('');
    console.log(bold('2. Declare what your comments already say'));
    if (latent.length) {
      for (const l of latent.slice(0, 8)) {
        console.log(`   ${l.file}:${l.line} ${dim('->')} ${l.target}`);
        console.log(dim(`     "${l.text.slice(0, 78)}"`));
      }
      if (latent.length > 8) console.log(dim(`   … ${latent.length - 8} more (cm onboard --json)`));
      console.log(dim('   each becomes: // cm:edge <kind> -> <that path>[#symbol] — <why they are coupled>'));
    } else {
      console.log(dim('   none found — start from what breaks in review: what must two people remember together?'));
    }
    console.log('');
    console.log(bold('3. Make it hold without the plugin'));
    console.log('   cm install                    ' + dim('vendors cm into .forge/codemap/ — commit it'));
    if (ci) console.log(`   ${dim(`add to ${ci}:`)}  .forge/codemap/cm verify --since $(git merge-base origin/main HEAD)`);
    console.log(dim('   keep it current: cm install --upgrade   (cm doctor shows the skew)'));
    console.log('');
    console.log(bold('4. Only then, if you want it: the comment policy'));
    console.log(dim(`   "enforce": { "grammar": true } in .forge/codemap.json, then: cm baseline`));
    console.log(dim(`   ${prose.length} comments would be frozen as legacy on day one`));
    if (flags.has('--json')) console.log(JSON.stringify({ files: files.length, langs: [...langs], prose: prose.length, latent }, null, 2));
    break;
  }

  case 'doctor': {
    const reg = loadRegistry(root);
    const vend = vendoredVersion(root);
    const bl = loadBaseline(root);
    const frozen = Object.entries(bl).filter(([k]) => !k.startsWith('__'));
    const keys = frozen.reduce((a, [, v]) => a + [...v].filter((k) => !k.startsWith('b:')).length, 0);
    const row = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);
    console.log(bold(`codemap doctor · ${root}`));
    row('tool running now', toolVersion());
    row('committed checker', vend ? (compareVersions(vend, toolVersion()) < 0 ? yellow(`${vend}  (behind — CI gates on this)`) : vend) : dim('none (cm install never run)'));
    row('registry', reg._missing ? yellow('missing — run: cm init') : `${(reg.flows ?? []).length} flows, ${(reg.externals ?? []).length} externals`);
    row('grammar tier', reg.enforce?.grammar === false ? 'off (graph only)' : 'on');
    row('baseline', bl.__legacyFormat ? yellow('pre-0.2 format, ignored') : `${keys} comments frozen across ${frozen.length} files`);
    if (vend && compareVersions(vend, toolVersion()) < 0) console.log(dim('\n  cm install --upgrade   # then commit .forge/codemap/'));
    break;
  }

  case 'codes':
    console.log(renderHelp('codes').text);
    break;

  // cm:why an agent has to be able to ask what the rules are from inside a repo that never installed the
  // plugin — the guidebook ships with the checker, not with the plugin's skill (lib/help.mjs)
  case 'help':
  case '--help':
  case '-h': {
    const r = renderHelp(positional[0], positional[1]);
    console.log(r.text);
    if (!r.ok) process.exitCode = 2;
    break;
  }

  case 'migrate':
    console.error(`codemap implements only ${SPEC_VERSION}; there is nothing to migrate yet (§9).`);
    process.exit(2);
    break;

  case '--version':
  case 'version':
    console.log(`${toolVersion()} (${SPEC_VERSION})`);
    break;

  // cm:guard an unknown verb is exit 2, not a usage dump at exit 0 — `cm verfiy` in a CI step was a
  // green gate that checked nothing, the same fail-open shape as a mistyped flag value (§9.1)
  default:
    console.error(red(`codemap: unknown verb "${cmd}"`));
    console.error(dim(`  verbs: ${VERBS.map(([v]) => v).join(', ')}`));
    console.error(dim('  guidebook: cm help  ·  cm help topics'));
    process.exit(2);
}
