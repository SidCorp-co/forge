// @generated codemap 0.13.0 — vendored by `cm install`; edit the plugin, not this.
// `cm help` — the guidebook, shipped inside the tool.
//
// It lives here rather than in the plugin's skill because the checker is what a project vendors
// (`cm install`): a contributor or agent working in a repo with no plugin installed still has to be able
// to ask what the rules are. A guide that only ships with the plugin is a guide half the users cannot read.
//
// Almost nothing here is written twice. The verb list, the diagnostics, the tags, the edge kinds, the
// language policies and the registry defaults are all rendered from the same constants the code runs on,
// so help cannot drift from behaviour — the framework's own rule (§1.1) applied to its own docs. What is
// hand-written is only what no constant holds: when to reach for an annotation, and what not to do. The
// contract itself is not copied at all; `cm help spec` slices the SPEC.md that `cm install` vendors.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAGS, EDGE_KINDS, CODE_TABLE } from './parse.mjs';
import { PROFILES } from './languages.mjs';
import { DEFAULT_REGISTRY, SPEC_VERSION } from './registry.mjs';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** codemap/1 §4 — one row per verb, and the only list of them: `cm help` and the usage text share it. */
export const VERBS = [
  ['init', '', 'write .forge/codemap.json + freeze existing comments as a baseline'],
  ['install', '[--upgrade] [--git-hook] [--force]', 'vendor cm into .forge/codemap/ so the rules hold with no plugin'],
  ['verify', '[paths...]', 'all three tiers  [--since <ref>] [--staged] [--tier T] [--fix] [--json] [--no-baseline] [--verbose] [--all-lines]'],
  ['fmt', '[paths...]', 'normalize annotations to canonical form (the tool owns the format)'],
  ['impact', '<path>', 'declared blast radius of a file: guards, edges both ways, flow neighbours  [--json]'],
  ['flow', '[name]', 'ordered trace of a flow across files and languages  [--mermaid]'],
  ['ls', '', 'every annotation in the repo'],
  ['graph', '', 'the whole declared graph, for another tool to consume  [--json]'],
  ['sweep', '[paths...]', 'list the prose the baseline is hiding  [--limit N] [--json] [--prune-baseline]'],
  ['baseline', '[paths...]', 're-freeze legacy prose by content hash; a path scopes it and MERGES  [--include-new]'],
  ['new flow', '<name>', 'declare a flow before annotating its steps  [--description "..."]'],
  ['new external', '<name>', 'declare an out-of-tree system a cm:edge may target  [--description "..."]'],
  ['onboard', '', 'read this repo and print the setup steps for it  [--json] [--prompt]'],
  ['doctor', '', 'versions, registry, baseline — and whether CI gates on an older checker'],
  ['codes', '', 'diagnostic reference (same as: cm help codes)'],
  ['help', '[topic]', 'this guidebook'],
  ['version', '', 'tool version + spec version'],
];

const pad = (s, n) => String(s).padEnd(n);

function table(rows, gap = 2) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : pad(c, widths[i]))).join(' '.repeat(gap)).trimEnd());
}

function specPath() {
  return [resolve(SCRIPTS, '..', 'SPEC.md'), join(SCRIPTS, 'SPEC.md')].find((p) => existsSync(p)) ?? null;
}

function verbs() {
  return [
    'VERBS',
    '',
    ...table(VERBS.map(([v, a, d]) => [`  cm ${v}`, a, d])),
  ].join('\n');
}

function overview() {
  return `cm — codemap/${SPEC_VERSION.split('/')[1]}

Carries the couplings NO tool can derive — cross-language contracts, cross-process flows, edit-time
invariants — as one-line cm: annotations, and hands them to whoever edits the file. Killing comment
spam is the side effect, from one rule: if a tool can derive it, you may not write it.

  LSP derives references. Types derive shapes. Paths derive modules. git derives history.
  CodeMap carries the complement, and nothing else.

WHERE IT RUNS

  before an edit   PreToolUse hook  -> cm impact <file>            injects guards/edges/flow steps
  after an edit    PostToolUse hook -> cm verify --fix <file>      normalizes, then blocks on violations
  in CI            cm verify --since <ref>                         all three tiers
  on commit        cm verify --staged                              grammar tier only

  All four run the SAME checker. A repo that ran \`cm install\` owns it: .forge/codemap/cm wins over a
  cm on PATH, which wins over the plugin's bundled copy. The plugin is a convenience, never authority.

${verbs()}

TOPICS  (cm help <topic>)

${table(Object.entries(TOPIC_BLURBS).map(([t, d]) => [`  ${t}`, d])).join('\n')}`;
}

