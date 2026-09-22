#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, '.forge', 'conformance.json');
const VOCABULARIES = {
  issue: { file: 'packages/core/src/db/schema.ts', symbol: 'issueStatuses' },
  job: { file: 'packages/core/src/db/schema.ts', symbol: 'jobStatuses' },
  session: { file: 'packages/core/src/db/session-vocabulary.ts', symbol: 'agentSessionStatuses' },
};
const DISCRIMINATOR = {
  issue: /\bissues?\b|IssueStatus/,
  job: /\bjobs?\b|JobStatus/,
  session: /agentSessions?|AgentSession/i,
};
// A status literal in either quote style: `packages/core` and `packages/contracts`
// are formatted with single quotes and `packages/web-v2` with double, so a
// single-quote-only scan reads the browser package as holding no tuples at all.
const QUOTED = /['"]([a-z_]+)['"]/g;
const TUPLE = /\[\s*((?:['"][a-z_]+['"]\s*,\s*)+['"][a-z_]+['"]\s*),?\s*\]/g;
// A yes/no classification over a whole status vocabulary. `Record<JobStatus,
// boolean>` IS a named question — its `true` keys are a tuple, reached by a
// route the array matcher cannot see. Only `boolean`: a `Record<Status, string>`
// is a lookup table, and grouping ITS keys by value would invent questions
// nobody asked (`KERNEL_TO_LABEL` would answer "a person is owed something").
const CLASSIFICATION =
  /(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*:\s*Record<\s*([A-Za-z0-9_$]+)\s*,\s*boolean\s*>\s*=\s*\{([^{}]*)\}/g;
const CLASSIFIED = /['"]?([a-z_]+)['"]?\s*:\s*(true|false)\b/g;
// A `.each` list is the DOMAIN a test claims to cover, never the value it
// asserts. That is the one tuple shape in a test file this checker reads.
const EACH_CASES = /\.each\(\s*$/;
const IS_TEST = /\.test\.tsx?$/;
const DIFFERS = /status-tuple:\s*differs\s*[—-]\s*\S/;
const MARKER_REACH = 6;
const DEFAULTS = {
  scanRoots: ['packages/core/src', 'packages/core/tests', 'packages/contracts/src'],
  scanExts: ['.ts', '.tsx'],
  skipDirs: ['node_modules', 'dist', 'coverage', '.next', '.turbo', 'drizzle'],
};

function die(message) {
  console.error(`check-status-tuples: ${message}`);
  process.exit(2);
}

function config() {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS;
  try {
    const declared = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))?.checkers?.['status-tuples'];
    return { ...DEFAULTS, ...(declared ?? {}) };
  } catch (err) {
    die(`${CONFIG_PATH} is not readable JSON: ${err.message}`);
  }
}

function readVocabularies() {
  const read = {};
  const sources = new Map();
  for (const [name, { file, symbol }] of Object.entries(VOCABULARIES)) {
    if (!sources.has(file)) {
      const abs = join(ROOT, file);
      if (!existsSync(abs)) {
        die(
          `${file} is not there, so the status vocabularies cannot be read and every\n` +
            'tuple below would be measured against an empty list',
        );
      }
      sources.set(file, readFileSync(abs, 'utf8'));
    }
    const hit = sources
      .get(file)
      .match(new RegExp(`export const ${symbol}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`));
    if (!hit) {
      die(
        `${file} no longer declares \`export const ${symbol} = [...] as const\`.\n` +
          'The checker reads its vocabularies from that declaration rather than carrying a copy,\n' +
          'so a rename there stops the scan instead of quietly narrowing it. Point this checker at\n' +
          'the new name.',
      );
    }
    const members = new Set([...hit[1].matchAll(QUOTED)].map((m) => m[1]));
    if (members.size === 0) die(`${symbol} parsed to an empty vocabulary`);
    read[name] = members;
  }
  return read;
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Every `status-tuple: differs` comment, whole, with the line it ends on. The
 * whole text is kept because the marker has to NAME the answer it differs from:
 * a reason written about one neighbour is not an excuse against a different one.
 */
function markers(source) {
  const out = [];
  const comments = /\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n[ \t]*\/\/[^\n]*)*/g;
  for (const hit of source.matchAll(comments)) {
    if (!DIFFERS.test(hit[0])) continue;
    out.push({
      endLine: source.slice(0, hit.index + hit[0].length).split('\n').length,
      text: hit[0],
    });
  }
  return out;
}

const namesPeer = (excuse, peer) =>
  new RegExp(`\\b${peer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(excuse);

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function walk(rel, cfg, acc) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!cfg.skipDirs.includes(entry.name)) walk(path, cfg, acc);
      continue;
    }
    if (!cfg.scanExts.some((ext) => entry.name.endsWith(ext))) continue;
    acc.push(path);
  }
  return acc;
}

/** The vocabulary a tuple is drawn from, or null where the text does not say. */
export function attributeVocabulary(members, context, vocabularies) {
  const candidates = Object.entries(vocabularies)
    .filter(([, members_]) => members.every((m) => members_.has(m)))
    .map(([name]) => name);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const named = candidates.filter((name) => DISCRIMINATOR[name].test(context));
  return named.length === 1 ? named[0] : null;
}

export function sitesIn(rel, source, vocabularies, unattributed = []) {
  const marked = markers(source);
  const text = stripComments(source);
  const isTest = IS_TEST.test(rel);
  const sites = [];
  const push = ({ members, line, context, name }) => {
    const vocabulary = attributeVocabulary(members, context, vocabularies);
    if (vocabulary === null) {
      if (Object.values(vocabularies).some((v) => members.every((m) => v.has(m)))) {
        unattributed.push({ rel, line, members });
      }
      return;
    }
    const marker = marked.find((m) => m.endLine <= line && m.endLine > line - MARKER_REACH);
    sites.push({
      rel,
      line,
      vocabulary,
      key: `${vocabulary}|${[...members].sort().join(',')}`,
      name,
      excuse: marker ? marker.text : null,
    });
  };

  for (const hit of text.matchAll(TUPLE)) {
    const members = [...hit[1].matchAll(QUOTED)].map((m) => m[1]);
    const before = text.slice(0, hit.index);
    // A tuple written as an object-literal property value is a table row, not a
    // named question: `transitions` and `JOB_TYPE_EXPECTED_EXIT_STATUS` both hold
    // rows that coincide with a constant without restating it.
    if (/:\s*$/.test(before)) continue;
    // `ARRAY[...]` is a SQL literal wearing brackets. SQL is out of this
    // checker's scope by the same rule that leaves `IN ('a', 'b')` alone.
    if (/\bARRAY\s*$/.test(before)) continue;
    // In a test file the tuple is usually the ASSERTION — `expect(jobStatuses)
    // .toEqual([...])` restates the declaration on purpose, because importing the
    // constant would make the assertion vacuous. A `.each` case list never is:
    // it enumerates the domain the test claims to cover, so a member added to the
    // constant leaves the test silently covering less than its name says.
    if (isTest && !EACH_CASES.test(before.slice(-40))) continue;
    const declaration = before
      .slice(-160)
      .match(
        /(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*(?::[^=]*?)?=\s*(?:new Set(?:<[^>]*>)?\(\s*)?$/,
      );
    push({
      members,
      line: lineOf(text, hit.index),
      context: text.slice(Math.max(0, hit.index - 260), hit.index + 260),
      name: declaration ? declaration[1] : null,
    });
  }

  for (const hit of text.matchAll(CLASSIFICATION)) {
    const members = [...hit[3].matchAll(CLASSIFIED)]
      .filter((m) => m[2] === 'true')
      .map((m) => m[1]);
    if (members.length < 2) continue;
    push({
      members,
      line: lineOf(text, hit.index),
      // The `Record<…Status, boolean>` annotation says which vocabulary is being
      // classified, so the discriminator reads the type name rather than prose.
      context: hit[2],
      name: hit[1],
    });
  }
  return sites;
}

/**
 * The two rules, over the sites of one scan.
 *
 * A DECLARATION is excused only by a marker that names another declaration
 * holding this same tuple. `UNHELD_LIVE_JOB_STATUSES` carries a marker about
 * `LIVE_JOB_STATUSES`, which is a different tuple — reading that as a blanket
 * excuse would let a THIRD module declare the unheld set again and pass, which
 * is exactly how `pipeline/runs-rollup.ts` held a second `LIVE_JOB_STATUSES`
 * with the gate green (ISS-1106 criterion 13).
 *
 * An INLINE copy has no name to be named back, so any marker within reach
 * excuses it.
 */
export function judge(sites) {
  const groups = new Map();
  for (const site of sites) {
    if (!groups.has(site.key)) groups.set(site.key, []);
    groups.get(site.key).push(site);
  }
  const twoAnswers = [];
  const restatements = [];
  const byName = new Map();
  for (const site of sites) {
    if (site.name === null) continue;
    if (!byName.has(site.name)) byName.set(site.name, []);
    byName.get(site.name).push(site);
  }
  const twoMeanings = [...byName.entries()]
    .map(([name, declarations]) => ({ name, declarations }))
    .filter(({ declarations }) => new Set(declarations.map((d) => d.key)).size > 1);
  for (const [key, members] of groups) {
    const declarations = members.filter((s) => s.name !== null);
    const unexcused = declarations.filter(
      (s) => !(s.excuse && declarations.some((d) => d !== s && namesPeer(s.excuse, d.name))),
    );
    if (unexcused.length > 1) twoAnswers.push({ key, declarations: unexcused });
    if (declarations.length === 0) continue;
    const owner = unexcused[0] ?? declarations[0];
    for (const inline of members.filter((s) => s.name === null && !s.excuse)) {
      restatements.push({ key, inline, owner });
    }
  }
  return { groups, twoAnswers, restatements, twoMeanings };
}

const at = (s) => `${s.rel}:${s.line}`;

function main() {
  const mode = process.argv[2];
  if (mode !== '--all') {
    die('the only mode is --all — a staged subset reports clean on a tree that is not');
  }

  const cfg = config();
  const vocabularies = readVocabularies();
  const files = cfg.scanRoots.reduce((acc, rel) => walk(rel, cfg, acc), []);
  if (files.length === 0) die(`no source files found under ${cfg.scanRoots.join(', ')}`);

  const unattributed = [];
  const sites = files.flatMap((rel) =>
    sitesIn(rel, readFileSync(join(ROOT, rel), 'utf8'), vocabularies, unattributed),
  );
  const { groups, twoAnswers, restatements, twoMeanings } = judge(sites);

  if (unattributed.length > 0) {
    console.log(
      `check-status-tuples: ${unattributed.length} tuple(s) fit more than one status vocabulary\n` +
        'and nothing nearby says which, so they were not measured. Printed rather than dropped,\n' +
        'so the exclusion cannot go quiet:',
    );
    for (const u of unattributed) console.log(`  ${at(u)} — [${u.members.join(', ')}]`);
  }

  if (twoAnswers.length > 0 || restatements.length > 0 || twoMeanings.length > 0) {
    console.error(
      `check-status-tuples: ${twoAnswers.length} status tuple(s) with more than one declaration, ` +
        `${restatements.length} inline restatement(s) of a tuple a constant already holds, ` +
        `${twoMeanings.length} name(s) meaning two different tuples:\n`,
    );
    for (const fault of twoMeanings) {
      const answers = new Set(fault.declarations.map((d) => d.key)).size;
      console.error(`  ${fault.name} means ${answers} different tuples:`);
      for (const d of fault.declarations) {
        console.error(`    ${at(d)} — [${d.key.split('|')[1]}]`);
      }
    }
    for (const fault of twoAnswers) {
      console.error(
        `  [${fault.key.split('|')[1]}] is declared ${fault.declarations.length} times:`,
      );
      for (const d of fault.declarations) console.error(`    ${d.name} — ${at(d)}`);
    }
    for (const fault of restatements) {
      console.error(
        `  ${at(fault.inline)} writes [${fault.key.split('|')[1]}] inline — ` +
          `${fault.owner.name} at ${at(fault.owner)} already holds it`,
      );
    }
    console.error(
      '\nOne question has one answer, and one name answers one question. Two constants holding\n' +
        'the same status tuple are one answer with two labels whatever they are called, and an\n' +
        'inline copy is a third label with no name at all: each is a place a later change can move\n' +
        'one copy and leave the rest, which is how the same predicate starts giving two verdicts.\n' +
        'A name holding two tuples is worse than either, because the two never collide by value and\n' +
        'a reader of one file and a reader of the other both think they know what it means. Keep\n' +
        'the surviving name in the module that owns the concept and move every caller to it.\n\n' +
        'A pair that genuinely must differ says so at the declaration, in a comment within\n' +
        `${MARKER_REACH} lines above it, reading: status-tuple: differs — <why this answer ` +
        'cannot be the other>',
    );
    process.exit(1);
  }

  console.log(
    `status-tuples: ${files.length} file(s) scanned, ${sites.length} tuple(s), ` +
      `${groups.size} distinct answer(s)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