const TOPIC_BLURBS = {
  annotations: 'the five tags, their syntax, and which one to reach for',
  codes: 'every diagnostic: tier, section, cause, fix',
  baseline: 'how legacy prose is frozen, and how the total is allowed to fall',
  languages: 'per-language comment policy — why this survives a Go or Laravel repo',
  config: '.forge/codemap.json: every knob, and the three adoption modes',
  ci: 'exit codes, scoping a run, gating a commit',
  workflow: 'what to do before an edit, and how to answer a block',
  principles: 'when an annotation is earned, and what not to do',
  spec: 'the contract itself — cm help spec [§N] slices SPEC.md',
  verbs: 'the verb table on its own',
};

function annotations() {
  const consumers = {
    flow: 'cm flow -> ordered trace + mermaid',
    edge: 'cm impact -> blast radius',
    guard: 'PreToolUse -> injected before an edit',
    hack: 'cm verify -> stale-workaround check',
    why: 'none — read in place',
  };
  const forms = {
    flow: '<leader> cm:flow  <flow>/<step> [after:<step>] [— <text>]',
    edge: '<leader> cm:edge  <kind> -> <target> [— <text>]',
    guard: '<leader> cm:guard <text>',
    hack: '<leader> cm:hack  ISS-<n> until:<condition> — <text>',
    why: '<leader> cm:why   <text>',
  };
  const pick = [
    ['  whoever edits this must obey a condition', 'cm:guard'],
    ['  a coupling nothing links', 'cm:edge'],
    ['  this code is a step of a named runtime flow', 'cm:flow'],
    ['  a live workaround with an exit condition', 'cm:hack'],
    ['  non-obvious rationale, no tool consumes it', 'cm:why'],
  ];

  return `ANNOTATIONS

Exactly ${TAGS.length} tags. The set is the size of the set of distinct consumers — a tag exists only if
something consumes it and the payoff lands in the same session.

${table(TAGS.map((t) => [`  cm:${t}`, consumers[t]])).join('\n')}

FORM

${TAGS.map((t) => `  ${forms[t]}`).join('\n')}

  <leader>  the language's line-comment leader: // , # or --  (line comments ONLY — inside a
            /* */ or /** */ block it is CM003, so no other toolchain ever parses a cm: line)
  <kind>    ${EDGE_KINDS.join(' | ')}
  <target>  repo-relative path, optionally path#symbol. Absolute paths, URLs and ../ or ./ are
            CM005 — a target resolves from the REPO ROOT, never from this file. cm fmt rewrites a
            ../ target that resolves. The #symbol must be present in the target file, or CM106.
            external:<name>/<path> targets a system OUTSIDE the tree (a migration's original, a
            service in another repo). The name must be declared — cm new external <name> — and that
            is ALL that is checked: nothing here can see the path inside it.
  ->        ASCII, it sits in the machine-parsed position. — separates prose; - and -- are
            accepted on input and normalized by cm fmt.

  ONE LINE, ONE ANNOTATION. Only the annotation's own line is parsed.
  A wrap is ONE line: the single standalone comment directly below, same leader, is its
  continuation. A second such line is prose again. cm impact / cm flow / cm ls render the
  annotation and its wrap as one sentence; cm fmt still rewrites only the annotation's own line.
  Ordering in a flow comes from after:, never from numbers, so inserting a step renumbers nothing.

WHICH ONE

${table(pick).join('\n')}

  Multi-line rationale goes in the MODULE HEADER (first comment run, followed by a blank line,
  before any code — a shebang and a "use client"/"use server"/"use strict" directive may precede it).
  One-line rationale at a call site is cm:why. There is no cm:todo — the tracker owns outstanding
  work; file an issue at draft instead (CM010).

  cm:flow needs its flow declared first: cm new flow <name>. Steps are never declared — they are
  derived from the code.`;
}

function codes() {
  const rows = Object.entries(CODE_TABLE).map(([code, v]) => [`  ${code}`, v.tier, v.section, v.message]);
  return `DIAGNOSTICS

Tier decides where it runs: grammar in the edit hook (blocking) and everywhere; referential and
structural in CI; advisory is warning-only, cannot change the exit code, and is off unless asked for
(--tier advisory, or enforce.advisory). Every code has a cause, a fix and a § pointer.

${table(rows).join('\n')}

  Last resort, on the line above:  <leader> cm:ignore <CODE> — <reason>
  Both the code and the reason are mandatory; a bare ignore is itself an error.`;
}

function baseline() {
  return `BASELINE — how legacy is handled

\`cm init\` freezes every prose comment that already exists, BY CONTENT: per file, a hash of each
normalized comment text. So a legacy repo is green on day one, and only a comment whose TEXT is new
gets flagged. Reformatting, moving code and deleting old comments are all free.

  Counting comments per file was the first design and it failed: adding three lines to a file with
  eighty frozen comments surfaced all eighty, because a count cannot say WHICH comment is new.

  A pre-0.2 count-format baseline is detected, ignored and reported — never silently trusted. While
  it is unreadable prose is NOT enforced at all: nothing can tell new prose from legacy, and blocking
  an author for a comment they did not write is the wrong half of the trade. Fix: cm baseline.

  A reflow is free: beside each line's key sits a block key over the whole comment run, and that one
  survives re-wrapping. Relabeling is NOT progress — the words a cm: tag carries still count as present,
  so the debt line only falls when a comment is deleted or genuinely reworded.

  cm baseline refuses to freeze a comment that is not in git HEAD. Freezing what you wrote a minute ago
  is not onboarding legacy, it is clearing a diagnostic; --include-new does it anyway and says so.

THE ONE EXCEPTION, or the total never falls

Prose sharing a comment block with a cm: annotation is NOT frozen — it is reported regardless of the
baseline. Annotating a site means you have just read it, so the noise there is yours. Prose you never
touched stays frozen.

  Contiguous standalone comment lines form one block. A trailing comment on a code line does not.
  CM011 is excluded: it measures a header's length, not one comment's text, so no site can own it.

  A frozen key is dropped only when its text is GONE from the file. Sited prose is still in the file,
  so it stays frozen — the annotation that sited it may be removed later.

DEBT, NOT ABSOLUTION

  cm verify                  prints "N distinct still frozen · M cleaned" on every run
  cm sweep [paths...]        lists exactly what the baseline is hiding
  cm sweep --prune-baseline  drops keys that match nothing (whole-tree only; edits no source file)
  cm baseline                re-freeze from scratch

Legacy is frozen, never migrated. Mass-deleting old comments is a separate, reviewable change, and
cm will not do it for you.`;
}

function languages() {
  const rows = Object.values(PROFILES).map((p) => [
    `  ${p.id}`,
    p.lineLeaders.join(' '),
    p.docPolicy,
    p.enforce === false ? 'enforcement off' : '',
  ]);
  return `LANGUAGES

docPolicy decides what happens to ORDINARY comments. It is what lets this be dropped into an
ecosystem whose convention is the opposite of "few comments" without being uninstalled on day one.

  banned                a prose comment is CM001
  allowed               prose is accepted; only cm: grammar is enforced
  required-on-exported  only a run directly above the package clause or an EXPORTED declaration is exempt

${table(rows).join('\n')}

  TS/JS:  /** */ doc blocks are exempt ANYWHERE — the IDE surfaces them on hover, a consumer with an
          immediate payoff. /* */ is not a doc block and is prose. Narration inside a function body,
          the spam this exists to kill, is always a line comment.
  Go:     godoc and revive require a comment above every exported declaration, so position decides.
  PHP:    PHPStan/Psalm/Laravel docblocks are load-bearing. vendor/ and _ide_helper* are excluded.
  Python: docstrings are strings, not comments — out of scope by construction.
  Rust:   // SAFETY: is exempt; clippy requires it.

Every compiler and linter pragma is exempt in every language (@ts-*, eslint, biome, noqa, phpcs,
go:build, clippy::, shellcheck …). A file marked generated in its first lines is skipped entirely.

Override per language in .forge/codemap.json — see: cm help config`;
}

function config() {
  const d = DEFAULT_REGISTRY;
  return `CONFIG — .forge/codemap.json

JSON so the whole framework runs on a bare node with zero dependencies. Validates against
schema/codemap.schema.json. No registry ⇒ prose enforcement is OFF: the plugin can be installed once
machine-wide and no un-onboarded tree is ever blocked. Onboarding is a per-repo decision.

{
  "specVersion": "${SPEC_VERSION}",
  "flows":    [{ "name": "job-dispatch", "description": "issue → dispatched job" }],
  "enforce":  { "grammar": true, "include": ["**"], "exclude": [...], "headerMaxLines": 20 },
  "languages": { "sql": { "enforce": true }, "go": { "docPolicy": "allowed" } }
}

  specVersion      checked by every command; a tool older than the registry refuses to run
  flows            closes the vocabulary of flow NAMES so a typo cannot fork the graph (CM101).
                   Steps are never declared here — they are derived from the code.
  enforce.grammar  master switch for the PROSE family (CM001/CM010/CM011) only
  enforce.include  default ${JSON.stringify(d.enforce.include)}
  enforce.exclude  default has ${d.enforce.exclude.length} entries (node_modules, dist, vendor, worktrees, …).
                   .forge/codemap/**, node_modules and .git are excluded unconditionally on top.
  headerMaxLines   default ${d.enforce.headerMaxLines ?? 20}; beyond it a module header is CM011
  languages.<id>   per-language { enforce, docPolicy } — ids: ${Object.keys(PROFILES).join(', ')}

THREE ADOPTION MODES

  graph only     "enforce": { "grammar": false }
                 cm:edge/guard/flow + impact + injection. No comment policing. Malformed
                 ANNOTATIONS are still errors (CM002–CM009) — that part is never optional.
  + discipline   the default. Prose that a tool could derive is blocked.
  + flows        declare flows and get cm flow, mermaid, and the referential/structural tiers.

Each is useful without the next. Start at whichever one you will actually keep.`;
}

function ci() {
  return `CI AND COMMITS

EXIT CODES — the 1/2 split is load-bearing

  0   the gate ran; nothing but structural warnings
  1   the gate ran and found violations
  2   the gate COULD NOT RUN — bad flag, unknown --tier, unresolvable --since, path matching nothing

Never treat 2 as a pass: it means nothing was checked. Every fail-open bug this tool has shipped had
one shape — a broken invocation producing an empty scope and a green summary.

SCOPING A RUN

  cm verify                          whole tree
  cm verify --since <ref>            files changed against a ref (ACMR), grammar tier scoped to the
                                     CHANGED LINES — referential and structural are never line-scoped,
                                     since a dangling edge can be caused by a change elsewhere
  cm verify --since <ref> --all-lines   every line of every changed file
  cm verify --staged                 staged files only — what a pre-commit hook must gate
  cm verify <paths...>               explicit paths; resolved against the CWD first, then the repo root
  cm verify --tier grammar           one tier: all | grammar | referential | structural | advisory
  cm verify --tier advisory          warning-only evidence check (CM301), off in --tier all unless
                                     the registry sets enforce.advisory — see §7.1 for why

READING A BIG RUN

  Above 20 diagnostics a whole-tree run groups by code and prints each fix ONCE, worst code first,
  with the files that carry it. Per-line output is kept for a small run and whenever explicit paths
  are passed — the hook and a single-file run are where the line number is the point.
  cm verify --verbose               every line, however many there are
  --json is never grouped: tools consume it.

RECIPES

  CI            .forge/codemap/cm verify --since $(git merge-base origin/main HEAD)
  CI (no vendor) git clone --depth 1 --branch codemap-v<x.y.z> <repo> /tmp/cm
                 node /tmp/cm/plugins/forge-codemap/scripts/cm.mjs verify   (pin a TAG, never a branch)
  staying current  cm doctor  ·  cm install --upgrade  ·  agent-setup/codemap-upgrade.yml opens the PR
  pre-commit    .forge/codemap/cm verify --staged --tier grammar     (cm install --git-hook writes it)
  agent-side    cm verify --fix --json <file>                        what the PostToolUse hook runs

  In a shallow clone the base ref is often not fetched — that is an exit 2, not a clean tree.
  git fetch --deepen 50 (or fetch-depth: 0) before the gate.

  --json adds: onboarded, baselineUnreadable, normalized, legacy{debt,cleaned,scoped} — enough for a
  caller to decide what blocks without re-implementing the baseline.`;
}

function workflow() {
  return `WORKFLOW — using this correctly as an agent

BEFORE YOU CHANGE A FILE

  cm impact <path>      guards you must honour, edges whose other side may need the same change,
                        the flow steps this file owns and their neighbours.
  Then LSP references for the symbols involved — that half is the compiler's job, not this tool's.
  Report the union, and say which half came from declarations and which from the LSP: one is a human
  promise, the other is compiler truth.

WHEN AN EDIT IS BLOCKED

  Read the code and its fix line, not just the message. Then, in order of how often it is right:

  CM001  delete the comment. It is the answer almost every time — the compiler, the types, the path
         or the LSP already states it. Convert it ONLY if it records something none of them can:
         then it is cm:why (rationale) or cm:guard (something whoever edits this must know).
  CM010  do NOT convert a TODO into cm:hack to silence it. File an issue at draft. cm:hack is only
         for a workaround that is in the code right now, and it needs until:<what would remove it>.
  CM009  already fixed for you — the hook normalized it before reporting. Never retype it by hand.
  CM002-8 the annotation is malformed: cm help annotations has the exact form.
  CM011  a header orients a reader in a few lines; move the rest to docs/ and leave a pointer.

  The frozen count in the message is not your problem — those comments predate you. Only the listed
  ones are yours.

  Last resort: cm:ignore <CODE> — <reason> on the line above. A bare ignore is itself an error.

WHEN YOU ADD AN ANNOTATION

  Only when no tool can derive it, and pick by CONSUMER, not by taste (cm help annotations).
  Annotate from EVIDENCE: the coupling that already caused a manual intervention or a broken deploy.
  A flow nobody has been burned by has not earned its annotations yet.

WHAT NOT TO DO

  Do not delete or edit legacy comments to make a run green — that is a separate, reviewable change.
  Do not turn enforcement off in .forge/codemap.json to pass a gate.
  Do not add a comment "for the next reader" that the code already says. That is the whole point.`;
}

function principles() {
  const spec = specPath();
  const body = spec ? section(readFileSync(spec, 'utf8'), '2') : null;
  return `PRINCIPLES\n\n${body ?? '(SPEC.md not found beside this copy of cm)'}\n
The two that decide the most day to day:

  Derivable ⇒ forbidden. \`// Load the config\` is not ugly, it is INVALID.
  An annotation exists only if a tool consumes it AND the payoff lands in the same session.

Full contract: cm help spec`;
}

/** Slice one \`## §N …\` section out of SPEC.md, or the whole file when no section is asked for. */
function section(src, want) {
  const lines = src.split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (/^## §/.test(l)) starts.push(i); });
  if (!want) return src.trim();
  const idx = starts.find((i) => new RegExp(`^## §${want}(\\D|$)`).test(lines[i]));
  if (idx === undefined) {
    const names = starts.map((i) => lines[i].replace(/^## /, ''));
    return `no section §${want}. SPEC.md has:\n${names.map((n) => `  ${n}`).join('\n')}`;
  }
  const next = starts.find((i) => i > idx);
  return lines.slice(idx, next ?? lines.length).join('\n').trim();
}

function spec(arg) {
  const p = specPath();
  if (!p) {
    return 'SPEC.md is not beside this copy of cm. In a vendored install it is .forge/codemap/SPEC.md —\nre-run `cm install` to restore it.';
  }
  return section(readFileSync(p, 'utf8'), arg ? String(arg).replace(/^§/, '') : null);
}

const TOPICS = {
  annotations, codes, baseline, languages, config, ci, workflow, principles, verbs,
};

/**
 * @param {string|undefined} topic
 * @param {string|undefined} arg  extra argument, currently only the spec section
 * @returns {{text: string, ok: boolean}}
 */
export function renderHelp(topic, arg) {
  if (!topic) return { text: overview(), ok: true };
  if (topic === 'spec') return { text: spec(arg), ok: true };
  if (topic === 'topics') return { text: Object.keys(TOPIC_BLURBS).sort().join('\n'), ok: true };
  const fn = TOPICS[topic];
  if (!fn) {
    return {
      text: `no help topic "${topic}". Topics: ${Object.keys(TOPIC_BLURBS).sort().join(', ')}`,
      ok: false,
    };
  }
  return { text: fn(), ok: true };
}

export const HELP_TOPICS = Object.keys(TOPIC_BLURBS);
